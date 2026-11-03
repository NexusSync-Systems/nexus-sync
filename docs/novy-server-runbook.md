# Postavení backendu na novém serveru

Postup pro případ, že produkční server neexistuje a staví se od nuly. Napsáno podle toho, co nasazovací úloha `deploy-backend` v `.github/workflows/ci.yml` od serveru skutečně vyžaduje — ne podle obecného návodu.

Vzor jednorázového nastavení je v `docs/testovaci-prostredi.md`; tady je produkční varianta a navíc věci, které s ztrátou serveru souvisí.

---

## 0. Nejdřív: nevzdávejte data předčasně

Zálohy se podle `docs/database-backup-restore-runbook.md` ukládaly do `/var/backups/nexus` — **na ten samý server**. V runbooku není ani jedna zmínka o kopii mimo něj. Se zánikem serveru tedy zmizely i zálohy.

**Než to přijmete jako hotovou ztrátu, ověřte u poskytovatele:**

- Je instance jen pozastavená (suspended) kvůli platbě, nebo smazaná (destroyed)? Pozastavená se obvykle dá obnovit.
- Existuje snapshot nebo záloha svazku? U Vultru i Hetzneru se platí zvlášť a bývá vypnutá — ale stojí to minutu na zjištění.
- Nemáte dump stažený ručně na svém počítači z nějakého dřívějšího ladění?

Pokud nic z toho, data jsou pryč a pilot začne s prázdnou databází. Pro pilot to je přijatelné; horší by bylo stavět na domněnce, že se někde ještě najdou.

> I kdyby se databáze objevila, bez původního `.env` by **šifrovaná pole nešla přečíst** — `ENCRYPTION_KEY` chrání SIP hesla a `Profile.credentials`. Proto musí ten klíč od teď existovat i mimo server.

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

**Doporučení: Hetzner CX22, kolem 4 € měsíčně.** Právě jste o server přišel; za cenu dvou kafé měsíčně dostanete něco, co nikdo nerecykluje. Volání na Hetzner API navíc už v kódu jsou.

**Bezplatná varianta: Oracle Cloud Always Free** — ARM Ampere, 4 jádra, 24 GB RAM, 200 GB disku, zdarma trvale; uběhne i Ollama. Dvě úskalí, ať to není překvapení: kapacita ARM v populárních regionech bývá nedostupná a Oracle si vyhrazuje zabírat nevyužité instance. Na pilot to jde, na něco, co nesmí zmizet, bych na to nesázel.

## 2. Jméno serveru

**Nepoužívejte znovu bezplatnou dynamickou DNS.** Předchozí jméno `nexus-api.myvnc.com` běželo na No-IP, kde se bezplatný hostname musí potvrzovat každých 30 dní, jinak přestane odpovídat.

Kupte vlastní doménu (kolem 250–300 Kč na rok) a dejte `A` záznam na IP serveru. Odstraní to celou tuhle třídu výpadků.

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

Databáze (zvolte si vlastní heslo, do `.env` půjde stejné):

```bash
sudo -u postgres createdb nexus
sudo -u postgres psql -c "CREATE USER nexus WITH PASSWORD 'zvol-vlastni-heslo';"
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE nexus TO nexus;"
sudo -u postgres psql -d nexus -c "GRANT ALL ON SCHEMA public TO nexus;"
```

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
  echo "DATABASE_URL=postgresql://nexus:zvol-vlastni-heslo@127.0.0.1:5432/nexus"
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
