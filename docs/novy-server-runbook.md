# Postavení backendu na novém serveru

Postup pro případ, že produkční server neexistuje a staví se od nuly. Napsáno podle toho, co nasazovací úloha `deploy-backend` v `.github/workflows/ci.yml` od serveru skutečně vyžaduje — ne podle obecného návodu.

Vzor jednorázového nastavení je v `docs/testovaci-prostredi.md`; tady je produkční varianta a navíc věci, které s ztrátou serveru souvisí.

---

## 0. Nejdřív data, teprve pak server

**Než usoudíte, že jsou data pryč, zjistěte, kam se kopírovaly zálohy mimo server.**

`docs/database-backup-restore-runbook.md` kopii mimo server **vyžaduje**, a to dvakrát:

> Store backups off-host or in encrypted storage. A backup on the same VM is not disaster recovery.

> Copy at least one daily backup off the app server.

Příkladová cesta `/var/backups/nexus` v tom runbooku je jen lokální mezikrok, ne jediné místo, kde zálohy měly ležet. Takže není pravda, že se ztrátou serveru nutně zmizelo všechno — záleží na tom, jestli se to nastavené cílové místo opravdu používalo.

Projděte proto, co z toho platí:

- Byl nakonfigurovaný `rclone`, `scp` nebo jiný odvoz na druhý stroj či do objektového úložiště? Podívejte se, kam.
- Nemáte dump v e-mailu, ve svém počítači nebo na disku z nějakého dřívějšího ladění?
- Co říká `/var/log/nexus-db-backup.log`, pokud jeho kopii někde máte?

Až když se nic nenajde, platí, že záloha ležela jen na zaniklém stroji. Sekce 7 proto odvoz mimo server řeší jako první věc, ne jako poslední.

### Výsledek hledání v listopadu 2026 — ať to nikdo nedělá podruhé

Odvoz mimo server **nastavený byl**: `Google Drive / My Drive / Nexus_Backups`. Ležely v něm tři soubory z 18., 19. a 20. března 2026, každý 2,1 kB.

Použitelné nebyly a stojí za to vědět proč:

- obsahovaly `root/nexus-sync/server/prisma/dev.db`, tedy **vývojovou SQLite databázi**, ne produkční Postgres;
- ve všech třech byl **tentýž nezměněný soubor z 15. 3. 2026 11:23** o 53 248 B. Úloha tři noci po sobě zazipovala soubor, do kterého nikdo nepsal — živou databázi nezálohovala nikdy;
- obsah: `Agency` 1, `Profile` 3, `Role` 4, `User` 1 řádek. Žádné `Chat`, žádné `Message`;
- pak odvoz přestal a nikdo si toho nevšiml.

Prověřeno i to, co by mohlo zálohu držet jinde: **žádný workflow nikdy neukládal databázi jako artefakt** (všechna tři místa s `upload-artifact` jsou Playwright report, APK a AAB) a v repozitáři není nastavený žádný odvoz, jen pokyn v runbooku.

**Produkční data tedy k dispozici nejsou a pilot začíná s prázdnou databází.**

Je to učebnicový tichý pád: zálohy vznikaly, v Drive se objevovaly, a celou dobu v nich nebylo nic. Proto je v sekci 7 ověření restoru podmínka, ne doporučení, a proto `scripts/prozkoumej-zalohu.sh` vypisuje počty řádků — na takové záloze by hned ukázal `Message 0`.

### Dump datujte a ověřte, než se podle něj začnete rozhodovat

Zálohy vyrábí `server/scripts/backup-postgres.sh` a jméno nese **čas v UTC**, takže věk se pozná ze souboru:

```
nexus_YYYYMMDDTHHMMSSZ.dump
nexus_YYYYMMDDTHHMMSSZ.dump.sha256
```

### Nejsnazší cesta: prozkoumat dump u sebe na stroji

Server ještě nemáte a Postgres lokálně instalovat nemusíte. `scripts/prozkoumej-zalohu.sh` udělá všechno v zahoditelném kontejneru:

