# Relay: kudy chodí hovory a kudy SMS

Dvě aplikace, dvě role. `nexusFull` (`com.nexushub.app`, „Nexus Hub") je
aplikace pro lidi; `nexusRelay` (`com.nexushub.relay`, „Nexus Relay") je
zařízení se SIM, které nikdo neobsluhuje.

**Hovory jdou přes SIP. SMS přes relay.** Operátorka čte i odpovídá ve webové
aplikaci.

## SMS

### Příchozí (klient → agentura)

Běží **nativně, nezávisle na WebView** — funguje i když je appka zabitá:

1. `NexusSmsReceiver` zachytí `SMS_RECEIVED` / `SMS_DELIVER`, vezme si 30s
   wake lock a `goAsync()`
2. `NexusRelayPlugin.onTransportMessageReceived` pošle HTTP POST na server
   podle uložených předvoleb (baseUrl, deviceId, installationId)
3. Server zprávu uloží a rozešle operátorkám přes Socket.IO (`sms:incoming`)
4. Plná aplikace ji ukáže ve schránce

Aktivuje to příznak `KEY_IS_ACTIVE`, který nastaví `configureRelay`
z obrazovky `RelayApp` / `RelayMode`.

### Odchozí (operátorka → klient)

Push, ne polling:

1. Operátorka odešle ve webu → `messageController` uloží a **hned** vyšle
   přes Socket.IO `relay_command` (typ `send_sms`) — v kódu označené jako
   *„faster than push"*
2. Když relay není připojený, jde FCM push `send_sms`, který
   `NexusFcmService` provede nativně i při zabité aplikaci
   (`sendSmsFromData`)
3. Relay pošle přes `SmsManager.sendTextMessage` (delší přes
   `sendMultipartTextMessage`) z vlastní SIM
4. Výsledek nahlásí `PATCH /api/messages/{id}/status`

`NexusRelayForegroundService` navíc každých 30 s stahuje
`GET /api/messages/outbox?profileId=…&installationId=…`. To je **záchranná
síť** pro zprávy, které minuly socket i push — ne hlavní cesta.

## Hovory

### SIP (to používáme)

`NexusSipPlugin` registruje relay proti Asterisku. Credentials si vyzvedne
z `GET /api/sip/config`, který koncový bod v případě potřeby **rovnou
zřídí** a spustí regeneraci konfigurace.

Serverová strana je hotová: `asteriskConfigGenerator` skládá z databáze
`pjsip.conf` (transporty udp/tcp/ws/wss, koncové body pro relay i
operátorky, registrace trunku, `identify`) a `extensions.conf`, zazálohuje
původní soubory, nasadí je přes SSH a udělá `pjsip reload` +
`dialplan reload`. Ruční spuštění: `POST /api/sip/reload-asterisk`.

Podklady pro server jsou v [docs/asterisk/](asterisk/) — `setup.sh`,
`pjsip.conf`, `extensions.conf`.

### Odchozí (operátorka → klient)

Operátorka volá **za profil**: klient uvidí číslo modelky, ne číslo agentury.
Vytáčí se `<DID>*<číslo klienta>`, prefix vybírá zobrazené číslo.

```
exten => _+420777111222*X.,1,NoOp(Odchozí hovor, klient uvidí +420777111222)
 same => n,Set(CALLERID(num)=+420777111222)
 same => n,Dial(PJSIP/${EXTEN:14}@trunk_trunkA,60,rT)
```

**Číslo volajícího skládá server, ne prohlížeč.** Pravidlo vznikne jen pro
DID, které je v databázi (`loadSipDataFromDB` filtruje na `active`
a přiřazený profil); cokoli jiného propadne na `_X.` a hovor se položí.
Kdyby si caller ID vybíral klient, dalo by se volat pod cizím číslem.
DID a trunk drží pohromadě, takže číslo agentury A neodejde trunkem B.

Cíl se generuje ve dvou podobách — `*X.` a `*+X.`. `X` je v Asterisku jen
číslice, takže samotné `*X.` by číslo v E.164 s plusem nechytilo.

**Hovor se ZÁMĚRNĚ nenahrává.** Žádný `MixMonitor`. Hlídá to test, protože
zapnutí by mělo důsledky i pro stránku o evidenci údajů.

V prohlížeči to obsluhuje `startCall` z kontextu → `useOperatorSip.startCall`
→ `ua.call()`. Seznam čísel chodí z `GET /api/sip/dids` (jen vlastní
agentura). Když se seznam nenačte, tlačítko volání ve schránce je nedostupné
— radši nezavolat než zavolat pod cizím číslem.

### GSM most (výchozí VYPNUTÝ)

`NexusInCallService` umí udělat z telefonu výchozí vytáčeč a přemostit
skutečný GSM hovor do WebRTC (`/api/device/webrtc/offer`, `/ice`,
operátorka odpoví přes `useOperatorWebRTC`).

**Nepoužíváme ho a od 5. 8. 2026 je výchozí vypnutý** (`build.gradle`,
`ENABLE_GSM_CALL_BRIDGE`). Tři důvody:

1. **Soupeří se SIP** o tytéž příchozí hovory.
2. **Chce roli výchozího vytáčeče** — nápadné oprávnění pro funkci, která
   se nepoužije.
3. **Dodá rozbitý hovor.** Bridge je jednosměrný: do WebRTC jde jen
   mikrofon telefonu. Hlas volajícího (downlink) vyžaduje
   `AudioSource.VOICE_CALL` a oprávnění `CAPTURE_AUDIO_OUTPUT`
   (`signature|privileged`), které na běžném telefonu získat nejde.
   Obejít se to dá akustickou smyčkou přes hlasitý odposlech, ale za cenu
   echa a zpětné vazby — proto to zapnuté není.

Zapnout pro pokusy:

```
ENABLE_GSM_CALL_BRIDGE=true
```

v `local.properties` nebo jako proměnnou prostředí. Manifest tím hradlí
**jen** `NexusInCallService`; fantomové hovory (`NexusGhostCallActivity`)
na něm nezávisí, ty jedou přes FCM a full-screen intent.

## Kde má Asterisk běžet, a proč ne hostovaná služba

**Pro pilot to řešit nemusíš.** `docs/pilot-readiness-checklist.md` nezmiňuje SIP,
hovory ani Asterisk ani jednou; brána 5 je celá o SMS, a ty na hovorech nezávisí.
Tahle sekce existuje proto, aby se rozhodnutí nemuselo hledat znovu, až hovory
na řadu přijdou.

### Stav k 3. 11. 2026

Na novém serveru Asterisk **není** — běží tam jen backend, PostgreSQL a nginx.
`SipManager.jsx` proto padá na zapsané `wss://nexus-api.myvnc.com:8089/ws`, což je
zaniklý server. `VITE_SIP_WS_URL` se záměrně nenastavuje, dokud Asterisk někde
nepoběží: klient by jinak otvíral spojení na port, kde nic neposlouchá, a vypadalo
by to jako chyba aplikace místo chybějící služby. Postup zprovoznění je
v `docs/novy-server-runbook.md`, oddíl 10.

### Rozhodnutí: vlastní Asterisk, ne hostovaná CPaaS

Klient je na Asterisk **nevázaný** — `useOperatorSip` používá JsSIP a potřebuje jen
`{ wsUrl, username, password }`. Technicky by tedy fungovala i hostovaná služba
(Twilio, Vonage a podobně) bez zásahu do klienta; navázaný je server, kde
`asteriskConfigGenerator` skládá konfiguraci a nasazuje ji přes SSH.

Přesto volíme vlastní Asterisk, a to kvůli kontrole nad hovory:

- média netečou přes servery třetí strany,
- nikdo cizí neuchovává metadata o tom, kdo komu volal a jak dlouho,
- zůstáváme **správcem** místo vztahu se zpracovatelem — a u amerického
  poskytovatele i mimo otázku přenosu údajů mimo EU, viz
  `docs/zpracovani-osobnich-udaju.md`.

### Co tím ale NEZÍSKÁME, ať to nikdo nečeká

**Hovor na veřejné číslo prochází telekomunikačním operátorem vždy.** Kontext
`[from-trunk]` v `docs/asterisk/extensions.conf` to ukazuje: s externím SIP trunkem
se počítá. Operátor podléhá povinnostem ohledně zákonných odposlechů ve své
jurisdikci, a vlastní hosting to nemění — odstraňuje jednu firmu v cestě, ne
operátora.

„Hovor, který nikdo nemůže odposlechnout" u veřejné telefonie zajistit nelze.
Operátora nepotkají jen hovory v rámci aplikace (operátorka ↔ operátorka přes
WebRTC), ty projdou pouze naším Asteriskem.

Co hraje v náš prospěch: **hovory se nenahrávají.** Je to vědomé rozhodnutí
zapsané v `asteriskConfigGenerator.js` („ZÁMĚRNĚ SE NENAHRÁVÁ: žádný MixMonitor")
a z hlediska soukromí je to větší páka než volba hostingu. Hostovaný poskytovatel
by technickou schopnost nahrávat měl, i kdybychom si ji nevyžádali.

### Na samostatný stroj, ne vedle backendu

`asteriskConfigGenerator` nahrává konfiguraci **přes SSH na `VPS_SSH_HOST`**, takže
je na vzdálený Asterisk napsaný. Na stejném stroji jako backend by se server
připojoval sám k sobě. Samostatný stroj navíc řeší paměť: Asterisk vedle Node
a PostgreSQL na 952 MB současného micro je optimistický, zvlášť u WebRTC.

### Co opravit, než se Asterisk někam přestěhuje

`SipManager.jsx` bere přihlašovací údaje z `GET /api/sip/config`, ale **adresu
WebSocketu ze zapečené `VITE_SIP_WS_URL`**. Server přitom port už zná
(`ASTERISK_WS_PORT`). Dokud to tak je, znamená každé přestěhování Asterisku novou
APK — tedy obcházení telefonů. Kdyby `wsUrl` vracelo API spolu s údaji, stačila by
změna na serveru. Je to tatáž past jako u `VITE_API_URL`, viz #146.

## Na co si dát pozor

`__APP_VARIANT__` je konstanta dosazená Vitem při buildu — dosazuje se
**holý identifikátor**. Zápis `window.__APP_VARIANT__` Vite nenahradí
a nikdo ho za běhu nenastavuje, takže vyjde vždycky `'full'`. Přesně tohle
se stalo v `NexusSms.js` a relay se kvůli tomu chovala jako plná aplikace:
nevyskakovalo okno příchozí SMS a odpověď z něj šla přes API serveru místo
přes SIM. Správný zápis je `typeof __APP_VARIANT__ !== 'undefined'`.
