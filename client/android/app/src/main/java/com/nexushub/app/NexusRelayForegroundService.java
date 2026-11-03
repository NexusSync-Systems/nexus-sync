package com.nexushub.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.telephony.PhoneStateListener;
import android.telephony.SmsManager;
import android.telephony.TelephonyCallback;
import android.telephony.TelephonyManager;
import android.util.Log;
import androidx.annotation.Nullable;
import androidx.annotation.RequiresApi;
import android.os.PowerManager;
import androidx.core.app.NotificationCompat;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

public class NexusRelayForegroundService extends Service {
    static final String ACTION_START = "com.nexushub.app.action.RELAY_START";
    static final String ACTION_STOP  = "com.nexushub.app.action.RELAY_STOP";

    private static final String TAG            = "NexusRelayService";
    private static final String CHANNEL_ID     = "nexus-relay-foreground";
    private static final String TIMEOUT_CHANNEL_ID = "nexus-relay-stopped";
    private static final int    NOTIFICATION_ID = 10021;
    private static final int    TIMEOUT_NOTIFICATION_ID = 10022;
    private static final int    POLL_INTERVAL_S = 30;   // native outbox poll interval
    private static final int    INITIAL_DELAY_S = 5;    // first poll after 5s

    private TelephonyManager      telephonyManager;
    private NexusPhoneListener    phoneListener;
    private TelephonyCallback     telephonyCallback;
    private ScheduledExecutorService scheduler;

    // ── Lifecycle ────────────────────────────────────────────────────────────

