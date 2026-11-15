# Živý test dvou telefonů (brána 5)

Tohle je postup pro **bránu 5** z `docs/pilot-readiness-checklist.md` — jediná
brána pilotu, kterou nejde zavřít z počítače. Potřebuje dva fyzické telefony,
SIM kartu a člověka, který SMS opravdu pošle.

Doplňuje `docs/android-relay-field-test.md` (tam jsou podrobné testy 1–7
a logcat). Tenhle dokument k nim přidává to, co v nich chybělo: **jak si po
každém kroku ověřit, co doopravdy leží v databázi**, a ne jen co je vidět ve webu.

## Co potřebujete

| | |
| --- | --- |
| **Telefon A — relay** | se SIM kartou, nainstalovaná **Nexus Relay** (`com.nexushub.relay`) |
| **Telefon B — volající** | jakýkoli telefon, ze kterého jdou poslat SMS na číslo telefonu A |
| **Účet modelky** | `testovaci.profil.a@nexusstack.eu` — jím se přihlásí telefon A |
| **Účet operátorky** | `test-op1@nexusstack.eu` — jím se ve webu píšou odpovědi |
| **Prohlížeč** | web aplikace, přihlášená jako operátorka |

Hesla k těmhle účtům má vlastník projektu. **Přihlašuje vždy člověk**, ne
automat ani asistent.

## Kontrola, kterou spouštíte po každém kroku

`Kontrola relay telefonu` ve GitHub Actions (`workflow_dispatch`). Jde na server
**jen pro čtení** — spojení má `default_transaction_read_only=on`, takže zápis
odmítne sama databáze. Můžete ji pouštět opakovaně a kdykoli.

```bash
gh workflow run kontrola-relay-telefonu.yml -f profil="Testovaci profil A" -f okno_min=10 -f cekano_sms=10
```

Nebo v Actions → *Kontrola relay telefonu* → *Run workflow*.

Co vypíše:

- jestli má profil **vlastní účet vlastníka** (ne účet operátorky),
- kolik je **přiřazených operátorek** (bez nich chat nikdo neuvidí),
- **vazby zařízení** zvlášť pro `relay` a `full` včetně stáří `lastSeenAt`,
- **kolik příchozích SMS** se uložilo v okně a kolik z nich má **dvojníka**,
- kolik odchozích zpráv **uvízlo v `pending_relay`** déle než 2 minuty.

Výstup je **veřejný** (repozitář je veřejný), proto obsahuje jen počty a
verdikty — žádná čísla, texty zpráv ani e-maily. Konkrétní zprávu si
prohlédněte v dashboardu.

## Postup

### 0. Telefon A má správnou a aktuální aplikaci

Verze na serveru: `curl -s https://api.nexusstack.eu/api/vultr/apk-info`.
Číslo musí odpovídat tomu, co je v telefonu:

```bash
adb shell pm list packages | grep nexushub
adb shell dumpsys package com.nexushub.relay | grep -E 'versionName|versionCode'
adb shell cmd role holders android.app.role.SMS
```

Třetí příkaz **musí vypsat `com.nexushub.relay`**. Když vypíše něco jiného,
relay SMS vůbec nedostane a zbytek testu nemá smysl.

**Potřebujete alespoň `3.155-b1074`.** Starší APK nemá obnovu tokenu z #193 —
relay po hodině tiše přestane mít živé spojení (SMS by pořád chodily přes
`deviceSecret`, ale krok 8 níž by selhal).

### 1. Párování

Na telefonu A se přihlaste jako **účet modelky**, vyberte profil a zapněte
relay režim. Pak:

```bash
gh workflow run kontrola-relay-telefonu.yml -f profil="Testovaci profil A" -f okno_min=10 -f cekano_sms=0
```

Čeká se: `✓ profil má vlastní účet vlastníka`, `přiřazených operátorek: 1`
a v tabulce vazeb řádek `relay | t | 1` se stářím `lastSeenAt` v sekundách.

**Když role vlastníka ukazuje na operátorku**, zastavte se tady — je to ta
vada, kterou řešily #184 a #185, a bez vlastnictví se sledování polohy
i audit připíšou nesprávnému člověku.

### 2. Deset příchozích SMS

Z telefonu B pošlete **10 SMS s rozlišitelným textem** — `zkouska 1/10`,
`zkouska 2/10`, … Obrazovku telefonu A nechte zapnutou.