```bash
./scripts/prozkoumej-zalohu.sh /cesta/k/nexus_….dump
```

Ověří `sha256`, přečte z hlavičky dumpu **čas vytvoření a verzi Postgresu** (nezávisle na jméně souboru), obnoví data do kontejneru, vypíše **počty řádků** u tabulek, které jmenuje brána 3 v `docs/pilot-readiness-checklist.md`, a **čas poslední zprávy, aktivity chatu a auditu**. Pak kontejner smaže. Nikam se nepřipojuje a dump otevírá jen pro čtení.

Potřebuje jen běžící Docker (nebo OrbStack). Když démon neběží, řekne to a skončí.

Z `Dumped from database version` si všimněte verze: dump z novějšího Postgresu se do staršího obnovit nedá.

### Varianta na serveru

Až server bude, je v repozitáři `server/scripts/verify-restore-postgres.sh`. **Nerestorujte do produkční databáze** — skript to sám odmítne, ale smysl je podívat se na obsah dřív, než ho někam pustíte:

```bash
sudo -u postgres createdb nexus_kontrola
cd /root/nexus-backend

BACKUP_FILE=/cesta/k/nexus_….dump \
RESTORE_DATABASE_URL=postgresql://nexus:${DB_HESLO}@127.0.0.1:5432/nexus_kontrola \
bash scripts/verify-restore-postgres.sh
```

Skript zkontroluje `sha256` (pokud je soubor vedle), obnoví dump do té oddělené databáze a **vypíše počty řádků po tabulkách**. Z nich poznáte, jak je záloha úplná, a z `MAX(createdAt)` ve zprávách i to, kam v čase sahá:

```bash
psql postgresql://nexus:${DB_HESLO}@127.0.0.1:5432/nexus_kontrola \
  -c 'SELECT MAX("createdAt") AS posledni_zprava FROM "Message";'
```

Teprve podle toho se rozhodněte, jestli ji nasadit jako výchozí stav pilotu, nebo začít s prázdnou databází.

> **Pozor na šifrovaná pole — a jsou na nich dva různé klíče.**
>
> - `ENCRYPTION_KEY` (`server/src/utils/encryption.js`) chrání `Profile.credentials`.
> - `SIP_ENCRYPTION_KEY` (`server/src/services/sipEncryption.js`) chrání SIP hesla, tedy `DeviceBinding.sipPassword` a `SipTrunk`. Je to **hex o 64 znacích** a funkce ho odmítne, když jinou délku nemá.
>
> Bez původních hodnot z `.env` starého serveru se tahle pole z obnovené databáze **dešifrovat nedají**. Zbytek dat je čitelný; SIP přihlašovací údaje a `Profile.credentials` se budou muset nastavit znovu. Proto oba klíče od začátku patří i mimo server.

---

## 1. Volba serveru

Backend potřebuje **trvale běžící proces s diskem**, ne serverless:

| Potřeba | Proč |
| --- | --- |
| `node-cron` | denní úlohy, proces nesmí usínat |
| `multer` | nahrané soubory na disk |
| `socket.io` | WebSockety, dlouhoživotní spojení |
| Prisma + PostgreSQL | skutečná databáze |

Tím padá Render free (po 15 minutách nečinnosti službu uspí), funkce na Vercelu i Netlify (žádný trvalý proces ani disk) a Railway (jen úvodní kredit).

### Zdarma: Oracle Cloud Always Free

Jediná bezplatná varianta, která tyhle čtyři požadavky splní celé: **ARM Ampere A1, až 4 jádra a 24 GB RAM, 200 GB disku, zdarma trvale** (ne na 12 měsíců). Uběhne na tom Node, PostgreSQL i Ollama naráz.

Co vědět předem, ať to není překvapení:

- **Kapacita ARM v evropských regionech často není dostupná** — registrace projde, ale vytvoření instance skončí na „out of capacity". Zkoušet opakovaně, nebo zvolit jiný region.
- **Oracle si vyhrazuje zabírat nevyužité Always Free instance.** Backend, který obsluhuje relay telefony, nevyužitý nebude, takže by to nemělo hrozit — ale je to podmínka, ne záruka.
- Při registraci chce **kartu k ověření totožnosti**. Z Always Free se neúčtuje, ale karta je potřeba.

