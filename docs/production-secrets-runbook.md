# Production secrets runbook

Tento dokument popisuje, ktere secrets a environment promenne musi byt nastavene pro produkcni provoz Nexus Hubu. Skutecne hodnoty nepatri do repozitare, screenshotu ani dokumentace.

## Kde se nastavuje

- GitHub Actions: `Repository -> Settings -> Secrets and variables -> Actions`.
- Backend runtime: `.env` na serveru nebo secret manager deploy platformy.
- Frontend build: GitHub Actions build env nebo hosting provider env.
- Android build: lokální `client/android/local.properties`, CI secrets, nebo build environment.

## Backend runtime

Povinne:

- `DATABASE_URL`: PostgreSQL connection string.
- `JWT_SECRET`: nahodna hodnota alespon 32 znaku, idealne 64 bajtu hex.
- `DEVICE_SECRET`: shared secret pro legacy/device webhooky, alespon 16 znaku.
- `ENCRYPTION_KEY`: hlavni encryption key pro citliva data, alespon 32 znaku.

Doporucene:

- `ALLOWED_ORIGINS`: produkcni frontend domeny oddelene carkou.
- `SENTRY_DSN`: produkcni error tracking.
- `TELEGRAM_BOT_TOKEN`: bot token pro alerty.
- `TELEGRAM_CHAT_ID`: cilovy chat pro alerty.
- `GOOGLE_APPLICATION_CREDENTIALS`: cesta k Firebase service account JSON, nebo
- `FIREBASE_SERVICE_ACCOUNT_JSON`: inline Firebase service account JSON.

Stripe:

- `STRIPE_PUBLISHABLE_KEY`: `pk_live_...` pro produkci, `pk_test_...` pro test.
- `STRIPE_SECRET_KEY`: `sk_live_...` pro produkci, `sk_test_...` pro test.
- `STRIPE_WEBHOOK_SECRET`: `whsec_...` ze Stripe webhook endpointu.
- `STRIPE_PRICE_STARTER_MONTHLY_CZK`: volitelne pevne Stripe Price ID pro Starter.
- `STRIPE_PRICE_PRO_MONTHLY_CZK`: volitelne pevne Stripe Price ID pro Professional.
- `STRIPE_PRICE_AGENCY_MONTHLY_CZK`: volitelne pevne Stripe Price ID pro Agency.
- `REQUIRE_STRIPE_CONFIG=true`: zapnout v produkci, pokud ma byt aktivni platba kartou.

Monitoring:

- `PENDING_BILLING_ALERT_MINUTES=60`
- `RELAY_OFFLINE_ALERT_MINUTES=15`
- `MONITOR_ALERT_COOLDOWN_MINUTES=60`

Bankovni platby:

- `ALLOW_BANK_TRANSFER_BILLING=false`: bankovni prevod je vypnuty a nema byt dostupny v prvnim pilotu.
- `BANK_ACCOUNT`: ucet zobrazeny u bankovniho prevodu, pouzit pouze pokud se prevod nekdy znovu zapne.
- `FIO_API_TOKEN`: token pro Fio synchronizaci plateb, pouzit pouze pokud je aktivni Fio worker.

SIP/Asterisk:

- `SIP_ENCRYPTION_KEY`: 64 hex znaku pro AES-256-GCM SIP hesla.
- `VPS_SSH_HOST`
- `VPS_SSH_USER`
- `VPS_SSH_KEY_PATH` nebo `VPS_SSH_PASSWORD`
- `ASTERISK_CONF_DIR`
- `ASTERISK_WS_PORT`
- `ASTERISK_SIP_PORT`

Infra/SSH:

- `VULTR_API_KEY`
- `VULTR_INSTANCE_ID`
- `SSH_HOST`
- `SSH_USER`
- `SSH_KEY_PATH`
- `HETZNER_SSH_HOST`, pokud se pouziva Hetzner AI node.

## Frontend build

Povinne pro produkci:

- `VITE_API_URL`: napr. `https://api.nexusstack.eu/api`. Bez ni klient nema kam mluvit a nahlas to ohlasi do konzole; zapsana zaloha v nem od 3. 11. 2026 neni.
- `VITE_STRIPE_PUBLISHABLE_KEY`: `pk_live_...`, pokud pouzivate Stripe Checkout fallback pres Stripe.js.
- `VITE_APP_VERSION`: nastavuje CI build, napr. `v3.79-b123`.

Volitelne:

