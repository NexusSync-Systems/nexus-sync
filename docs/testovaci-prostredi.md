# Testovací prostředí

> **Stav k 3. 11. 2026: testovací backend NEEXISTUJE.**
>
> Stroj, pro který je tenhle postup napsaný, byl smazán. Konkrétně už neplatí
> jméno `nexus-test-api.myvnc.com`, nginx a certbot pro ně, a secrety
> `STAGING_HOST` / `STAGING_USER` / `STAGING_PASSWORD` míří na starý server.
> Nový backend běží na `api.nexusstack.eu` (Oracle, 952 MB RAM).
>
> Druhá kopie by na něm jít měla — vlastní databáze ve stejném PostgreSQL
> a jeden Node proces navíc je asi 150 MB z těch 952 — ale chce to novou
> poddomenu s certifikátem a přepsat oddíly „Jednorázové nastavení serveru"
> a „Secrety v GitHubu" níž. **Ověřený postup pro nový server zatím není.**
>
> Náhledy pull requestů proto míří na **produkční** API a ukazují červený pruh
> `NÁHLED ZMĚN — POZOR, PRACUJETE S OSTRÝMI DATY`. Dnes nemají co poškodit
> (databáze je prázdná), ale s pilotem by zapisovaly do dat skutečných lidí —
> hlídá to brána 2 v `docs/pilot-readiness-checklist.md` jako no-go.

Testovací backend je **druhá kopie téhož kódu** na tomtéž serveru: vlastní
databáze, vlastní proces, vlastní port, vlastní `.env`. Náhledy pull requestů
na Netlify pak míří na něj místo na produkci.

Sdílený je jen stroj. Nic jiného — a to je záměr.

## Proč se nekopírují produkční data

Databáze obsahuje telefonní čísla klientů a obsahy zpráv skutečných lidí.
Kopie do prostředí, kde se běžně proklikává a kam má přístup víc lidí, je
únik osobních údajů, i když se nikdo nechová špatně.

Testovací databáze proto vzniká z **migrací a seedu** — stejná struktura,
vymyšlená data. Seed zakládá tytéž účty, které používají testy
(`owner@nexus.sync`, `jan@`, `alice@` …).

Kdybys někdy potřeboval produkční data kvůli konkrétní chybě, nekopíruj je
celá: vytáhni jeden případ a čísla i texty přepiš.

## Co je nejnebezpečnější udělat špatně

**Zkopírovat produkční `.env`.** Nejde jen o Stripe. Kdyby měl testovací
server stejný `JWT_SECRET`, přihlašovací token, který vydá, by prošel i na
produkci — kdokoli s přístupem k testu by se dostal do ostrého provozu.

Proto se sem produkční secrety **nedědí** a nasazovací workflow bez vlastních
hodnot odmítne pokračovat. `.env` se navíc při každém nasazení skládá znovu,
takže ruční úprava na serveru nepřežije.

K tomu `scripts/audit-runtime-secrets.js` při `NEXUS_ENVIRONMENT=staging`
zastaví nasazení, když by test uměl:

| Zakázáno na testu | Proč |
|---|---|
| `FIO_API_TOKEN` | četl by skutečný bankovní účet |
| `ALLOW_BANK_TRANSFER_BILLING=true` | vydával by skutečné platební pokyny |
| `sk_live_…` | strhával by skutečné peníze |
| Firebase / FCM účet | posílal by push na telefony skutečných modelek |

## Jednorázové nastavení serveru

Tohle udělej ty — CI k tomu nemá a nemá mít přístup.

```bash
# 1. Databáze
sudo -u postgres createdb nexus_test
sudo -u postgres psql -c "CREATE USER nexus_test WITH PASSWORD 'zvol-vlastni';"
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE nexus_test TO nexus_test;"

# 2. Druhá kopie kódu
git clone https://github.com/Zdenekdi/nexus-sync.git /root/nexus-backend-test
cd /root/nexus-backend-test/server && npm install

# 3. Nginx: nexus-test-api.myvnc.com → 127.0.0.1:3001
#    (stejný server block jako produkce, jen jiný proxy_pass a jiné jméno)

# 4. Certifikát
certbot --nginx -d nexus-test-api.myvnc.com
```

Port **3001** je natvrdo v nasazovacím workflow; produkce běží na 3000.

## Secrety v GitHubu

Settings → Secrets and variables → Actions:

| Secret | Co to je |
|---|---|
| `STAGING_HOST` | tentýž stroj jako produkce |
| `STAGING_USER`, `STAGING_PASSWORD` | přístup přes SSH |
| `STAGING_DATABASE_URL` | připojení k `nexus_test` na `localhost:5432` (uživatel a heslo z kroku 1) |
| `STAGING_JWT_SECRET` | **jiný než produkční**, aspoň 32 znaků |
| `STAGING_DEVICE_SECRET` | **jiný než produkční**, aspoň 16 znaků |
| `STAGING_ENCRYPTION_KEY` | **jiný než produkční**, aspoň 32 znaků |
| `STAGING_API_URL` | `https://nexus-test-api.myvnc.com` |

Nová náhodná tajemství:

```bash
openssl rand -hex 32
```

## Nasazení

Actions → „🧪 Nasadit testovací backend" → Run workflow. Vybereš větev
a jestli se má znovu naplnit databáze demo daty.

Schválně to neběží samo při každém pushi: testovací server by se měnil pod
rukama zrovna ve chvíli, kdy na něm někdo něco zkouší.

## Testovací web

Náhledy Netlify u pull requestů se na testovací API napojí samy —
`netlify.toml` jim nastaví `VITE_API_URL`. Dole se ukáže oranžový pruh
`TESTOVACÍ PROSTŘEDÍ`, aby se to nedalo splést s ostrým provozem.

Dokud testovací backend neběží, míří náhledy na produkci — `netlify.toml` jim
od 3. 11. 2026 nastavuje `VITE_API_URL` na `https://api.nexusstack.eu/api`
**výslovně** a nechává červený pruh
`NÁHLED ZMĚN — POZOR, PRACUJETE S OSTRÝMI DATY`.

Dřív se tam adresa nenastavovala vůbec a klient spadl na zapsanou výchozí
hodnotu. Když ten server zanikl, náhledy tiše mířily na mrtvý stroj a nikdo si
toho nevšiml, protože build i nasazení proběhly úspěšně.

Až server postavíš, přepiš v `netlify.toml` `VITE_API_URL` na jeho adresu
a `VITE_NEXUS_ENVIRONMENT` na `staging`. Pruh se tím změní na oranžový
`TESTOVACÍ PROSTŘEDÍ — DATA NEJSOU OSTRÁ`.

## Co tím nezískáš

- **Ověření Fio.** Sandbox neexistuje; párování plateb jde vyzkoušet jedině
  skutečným převodem na skutečný účet.
- **Ověření relaye.** Potřebuje skutečný telefon, který pár hodin leží.
- **Nácvik nasazení produkce.** Testovací server běží na tomtéž stroji, takže
  neověří, co se stane při nasazení samotném.