### Když ARM kapacita nebude

Záložní bezplatná skladba, rozdělená na dvě části:

- **Google Cloud Always Free** `e2-micro` (jen regiony `us-central1`, `us-west1`, `us-east1`), 30 GB disku — pro Node a nahrané soubory. Má jen 1 GB RAM, takže na něm Postgres nechte běžet jinde.
- **Neon** nebo **Supabase** — bezplatný PostgreSQL. Databáze tím zmizí ze serveru, čímž se mimochodem vyřeší i to, že záloha ležela vedle dat.

Dvě výhrady: `e2-micro` je jen v USA, takže k tomu patří delší odezva **a otázka přenosu údajů mimo EU** — viz `docs/zpracovani-osobnich-udaju.md`. A 1 GB RAM na Ollamu nestačí; AI nechte pro pilot vypnutou, `template_fallback` to pokryje.

### Až později

**Hetzner CX22, kolem 4 € měsíčně** — jestli pilot vyjde a nechcete, aby vám server zmizel znovu. Volání na Hetzner API už v kódu jsou. Tohle není potřeba řešit teď.

## 2. Jméno serveru

Předchozí jméno `nexus-api.myvnc.com` běželo na No-IP, kde se bezplatný hostname musí **potvrzovat každých 30 dní**, jinak přestane odpovídat. Přesně to se stalo.

**Zdarma a bez té pasti: DuckDNS.** Dává `vase-jmeno.duckdns.org`, nevyžaduje pravidelné potvrzování a Let's Encrypt na něm funguje. Cloudový server má pevnou veřejnou IP, takže stačí záznam jednou nastavit.

Pokud se u No-IP rozhodnete zůstat, dejte si **připomínku na potvrzení každých 25 dní**. Jinak tenhle výpadek přijde znovu, jen o měsíc později.

Až budete ochotný platit, **vlastní doména za 250–300 Kč na rok** tuhle třídu výpadků odstraní úplně. Na pilot to ale není podmínka.

---

## 3. Instalace

Všechno pod `root`, Ubuntu 24.04 LTS.

```bash
apt update && apt upgrade -y
apt install -y curl git nginx postgresql postgresql-client certbot python3-certbot-nginx
```

Node.js 22 — stejnou verzi, jakou používá CI:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
npm install -g pm2
```

Databáze. Heslo si nechte vygenerovat a držte ho v proměnné — nevypisuje se na obrazovku a nezůstane v historii shellu:

```bash
DB_HESLO="$(openssl rand -base64 24)"

sudo -u postgres createdb nexus
sudo -u postgres psql -c "CREATE USER nexus WITH PASSWORD '${DB_HESLO}';"
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE nexus TO nexus;"
sudo -u postgres psql -d nexus -c "GRANT ALL ON SCHEMA public TO nexus;"
```

Proměnnou `DB_HESLO` nechte v tomtéž shellu — použije se v dalším kroku pro `.env`. Pak si ji odložte do správce hesel.

Kód. Nasazení očekává klon **backendového** repozitáře přesně v `/root/nexus-backend` — tam úloha `sync-backend` posílá podsložku `server/`:

```bash
git clone https://github.com/Zdenekdi/nexus-backend.git /root/nexus-backend
cd /root/nexus-backend
npm install
```

## 4. Soubor `.env`

Povinné položky vycházejí z `server/scripts/audit-runtime-secrets.js`, který nasazení spouští se `STRICT_RUNTIME_SECRETS=true` a při chybě deploy zastaví:

| Proměnná | Požadavek |
| --- | --- |
| `JWT_SECRET` | nejméně 32 znaků |
| `DEVICE_SECRET` | nejméně 16 znaků |
| `ENCRYPTION_KEY` | nejméně 32 znaků |
| `DATABASE_URL` | musí začínat `postgres://` nebo `postgresql://` |