- `VITE_SIP_WS_URL`: WebSocket URL pro SIP, napr. `wss://sip.vase-domena.cz:8089/ws`. Zatim se nenastavuje — Asterisk nikde nebezi, viz `docs/relay-hovory-a-sms.md`.
- `VITE_APP_VARIANT`: `full` nebo `relay` pro Android/Capacitor build varianty.

## Android build

- `DEVICE_SECRET`: musi odpovidat backendovemu `DEVICE_SECRET`, pokud APK stale pouziva secret-based relay flow.
- `VITE_API_URL`: backend API URL pro Relay build.
- Firebase konfigurace: `client/android/app/google-services.json`.
- Keystore hodnoty v `client/android/keystore.properties`, nikoliv v gitu.

## GitHub Actions secrets

Workflowy v repozitari pouzivaji tyto secrets:

- `API_BASE_URL`: backend base URL pro upload APK.
- `DEPLOY_API_TOKEN`: token pro `/api/vultr/upload-apk`.
- `SYNC_BACKEND_TOKEN`: GitHub token pro backend sync krok.
- `DEPLOY_HOST`
- `DEPLOY_USER`
- `DEPLOY_PASSWORD`
- `STRIPE_PUBLISHABLE_KEY`
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `FIREBASE_SERVICE_ACCOUNT_NEXUS_SYNC_8D50B`
- `GCP_SA_KEY`
- `NEXUS_API_URL`
- `NEXUS_DEVICE_SECRET`
- `TEST_OWNER_EMAIL`
- `TEST_OWNER_PASSWORD`
- `FRONTEND_URL`

Poznamka: backend deploy guard odmita nasazeni, pokud je v GitHub Actions nastaveny
`STRIPE_SECRET_KEY`, ale chybi `STRIPE_WEBHOOK_SECRET` nebo `STRIPE_PUBLISHABLE_KEY`.
Je to zamerne: bez webhook secretu by Stripe checkout mohl vzniknout, ale placeny tarif
by se nemusel bezpecne aktivovat.

## Generovani hodnot

```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))" # JWT_SECRET
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" # DEVICE_SECRET nebo ENCRYPTION_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" # SIP_ENCRYPTION_KEY
```

## Rotace secrets

JWT:

1. Vytvor novy `JWT_SECRET`.
2. Nasad backend.
3. Pocitej s odhlasenim aktivnich uzivatelu.
4. Over login a refresh flow.

Device secret:

1. Vytvor novy `DEVICE_SECRET`.
2. Sestav novou Relay APK se stejnou hodnotou.
3. Nasad backend a APK koordinovane.
4. Over `/api/device/verify`, `/api/device/relay` a outbox.

Stripe:

1. Vytvor nove live/test klice ve Stripe Dashboardu.
2. Aktualizuj backend secrets.
3. Aktualizuj frontend `VITE_STRIPE_PUBLISHABLE_KEY`.
4. Znovu vytvor webhook endpoint secret `STRIPE_WEBHOOK_SECRET`.
5. Proved test z `docs/stripe-test-mode.md`.

Firebase:

1. Vytvor novy service account key.
2. Aktualizuj `FIREBASE_SERVICE_ACCOUNT_JSON` nebo soubor na serveru.
3. Restartuj backend.
4. Over push token registraci a test push.

Deploy tokeny:

1. Vygeneruj novy token v aplikaci nebo GitHubu.
2. Aktualizuj GitHub Actions secret.
3. Spust build/deploy workflow.
4. Zneplatni stary token.

## Kontrola po deployi

- Spustte runtime preflight bez vypisu hodnot:

```bash
cd /root/nexus-backend
STRICT_RUNTIME_SECRETS=true npm run security:runtime
```

- `/health` vraci `status: ok`.
- `/api/admin/operational-health` vraci `status: ok` pro App Ownera.
- Opakovatelny smoke prikaz bez vypisu tokenu/hodnot:

```bash
OPS_API_BASE_URL=https://api.nexusstack.eu/api \
OPS_OWNER_EMAIL=owner@example.com \
OPS_OWNER_PASSWORD=... \
STRICT_OPERATIONAL_HEALTH=true \
npm run ops:health
```

- Stripe checkout vytvori session a webhook ji aktivuje.
- Relay telefon posle inbound SMS a outbox poll obnovuje `lastSeenAt`.
- Telegram alerty jsou dorucitelne nebo jsou vedome vypnute.
- GitHub Actions neobsahuji secrets v logu.

## Co nikdy necommitovat

- `.env`
- `firebase-auth.json`
- `google-services.json` s produkcnimi credentials, pokud neni urceny verejne pro Android app config.
- `keystore.properties`
- SSH private keys
- Stripe `sk_...` a `whsec_...`
- Databazove dumpy s osobnimi daty
