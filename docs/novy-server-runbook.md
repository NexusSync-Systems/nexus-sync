# Postavení backendu na novém serveru

Postup pro případ, že produkční server neexistuje a staví se od nuly. Napsáno podle toho, co nasazovací úloha `deploy-backend` v `.github/workflows/ci.yml` od serveru skutečně vyžaduje — ne podle obecného návodu.

Vzor jednorázového nastavení je v `docs/testovaci-prostredi.md`; tady je produkční varianta a navíc věci, které s ztrátou serveru souvisí.

---

## 0. Nejdřív data, teprve pak server

Proč je ztráta serveru rovnou ztrátou dat: zálohy se podle `docs/database-backup-restore-runbook.md` ukládaly do `/var/backups/nexus`, tedy **na ten samý stroj**, a v celém runbooku není ani jedna zmínka o kopii jinam. Záloha ležící na zálohovaném serveru není záloha. Sekce 7 to proto řeší jako první věc, ne jako poslední.

### Dump datujte a ověřte, než se podle něj začnete rozhodovat

Zálohy vyrábí `server/scripts/backup-postgres.sh` a jméno nese **čas v UTC**, takže věk se pozná ze souboru:

```
nexus_YYYYMMDDTHHMMSSZ.dump
nexus_YYYYMMDDTHHMMSSZ.dump.sha256
```

K ověření je v repozitáři hotový nástroj. **Nerestorujte do produkční databáze** — skript to sám odmítne, ale smysl je podívat se na obsah dřív, než ho někam pustíte:

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

> **Pozor na šifrovaná pole.** Bez původního `ENCRYPTION_KEY` z `.env` starého serveru se z obnovené databáze **nepřečtou SIP hesla ani `Profile.credentials`** — dešifrovat je nelze. Zbytek dat je čitelný; tyhle dvě věci bude potřeba nastavit znovu. Proto musí nový klíč od začátku existovat i mimo server.

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

```bash
cd /root/nexus-backend
{
  echo "DATABASE_URL=postgresql://nexus:${DB_HESLO}@127.0.0.1:5432/nexus"
  echo "JWT_SECRET=$(openssl rand -base64 48)"
  echo "DEVICE_SECRET=$(openssl rand -base64 32)"
  echo "ENCRYPTION_KEY=$(openssl rand -base64 48)"
  echo "PORT=3000"
  echo "NODE_ENV=production"
} > .env
chmod 600 .env
```

Stripe klíče a `APK_DEPLOY_TOKEN` do `.env` dopisuje samo nasazení z GitHub secretů — ty tam ručně nedávejte.

**Tři vygenerované klíče si hned odložte mimo server** (správce hesel). Bez nich se ze zálohy nepřečtou šifrovaná pole. Přesně tohle teď chybí.

## 5. První migrace a spuštění

```bash
cd /root/nexus-backend
./node_modules/.bin/prisma generate
./node_modules/.bin/prisma migrate deploy
node prisma/seed.js    # zakládá role a výchozí účty
pm2 start src/index.js --name nexus-backend-final
pm2 save && pm2 startup
```

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
        client_max_body_size 25M;
    }
}
```

Hlavičky `Upgrade` a `Connection` nejsou ozdoba — bez nich nefungují WebSockety (`socket.io`). `client_max_body_size` kvůli nahrávání do galerie a APK.

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
| `API_BASE_URL` | `https://vase-domena.cz/api` |

Nasazení dnes používá **přihlášení heslem pod rootem** (`appleboy/ssh-action` s `password`). Na novém serveru doporučuji přejít na klíč — `ssh-action` umí `key:` — a heslové přihlášení v `sshd_config` vypnout. Je to jedna změna v úloze a jeden nový secret.

## 9. Relay telefony se musí spárovat znovu

Per-device tajemství se počítá jako HMAC-SHA256 z `installationId` klíčem `DEVICE_SECRET`. Nový `DEVICE_SECRET` tedy znamená, že **žádný stávající telefon se nepřihlásí**.

Na každém telefonu je potřeba:

1. v aplikaci přepsat adresu backendu na novou doménu (ukládá se do předvoleb, `configureRelay`),
2. znovu projít párování přes `/api/device/verify`,
3. zkontrolovat, že se obnovuje `lastSeenAt`.

Rozvoz APK jde přes `API_BASE_URL/api/vultr/upload-apk`, tedy přes tenhle backend. Dokud neběží, nedostanete na telefony ani novou verzi — včetně opravy šestihodinového limitu z #139, kterou relay telefony pořád nemají.

## 10. Na závěr

Projděte `docs/pilot-readiness-checklist.md`. Po postavení serveru by měly jít vyhodnotit brány, které dosud nešly vůbec — 3 (záloha), 4 (Stripe webhook), 5 (relay), 6 (RBAC proti endpointům), 7 (monitoring) a 8 (manuální smoke).

Z brány 7 nezapomeňte na alerty: v kódu je podpora Telegramu i Sentry, ale jestli byly nastavené, bylo vidět jen v `.env` na starém serveru. Na novém to nastavte vědomě, nebo vědomě vynechte — brána 10 má no-go „monitoring není dostupný a nikdo nesleduje logy".
