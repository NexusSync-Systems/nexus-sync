package com.nexushub.app;

import android.telephony.SmsManager;
import android.Manifest;
import android.app.Activity;
import android.app.KeyguardManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import androidx.core.content.ContextCompat;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import android.telephony.PhoneStateListener;
import android.telephony.TelephonyCallback;
import android.telephony.TelephonyManager;
import androidx.activity.result.ActivityResult;
import androidx.annotation.RequiresApi;
import java.nio.charset.StandardCharsets;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

@CapacitorPlugin(
    name = "NexusRelay",
    permissions = {
        @Permission(alias = NexusRelayPlugin.SMS_PERMISSION_ALIAS, strings = { Manifest.permission.RECEIVE_SMS, Manifest.permission.READ_SMS, Manifest.permission.SEND_SMS }),
        @Permission(alias = NexusRelayPlugin.PHONE_PERMISSION_ALIAS, strings = { Manifest.permission.READ_PHONE_STATE, Manifest.permission.READ_CALL_LOG }),
        @Permission(alias = NexusRelayPlugin.LOCATION_PERMISSION_ALIAS, strings = { Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION })
    }
)
public class NexusRelayPlugin extends Plugin {
    static final String PREFS_NAME = "NexusRelayPrefs";

    // ── Šifrované úložiště (Android Keystore) ────────────────────────────────
    // Relay bearer token + credentials NESMÍ ležet v plaintext SharedPreferences.
    // securePrefs() vrací EncryptedSharedPreferences pod jménem "<legacy>_secure",
    // při první inicializaci zmigruje legacy plaintext hodnoty a smaže je. Když
    // šifrování selže (raritní problém s Keystore), graceful fallback na plaintext
    // — relay se nikdy nerozbije. Všechna čtení/zápisy prefs jdou přes tuhle metodu.
    private static final java.util.Map<String, android.content.SharedPreferences> SECURE_CACHE = new java.util.HashMap<>();

    static synchronized android.content.SharedPreferences securePrefs(Context context, String legacyName) {
        android.content.SharedPreferences cached = SECURE_CACHE.get(legacyName);
        if (cached != null) return cached;
        android.content.SharedPreferences prefs;
        try {
            androidx.security.crypto.MasterKey key = new androidx.security.crypto.MasterKey.Builder(context)
                .setKeyScheme(androidx.security.crypto.MasterKey.KeyScheme.AES256_GCM)
                .build();
            prefs = androidx.security.crypto.EncryptedSharedPreferences.create(
                context,
                legacyName + "_secure",
                key,
                androidx.security.crypto.EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                androidx.security.crypto.EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
            );
            migrateLegacyPrefs(context, legacyName, prefs);
        } catch (Exception e) {
            android.util.Log.e("NexusRelay", "EncryptedSharedPreferences selhalo pro '" + legacyName + "', fallback na plaintext: " + e.getMessage());
            prefs = context.getSharedPreferences(legacyName, Context.MODE_PRIVATE);
        }
        SECURE_CACHE.put(legacyName, prefs);
        return prefs;
    }

    @SuppressWarnings("unchecked")
    private static void migrateLegacyPrefs(Context context, String legacyName, android.content.SharedPreferences enc) {
        android.content.SharedPreferences legacy = context.getSharedPreferences(legacyName, Context.MODE_PRIVATE);
        java.util.Map<String, ?> all = legacy.getAll();
        if (all.isEmpty()) return;
        android.content.SharedPreferences.Editor ed = enc.edit();
        for (java.util.Map.Entry<String, ?> e : all.entrySet()) {
            Object v = e.getValue();
            if (v instanceof String) ed.putString(e.getKey(), (String) v);
            else if (v instanceof Boolean) ed.putBoolean(e.getKey(), (Boolean) v);
            else if (v instanceof Integer) ed.putInt(e.getKey(), (Integer) v);
            else if (v instanceof Long) ed.putLong(e.getKey(), (Long) v);
            else if (v instanceof Float) ed.putFloat(e.getKey(), (Float) v);
            else if (v instanceof java.util.Set) ed.putStringSet(e.getKey(), (java.util.Set<String>) v);
        }
        ed.apply();
        legacy.edit().clear().apply(); // po migraci smaž plaintext
        android.util.Log.i("NexusRelay", "Migrace " + all.size() + " prefs '" + legacyName + "' do šifrovaného úložiště");
    }
    static final String KEY_BASE_URL = "baseUrl";
    static final String KEY_DEVICE_ID = "deviceId";
    static final String KEY_INSTALLATION_ID = "installationId";
    static final String KEY_IS_ACTIVE = "isActive";
    static final String KEY_PROFILE_ID = "profileId";
    static final String KEY_AUTH_TOKEN = "authToken";
    // Pověření ZAŘÍZENÍ. Na rozdíl od authTokenu (1 h) nevyprší, takže služba
    // na pozadí funguje i poté, co systém zabije WebView a přihlášení se
    // přestane obnovovat. Server ho odvozuje jako HMAC(DEVICE_SECRET,
    // installationId) a vydá při párování v /device/verify.
    static final String KEY_DEVICE_SECRET = "deviceSecret";
    static final String KEY_LAST_SMS_HISTORY_SYNC_AT = "lastSmsHistorySyncAt";

    static final String SMS_PERMISSION_ALIAS = "sms";
    static final String PHONE_PERMISSION_ALIAS = "phone";
    static final String LOCATION_PERMISSION_ALIAS = "location";

    // Polohu vyžaduje jen plná aplikace — telefon modelky hlásí polohu během
    // schůzky. Relay je zařízení se SIM, které nikam nechodí, a od rozdělení
    // manifestů (src/nexusRelay vs. src/nexusFull) ji ani nedeklaruje.
    //
    // Bez tohohle hradla by relay čekala na oprávnění, o které si nemůže říct:
    // hasAllRequiredPermissions() by nikdy nevyšlo a průvodce nastavením by
    // nikdy neohlásil hotovo.
    private static final boolean VYZADUJE_POLOHU = !"relay".equals(BuildConfig.APP_VARIANT);
    private static final String[] SUPPORTED_RCS_PACKAGES = { "com.google.android.apps.messaging" };
    private static final long SMS_DEDUP_WINDOW_MS = 8000L;
    private static final long DEFAULT_SMS_SYNC_LOOKBACK_MS = 31L * 24L * 60L * 60L * 1000L;
    private static final long BACKGROUND_SMS_SYNC_LOOKBACK_MS = 10L * 60L * 1000L;

    public static NexusRelayPlugin instance;
    private NexusPhoneListener phoneListener;
    private TelephonyCallback telephonyCallback;
    private TelephonyManager telephonyManager;
    private static String lastSmsBody;
    private static long lastSmsBodyAt;

    @Override
    public void load() {
        super.load();
        instance = this;

        telephonyManager = (TelephonyManager) getContext().getSystemService(Context.TELEPHONY_SERVICE);
        if (isRelayActiveInPrefs()) {
            NexusRelayForegroundService.start(getContext());
        }
        maybeRegisterCallStateListener();
    }