    static void start(Context context) {
        Intent intent = new Intent(context, NexusRelayForegroundService.class);
        intent.setAction(ACTION_START);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(intent);
        } else {
            context.startService(intent);
        }
    }

    static void stop(Context context) {
        Intent intent = new Intent(context, NexusRelayForegroundService.class);
        intent.setAction(ACTION_STOP);
        context.startService(intent);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        telephonyManager = (TelephonyManager) getSystemService(Context.TELEPHONY_SERVICE);
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : ACTION_START;

        if (ACTION_STOP.equals(action)) {
            stopNativePolling();
            unregisterCallStateListener();
            stopForeground(true);
            stopSelf();
            return START_NOT_STICKY;
        }

        boolean relayActive = NexusRelayPlugin.securePrefs(this, NexusRelayPlugin.PREFS_NAME)
            .getBoolean(NexusRelayPlugin.KEY_IS_ACTIVE, false);
        if (!relayActive) {
            stopNativePolling();
            unregisterCallStateListener();
            stopForeground(true);
            stopSelf();
            return START_NOT_STICKY;
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, buildNotification(), typPopredoveSluzby());
        } else {
            startForeground(NOTIFICATION_ID, buildNotification());
        }
        // Relay zase běží — varování o zastavení už neplatí.
        rozpocetVyprsel = false;
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm != null) nm.cancel(TIMEOUT_NOTIFICATION_ID);

        registerCallStateListener();
        startNativePolling();
        return START_STICKY;
    }

    /**
     * Typ popředové služby, se kterým se relay spouští.
     *
     * Android 15 a výš dává typu dataSync rozpočet 6 hodin na 24 hodin.
     * Relay telefon leží v šuplíku a nikdo ho nebere do ruky — rozpočet by
     * mu došel a Android by službu ukončil (a další start odmítl), protože
     * časovač resetuje jedině to, když někdo aplikaci otevře na popředí.
     * Typ specialUse tomuhle limitu nepodléhá, proto ho relay upřednostňuje.
     *
     * Typ se nebere z pevné konstanty, ale z toho, co má příchuť doopravdy
     * v manifestu: specialUse deklaruje jen src/nexusRelay, plná aplikace ne
     * (musela by si o něj v Google Play zvlášť požádat). Kdyby se tu natvrdo
     * vracelo SPECIAL_USE, plná aplikace by na startForeground spadla.
     */
    @RequiresApi(Build.VERSION_CODES.Q)
    private int typPopredoveSluzby() {
        int deklarovane = 0;
        try {
            ServiceInfo info = getPackageManager().getServiceInfo(
                new ComponentName(this, NexusRelayForegroundService.class), 0);
            deklarovane = info.getForegroundServiceType();
        } catch (PackageManager.NameNotFoundException e) {
            Log.w(TAG, "Vlastní ServiceInfo se nepodařilo přečíst, beru dataSync", e);
        }

        return vyberTyp(deklarovane, Build.VERSION.SDK_INT);
    }

    /**
     * Oddělené od {@link #typPopredoveSluzby()}, aby se dalo otestovat bez
     * telefonu — viz NexusRelayForegroundServiceTest. Chyba v téhle úvaze se
     * totiž neprojeví varováním, ale pádem plné aplikace na startForeground.
     *
     * @param deklarovane maska typů z manifestu (0 = nepodařilo se přečíst)
     * @param sdkInt      verze Androidu na telefonu
     */
    static int vyberTyp(int deklarovane, int sdkInt) {
        boolean maSpecialUse = sdkInt >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE
            && (deklarovane & ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE) != 0;
        return maSpecialUse
            ? ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
            : ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC;
    }

    // ── Vypršení rozpočtu popředové služby ───────────────────────────────────

    /**
     * Android 15+ u časově omezených typů (dataSync, mediaProcessing) zavolá
     * tohle, až dojde rozpočet. Služba má pak pár sekund na to, aby skončila
     * sama — jinak ji systém shodí s RemoteServiceException.
     *
     * Relay běží na specialUse, který limitu nepodléhá, takže sem za
     * normálních okolností nedojde. Platí to ale pro plnou aplikaci (ta
     * zůstává na dataSync) a hlavně to je pojistka pro případ, že Google
     * limit rozšíří i na specialUse. Tiše umřít je to jediné, co si relay
     * dovolit nesmí.
     */
    @Override
    @RequiresApi(Build.VERSION_CODES.VANILLA_ICE_CREAM)
    public void onTimeout(int startId, int fgsType) {
        zastavPoVyprseniRozpoctu("vypršel rozpočet typu " + fgsType);
    }

    /** Starší jednoparametrová varianta (Android 14, shortService). */
    @Override
    @RequiresApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
    public void onTimeout(int startId) {
        zastavPoVyprseniRozpoctu("vypršel rozpočet popředové služby");
    }

    private boolean rozpocetVyprsel = false;

    private void zastavPoVyprseniRozpoctu(String duvod) {
        if (rozpocetVyprsel) return;   // obě varianty onTimeout můžou přijít obě
        rozpocetVyprsel = true;

        Log.w(TAG, "Android ukončuje popředovou službu: " + duvod);
        stopNativePolling();
        unregisterCallStateListener();
        stopForeground(true);
        oznamZastaveni();
        stopSelf();
    }

    /**
     * Trvalé oznámení zmizí i se službou, takže po relay nezůstane žádná
     * stopa. Tohle je ta stopa — vlastní kanál s vyšší důležitostí, ne tichý
     * servisní, ať si toho někdo všimne dřív než zákazník.
     */
    private void oznamZastaveni() {
        try {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            // Oznámení říká „otevřete aplikaci" — musí se tedy dát otevřít
            // kliknutím, jinak je to jen hláška. Otevření aplikace zároveň
            // resetuje rozpočet a NexusRelayPlugin.handleOnResume() relay
            // znovu nastartuje, takže ten text platí doslova.
            PendingIntent otevriAplikaci = PendingIntent.getActivity(
                this,
                0,
                new Intent(this, MainActivity.class)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

            nm.notify(TIMEOUT_NOTIFICATION_ID, new NotificationCompat.Builder(this, TIMEOUT_CHANNEL_ID)
                .setContentTitle(getString(R.string.relay_timeout_title))
                .setContentText(getString(R.string.relay_timeout_text))
                .setStyle(new NotificationCompat.BigTextStyle().bigText(getString(R.string.relay_timeout_text)))
                .setSmallIcon(android.R.drawable.stat_notify_error)
                .setCategory(NotificationCompat.CATEGORY_ERROR)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setContentIntent(otevriAplikaci)
                .setAutoCancel(true)
                .build());
        } catch (Exception e) {
            Log.w(TAG, "Nepodařilo se oznámit zastavení relay", e);
        }
    }

    @Override
    public void onDestroy() {
        stopNativePolling();
        unregisterCallStateListener();
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    // ── Native outbox polling ─────────────────────────────────────────────────

    private void startNativePolling() {
        if (scheduler != null && !scheduler.isShutdown()) return;
        Log.d(TAG, "Starting native outbox polling every " + POLL_INTERVAL_S + "s");
        scheduler = Executors.newSingleThreadScheduledExecutor();
        scheduler.scheduleWithFixedDelay(this::pollOutboxNative,
            INITIAL_DELAY_S, POLL_INTERVAL_S, TimeUnit.SECONDS);
    }

    private void stopNativePolling() {
        if (scheduler != null) {
            scheduler.shutdownNow();
            scheduler = null;
        }
    }

    /**
     * Polls /api/messages/outbox?profileId=xxx and sends each pending SMS
     * via SmsManager. Acquires a PARTIAL_WAKE_LOCK to prevent the CPU from
     * sleeping mid-poll when the screen is off (Android Doze mode workaround).
     */
    private void pollOutboxNative() {
        SharedPreferences prefs = NexusRelayPlugin.securePrefs(this, NexusRelayPlugin.PREFS_NAME);
        if (!prefs.getBoolean(NexusRelayPlugin.KEY_IS_ACTIVE, false)) {
            Log.d(TAG, "pollOutboxNative: relay not active, skipping");
            return;
        }

        String baseUrl       = prefs.getString(NexusRelayPlugin.KEY_BASE_URL, null);
        String profileId     = prefs.getString(NexusRelayPlugin.KEY_PROFILE_ID, null);
        String installationId = prefs.getString(NexusRelayPlugin.KEY_INSTALLATION_ID, null);
        String deviceSecret  = prefs.getString(NexusRelayPlugin.KEY_DEVICE_SECRET, null);
        String authToken     = prefs.getString(NexusRelayPlugin.KEY_AUTH_TOKEN, null);

        if (baseUrl == null || profileId == null) {
            Log.w(TAG, "pollOutboxNative: missing baseUrl or profileId");
            return;
        }
        // Secret zařízení nevyprší, authToken po hodině ano. Stačí jedno z nich,
        // ale bez obojího nemá smysl se serverem vůbec mluvit.
        boolean maSecret = deviceSecret != null && !deviceSecret.isEmpty();
        if (!maSecret && (authToken == null || authToken.isEmpty())) {
            Log.w(TAG, "pollOutboxNative: no credentials");
            oznamProblem(R.string.relay_potrebuje_prihlaseni);
            return;
        }

        NexusRelayPlugin.SmsSyncResult syncResult = NexusRelayPlugin.syncSmsHistoryNative(this, 25, 10 * 60_000L);
        if (syncResult.synced > 0 || syncResult.failed > 0) {
            Log.d(TAG, "pollOutboxNative: SMS inbox fallback synced=" + syncResult.synced + ", failed=" + syncResult.failed);
        }

        // ── WakeLock: keep CPU awake while doing network I/O (screen-off safe) ──
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        PowerManager.WakeLock wakeLock = pm.newWakeLock(
            PowerManager.PARTIAL_WAKE_LOCK, "NexusHub::OutboxPollWakeLock");
        wakeLock.acquire(30_000L); // max 30s safety timeout

        try {
            // Derive the API base (strip trailing /api/device/relay if present)
            String apiBase = baseUrl.replaceAll("/api/device/relay$", "")
                                    .replaceAll("/api$", "");

            String outboxUrl = apiBase + "/api/messages/outbox?profileId=" + profileId;
            if (installationId != null && !installationId.isEmpty()) {
                outboxUrl += "&installationId=" + installationId;
            }

            URL url = new URL(outboxUrl);
            HttpURLConnection conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("GET");
            conn.setRequestProperty("Accept", "application/json");
            NexusRelayPlugin.applyRelayCredentials(this, conn);
            conn.setConnectTimeout(10000);
            conn.setReadTimeout(10000);

            int code = conn.getResponseCode();
            if (code != 200) {
                Log.w(TAG, "pollOutboxNative: outbox returned HTTP " + code);
                conn.disconnect();
                // 401/403 se samo nespraví. Dřív se tady jen zapsal řádek do
                // logu a služba se vrátila — navenek se nezměnilo nic a relay
                // mohl mlčet hodiny, aniž by to šlo poznat.
                if (code == 401 || code == 403) {
                    oznamProblem(maSecret ? R.string.relay_server_odmita : R.string.relay_potrebuje_prihlaseni);
                } else {
                    oznamVporadku();
                }
                return;
            }
            oznamVporadku();

            BufferedReader reader = new BufferedReader(
                new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) {
                sb.append(line);
            }
            reader.close();
            conn.disconnect();

            org.json.JSONArray messages = new org.json.JSONArray(sb.toString());
            if (messages.length() == 0) return;

            Log.d(TAG, "pollOutboxNative: " + messages.length() + " pending message(s)");

            SmsManager smsManager;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                smsManager = getSystemService(SmsManager.class);
            } else {
                smsManager = SmsManager.getDefault();
            }

            for (int i = 0; i < messages.length(); i++) {
                org.json.JSONObject msg = messages.getJSONObject(i);
                String messageId = msg.optString("id");
                String to        = msg.optString("to");
                String text      = msg.optString("text");

                if (to.isEmpty() || text.isEmpty()) continue;

                try {
                    if (text.length() > 160) {
                        java.util.ArrayList<String> parts = smsManager.divideMessage(text);
                        smsManager.sendMultipartTextMessage(to, null, parts, null, null);
                    } else {
                        smsManager.sendTextMessage(to, null, text, null, null);
                    }
                    NexusRelayPlugin.insertSentSms(this, to, text);
                    Log.d(TAG, "pollOutboxNative: SMS sent to " + to + " (msg=" + messageId + ")");
                    updateMessageStatus(apiBase, messageId, "sent");
                } catch (Exception smsEx) {
                    Log.e(TAG, "pollOutboxNative: SMS send failed for " + messageId, smsEx);
                    updateMessageStatus(apiBase, messageId, "failed");
                }
            }

        } catch (Exception e) {
            Log.e(TAG, "pollOutboxNative: error", e);
        } finally {
            if (wakeLock.isHeld()) wakeLock.release();
        }
    }

    /**
     * PATCH /api/messages/{id}/status — marks message as sent or failed.
     */
    private void updateMessageStatus(String apiBase, String messageId, String status) {
        if (messageId == null || messageId.isEmpty()) return;
        try {
            URL url = new URL(apiBase + "/api/messages/" + messageId + "/status");
            HttpURLConnection conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("PATCH");
            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            NexusRelayPlugin.applyRelayCredentials(this, conn);
            conn.setDoOutput(true);
            conn.setConnectTimeout(8000);
            conn.setReadTimeout(8000);

            String body = "{\"status\":\"" + status + "\"}";
            try (OutputStream os = conn.getOutputStream()) {
                os.write(body.getBytes(StandardCharsets.UTF_8));
            }

            int code = conn.getResponseCode();
            Log.d(TAG, "updateMessageStatus: " + messageId + " -> " + status + " (HTTP " + code + ")");
            conn.disconnect();
        } catch (Exception e) {
            Log.w(TAG, "updateMessageStatus: failed for " + messageId, e);
        }
    }

    // ── Notification ──────────────────────────────────────────────────────────

    private Notification buildNotification() {
        return buildNotification(0);
    }

    /**
     * @param problemResId 0 = běžný stav; jinak text závady
     */
    private Notification buildNotification(int problemResId) {
        boolean jeProblem = problemResId != 0;
        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(jeProblem ? R.string.relay_service_title_problem : R.string.relay_service_title))
            .setContentText(getString(jeProblem ? problemResId : R.string.relay_service_text))
            .setSmallIcon(jeProblem ? android.R.drawable.stat_notify_error : android.R.drawable.stat_notify_sync)
            .setOngoing(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build();
    }

    /**
     * Trvalé oznámení je jediné, co je na relay telefonu vidět. Když se
     * nedaří mluvit se serverem, musí to říct — dřív se stav zapsal jen do
     * logu a navenek relay dál tvrdil „je aktivní", zatímco nedělal nic.
     *
     * Poslední zobrazený stav si pamatujeme, aby se oznámení nepřepisovalo
     * každých 30 s zbytečně.
     */
    private int zobrazenyProblem = 0;

    private void oznamProblem(int textResId) {
        if (zobrazenyProblem == textResId) return;
        zobrazenyProblem = textResId;
        prekresliOznameni(textResId);
    }

    private void oznamVporadku() {
        if (zobrazenyProblem == 0) return;
        zobrazenyProblem = 0;
        prekresliOznameni(0);
    }

    private void prekresliOznameni(int problemResId) {
        try {
            NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.notify(NOTIFICATION_ID, buildNotification(problemResId));
        } catch (Exception e) {
            Log.w(TAG, "Nepodařilo se překreslit oznámení", e);
        }
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        NotificationChannel channel = new NotificationChannel(
            CHANNEL_ID,
            getString(R.string.relay_service_channel_name),
            NotificationManager.IMPORTANCE_LOW
        );
        channel.setDescription(getString(R.string.relay_service_channel_desc));
        nm.createNotificationChannel(channel);

        // Zastavení relay je zpráva, která nesmí zapadnout mezi tiché servisní
        // oznámení — proto vlastní kanál, který smí zvonit.
        NotificationChannel timeoutChannel = new NotificationChannel(
            TIMEOUT_CHANNEL_ID,
            getString(R.string.relay_timeout_channel_name),
            NotificationManager.IMPORTANCE_HIGH
        );
        timeoutChannel.setDescription(getString(R.string.relay_timeout_channel_desc));
        nm.createNotificationChannel(timeoutChannel);
    }

    // ── Call state ────────────────────────────────────────────────────────────

    private void registerCallStateListener() {
        if (telephonyManager == null) return;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                if (telephonyCallback != null) return;
                telephonyCallback = new ServiceCallStateCallback(this);
                telephonyManager.registerTelephonyCallback(getMainExecutor(), telephonyCallback);
                return;
            }
            if (phoneListener != null) return;
            phoneListener = new NexusPhoneListener(this);
            telephonyManager.listen(phoneListener, PhoneStateListener.LISTEN_CALL_STATE);
        } catch (SecurityException ex) {
            Log.w(TAG, "Missing permission for call state listener", ex);
        }
    }

    private void unregisterCallStateListener() {
        if (telephonyManager == null) return;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                if (telephonyCallback != null) {
                    telephonyManager.unregisterTelephonyCallback(telephonyCallback);
                    telephonyCallback = null;
                }
                return;
            }
            if (phoneListener != null) {
                telephonyManager.listen(phoneListener, PhoneStateListener.LISTEN_NONE);
                phoneListener = null;
            }
        } catch (Exception ex) {
            Log.w(TAG, "Call state listener unregister failed", ex);
        }
    }

    @RequiresApi(Build.VERSION_CODES.S)
    private static class ServiceCallStateCallback extends TelephonyCallback
            implements TelephonyCallback.CallStateListener {
        private final Context context;

        ServiceCallStateCallback(Context context) {
            this.context = context;
        }

        @Override
        public void onCallStateChanged(int state) {
            NexusRelayPlugin.onCallStateChanged(context, null, NexusRelayPlugin.toCallStateString(state));
        }
    }
}
