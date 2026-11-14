# Android Relay field-test checklist

Tento checklist slouzi pro realne overeni Nexus Relay na fyzickem telefonu se SIM kartou. Cilem je poznat, jestli se prijata SMS ztratila v telefonu, pri forwardu na server, nebo az ve webovem rozhrani.

## Predpoklady

- Telefon ma aktivni SIM kartu, data nebo Wi-Fi a spravny cas.
- Je nainstalovana aktualni Nexus Relay APK.
- Telefon je sparovany s profilem pres `/api/device/verify`.
- V dashboardu je videt odpovidajici `installationId` a profil v `Nastaveni zarizeni`.
- Relay rezim je aktivni a stav serveru je `CONNECTED`.
- Aplikace ma povolene SMS, telefon, poloha, notifikace a spousteni na pozadi.
- Nexus Relay je nastavena jako vychozi SMS aplikace.
- Optimalizace baterie je vypnuta, u Xiaomi/Samsung/Oppo/Vivo take povolit autostart nebo unrestricted battery.
- Telefon je pripojeny k nabijecce.

## Rychly backend smoke test bez telefonu

Nez zacnete hledat problem v Androidu nebo SIM karte, overte, ze testovaci backend umi
sparovat Relay zarizeni a ulozit prijatou zpravu pres aktualni endpointy
`/api/device/verify` a `/api/device/relay`.

```bash
API_BASE=https://nexus-api.example.com/api \
DEVICE_SECRET=... \
PROFILE_PHONE=+420773227907 \
PROFILE_ID=profile-id-z-dashboardu \
MANAGER_EMAIL=alice@example.com \
MANAGER_PASSWORD=... \
npm run test:relay:live
```

Co skript overuje:

- login managera a cteni `/api/chats`;
- sparovani `installationId` pres `/api/device/verify`;
- prijem SMS pres `/api/device/relay` a dohledani ulozene zpravy v `/api/messages/:chatId`;
- varianty cisla s `+420`, `420`, `0` a lokalnim tvarem;
- call event pres `/api/device/relay`;
- zamitnuti spatneho `DEVICE_SECRET`;
- volitelne legacy endpointy `/api/device/mobile/*` a `/api/device/goip/sms`, pokud nejsou v produkci vypnute.

Pokud tento smoke test projde, backend prijem funguje a dalsi hledani smerujte na
telefon: default SMS role, permissions, foreground service, inbox fallback a logcat.
Pokud smoke test selze uz na `/api/device/verify` nebo `/api/device/relay`, problem
je v serverove konfiguraci, bindingu, `DEVICE_SECRET` nebo profilu.

## Doporucene logy

Pri testu sbirejte Android logcat:

```bash
adb logcat -v time NexusRelay:D NexusRelayService:D FirebaseMessaging:D AndroidRuntime:E '*:S'
```

### Pozor na balicek: relay NENI `com.nexushub.app`