Pokud je nastavený kterýkoli ze Stripe klíčů, audit vyžaduje **všechny tři** (`STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`), kontroluje jim předpony a hlídá, aby secret a publishable klíč nebyly z různých režimů (test vs live). `ALLOW_UNSIGNED_BILLING_WEBHOOK=true` v produkci audit odmítne.

Vygenerování klíčů:

Audit nehlídá, ale backend je potřebuje, takže do `.env` patří taky:

| Proměnná | K čemu |
| --- | --- |
| `API_BASE_URL` | **bez `/api` na konci.** `server/src/routes/vultrRoutes.js` z ní skládá odkazy ke stažení APK a OTA jako `${API_BASE_URL}/api/vultr/…`. Když chybí, server od 3. 11. 2026 **nic nedoplní** — jednou varuje do logu a odkaz zůstane neúplný (`server/src/utils/publicUrls.js`). Dřív se použila zapsaná adresa zaniklého serveru a aktualizace odkazovaly tam. Změna stejnojmenného GitHub secretu v oddílu 8 tuhle proměnnou na server **nezapíše**. |
| `SIP_ENCRYPTION_KEY` | hex o 64 znacích; chrání SIP hesla. Potřeba jen když používáte SIP. |
| `ALLOWED_ORIGINS` | **Bez ní web na vlastní doméně z API nic nedostane.** Allowlist CORS v `server/src/app.js` je tato proměnná plus pevně zapsané `*.firebaseapp.com` / `*.web.app` a Capacitor `localhost`. Vlastní doména v něm není, takže požadavek z ní skončí 403 — a v prohlížeči to vypadá jako chyba přihlášení, ne jako CORS. Oddělte čárkou, bez mezer. |

```bash
cd /root/nexus-backend
{
  echo "DATABASE_URL=postgresql://nexus:${DB_HESLO}@127.0.0.1:5432/nexus"
  echo "JWT_SECRET=$(openssl rand -base64 48)"
  echo "DEVICE_SECRET=$(openssl rand -base64 32)"
  echo "ENCRYPTION_KEY=$(openssl rand -base64 48)"
  echo "SIP_ENCRYPTION_KEY=$(openssl rand -hex 32)"
  echo "API_BASE_URL=https://vase-domena.cz"
  echo "ALLOWED_ORIGINS=https://vase-domena.cz"
  echo "PORT=3000"
  echo "NODE_ENV=production"
} > .env
chmod 600 .env
```

`SIP_ENCRYPTION_KEY` se generuje `-hex 32`, ne `-base64` — `sipEncryption.js` vyžaduje přesně 64 hexadecimálních znaků a jinou délku odmítne.

Do `ALLOWED_ORIGINS` patří adresa **webu**, ne API. Když web běží na `https://example.eu`
a API na `https://api.example.eu`, je tam ta první. Backend od 3. 11. 2026 při startu
v produkci varuje, když v té proměnné není žádný `https://` origin — v logu
(`pm2 logs`) hledejte `ALLOWED_ORIGINS neobsahuje`.

Ověření, že CORS pouští web a nepouští cizí doménu:

```bash
for O in https://vase-domena.cz https://cizi.example.com; do
  printf "%s -> HTTP %s\n" "$O" "$(curl -s -o /dev/null -w '%{http_code}' -H "Origin: $O" https://api.vase-domena.cz/api/auth/me)"
done
```

Web musí dostat `401` (CORS prošel, chybí jen přihlášení), cizí doména `403`.

Stripe klíče a `APK_DEPLOY_TOKEN` do `.env` dopisuje samo nasazení z GitHub secretů — ty tam ručně nedávejte.

**Všechny čtyři vygenerované klíče** (`JWT_SECRET`, `DEVICE_SECRET`, `ENCRYPTION_KEY`, `SIP_ENCRYPTION_KEY`) **si hned odložte mimo server**, do správce hesel. Bez posledních dvou se ze zálohy nepřečtou šifrovaná pole. Přesně tohle teď chybí.