> Texty musí být různé. Kontrola hlásí duplicitu podle shodného textu ve
> dvouminutovém okně, takže deset stejných zpráv by se tvářilo jako chyba
> fallbacku.

```bash
gh workflow run kontrola-relay-telefonu.yml -f profil="Testovaci profil A" -f okno_min=15 -f cekano_sms=10
```

Čeká se: `✓ dorazilo přesně 10/10` a `zpráv, které mají dvojníka: 0`.

Ve webu jako operátorka zkontrolujte, že chat vidíte a že u čísla je správný
profil.

### 3. Dosynchronizování po výpadku

1. Na telefonu A vypněte data i Wi-Fi (letadlo stačí, SMS musí chodit).
2. Z telefonu B pošlete **3 SMS** s dalšími rozlišitelnými texty.
3. Počkejte, až je uvidíte v systémové SMS aplikaci telefonu A.
4. Zapněte data a počkejte **alespoň 60 s**.

```bash
gh workflow run kontrola-relay-telefonu.yml -f profil="Testovaci profil A" -f okno_min=15 -f cekano_sms=3
```

Čeká se `3/3` a **nula dvojníků** — zpráva, která prošla broadcastem i
fallbackem, se nesmí uložit dvakrát.

### 4. Zamčená obrazovka

Telefon A zamkněte, počkejte 5 minut, pošlete jednu SMS a **neodemykejte**
dalších 60 s. Pak kontrola s `cekano_sms=1`.

### 5. Po restartu telefonu

Telefon A restartujte, nechte ho 2 minuty zamčený, pošlete jednu SMS.
Kontrola s `cekano_sms=1`. Aplikaci **neotvírejte** — o to v tomhle kroku jde.

Když SMS nedorazí, viník je nejčastěji OEM autostart (Xiaomi, Samsung, Oppo,
Vivo). Zapište si model telefonu a povolte autostart / neomezenou baterii.

### 6. Pět odpovědí z webu

Jako operátorka pošlete v chatu **5 odpovědí**. Musí odejít ze SIM telefonu A.

```bash
gh workflow run kontrola-relay-telefonu.yml -f profil="Testovaci profil A" -f okno_min=15 -f cekano_sms=0
```

Čeká se `v pending_relay déle než 2 min: 0`. Cokoli jiného je no-go z brány 5.

### 7. Spárování plné aplikace nesmí vypnout relay

Na **druhém** telefonu (nebo na telefonu A jako druhá aplikace) spárujte
**Nexus Hub** (`com.nexushub.app`) na tentýž profil. Pak kontrola.

Čeká se, že v tabulce vazeb budou **oba řádky aktivní** — `relay | t` i
`full | t`. Do #188 si obě vazby přehazovaly jednu jedinou aktivní vazbu
profilu, takže spárování plné aplikace relay umlčelo.

Hned po tom pošlete ještě jednu SMS z telefonu B a ověřte `cekano_sms=1`.
Tabulka vazeb sama neprokáže, že relay pořád doopravdy přijímá.

### 8. Obnova tokenu (potřebuje hodinu)

Nechte telefon A s běžící aplikací **víc než hodinu** (`ACCESS_TOKEN_EXPIRY`
je `1h`). Pak v logu:

```bash
adb logcat -d | grep -i "Token obnoven\|Relay"
```

Čeká se `[Relay] Token obnoven`. Potom pošlete SMS a ověřte, že dorazila.

Bez #193 se relay po hodině tiše odřízl od živého spojení. **Pozor na to, co
tenhle krok neprokáže:** příchozí SMS chodí přes `deviceSecret`, takže by
dorazily i s prošlým tokenem. Co padá bez obnovy, je socket a `/device/verify`
— tedy okamžité odpovědi z webu, ne příjem.

## Kdy je brána 5 zavřená

Všechny kroky 1–8 prošly a kontrola skončila `✅` **po každém z nich**. Jeden
zelený běh na konci nestačí: kroky 3, 4, 5 a 7 se navzájem nezastupují, každý
zkouší jinou cestu, po které se SMS může ztratit.

## Co tenhle postup neověří

- **Víc telefonů najednou.** Testuje se jedna modelka a jedna SIM.
- **Hovory.** Jdou přes SIP, ne přes relay (`docs/relay-hovory-a-sms.md`).
- **Dlouhý provoz.** Hodina na krok 8 je minimum, ne důkaz o stabilitě za dny.
- **Cizí operátor.** Doručování SMS se mezi operátory liší.