    /**
     * Android 15 umí popředovou službu ukončit, až vyčerpá rozpočet, a další
     * start odmítne, dokud se aplikace neobjeví na popředí — jedině tím se
     * časovač resetuje. Tohle je ta chvíle, kdy se o tom dá něco udělat.
     *
     * load() na to nestačí: ten běží jednou při vzniku pluginu. Když aktivita
     * mezitím žila dál, vrácení na popředí žádnou metodu pluginu nevyvolá a
     * relay by zůstal stát, i když má v nastavení zapnuto. Oznámení
     * o zastavení relay posílá uživatele právě sem, takže tohle je to, co
     * tomu slibu dává platnost.
     */
    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        if (!isRelayActiveInPrefs()) return;
        try {
            NexusRelayForegroundService.start(getContext());
        } catch (Exception e) {
            android.util.Log.w("NexusRelay", "handleOnResume: relay se nepodařilo nastartovat", e);
        }
    }

    @Override
    protected void handleOnDestroy() {
        unregisterCallStateListener();
        telephonyManager = null;
        if (instance == this) {
            instance = null;
        }
        super.handleOnDestroy();
    }

    @PluginMethod
    public void ensureReady(PluginCall call) {
        if (hasAllRequiredPermissions()) {
            maybeRegisterCallStateListener();
            call.resolve(buildStatus());
            return;
        }

        requestPermissionForAliases(getMissingPermissionAliases(), call, "permissionsReadyCallback");
    }

    @PermissionCallback
    private void permissionsReadyCallback(PluginCall call) {
        if (getPermissionState(PHONE_PERMISSION_ALIAS) == PermissionState.GRANTED) {
            maybeRegisterCallStateListener();
        } else {
            unregisterCallStateListener();
        }
        call.resolve(buildStatus());
    }

    private boolean hasAllRequiredPermissions() {
        return getPermissionState(SMS_PERMISSION_ALIAS) == PermissionState.GRANTED &&
            getPermissionState(PHONE_PERMISSION_ALIAS) == PermissionState.GRANTED &&
            (!VYZADUJE_POLOHU || getPermissionState(LOCATION_PERMISSION_ALIAS) == PermissionState.GRANTED);
    }

    private String[] getMissingPermissionAliases() {
        java.util.List<String> missing = new java.util.ArrayList<>();
        if (getPermissionState(SMS_PERMISSION_ALIAS) != PermissionState.GRANTED) {
            missing.add(SMS_PERMISSION_ALIAS);
        }
        if (getPermissionState(PHONE_PERMISSION_ALIAS) != PermissionState.GRANTED) {
            missing.add(PHONE_PERMISSION_ALIAS);
        }
        if (VYZADUJE_POLOHU && getPermissionState(LOCATION_PERMISSION_ALIAS) != PermissionState.GRANTED) {
            missing.add(LOCATION_PERMISSION_ALIAS);
        }
        return missing.toArray(new String[0]);
    }

    @PluginMethod
    public void checkStatus(PluginCall call) {
        call.resolve(buildStatus());
    }

    private JSObject buildStatus() {
        JSObject status = new JSObject();
        PermissionState smsState = getPermissionState(SMS_PERMISSION_ALIAS);
        PermissionState phoneState = getPermissionState(PHONE_PERMISSION_ALIAS);
        PermissionState locationState = getPermissionState(LOCATION_PERMISSION_ALIAS);
        boolean notificationAccess = isNotificationListenerEnabled(getContext());
        status.put(SMS_PERMISSION_ALIAS, smsState.toString());
        status.put(PHONE_PERMISSION_ALIAS, phoneState.toString());
        status.put(LOCATION_PERMISSION_ALIAS, locationState.toString());
        status.put("ready",
            smsState == PermissionState.GRANTED &&
            phoneState == PermissionState.GRANTED &&
            (!VYZADUJE_POLOHU || locationState == PermissionState.GRANTED));
        status.put("callMonitoring", phoneState == PermissionState.GRANTED);
        status.put("smsMonitoring", smsState == PermissionState.GRANTED);
        status.put("locationMonitoring", locationState == PermissionState.GRANTED);
        status.put("notificationAccess", notificationAccess);
        status.put("rcsMonitoring", notificationAccess);
        return status;
    }

    @PluginMethod
    public void openNotificationAccessSettings(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        JSObject ret = new JSObject();
        ret.put("opened", true);
        ret.put("notificationAccess", isNotificationListenerEnabled(getContext()));
        call.resolve(ret);
    }

    // ── Sdílení polohy (telefon jako GPS tracker) ────────────────────────────────
    // JS (phoneTracker) zavolá tohle, když gating (A+B+C) chce reportovat polohu.
    // Config uložíme do securePrefs a spustíme foreground NexusLocationService, aby
    // reportování jelo i se zhasnutou obrazovkou.
    @PluginMethod
    public void startLocationTracking(PluginCall call) {
        String token = call.getString("token");
        String ingestUrl = call.getString("ingestUrl");
        if (token == null || token.isEmpty() || ingestUrl == null || ingestUrl.isEmpty()) {
            call.reject("token and ingestUrl are required");
            return;
        }
        Long minMs = call.getLong("minIntervalMs");
        long minInterval = (minMs != null && minMs > 0) ? minMs : 20000L;

        securePrefs(getContext(), PREFS_NAME).edit()
            .putBoolean(NexusLocationService.KEY_TRACK_ACTIVE, true)
            .putString(NexusLocationService.KEY_TRACK_TOKEN, token)
            .putString(NexusLocationService.KEY_TRACK_URL, ingestUrl)
            .putLong(NexusLocationService.KEY_TRACK_MIN_MS, minInterval)
            .apply();
        NexusLocationService.start(getContext());
        call.resolve();
    }

    @PluginMethod
    public void stopLocationTracking(PluginCall call) {
        securePrefs(getContext(), PREFS_NAME).edit()
            .putBoolean(NexusLocationService.KEY_TRACK_ACTIVE, false)
            .apply();
        NexusLocationService.stop(getContext());
        call.resolve();
    }

    private void maybeRegisterCallStateListener() {
        // Foreground service owns call monitoring when relay mode is active.
        if (isRelayActiveInPrefs()) {
            unregisterCallStateListener();
            return;
        }
        if (telephonyManager == null || getPermissionState(PHONE_PERMISSION_ALIAS) != PermissionState.GRANTED) {
            return;
        }
        registerCallStateListener();
    }

    private void registerCallStateListener() {
        if (telephonyManager == null) {
            return;
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            if (telephonyCallback != null) {
                return;
            }
            telephonyCallback = new NexusCallStateCallback();
            telephonyManager.registerTelephonyCallback(getContext().getMainExecutor(), telephonyCallback);
            return;
        }

        registerLegacyCallStateListener();
    }

    private void unregisterCallStateListener() {
        if (telephonyManager == null) {
            return;
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            if (telephonyCallback != null) {
                telephonyManager.unregisterTelephonyCallback(telephonyCallback);
                telephonyCallback = null;
            }
            return;
        }

        unregisterLegacyCallStateListener();
    }

    @SuppressWarnings("deprecation")
    private void registerLegacyCallStateListener() {
        if (phoneListener != null) {
            return;
        }
        phoneListener = new NexusPhoneListener(getContext());
        telephonyManager.listen(phoneListener, PhoneStateListener.LISTEN_CALL_STATE);
    }

    @SuppressWarnings("deprecation")
    private void unregisterLegacyCallStateListener() {
        if (phoneListener != null) {
            telephonyManager.listen(phoneListener, PhoneStateListener.LISTEN_NONE);
            phoneListener = null;
        }
    }

    @PluginMethod
    public void configureRelay(PluginCall call) {
        String baseUrl = call.getString("baseUrl");
        String deviceId = call.getString("deviceId");
        String installationId = call.getString("installationId");
        String authToken = call.getString("authToken");
        if (authToken == null) authToken = call.getString("token");
        String deviceSecret = call.getString("deviceSecret");
        Boolean isActive = call.getBoolean("isActive", false);

        Context context = getContext();
        android.content.SharedPreferences prefs = securePrefs(context, PREFS_NAME);
        android.content.SharedPreferences.Editor editor = prefs.edit();
        
        if (baseUrl != null) editor.putString(KEY_BASE_URL, baseUrl);
        if (deviceId != null) editor.putString(KEY_DEVICE_ID, deviceId);
        if (installationId != null) editor.putString(KEY_INSTALLATION_ID, installationId);
        if (authToken != null) {
            if (authToken.isEmpty()) {
                editor.remove(KEY_AUTH_TOKEN);
            } else {
                editor.putString(KEY_AUTH_TOKEN, authToken);
            }
        }
        // Prázdný řetězec NEPŘEPISUJE uložený secret. JS ho posílá při každém
        // překreslení a chvíli po startu ještě nemusí být načtený z úložiště —
        // kdyby ho prázdná hodnota smazala, služba by přišla o jediné pověření,
        // které nevyprší, a byli bychom zpátky u tiše mrtvého relaye.
        if (deviceSecret != null && !deviceSecret.isEmpty()) {
            editor.putString(KEY_DEVICE_SECRET, deviceSecret);
        }
        String profileId = call.getString("profileId");
        if (profileId != null) editor.putString(KEY_PROFILE_ID, profileId);
        boolean relayActive = isActive != null && isActive;
        editor.putBoolean(KEY_IS_ACTIVE, relayActive);
        editor.apply();

        if (relayActive) {
            unregisterCallStateListener();
            NexusRelayForegroundService.start(context);
        } else {
            NexusRelayForegroundService.stop(context);
            maybeRegisterCallStateListener();
        }

        JSObject ret = buildStatus();
        ret.put("configUpdated", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void confirmDeviceCredential(PluginCall call) {
        KeyguardManager keyguardManager = (KeyguardManager) getContext().getSystemService(Context.KEYGUARD_SERVICE);
        JSObject ret = new JSObject();

        if (keyguardManager == null || !keyguardManager.isDeviceSecure()) {
            ret.put("available", false);
            ret.put("unlocked", false);
            call.resolve(ret);
            return;
        }

        String title = call.getString("title", "Unlock Nexus Hub");
        String description = call.getString("description", "Confirm your screen lock to continue");
        Intent intent = keyguardManager.createConfirmDeviceCredentialIntent(title, description);

        if (intent == null) {
            ret.put("available", false);
            ret.put("unlocked", false);
            call.resolve(ret);
            return;
        }

        startActivityForResult(call, intent, "confirmDeviceCredentialCallback");
    }

    @PluginMethod
    public void isDefaultSmsApp(PluginCall call) {
        Context ctx = getContext();
        String def;
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
            android.app.role.RoleManager rm =
                (android.app.role.RoleManager) ctx.getSystemService(android.app.role.RoleManager.class);
            boolean held = rm != null && rm.isRoleHeld(android.app.role.RoleManager.ROLE_SMS);
            JSObject result = new JSObject();
            result.put("isDefault", held);
            call.resolve(result);
        } else {
            def = android.provider.Telephony.Sms.getDefaultSmsPackage(ctx);
            JSObject result = new JSObject();
            result.put("isDefault", ctx.getPackageName().equals(def));
            call.resolve(result);
        }
    }

    @PluginMethod
    public void requestDefaultSmsApp(PluginCall call) {
        Context ctx = getContext();
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.Q) {
            android.app.role.RoleManager rm =
                (android.app.role.RoleManager) ctx.getSystemService(android.app.role.RoleManager.class);
            if (rm != null && !rm.isRoleHeld(android.app.role.RoleManager.ROLE_SMS)) {
                android.content.Intent intent = rm.createRequestRoleIntent(android.app.role.RoleManager.ROLE_SMS);
                startActivityForResult(call, intent, "requestDefaultSmsAppCallback");
                return;
            }
        } else {
            android.content.Intent intent = new android.content.Intent(
                android.provider.Telephony.Sms.Intents.ACTION_CHANGE_DEFAULT);
            intent.putExtra(android.provider.Telephony.Sms.Intents.EXTRA_PACKAGE_NAME,
                ctx.getPackageName());
            startActivityForResult(call, intent, "requestDefaultSmsAppCallback");
            return;
        }
        call.resolve();
    }

    @ActivityCallback
    private void requestDefaultSmsAppCallback(PluginCall call, ActivityResult result) {
        call.resolve();
    }

    @PluginMethod
    public void sendSms(PluginCall call) {
        String to = call.getString("to");
        String text = call.getString("text");

        if (to == null || text == null) {
            call.reject("Recipient and text are required");
            return;
        }

        try {
            SmsManager smsManager;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                smsManager = getContext().getSystemService(SmsManager.class);
            } else {
                smsManager = SmsManager.getDefault();
            }

            // Rozdělení nech na divideMessage — je encoding-aware (GSM-7 = 160 znaků/část,
            // ale UCS-2 pro emoji/diakritiku jen 70). Pevná hranice 160 by unicode zprávu
            // o 71–160 znacích poslala jako jednu a ořízla ji.
            java.util.ArrayList<String> parts = smsManager.divideMessage(text);
            if (parts.size() > 1) {
                smsManager.sendMultipartTextMessage(to, null, parts, null, null);
            } else {
                smsManager.sendTextMessage(to, null, text, null, null);
            }

            // If we are the default SMS app, we must write sent messages to the provider
            insertSentSms(getContext(), to, text);

            // Emit event to JS for real-time logging in UI
            JSObject relayEvent = new JSObject();
            relayEvent.put("type", "sms");
            relayEvent.put("from", to);
            relayEvent.put("content", text);
            relayEvent.put("status", "sent");
            relayEvent.put("direction", "outbound");
            notifyListeners("relay_event", relayEvent);

            JSObject ret = new JSObject();
            ret.put("sent", true);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("SMS failed to send: " + e.getMessage());
        }
    }

    @PluginMethod
    public void markSmsAsRead(PluginCall call) {
        String address = call.getString("address");
        if (address == null || address.isEmpty()) {
            call.reject("Address is required");
            return;
        }
        
        try {
            Uri uri = Uri.parse("content://sms/");
            android.content.ContentValues values = new android.content.ContentValues();
            values.put("read", 1);
            
            // Note: address in DB might not perfectly match provided address due to formatting,
            // but SMS provider handles basic matching. For exact matching, it's better to 
            // query by thread_id if available, but filtering by address and unread is a start.
            String selection = "address = ? AND read = 0";
            String[] selectionArgs = new String[] { address };
            
            int updatedRows = getContext().getContentResolver().update(uri, values, selection, selectionArgs);
            
            JSObject ret = new JSObject();
            ret.put("success", true);
            ret.put("updated", updatedRows);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Failed to mark SMS as read: " + e.getMessage());
        }
    }

    @PluginMethod
    public void getSmsHistory(PluginCall call) {
        long lastTimestamp = call.getLong("lastTimestamp", 0L);
        int limit = call.getInt("limit", 5000);
        JSArray messages = new JSArray();

        try {
            Uri uri = Uri.parse("content://sms/");
            String[] projection = new String[] { "_id", "address", "body", "date", "type", "read" };
            // Filter: only messages newer than lastTimestamp
            String selection = "date > ?";
            String[] selectionArgs = new String[] { String.valueOf(lastTimestamp) };
            // Sort newest first — do NOT put LIMIT here, it's not reliable on all Android versions
            String sortOrder = "date DESC";

            Cursor cursor = getContext().getContentResolver().query(
                uri, projection, selection, selectionArgs, sortOrder);

            if (cursor != null) {
                int count = 0;
                if (cursor.moveToFirst()) {
                    do {
                        JSObject msg = new JSObject();
                        msg.put("id", cursor.getString(cursor.getColumnIndexOrThrow("_id")));
                        msg.put("address", cursor.getString(cursor.getColumnIndexOrThrow("address")));
                        msg.put("body", cursor.getString(cursor.getColumnIndexOrThrow("body")));
                        msg.put("date", cursor.getLong(cursor.getColumnIndexOrThrow("date")));
                        int type = cursor.getInt(cursor.getColumnIndexOrThrow("type"));
                        int read = cursor.getInt(cursor.getColumnIndexOrThrow("read"));
                        // 1 = MESSAGE_TYPE_INBOX, 2 = MESSAGE_TYPE_SENT
                        msg.put("type", type == 1 ? "inbound" : "outbound");
                        msg.put("read", read == 1);
                        messages.put(msg);
                        count++;
                        if (count >= limit) break; // manual limit
                    } while (cursor.moveToNext());
                }
                cursor.close();
            }

            JSObject ret = new JSObject();
            ret.put("messages", messages);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Failed to fetch SMS history: " + e.getMessage());
        }
    }

    @PluginMethod
    public void syncHistory(PluginCall call) {
        int limit = call.getInt("limit", 500);
        long lookbackMs = call.getLong("lookbackMs", DEFAULT_SMS_SYNC_LOOKBACK_MS);
        Context context = getContext().getApplicationContext();

        new Thread(() -> {
            SmsSyncResult result = syncSmsHistoryNative(context, limit, lookbackMs);
            JSObject ret = new JSObject();
            ret.put("synced", result.synced);
            ret.put("failed", result.failed);
            ret.put("skipped", result.skipped);
            ret.put("lastSyncedAt", result.lastSyncedAt);
            call.resolve(ret);
        }).start();
    }

    static SmsSyncResult syncSmsHistoryNative(Context context, int limit, long fallbackLookbackMs) {
        SmsSyncResult result = new SmsSyncResult();
        if (context == null) return result;

        android.content.SharedPreferences prefs = securePrefs(context, PREFS_NAME);
        boolean isActive = prefs.getBoolean(KEY_IS_ACTIVE, false);
        String baseUrl = prefs.getString(KEY_BASE_URL, null);
        String deviceId = prefs.getString(KEY_DEVICE_ID, "RELAY-DEVICE");
        String installationId = prefs.getString(KEY_INSTALLATION_ID, null);

        if (!isActive || baseUrl == null || baseUrl.isEmpty()) {
            result.skipped++;
            return result;
        }

        long now = System.currentTimeMillis();
        long lastSyncAt = prefs.getLong(KEY_LAST_SMS_HISTORY_SYNC_AT, 0L);
        long lookback = fallbackLookbackMs > 0 ? fallbackLookbackMs : BACKGROUND_SMS_SYNC_LOOKBACK_MS;
        long since = lastSyncAt > 0 ? lastSyncAt : Math.max(0L, now - lookback);
        int maxRows = Math.max(1, Math.min(limit, 5000));

        PowerManager pm = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        PowerManager.WakeLock wakeLock = pm != null
            ? pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "NexusHub:SmsHistorySync")
            : null;
        if (wakeLock != null) {
            wakeLock.acquire(30_000L);
        }

        Cursor cursor = null;
        long lastSuccessfulDate = lastSyncAt;
        try {
            Uri uri = android.provider.Telephony.Sms.Inbox.CONTENT_URI;
            String[] projection = new String[] { "_id", "address", "body", "date" };
            String selection = "date > ?";
            String[] selectionArgs = new String[] { String.valueOf(since) };
            cursor = context.getContentResolver().query(
                uri,
                projection,
                selection,
                selectionArgs,
                "date ASC"
            );

            if (cursor == null) {
                result.skipped++;
                return result;
            }

            int count = 0;
            while (cursor.moveToNext() && count < maxRows) {
                count++;
                String address = cursor.getString(cursor.getColumnIndexOrThrow("address"));
                String body = cursor.getString(cursor.getColumnIndexOrThrow("body"));
                long date = cursor.getLong(cursor.getColumnIndexOrThrow("date"));

                if (address == null || address.isEmpty() || body == null || body.isEmpty()) {
                    result.skipped++;
                    continue;
                }

                boolean forwarded = forwardDataNativeBlocking(
                    context,
                    baseUrl,
                    deviceId,
                    installationId,
                    "sms",
                    address,
                    body,
                    date > 0 ? date : now
                );

                if (!forwarded) {
                    result.failed++;
                    break;
                }

                result.synced++;
                if (date > lastSuccessfulDate) {
                    lastSuccessfulDate = date;
                }
            }

            if (lastSuccessfulDate > lastSyncAt) {
                prefs.edit().putLong(KEY_LAST_SMS_HISTORY_SYNC_AT, lastSuccessfulDate).apply();
                result.lastSyncedAt = lastSuccessfulDate;
            } else {
                result.lastSyncedAt = lastSyncAt;
            }
        } catch (SecurityException e) {
            android.util.Log.w("NexusRelay", "syncSmsHistoryNative: missing SMS permission", e);
            result.failed++;
        } catch (Exception e) {
            android.util.Log.e("NexusRelay", "syncSmsHistoryNative: failed", e);
            result.failed++;
        } finally {
            if (cursor != null) {
                cursor.close();
            }
            if (wakeLock != null && wakeLock.isHeld()) {
                wakeLock.release();
            }
        }

        return result;
    }

    // ── Static send_sms entry point (called natively from NexusFcmService) ─────
    // Sends an SMS using data from a FCM data-only payload without needing
    // the JS / Capacitor layer to be running (works when screen is off / killed).
    public static void sendSmsFromData(Context context, java.util.Map<String, String> data) {
        if (context == null || data == null) return;

        // Only proceed if relay mode is active
        boolean isActive = securePrefs(context, PREFS_NAME)
            .getBoolean(KEY_IS_ACTIVE, false);
        if (!isActive) {
            android.util.Log.w("NexusRelay", "sendSmsFromData: relay not active, skipping");
            return;
        }

        String to        = data.get("to");
        String content   = data.get("content");
        String messageId = data.get("messageId");
        android.content.SharedPreferences prefs = securePrefs(context, PREFS_NAME);
        String baseUrl = prefs.getString(KEY_BASE_URL, null);
        String authToken = prefs.getString(KEY_AUTH_TOKEN, null);

        if (to == null || to.isEmpty() || content == null || content.isEmpty()) {
            android.util.Log.w("NexusRelay", "sendSmsFromData: missing to/content");
            return;
        }

        // Acquire WakeLock to keep CPU alive during send (screen-off safe)
        android.os.PowerManager pm = (android.os.PowerManager) context.getSystemService(Context.POWER_SERVICE);
        android.os.PowerManager.WakeLock wakeLock = pm.newWakeLock(
            android.os.PowerManager.PARTIAL_WAKE_LOCK, "NexusHub::FcmSmsWakeLock");
        wakeLock.acquire(20_000L); // max 20s

        String finalStatus = "failed";
        try {
            SmsManager smsManager;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                smsManager = context.getSystemService(SmsManager.class);
            } else {
                smsManager = SmsManager.getDefault();
            }
            if (smsManager == null) {
                android.util.Log.e("NexusRelay", "sendSmsFromData: SmsManager unavailable");
                finalStatus = "failed";
            } else {
                // Encoding-aware rozdělení (viz sendSms výše) — pevná hranice 160 by
                // ořízla unicode zprávu o 71–160 znacích (UCS-2 limit je 70/část).
                java.util.ArrayList<String> parts = smsManager.divideMessage(content);
                if (parts.size() > 1) {
                    smsManager.sendMultipartTextMessage(to, null, parts, null, null);
                } else {
                    smsManager.sendTextMessage(to, null, content, null, null);
                }

                // If we are the default SMS app, we must write sent messages to the provider
                insertSentSms(context, to, content);
                
                if (BuildConfig.DEBUG) { // příjemce SMS je PII — nelogovat v produkci
                    android.util.Log.d("NexusRelay", "sendSmsFromData: SMS sent to " + to);
                }
                finalStatus = "sent";
            }
        } catch (Exception e) {
            android.util.Log.e("NexusRelay", "sendSmsFromData: failed to send SMS", e);
            finalStatus = "failed";
        } finally {
            reportMessageStatusBlocking(context, baseUrl, messageId, finalStatus);
            if (wakeLock.isHeld()) wakeLock.release();
        }
    }

    private static void reportMessageStatusBlocking(Context context, String baseUrl, String messageId, String statusToReport) {
        if (messageId == null || messageId.isEmpty() || baseUrl == null) {
            return;
        }

        java.net.HttpURLConnection conn = null;
        try {
            final String apiBase = baseUrl.replaceAll("/api/device/relay$", "")
                                          .replaceAll("/api$", "");
            java.net.URL url = new java.net.URL(apiBase + "/api/messages/" + messageId + "/status");
            conn = (java.net.HttpURLConnection) url.openConnection();
            conn.setRequestMethod("PATCH");
            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            applyRelayCredentials(context, conn);
            conn.setDoOutput(true);
            conn.setConnectTimeout(8000);
            conn.setReadTimeout(8000);
            String body = "{\"status\":\"" + statusToReport + "\"}";
            try (java.io.OutputStream os = conn.getOutputStream()) {
                os.write(body.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            }
            int code = conn.getResponseCode();
            android.util.Log.d("NexusRelay", "sendSmsFromData: status reported (" + statusToReport + "), HTTP " + code);
        } catch (Exception ex) {
            android.util.Log.w("NexusRelay", "sendSmsFromData: failed to report status", ex);
        } finally {
            if (conn != null) {
                conn.disconnect();
            }
        }
    }

    /**
     * Přiloží k žádosti pověření zařízení a — je-li po ruce — i přihlášení
     * uživatele. Pořadí je záměrné: server dá přednost hlavičkám zařízení,
     * protože ty nevyprší. Bearer zůstává pro cesty, které zatím ověření
     * zařízení neumí.
     *
     * @return true, když se podařilo přiložit aspoň jedno pověření
     */
    static boolean applyRelayCredentials(Context context, java.net.HttpURLConnection conn) {
        android.content.SharedPreferences prefs = securePrefs(context, PREFS_NAME);
        String installationId = prefs.getString(KEY_INSTALLATION_ID, null);
        String deviceSecret = prefs.getString(KEY_DEVICE_SECRET, null);
        String authToken = prefs.getString(KEY_AUTH_TOKEN, null);

        boolean maZarizeni = installationId != null && !installationId.isEmpty()
            && deviceSecret != null && !deviceSecret.isEmpty();
        if (maZarizeni) {
            conn.setRequestProperty("X-Installation-Id", installationId);
            conn.setRequestProperty("X-Device-Secret", deviceSecret);
        }
        if (authToken != null && !authToken.isEmpty()) {
            conn.setRequestProperty("Authorization", "Bearer " + authToken);
            return true;
        }
        return maZarizeni;
    }

    static void insertSentSms(Context context, String to, String text) {
        try {
            android.content.ContentValues values = new android.content.ContentValues();
            values.put(android.provider.Telephony.Sms.ADDRESS, to);
            values.put(android.provider.Telephony.Sms.BODY, text);
            values.put(android.provider.Telephony.Sms.DATE, System.currentTimeMillis());
            values.put(android.provider.Telephony.Sms.TYPE, android.provider.Telephony.Sms.MESSAGE_TYPE_SENT);
            values.put(android.provider.Telephony.Sms.READ, 1);
            context.getContentResolver().insert(android.provider.Telephony.Sms.Sent.CONTENT_URI, values);
        } catch (Exception e) {
            android.util.Log.e("NexusRelay", "Failed to insert sent SMS into system provider", e);
        }
    }

    // ── Battery Optimization PluginMethods ───────────────────────────────
    @PluginMethod
    public void checkBatteryOptimization(PluginCall call) {
        JSObject ret = new JSObject();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
            boolean isIgnoring = pm != null && pm.isIgnoringBatteryOptimizations(getContext().getPackageName());
            ret.put("optimized", !isIgnoring);
        } else {
            ret.put("optimized", false);
        }
        call.resolve(ret);
    }

    @PluginMethod
    public void requestIgnoreBatteryOptimization(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            intent.setData(Uri.parse("package:" + getContext().getPackageName()));
            try {
                startActivityForResult(call, intent, "requestIgnoreBatteryOptimizationCallback");
            } catch (Exception e) {
                call.reject("Could not open battery optimization settings: " + e.getMessage());
            }
        } else {
            JSObject ret = new JSObject();
            ret.put("requested", false);
            call.resolve(ret);
        }
    }

    @PluginMethod
    public void openAppSettings(PluginCall call) {
        try {
            Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            intent.setData(Uri.parse("package:" + getContext().getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("Could not open app settings: " + e.getMessage());
        }
    }

    // ── Připravenost sledování polohy (onboarding) ───────────────────────
    //
    // Sledování polohy na pozadí spolehlivě běží jen když je splněno VÍC věcí najednou.
    // Systémový dialog pokryje jen část — „vždy" u polohy a autostart na MIUI apod. si
    // uživatel musí zapnout ručně v nastavení. Tohle vrátí stav všech podmínek, aby
    // průvodce v aplikaci uměl říct, co konkrétně ještě chybí (a neslibovat sledování,
    // které by ve skutečnosti neběželo).
    @PluginMethod
    public void checkTrackingReadiness(PluginCall call) {
        JSObject ret = new JSObject();
        Context ctx = getContext();

        boolean fine = ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_FINE_LOCATION)
            == PackageManager.PERMISSION_GRANTED;
        ret.put("fineLocation", fine);

        // ACCESS_BACKGROUND_LOCATION existuje až od Androidu 10; níž stačí fine.
        boolean background = Build.VERSION.SDK_INT < Build.VERSION_CODES.Q
            ? fine
            : ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_BACKGROUND_LOCATION)
                == PackageManager.PERMISSION_GRANTED;
        ret.put("backgroundLocation", background);

        // Foreground service potřebuje notifikaci (Android 13+ ji podmiňuje oprávněním).
        boolean notifications = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
            || ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED;
        ret.put("notifications", notifications);

        PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
        boolean batteryUnrestricted = Build.VERSION.SDK_INT < Build.VERSION_CODES.M
            || (pm != null && pm.isIgnoringBatteryOptimizations(ctx.getPackageName()));
        ret.put("batteryUnrestricted", batteryUnrestricted);

        ret.put("manufacturer", Build.MANUFACTURER == null ? "" : Build.MANUFACTURER);
        // Autostart je vlastnost některých OEM nadstaveb (MIUI, EMUI, ColorOS, FuntouchOS).
        // Jeho stav se z aplikace zjistit NEDÁ — umíme jen otevřít obrazovku a poprosit.
        ret.put("autostartSupported", resolveAutostartIntent() != null);

        call.resolve(ret);
    }

    // Obrazovka „autostart / spouštění na pozadí" se u každého OEM jmenuje jinak.
    // Vracíme první intent, který na tomhle zařízení skutečně existuje, jinak null.
    private Intent resolveAutostartIntent() {
        String[][] candidates = new String[][] {
            // Xiaomi / Redmi / POCO (MIUI, HyperOS)
            { "com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity" },
            // Huawei / Honor (EMUI)
            { "com.huawei.systemmanager", "com.huawei.systemmanager.startupmgr.ui.StartupNormalAppListActivity" },
            { "com.huawei.systemmanager", "com.huawei.systemmanager.optimize.process.ProtectActivity" },
            // Oppo / Realme (ColorOS)
            { "com.coloros.safecenter", "com.coloros.safecenter.permission.startup.StartupAppListActivity" },
            { "com.oppo.safe", "com.oppo.safe.permission.startup.StartupAppListActivity" },
            // Vivo (FuntouchOS / OriginOS)
            { "com.vivo.permissionmanager", "com.vivo.permissionmanager.activity.BgStartUpManagerActivity" },
            // Letv / OnePlus starší
            { "com.letv.android.letvsafe", "com.letv.android.letvsafe.AutobootManageActivity" },
        };
        PackageManager packageManager = getContext().getPackageManager();
        for (String[] c : candidates) {
            Intent intent = new Intent();
            intent.setComponent(new ComponentName(c[0], c[1]));
            if (intent.resolveActivity(packageManager) != null) {
                return intent;
            }
        }
        return null;
    }

    @PluginMethod
    public void openAutostartSettings(PluginCall call) {
        JSObject ret = new JSObject();
        Intent intent = resolveAutostartIntent();
        if (intent == null) {
            // Zařízení autostart nemá (čistý Android) — není co otevírat.
            ret.put("opened", false);
            call.resolve(ret);
            return;
        }
        try {
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            ret.put("opened", true);
            call.resolve(ret);
        } catch (Exception e) {
            android.util.Log.w("NexusRelay", "openAutostartSettings: " + e.getMessage());
            ret.put("opened", false);
            call.resolve(ret);
        }
    }

    @ActivityCallback
    private void requestIgnoreBatteryOptimizationCallback(PluginCall call, ActivityResult result) {
        JSObject ret = new JSObject();
        ret.put("requested", true);
        call.resolve(ret);
    }

    @ActivityCallback
    private void confirmDeviceCredentialCallback(PluginCall call, ActivityResult result) {
        JSObject ret = new JSObject();
        ret.put("available", true);
        ret.put("unlocked", result != null && result.getResultCode() == Activity.RESULT_OK);
        call.resolve(ret);
    }

    public static void onMessageReceived(Context context, String from, String body) {
        onMessageReceived(context, from, body, System.currentTimeMillis());
    }

    public static void onMessageReceived(Context context, String from, String body, long timestamp) {
        onTransportMessageReceived(context, "sms", from, body, null, timestamp);
    }

    public static void onSmsBroadcastReceived(final Context context, final String from, final String body, final long timestamp, final boolean persistToProvider, final Runnable completion) {
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    if (persistToProvider) {
                        insertInboxSmsIfMissing(context, from, body, timestamp);
                    }
                    onMessageReceivedBlocking(context, from, body, timestamp);
                } catch (Exception e) {
                    android.util.Log.e("NexusRelay", "SMS broadcast forward failed", e);
                } finally {
                    if (completion != null) {
                        completion.run();
                    }
                }
            }
        }).start();
    }

    public static boolean onMessageReceivedBlocking(Context context, String from, String body, long timestamp) {
        return onTransportMessageReceivedBlocking(context, "sms", from, body, null, timestamp);
    }

    public static void onRcsMessageReceived(Context context, String from, String body, String sourcePackage) {
        onTransportMessageReceived(context, "rcs", from, body, sourcePackage, System.currentTimeMillis());
    }

    private static void onTransportMessageReceived(Context context, String transport, String from, String body, String sourcePackage, long timestamp) {
        android.content.SharedPreferences prefs = securePrefs(context, PREFS_NAME);
        boolean isActive = prefs.getBoolean(KEY_IS_ACTIVE, false);
        String baseUrl = prefs.getString(KEY_BASE_URL, null);
        String deviceId = prefs.getString(KEY_DEVICE_ID, "RELAY-DEVICE");
        String installationId = prefs.getString(KEY_INSTALLATION_ID, null);

        String safeFrom = from != null ? from : "UNKNOWN";
        String safeBody = body != null ? body : "";
        String safeTransport = normalizeTransport(transport);

        if ("sms".equals(safeTransport)) {
            rememberRecentSmsBody(safeBody);
        }

        // 1. Notify JS (for UI logs if app is open)
        if (instance != null) {
            JSObject ret = new JSObject();
            ret.put("from", safeFrom);
            ret.put("body", safeBody);
            ret.put("transport", safeTransport);
            ret.put("type", safeTransport);
            if (sourcePackage != null) {
                ret.put("sourcePackage", sourcePackage);
            }
            instance.notifyListeners("onMessageReceived", ret, true);
            if ("rcs".equals(safeTransport)) {
                instance.notifyListeners("onRcsReceived", ret, true);
            } else {
                instance.notifyListeners("onSmsReceived", ret, true);
            }
        }

        // 2. Native Background Forwarding
        if (isActive && baseUrl != null) {
            forwardDataNative(context, baseUrl, deviceId, installationId, safeTransport, safeFrom, safeBody, timestamp);
        }
    }

    private static boolean onTransportMessageReceivedBlocking(Context context, String transport, String from, String body, String sourcePackage, long timestamp) {
        android.content.SharedPreferences prefs = securePrefs(context, PREFS_NAME);
        boolean isActive = prefs.getBoolean(KEY_IS_ACTIVE, false);
        String baseUrl = prefs.getString(KEY_BASE_URL, null);
        String deviceId = prefs.getString(KEY_DEVICE_ID, "RELAY-DEVICE");
        String installationId = prefs.getString(KEY_INSTALLATION_ID, null);

        String safeFrom = from != null ? from : "UNKNOWN";
        String safeBody = body != null ? body : "";
        String safeTransport = normalizeTransport(transport);

        if ("sms".equals(safeTransport)) {
            rememberRecentSmsBody(safeBody);
        }

        if (instance != null) {
            JSObject ret = new JSObject();
            ret.put("from", safeFrom);
            ret.put("body", safeBody);
            ret.put("transport", safeTransport);
            ret.put("type", safeTransport);
            if (sourcePackage != null) {
                ret.put("sourcePackage", sourcePackage);
            }
            instance.notifyListeners("onMessageReceived", ret, true);
            if ("rcs".equals(safeTransport)) {
                instance.notifyListeners("onRcsReceived", ret, true);
            } else {
                instance.notifyListeners("onSmsReceived", ret, true);
            }
        }

        if (!isActive || baseUrl == null) {
            return false;
        }

        boolean forwarded = forwardDataNativeBlocking(
            context,
            baseUrl,
            deviceId,
            installationId,
            safeTransport,
            safeFrom,
            safeBody,
            timestamp
        );

        if (forwarded && "sms".equals(safeTransport)) {
            long currentLastSync = prefs.getLong(KEY_LAST_SMS_HISTORY_SYNC_AT, 0L);
            if (timestamp > currentLastSync) {
                prefs.edit().putLong(KEY_LAST_SMS_HISTORY_SYNC_AT, timestamp).apply();
            }
        }

        return forwarded;
    }

    private static void insertInboxSmsIfMissing(Context context, String from, String body, long timestamp) {
        if (context == null || from == null || from.isEmpty() || body == null || body.isEmpty()) {
            return;
        }

        long messageDate = timestamp > 0 ? timestamp : System.currentTimeMillis();
        long windowStart = Math.max(0L, messageDate - 5000L);
        long windowEnd = messageDate + 5000L;
        Cursor cursor = null;

        try {
            String selection = android.provider.Telephony.Sms.ADDRESS + " = ? AND " +
                android.provider.Telephony.Sms.BODY + " = ? AND " +
                android.provider.Telephony.Sms.DATE + " >= ? AND " +
                android.provider.Telephony.Sms.DATE + " <= ?";
            String[] selectionArgs = new String[] {
                from,
                body,
                String.valueOf(windowStart),
                String.valueOf(windowEnd)
            };

            cursor = context.getContentResolver().query(
                android.provider.Telephony.Sms.Inbox.CONTENT_URI,
                new String[] { android.provider.Telephony.Sms._ID },
                selection,
                selectionArgs,
                null
            );

            if (cursor != null && cursor.moveToFirst()) {
                return;
            }

            android.content.ContentValues values = new android.content.ContentValues();
            values.put(android.provider.Telephony.Sms.ADDRESS, from);
            values.put(android.provider.Telephony.Sms.BODY, body);
            values.put(android.provider.Telephony.Sms.DATE, messageDate);
            values.put(android.provider.Telephony.Sms.TYPE, android.provider.Telephony.Sms.MESSAGE_TYPE_INBOX);
            values.put(android.provider.Telephony.Sms.READ, 0);
            values.put(android.provider.Telephony.Sms.SEEN, 0);
            context.getContentResolver().insert(android.provider.Telephony.Sms.Inbox.CONTENT_URI, values);
        } catch (Exception e) {
            android.util.Log.w("NexusRelay", "Failed to persist inbound SMS to provider", e);
        } finally {
            if (cursor != null) {
                cursor.close();
            }
        }
    }

    public static void onCallStateChanged(Context context, String from, String state) {
        // Ignore IDLE state – fired on listener registration and after call ends;
        // logging it would create phantom "call" entries when no call occurred.
        if (state == null || state.equals("IDLE")) {
            return;
        }
        
        // Prevent duplicate calls from Android 12+ TelephonyCallback which fires with null 'from'
        if (from == null || from.trim().isEmpty()) {
            return;
        }

        android.content.SharedPreferences prefs = securePrefs(context, PREFS_NAME);
        boolean isActive = prefs.getBoolean(KEY_IS_ACTIVE, false);
        String baseUrl = prefs.getString(KEY_BASE_URL, null);
        String deviceId = prefs.getString(KEY_DEVICE_ID, "RELAY-DEVICE");
        String installationId = prefs.getString(KEY_INSTALLATION_ID, null);

        // 1. Notify JS
        if (instance != null) {
            JSObject ret = new JSObject();
            ret.put("from", from);
            ret.put("state", state);
            instance.notifyListeners("onCallStateChanged", ret, true);
        }

        // 2. Native Background Forwarding
        if (isActive && baseUrl != null) {
            forwardDataNative(context, baseUrl, deviceId, installationId, "call", from, "State: " + state, System.currentTimeMillis());
        }
    }

    private static void forwardDataNative(final Context context, final String baseUrl, final String deviceId, final String installationId, final String type, final String from, final String content, final long timestamp) {
        // Acquire WakeLock to keep CPU alive during native forward (screen-off safe)
        android.os.PowerManager pm = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        final PowerManager.WakeLock wakeLock = pm != null
            ? pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "NexusHub:NativeForward")
            : null;
        if (wakeLock != null) {
            wakeLock.acquire(15_000L); // 15s max (HTTP timeout is 12s)
        }

        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    boolean forwarded = forwardDataNativeBlocking(
                        context,
                        baseUrl,
                        deviceId,
                        installationId,
                        type,
                        from,
                        content,
                        timestamp
                    );
                    if (forwarded && "sms".equals(normalizeTransport(type))) {
                        long currentLastSync = securePrefs(context, PREFS_NAME)
                            .getLong(KEY_LAST_SMS_HISTORY_SYNC_AT, 0L);
                        if (timestamp > currentLastSync) {
                            securePrefs(context, PREFS_NAME)
                                .edit()
                                .putLong(KEY_LAST_SMS_HISTORY_SYNC_AT, timestamp)
                                .apply();
                        }
                    }
                } catch (Exception e) {
                    android.util.Log.e("NexusRelay", "Native Forward Error", e);
                } finally {
                    if (wakeLock != null && wakeLock.isHeld()) {
                        wakeLock.release();
                    }
                }
            }
        }).start();
    }

    private static boolean forwardDataNativeBlocking(
        final Context context,
        final String baseUrl,
        final String deviceId,
        final String installationId,
        final String type,
        final String from,
        final String content,
        final long timestamp
    ) {
        java.net.HttpURLConnection conn = null;
        try {
            android.content.SharedPreferences prefs = securePrefs(context, PREFS_NAME);
            String profileId = prefs.getString(KEY_PROFILE_ID, null);
            String deviceSecret = prefs.getString(KEY_DEVICE_SECRET, null);
            String authToken = prefs.getString(KEY_AUTH_TOKEN, null);
            boolean maSecret = deviceSecret != null && !deviceSecret.isEmpty();
            if (!maSecret && (authToken == null || authToken.isEmpty())) {
                android.util.Log.w("NexusRelay", "Native Forward skipped: no credentials");
                return false;
            }

            java.net.URL url = new java.net.URL(baseUrl);
            conn = (java.net.HttpURLConnection) url.openConnection();
            conn.setRequestMethod("POST");
            conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
            conn.setRequestProperty("Accept", "application/json");
            if (authToken != null && !authToken.isEmpty()) {
                conn.setRequestProperty("Authorization", "Bearer " + authToken);
            }
            conn.setDoOutput(true);
            conn.setConnectTimeout(12000);
            conn.setReadTimeout(12000);

            org.json.JSONObject jsonParam = new org.json.JSONObject();
            jsonParam.put("deviceId", deviceId);
            if (installationId != null && !installationId.isEmpty()) {
                jsonParam.put("installationId", installationId);
            }
            if (profileId != null && !profileId.isEmpty()) {
                jsonParam.put("profileId", profileId);
            }
            // /device/relay čte pověření zařízení z těla, ne z hlavičky
            // (deviceController.handleRelay). Bez něj by příchozí SMS přestaly
            // chodit ve chvíli, kdy vyprší authToken — a přesně to se dělo.
            if (maSecret) {
                jsonParam.put("secret", deviceSecret);
            }
            jsonParam.put("transport", normalizeTransport(type));
            jsonParam.put("type", normalizeTransport(type));
            jsonParam.put("from", from);
            jsonParam.put("content", content);
            jsonParam.put("timestamp", formatIsoUtc(timestamp > 0 ? timestamp : System.currentTimeMillis()));

            try(java.io.OutputStream os = conn.getOutputStream()) {
                byte[] input = jsonParam.toString().getBytes(StandardCharsets.UTF_8);
                os.write(input, 0, input.length);
            }

            int code = conn.getResponseCode();
            android.util.Log.d("NexusRelay", "Native Forward Response Code: " + code);
            if (code >= 400) {
                java.io.InputStream errorStream = conn.getErrorStream();
                if (errorStream != null) {
                    java.io.BufferedReader reader = new java.io.BufferedReader(new java.io.InputStreamReader(errorStream, StandardCharsets.UTF_8));
                    StringBuilder responseBuilder = new StringBuilder();
                    String line;
                    while ((line = reader.readLine()) != null) {
                        responseBuilder.append(line);
                    }
                    reader.close();
                    android.util.Log.e("NexusRelay", "Native Forward Error Body: " + responseBuilder);
                }
                return false;
            }
            return true;
        } catch (Exception e) {
            android.util.Log.e("NexusRelay", "Native Forward Error", e);
            return false;
        } finally {
            if (conn != null) {
                conn.disconnect();
            }
        }
    }

    private static String formatIsoUtc(long timestamp) {
        java.text.SimpleDateFormat format = new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.US);
        format.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
        return format.format(new java.util.Date(timestamp));
    }

    public static void onFcmTokenRefreshed(String token) {
        if (instance == null) return;
        JSObject ret = new JSObject();
        ret.put("token", token);
        instance.notifyListeners("onFcmTokenRefreshed", ret, true);
    }

    static String toCallStateString(int state) {
        if (state == TelephonyManager.CALL_STATE_RINGING) return "RINGING";
        if (state == TelephonyManager.CALL_STATE_OFFHOOK) return "OFFHOOK";
        return "IDLE";
    }

    private static String normalizeTransport(String transport) {
        if ("call".equals(transport) || "rcs".equals(transport)) {
            return transport;
        }
        return "sms";
    }

    static boolean isRcsPackageSupported(String packageName) {
        if (packageName == null) {
            return false;
        }
        for (String supportedPackage : SUPPORTED_RCS_PACKAGES) {
            if (supportedPackage.equals(packageName)) {
                return true;
            }
        }
        return false;
    }

    static boolean isNotificationListenerEnabled(Context context) {
        if (context == null) {
            return false;
        }
        String enabledListeners = Settings.Secure.getString(context.getContentResolver(), "enabled_notification_listeners");
        if (enabledListeners == null || enabledListeners.isEmpty()) {
            return false;
        }
        ComponentName componentName = new ComponentName(context, NexusRcsNotificationListenerService.class);
        String flatName = componentName.flattenToString();
        String shortName = componentName.flattenToShortString();
        return enabledListeners.contains(flatName) || enabledListeners.contains(shortName);
    }

    static boolean wasRecentlyCapturedViaSms(String body) {
        String normalizedBody = normalizeBodyFingerprint(body);
        if (normalizedBody.isEmpty()) {
            return false;
        }
        synchronized (NexusRelayPlugin.class) {
            return normalizedBody.equals(lastSmsBody) && (System.currentTimeMillis() - lastSmsBodyAt) < SMS_DEDUP_WINDOW_MS;
        }
    }

    private static void rememberRecentSmsBody(String body) {
        String normalizedBody = normalizeBodyFingerprint(body);
        if (normalizedBody.isEmpty()) {
            return;
        }
        synchronized (NexusRelayPlugin.class) {
            lastSmsBody = normalizedBody;
            lastSmsBodyAt = System.currentTimeMillis();
        }
    }

    private static String normalizeBodyFingerprint(String body) {
        return body == null ? "" : body.trim();
    }

    private boolean isRelayActiveInPrefs() {
        return securePrefs(getContext(), PREFS_NAME).getBoolean(KEY_IS_ACTIVE, false);
    }

    static class SmsSyncResult {
        int synced = 0;
        int failed = 0;
        int skipped = 0;
        long lastSyncedAt = 0L;
    }

    @RequiresApi(Build.VERSION_CODES.S)
    private static class NexusCallStateCallback extends TelephonyCallback implements TelephonyCallback.CallStateListener {
        @Override
        public void onCallStateChanged(int state) {
            NexusRelayPlugin plugin = NexusRelayPlugin.instance;
            if (plugin == null) {
                return;
            }
            NexusRelayPlugin.onCallStateChanged(plugin.getContext(), null, NexusRelayPlugin.toCallStateString(state));
        }
    }
}