## 5. První migrace a spuštění

```bash
cd /root/nexus-backend
./node_modules/.bin/prisma generate
./node_modules/.bin/prisma migrate deploy
pm2 start src/index.js --name nexus-backend-final
pm2 save && pm2 startup
```

### Založení vlastníka — ne přes seed

**`node prisma/seed.js` v produkci nepoužívejte.** Zakládá demo účty se **veřejně známými hesly** (`password123`, `Nexus2024!`) a sám se proti tomu brání: při `NODE_ENV=production` vyhodí chybu, dokud mu to někdo nepřepíše přes `ALLOW_PROD_SEED=true`. To obcházení nedělejte.

Vlastníka založte s vlastním silným heslem přes `scripts/reset-owner.js`, který zároveň vytvoří roli „App Owner", pokud chybí:

```bash
cd /root/nexus-backend

# Skript si .env NENAČÍTÁ a Prisma bez DATABASE_URL v prostředí spadne na
# „Environment variable not found: DATABASE_URL". Tenhle řádek to řeší.
set -a; . ./.env; set +a

OWNER_HESLO="$(openssl rand -base64 24)"
echo "Heslo vlastníka: ${OWNER_HESLO}"     # opište do správce hesel

OWNER_EMAIL="vas@email.cz" \
OWNER_PASSWORD="${OWNER_HESLO}" \
node scripts/reset-owner.js
```

To načtení `.env` není opatrnost navíc — bez něj skript skutečně spadne. Ověřeno při stavbě serveru 3. 11. 2026.

Skript heslo sám nevypisuje, proto ten `echo` — bez něj byste se k němu už nedostali, ukládá se jen jako bcrypt hash. Opište ho a pak si historii shellu vyčistěte (`history -c`). Další role a účty se zakládají už z aplikace.

Jméno procesu **musí** být `nexus-backend-final` — nasazení ho restartuje podle něj.

Vstupní bod je `src/index.js`, jak říká `main` a `start` v `package.json`. V nasazovací úloze stálo dřív `server.js`, který v backendovém repozitáři neexistuje; opraveno spolu s tímhle runbookem. Dokud na starém serveru proces existoval, stačil restart a nikdo si toho nevšiml — na čistém serveru by deploy spadl přesně tady.

## 6. Nginx a certifikát

Produkce běží na portu **3000** (testovací kopie na 3001):

```nginx
server {
    server_name vase-domena.cz;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        client_max_body_size 260M;
    }
}
```

Tři řádky, které vypadají jako detail a nejsou:

**`Upgrade` a `Connection`** — bez nich nefungují WebSockety (`socket.io`).

**`X-Forwarded-For`** je bezpečnostní. `server/src/app.js` má `app.set('trust proxy', 1)` a omezení počtu pokusů o přihlášení klíčuje podle `req.ip`, který se bere z `X-Forwarded-For` — ne z `X-Real-IP`. Kdyby se tahle hlavička neposílala, stalo by se dvojí: všichni klienti by sdíleli jednu adresu (loopback nginxu), takže by si limit navzájem vyčerpávali, **a hlavičku poslanou klientem by nic nepřepsalo**, takže by si útočník mohl klíč limitu zvolit sám. `$proxy_add_x_forwarded_for` připojí skutečnou adresu klienta na konec, což je přesně to, co `trust proxy` 1 čte.

**`client_max_body_size 260M`** — ne 25M. `server/src/routes/vultrRoutes.js` přijímá APK do 150 MB, jeden endpoint do 250 MB. Při nižším limitu by nginx takový upload odmítl s HTTP 413 ještě **předtím**, než se dostane na backend, a rozvoz APK z CI by selhal na souborech, které endpoint povoluje.

```bash
certbot --nginx -d vase-domena.cz
```

## 7. Zálohy mimo server — hned, ne potom

**Tohle je důvod, proč je ztráta serveru ztrátou dat.** Záloha ležící na zálohovaném stroji není záloha.