Na relay telefonu je `com.nexushub.relay` („Nexus Relay"). `com.nexushub.app`
(„Nexus Hub") je plna aplikace pro lidi — viz `docs/relay-hovory-a-sms.md`.
Prikazy nize mely do 14. 11. 2026 napsany `com.nexushub.app`, takze na relay
telefonu vracely prazdny vystup a vypadalo to, jako ze opravneni chybi.
Overte si, co na telefonu doopravdy je:

```bash
adb shell pm list packages | grep nexushub
```

Pro overeni nainstalovane verze (cislo porovnejte s `GET /api/vultr/apk-info`):

```bash
adb shell dumpsys package com.nexushub.relay | grep -E 'versionName|versionCode'
```

Pro overeni, ze Android skutecne drzi Nexus Relay jako vychozi SMS aplikaci.
Prvni prikaz musi vypsat `com.nexushub.relay`; kdyz vypise systemovou SMS
aplikaci nebo `com.nexushub.app`, relay SMS nedostane a zadny dalsi test
nema smysl:

```bash
adb shell cmd role holders android.app.role.SMS
adb shell dumpsys package com.nexushub.relay | grep -E 'READ_SMS|RECEIVE_SMS|SEND_SMS|WRITE_SMS'
adb shell appops get com.nexushub.relay READ_SMS
```

Pro rychlou kontrolu, zda SMS lezi v systemovem SMS provideru telefonu:

```bash
adb shell content query --uri content://sms/inbox --projection address,body,date --sort "date DESC"
```

Pokud posledni SMS neni ani v `content://sms/inbox`, problem je pred Relay aplikaci
nebo v systemove SMS aplikaci/operatorovi. Pokud tam je, ale neni ve webu, resit
broadcast receiver, inbox fallback, auth token a odpoved `/api/device/relay`.

## Test 1: parovani zarizeni

1. Odhlaste a znovu prihlaste Relay aplikaci.
2. Vyberte profil/modelku, ke ktere telefon patri.
3. Zapnete Relay rezim.
4. V backendu nebo dashboardu overte aktivni DeviceBinding pro `installationId`.

Akceptace:

- `/api/device/verify` probehne bez chyby.
- Binding ma spravny `profileId`.
- Profil je online.
- Relay ulozi `authToken`, `profileId`, `installationId` a `baseUrl` do nativni konfigurace.

## Test 2: prijem SMS jako vychozi SMS aplikace

1. Z jineho telefonu poslete na Relay SIM unikatni text, napr. `Relay inbound 2026-07-09 10:15 A`.
2. Nechte obrazovku telefonu zapnutou.
3. Sledujte logcat.
4. Ve webu otevrite konverzaci daneho cisla.

Akceptace:

- V logu se objevi `NexusRelay` a `Native Forward Response Code: 200`.
- Web ukaze zpravu do 15 sekund.
- Chat je napojen na spravny profil.
- Zprava neni duplicitni.
- Cislo se sparuje i pri formatech `+420739777718`, `420739777718`, `0739777718` a `739777718`.

## Test 3: inbox fallback pri vypadku dat

1. Zapnete Relay.
2. Vypnete Wi-Fi/data na telefonu.
3. Poslete 3 SMS s unikatnim textem.
4. Pockejte, az se ulozi do systemove SMS aplikace.
5. Zapnete Wi-Fi/data.
6. Pockejte alespon 60 sekund.

Akceptace:

- Foreground service zavola `syncSmsHistoryNative`.
- V logu se objevi `SMS inbox fallback synced=...`.
- Vsechny 3 zpravy dorazi na server s puvodnim casem prijeti.
- Nevzniknou duplicity, pokud jedna ze zprav uz byla forwardovana pres broadcast.

## Test 4: screen-off a background prijem

1. Zapnete Relay a zamknete telefon.
2. Pockejte 5 minut.
3. Poslete SMS.
4. Neodemykejte telefon alespon 60 sekund.

Akceptace:

- SMS dorazi do webu bez otevreni aplikace.
- Foreground notification Nexus Relay je stale aktivni.
- Log neobsahuje `Native Forward skipped: missing auth token`.
- Baterie neni v rezimu, ktery ukoncuje foreground service.

## Test 5: reboot recovery

1. Zapnete Relay.
2. Restartujte telefon.
3. Po startu telefon nechte zamceny 2 minuty.
4. Poslete SMS.

Akceptace:

- `NexusBootReceiver` po startu obnovi foreground service, pokud byl Relay aktivni.
- SMS dorazi bez rucniho otevreni aplikace.
- Pokud OEM blokuje autostart, zaznamenejte model telefonu a nastavte autostart/unrestricted battery.

## Test 6: odchozi SMS z webu

1. Ve webu odpovezte v existujici konverzaci.
2. Sledujte, ze backend vytvori outbox zpravu pro profil.
3. Nechte telefon zamceny.
4. Sledujte logcat.

Akceptace:

- Telefon zpravu odesle pres `SmsManager`.
- Backend zmeni status zpravy na `sent`.
- Zprava se objevi v Android `Sent` provideru.
- Pri chybe se status zmeni na `failed`, nesmi zustat tise jako odeslano.

## Test 7: FCM data-only odeslani

1. Ujistete se, ze telefon zaregistroval FCM push token pres `/api/device/push-token`.
2. Poslete webovou odpoved v dobe, kdy je aplikace v pozadi.
3. Sledujte `NexusFcmService`.

Akceptace:

- `NexusFcmService` prijme data-only payload.
- `sendSmsFromData` pouzije WakeLock.
- Status se vrati na backend pres `/api/messages/{id}/status`.

## Test 8: chybejici opravneni

1. V Android nastaveni odeberte aplikaci `SMS` permission.
2. Poslete SMS.
3. Vratte permission.
4. Opakujte test.

Akceptace:

- Bez opravneni se chyba objevi v logu a zprava neni falesne oznacena jako dorucena na server.
- Po obnoveni opravneni funguje broadcast nebo inbox fallback.
- UI uzivatele upozorni, ze Relay monitoring neni plne aktivni.

## Test 9: hovory

1. Zavolejte na Relay SIM.
2. Nechte hovor pouze vyzvanet.
3. Zopakujte s prijetim a ukoncenim hovoru.

Akceptace:

- Server dostane stav `RINGING`.
- Nevznikaji fantomove `IDLE` udalosti.
- Pokud je cislo skryte nebo Android neposkytne caller ID, chovani se zaznamena jako limit telefonu/operatora.

## Test 10: dlouhodoby soak test

1. Nechte Relay bezet pres noc alespon 8 hodin.
2. Poslete rano 5 SMS za sebou.
3. Odeslete 5 odpovedi z webu.

Akceptace:

- Foreground service stale bezi.
- Zadna z 5 prichozich SMS nechybi.
- Zadna z 5 odchozich SMS nezustane pending dele nez 2 minuty.
- Web i server ukazuji stejne posledni zpravy.

## Klasifikace chyby

Telefon zpravu vidi, server ji nema:

- hledat `Native Forward Error`, HTTP 401/403/404/409 nebo `missing auth token`;
- zkontrolovat `installationId`, `profileId`, DeviceBinding a bearer token;
- overit, jestli inbox fallback pozdeji zpravu dosynchronizoval.
- overit, ze Nexus Relay je stale drzitelem role `android.app.role.SMS` a ma
  `READ_SMS`, `RECEIVE_SMS`, `SEND_SMS`, `WRITE_SMS` opravneni.

Server zpravu ma, web ji neukazuje:

- zkontrolovat normalizaci cisla a variants `+420`, `420`, `0`, bez predvolby;
- zkontrolovat filtr aktivniho profilu a aktualni mesic;
- overit WebSocket event `new_message` a rucni refresh konverzace.

Telefon zpravu nevidi:

- zkontrolovat, ze Nexus Relay je vychozi SMS aplikace;
- overit SIM, operatora, spam filtr a RCS;
- u RCS zapnout Notification Access, protoze RCS nemusi byt v SMS provideru.

## Pilot gate

Pred pilotnim provozem musi projit:

- 10/10 prijatych SMS z jednoho cisla bez ztraty a duplicit.
- 3/3 SMS dosynchronizovane po vypadku internetu.
- 5/5 odpovedi z webu odeslanych telefonem.
- 1 zprava prijata po zamceni obrazovky.
- 1 zprava prijata po restartu telefonu.
- 1 test hovoru s viditelnym cislem.
- Shoda posledni zpravy mezi Android SMS aplikaci, backendem a webem.

## Android limity

- Force stop aplikace v Android nastaveni muze vypnout broadcast receivery az do dalsiho rucniho otevreni aplikace.
- Nekteri vyrobci vyzaduji vlastni nastaveni autostartu mimo standardni Android battery optimization.
- Dual SIM muze menit vychozi SIM pro odesilani. Pri testu zapisujte SIM slot a vychozi SMS SIM.
- RCS neni spolehliva SMS. Zachytava se pres notifikace a zalezi na konkretni aplikaci pro zpravy.
