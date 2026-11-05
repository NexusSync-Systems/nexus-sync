# Jak nepřijít o server

O jeden produkční server jsme 3. 11. 2026 přišli a s ním o celou databázi.
Tenhle dokument je o tom, aby se to nestalo znovu — a hlavně o tom, co **není**
zařízené, protože to je ta část, která se zapomíná.

Stav k 5. 11. 2026.

## 1. Čím se o ten server dá přijít

### Zabavení za nečinnost — měřitelné a reálné

Backend běží na Oracle Cloud **Always Free** instanci. Podle dokumentace Oracle
je instance nečinná, když za 7 dní platí **všechny** tyhle podmínky zároveň:

> * CPU utilization for the 95th percentile is less than 20%
> * Network utilization is less than 20%
> * Memory utilization is less than 20% *(jen ARM shapes)*

— [Always Free Resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)

Stačí tedy prolomit **jednu** podmínku. Síť by znamenala držet trvale ~96 Mbps
(20 % z 0,48 Gbps), což je nesmysl. CPU je jediná dosažitelná.

Jak na tom server byl, než se s tím něco udělalo (změřeno 5. 11. 2026 ze
`sysstat` za tři dny, 261 vzorků):

| | |
| --- | --- |
| průměr | 0,79 % |
| medián | 0,37 % |
| **95. percentil** | **2,22 %** |
| maximum | 18,12 % |
| mez Oracle | 20,00 % |

Devětkrát pod mezí. Ten server nebyl „spíš nevytížený" — splňoval kritérium
nečinnosti s velkou rezervou.

**Dokumentace neříká, jestli se instance zastaví, nebo smaže.** Komunita tvrdí,
že se zastaví a dá se nastartovat, pokud je shape v regionu dostupný. Na to se
nedá sázet ze dvou důvodů: Oracle to nikde nepíše, a `VM.Standard.A1.Flex` ve
Frankfurtu dlouhodobě hlásí „Out of host capacity" (48 pokusů 3. 11. 2026
neuspělo), takže „dostupný shape" není samozřejmost.

### Co ještě

- **Oracle si vyhrazuje právo** Always Free zdroje odebrat. Always Free není
  smlouva. Je to vědomý kompromis, ne trvalé řešení.
- **Chyba v nasazení.** Rsync s `--delete` by při neúplném balíčku setřel
  běžící aplikaci. Pojistka v `deploy-backend` to kontroluje (viz `ci.yml`).
- **Plný disk.** Zastaví zálohy i zápis logů a pozná se to až tím, že něco
  přestane fungovat. Hlídá hlídka.
- **Vypršelý certifikát.** `certbot.timer` je aktivní, platnost do 1. 2. 2027.
  Hlídá hlídka.

## 2. Co je zařízené

### Údržba instance proti zabavení

`server/scripts/server-cron/udrzuj-instanci.sh`, cron `/etc/cron.d/nexus-udrzba`.

Dvakrát za hodinu pět minut výpočetní zátěže na jednom vlákně ze dvou — během
běhu je vytížení instance ~50 %, dlouhodobě 16,7 % času nad mezí. Potřeba je
víc než 5 %, takže trojnásobná rezerva na vynechané běhy, rebooty a nasazení.

- `nice -n 19` — cokoli jiného má přednost, aplikace o CPU nepřijde. Na měřené
  vytížení to vliv nemá, procesor je vytížený bez ohledu na prioritu.
- Zátěž je čistě výpočetní (`/dev/zero` je v jádře) — nesahá na disk ani na síť
  a nealokuje paměť.
- **Vypínač:** `touch /etc/nexus-udrzba-vypnuto` zastaví zátěž okamžitě
  a nasazení ho nepřepíše.
- Instaluje ji **nasazení z CI**, ne člověk. Na server se nedá zapisovat jinak,
  a navíc se tím opatření samo obnoví po přestavbě stroje.

**Ověřování nečti ze `sar`.** Lokální `sysstat` vzorkuje po deseti minutách
a pětiminutovou zátěž zprůměruje na ~25 %, takže to vypadá těsně. Oracle měří
po minutě, kde je to ~50 %. Spolehlivý údaj je **počet úspěšných běhů**
v `/var/log/nexus-udrzba.log` — čeká se 48 za den. Tak to kontroluje i hlídka.

### Hlídka serveru

`.github/workflows/hlidka.yml`, každé dvě hodiny.

Tohle je ten **chybějící upozorňovací kanál**: cron na serveru nemá kam poslat
mail, takže selhání zálohy nebo spadlá aplikace by nikoho neoslovily. Když
hlídka selže, GitHub pošle mail o spadlém běhu naplánovaného workflow.

Co kontroluje:

| Kontrola | Selže, když |
| --- | --- |
| `/health` zvenčí | neodpoví 200, nebo databáze není připojená |
| certifikát | platnost pod 7 dní (varování pod 21) |
| pm2 | aplikace neběží |
| disk | nad 90 % (varování nad 80) |
| záloha | žádná, starší než 36 h, nebo chybí šifrovaná kopie |
| značky selhání | na serveru leží `SELHALO-*`, `ZALOHA-ZASTARALA`, `ZADNA-ZALOHA` |
| údržba instance | cron chybí, nebo proběhla méně než 40× za 24 h |

Na server **nic nezapisuje**, jen čte.

### Noční záloha