```bash
mkdir -p /var/backups/nexus
crontab -e
# 15 2 * * * cd /root/nexus-backend && DATABASE_URL='...' BACKUP_DIR=/var/backups/nexus RETENTION_DAYS=30 npm run db:backup >> /var/log/nexus-db-backup.log 2>&1
```

A k tomu kopie někam jinam — stačí `rclone` nebo `scp` na jiný stroj či objektové úložiště. PR #136 přidává `server/scripts/archive-encrypted.sh`, který udělá `pg_dump` zašifrovaný GPG; takový soubor se dá odnést bez obav.

Ověřte, že restore funguje, **než na tom poběží pilot** — postup je v `docs/database-backup-restore-runbook.md`. Brána 3 v `docs/pilot-readiness-checklist.md` má jako no-go „restore nebyl nikdy vyzkoušený", a dosud vyzkoušený nebyl.

---

## 8. GitHub secrets, které se musí změnit

| Secret | Nová hodnota |
| --- | --- |
| `DEPLOY_HOST` | nová doména nebo IP |
| `DEPLOY_USER` | `root` |
| `DEPLOY_PASSWORD` | heslo k novému serveru |
| `API_BASE_URL` | `https://vase-domena.cz` — **bez `/api`**, viz níž |

### Pozor na `/api` v `API_BASE_URL`

Tahle proměnná se v repozitáři používá nejednotně a snadno se tím něco rozbije. Co jsem ověřil:

| Kdo ji čte | Co očekává |
| --- | --- |
| `ci.yml` (rozvoz APK) | **bez** `/api` — skládá `${API_BASE_URL}/api/vultr/upload-apk` |
| backend `vultrRoutes.js` | **bez** `/api` — skládá `${API_BASE_URL}/api/vultr/…` |
| `scripts/relay-field-test.sh` | **s** `/api` — výchozí hodnota je `…myvnc.com/api` |
| `audit-operational-health.js` | **s** `/api` — výchozí je `localhost:5000/api` |

Convence je tedy: **secret i serverová proměnná bez `/api`**, protože tak to čtou obě místa, která něco nasazují. Ty dva skripty, které `/api` čekají, dostávají správnou hodnotu dopsáním přípony v `ci.yml` — upraveno spolu s tímhle runbookem, ať se obě skupiny nehádají o jednu hodnotu.

Kdybyste secret nastavil s `/api`, rozvoz APK by mířil na `/api/api/vultr/upload-apk` a skončil by chybou 404.

Nasazení dnes používá **přihlášení heslem pod rootem** (`appleboy/ssh-action` s `password`). Na novém serveru doporučuji přejít na klíč — `ssh-action` umí `key:` — a heslové přihlášení v `sshd_config` vypnout. Je to jedna změna v úloze a jeden nový secret.

## 9. Relay telefony se musí spárovat znovu

Per-device tajemství se počítá jako HMAC-SHA256 z `installationId` klíčem `DEVICE_SECRET`. Nový `DEVICE_SECRET` tedy znamená, že **žádný stávající telefon se nepřihlásí**.

**Adresa backendu se v aplikaci přepsat nedá.** Bere se z `VITE_API_URL` **v době buildu**, a to od 3. 11. 2026 na jediném místě: `client/src/constants/config.js`. Když chybí, build nemá kam mluvit — aplikace ohlásí chybu do konzole a nenačte nic; zapsaná adresa zaniklého serveru už v klientovi není. `configureRelay` tu adresu jen zkopíruje z JS do nativních předvoleb — nevytváří ji, takže v předvolbách přepsat nejde.

Postup je tedy:

1. **postavit APK znovu** s novou adresou — `VITE_API_URL=https://vase-domena.cz/api`,
2. **nainstalovat ji na telefon ručně**, přes kabel nebo přeneseným souborem (rozvoz přes server zatím nejde, viz níž),
3. znovu projít párování přes `/api/device/verify`,
4. zkontrolovat, že se obnovuje `lastSeenAt`.

Bod 2 je nutný kvůli slepičímu problému: rozvoz APK jde přes backend, na který se telefon ještě neumí připojit. První instalaci proto nemine ruční přenos.

Rozvoz APK jde přes `API_BASE_URL/api/vultr/upload-apk`, tedy přes tenhle backend. Dokud neběží, nedostanete na telefony ani novou verzi — včetně opravy šestihodinového limitu z #139, kterou relay telefony pořád nemají.

## 10. Co na novém serveru není: Asterisk, tedy hovory

Nainstaloval jsem backend, PostgreSQL a nginx. **Asterisk ne**, takže hovory přes SIP na novém serveru nefungují. SMS jimi nejsou dotčené — ty jdou přes relay telefon, viz `docs/relay-hovory-a-sms.md`.

Projevuje se to v klientu takhle: `client/src/components/sip/SipManager.jsx` čte `VITE_SIP_WS_URL`, která se **nikde nenastavuje**, takže padá na zapsané `wss://nexus-api.myvnc.com:8089/ws` — zaniklý server.

Správná hodnota by byla `wss://api.nexusstack.eu:8089/ws`, protože podle `docs/asterisk/setup.sh` běžel Asterisk **na tomtéž stroji jako backend** a WSS na portu 8089 (`docs/asterisk/pjsip.conf`, `[transport-wss]`). Nenastavujte ji ale dřív, než tam Asterisk poběží — jinak to vypadá jako hotová konfigurace, a není.

**Nenastavení té proměnné ale spojování nevypne**, což jsem tu původně napsal špatně. `wsUrl` má zapsanou výchozí hodnotu, takže je vždy vyplněný; jakmile se přihlásí operátorka s SIP rolí a `GET /api/sip/config` vrátí údaje, JsSIP se spustí a pokusy o spojení selhávají tak či tak. Vypnout SIP by chtělo samostatnou podmínku — podrobněji v `docs/relay-hovory-a-sms.md`.

Co je potřeba udělat, než ta hodnota začne platit (**není to krok za krokem** — úplný postup ověřený na novém serveru zatím neexistuje, podklady jsou v [docs/asterisk/](asterisk/)):

1. **Nainstalovat Asterisk** — `docs/asterisk/setup.sh` je na to napsaný, ale pozor: s `--domain` spouští `certbot certonly --standalone`, a to **obsadí port 80**, na kterém běží nginx. Certifikát pro `api.nexusstack.eu` navíc už existuje v `/etc/letsencrypt/live/`, takže ho stačí Asterisku nasměrovat (`cert_file` a `priv_key_file` v `pjsip.conf`) a certbot nepouštět vůbec.
2. **Otevřít port 8089** — a to **ve dvou vrstvách**: v bezpečnostním seznamu u Oracle i v lokálním iptables, který na tom obrazu pouští jen 22, 80 a 443. Viz oddíl 6.
3. **Zvážit paměť.** Asterisk vedle Node a PostgreSQL na 952 MB a jednom jádře je optimistické. Tohle je ten případ, kdy se vyplatí získat ARM stroj s 12 GB.

**Pro pilot to blokátor není.** `docs/pilot-readiness-checklist.md` nezmiňuje SIP, hovory ani Asterisk ani jednou — brána 5 je celá o SMS. Pokud ale pilot má hovory obsahovat, patří do checklistu jedenáctá… respektive další brána, protože dnes to neověřuje nic.

## 11. Na závěr

Projděte `docs/pilot-readiness-checklist.md`. Po postavení serveru by měly jít vyhodnotit brány, které dosud nešly vůbec — 3 (záloha), 4 (Stripe webhook), 5 (relay), 6 (RBAC proti endpointům), 7 (monitoring) a 8 (manuální smoke).

Z brány 7 nezapomeňte na alerty: v kódu je podpora Telegramu i Sentry, ale jestli byly nastavené, bylo vidět jen v `.env` na starém serveru. Na novém to nastavte vědomě, nebo vědomě vynechte — brána 10 má no-go „monitoring není dostupný a nikdo nesleduje logy".