Běží a je ověřená — 3:17 UTC, šifrovaná kopie, kontrola věku v 9:05.
Podrobně `docs/database-backup-restore-runbook.md`.

## 3. Co zařízené NENÍ

### Odvoz zálohy ze serveru je ruční

Tohle je **největší zbývající riziko**. Zálohy leží na tomtéž stroji, o který
se bojíme. `bash scripts/odvez-zalohu.sh` je odveze na Mac, ale musí ho někdo
spustit.

**Proč to neodváží CI:** repozitář `Zdenekdi/nexus-sync` je **veřejný**
a artefakty i logy veřejného repozitáře jsou veřejně ke stažení. Šifrovaná
kopie produkční databáze v artefaktu by byla veřejně dostupná — šifrovaná sice,
ale natrvalo a pro kohokoli. To za pohodlí nestojí.

**Správné řešení: Oracle Object Storage.** Always Free zahrnuje 20 GB a je to
jiná služba než instance, takže ztrátu instance přežije. Dump má 130 kB.
Nastavit to chce OCI CLI a credentials na serveru — tedy něco, co musí udělat
člověk s přístupem k OCI konzoli.

#### Mezitím: denní odvoz na Mac přes launchd

Šablona je `scripts/launchd/eu.nexusstack.odvoz-zalohy.plist` — běží v 5:40
místního času, tedy po noční záloze. Když Mac v tu dobu spí, launchd úlohu
spustí po probuzení.

Instalace (nahradí cesty a zavede úlohu):

```bash
sed -e "s|__REPO__|$PWD|g" -e "s|__HOME__|$HOME|g" scripts/launchd/eu.nexusstack.odvoz-zalohy.plist > ~/Library/LaunchAgents/eu.nexusstack.odvoz-zalohy.plist && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/eu.nexusstack.odvoz-zalohy.plist && launchctl kickstart -p gui/$(id -u)/eu.nexusstack.odvoz-zalohy
```

Odinstalace:

```bash
launchctl bootout gui/$(id -u)/eu.nexusstack.odvoz-zalohy && rm ~/Library/LaunchAgents/eu.nexusstack.odvoz-zalohy.plist
```

Log je `~/Library/Logs/nexus-odvoz-zalohy.log`. **Dívat se do něj je jediný
způsob, jak poznat, že odvoz přestal fungovat** — launchd nikoho neupozorní
a hlídka v CI o tomhle Macu neví nic.

Ověření, že je zavedená: `launchctl print gui/$(id -u)/eu.nexusstack.odvoz-zalohy | head -5`

K ověřování archivu potřebuje skript heslo v `~/.nexus-zaloha-heslo` (mód 600),
jinak zálohu odveze, ale nahlas oznámí, že ji neověřil.

### Heslo k zálohám nemá potvrzenou kopii mimo server

Na serveru je v `/root/zaloha-heslo.txt`. Když o server přijdeme, odvezené
`.gpg` archivy **neotevře nikdo**. Záloha bez hesla uloženého jinde je stejně
nepoužitelná jako žádná.

K 5. 11. 2026 není potvrzené, že kopie existuje ve správci hesel.

### Na serveru není upozorňovací kanál

Hlídka v CI tu mezeru zalepuje zvenčí, ale sám server pořád nemá jak cokoli
oznámit — žádné SMTP, žádný Telegram. Kdyby přestala běžet i hlídka, nikdo
se nic nedozví.

### Naplánovaná workflow GitHub po 60 dnech vypne

Naplánovaná workflow se ve veřejném repozitáři **vypnou po 60 dnech bez
aktivity v repozitáři**. Pak hlídka tiše přestane hlídat — a „tiše" je tady to
podstatné slovo. Při aktivním vývoji to nehrozí; při pauze ano.

### Port 22 je otevřený do internetu

Uživatel je `ubuntu`, což je u Oracle Ubuntu výchozí a tedy uhodnutelné.
Přihlášení heslem je vypnuté, takže útok hrubou silou nemá na co, ale
`fail2ban` nainstalovaný není.

## 4. Když o server přijdeme

Postup přestavby je `docs/novy-server-runbook.md`. Pro obnovu dat je potřeba:

1. Odvezený `.gpg` archiv (viz výše — zatím ruční odvoz).
2. **Heslo k němu** (viz výše — kopie mimo server není potvrzená).
3. `docs/database-backup-restore-runbook.md`, oddíl o obnově.

Obnova je ověřená celá, ne jen vznik souboru: dump se 3. 11. 2026 obnovil do
dočasné databáze, 50 tabulek a počty řádků odpovídaly produkci.

## 5. Co by to zlepšilo, v tomhle pořadí

1. **Kopie hesla k zálohám do správce hesel.** Bez toho je celá kapitola
   o zálohách k ničemu. Minuta práce.
2. **Odvoz do Oracle Object Storage.** Zdarma v Always Free, přežije ztrátu
   instance, odpadne ruční krok.
3. **Zvážit Pay As You Go.** Komunita tvrdí, že PAYG účty se za nečinnost
   nezabavují. Always Free zdroje v PAYG účtu zůstávají bezplatné, ale je to
   platební metoda v systému a riziko omylem vzniklých poplatků — rozhodnutí,
   ne technikálie.
4. **`fail2ban`** na port 22.
5. **Upozorňovací kanál na serveru** (SMTP nebo Telegram), aby server neumlkl,
   když umlkne hlídka.
