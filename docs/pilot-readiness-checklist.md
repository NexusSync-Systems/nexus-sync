# Pilot readiness checklist

Tento checklist slouzi jako go/no-go brana pred rizenym pilotnim provozem Nexus Hubu s realnymi uzivateli, platbami a Relay telefonem.

## 1. Code and CI gate

- `master` je aktualni a pushnuty na GitHub.
- GitHub Actions jsou zelene:
  - `Pipeline: Build & Deploy` (obsahuje i Playwright E2E Tests)
  - `GCP Cloud Build`, pokud se pouziva GCP deploy
- Client build pro produkci prosel.
- Server lint prosel bez errors.
- Server tests prosly.
- Playwright API a E2E smoke prosly.
- Android APK je sestaveny z aktualniho commitu a v UI se ukazuje aktualni verze.

Prikaz pro lokalni pilot smoke:

```bash
npm run test:pilot
```

Poznamka: Stripe smoke je ve vychozim stavu skipnuty. Pro realny test Stripe test-mode pouzijte `RUN_STRIPE_TEST_MODE=true npm run test:stripe`.

## 2. Secrets and environment gate

Podle `docs/production-secrets-runbook.md` overte:

- Backend ma `JWT_SECRET`, `DEVICE_SECRET`, `ENCRYPTION_KEY`, `DATABASE_URL`.
- Stripe ma `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`.
- Frontend build ma `VITE_API_URL` a produkcni nebo testovaci `VITE_STRIPE_PUBLISHABLE_KEY` podle prostredi.
- Firebase push je nakonfigurovany.
- Telegram alerty jsou nakonfigurovane nebo vedome vypnute.
- `REQUIRE_STRIPE_CONFIG=true`, pokud ma byt v pilotu aktivni platba kartou.
- `netlify.toml` nesmi mit v kontextech `deploy-preview` a `branch-deploy`
  `VITE_API_URL` produkcniho API. Od 3. 11. 2026 ho tam ma zamerne: nahledy
  pull requestu musely zacit fungovat a databaze byla prazdna, takze nemely co
  poskodit. S realnymi uzivateli by ale nahled z libovolneho pull requestu
  zapisoval do jejich dat. Bud postavte testovaci backend podle
  `docs/testovaci-prostredi.md` a prepnete adresu na nej (`VITE_NEXUS_ENVIRONMENT`
  na `staging`), nebo tu promennou z obou kontextu odeberte.

Go/no-go:

- No-go, pokud nahledy na Netlify stale miri na produkcni API.
- No-go, pokud produkce pouziva test Stripe keys omylem.
- No-go, pokud `STRIPE_SECRET_KEY` existuje, ale chybi `STRIPE_WEBHOOK_SECRET`.
- No-go, pokud nejsou nastavene startup secrets a backend by spadl po restartu.
- No-go, pokud GitHub Actions obsahuje `STRIPE_SECRET_KEY`, ale neobsahuje
  `STRIPE_WEBHOOK_SECRET`; deploy guard takovy backend zamerne nenasadi.

## 3. Backup and restore gate

Podle `docs/database-backup-restore-runbook.md` overte:

- `STRICT_BACKUP_AUDIT=true npm run db:backup:audit` probehl na backend serveru.
- Manualni backup probehl pred pilotem.
- Checksum existuje.
- Restore verification probehl do oddelene databaze.
- Row counts davaji smysl pro `Agency`, `User`, `Profile`, `Chat`, `Message`, `Subscription`, `DeviceBinding`.
- Je jasne, kde lezi posledni funkcni backup.

Go/no-go:

- No-go, pokud nemame cerstvou overenou zalohu.
- No-go, pokud restore nebyl nikdy vyzkouseny.

## 4. Stripe payment gate

Test-mode:

- `npm run test:stripe` se v CI/lokalne korektne preskoci bez secrets.
- `RUN_STRIPE_TEST_MODE=true npm run test:stripe` vytvori Stripe Checkout session.
- Manualni test karta `4242 4242 4242 4242` aktivuje plan pres `checkout.session.completed`.
- Wrong webhook secret je odmitnut.

Production/live:

- Live webhook endpoint ve Stripe Dashboardu miri na `/api/billing/webhook`.
- Live webhook eventy obsahuji `checkout.session.completed`.
- Monitoring `/api/admin/operational-health` nema Stripe warning.

## 5. Relay Android gate

Podle `docs/android-relay-field-test.md` musi projit:

- `/api/device/verify` sparuje telefon se spravnym profilem.
- Nexus Relay je vychozi SMS aplikace.
- 10/10 prichozich SMS z jednoho cisla dorazi do webu bez duplicit.
- 3/3 SMS se dosynchronizuji po vypadku internetu pres inbox fallback.
- 5/5 odpovedi z webu odejde telefonem.
- Jedna SMS dorazi pri zamcene obrazovce.
- Jedna SMS dorazi po restartu telefonu.
- `lastSeenAt` se obnovuje pres inbound relay i outbox polling.

Go/no-go:

- No-go, pokud Android SMS aplikace zpravu vidi, ale backend ji nema ani po fallback sync.
- No-go, pokud outbox zustava `pending_relay` dele nez 2 minuty bez jasne chyby.

## 6. Security and RBAC gate

- Model role nema pristup k managerskym/admin endpointum.
- Legacy device endpoints jsou v produkci vypnute, pokud nejsou vedome potreba.
- Relay webhook prijima pouze platny `DEVICE_SECRET` nebo spravny Bearer token bindingu.
- Private gallery file endpoint vyzaduje Bearer token.
- Audit logy jsou dostupne pro App Owner/authorized role.
- Security PIN pro citlive akce funguje.

## 7. Operational monitoring gate

- `/health` vraci `200`.
- `/api/admin/operational-health` je dostupne App Ownerovi.
- `STRICT_OPERATIONAL_HEALTH=true npm run ops:health` probehne proti deploynutemu backendu.
- Telegram alert se odesle pro degradovany stav nebo je vedome vypnuty.
- Stale Stripe/card pending platby generuji warning.
- Offline Relay bindingy generuji warning po limitu.
- Server logy a Sentry jsou dostupne.

## 8. Manual pilot smoke

Spustte po deployi:

1. Prihlasit se jako App Owner.
2. Prihlasit se jako Agency Admin.
3. Prihlasit se jako Senior Operator.
4. Otevrit Dashboard, Profily, Dorucene, Nastaveni, Nastaveni zarizeni.
5. Otevrit Spravu webu a overit public/private galerii.
6. Vytvorit nebo otevrit chat a poslat test odpoved.
7. Poslat inbound SMS na Relay telefon.
8. Overit, ze zprava je v Android SMS, backendu i webu.
9. Spustit test Stripe Checkout v test-mode.
10. Overit `/api/admin/operational-health`.

## 9. Legal and data protection gate

Tato brana chybela. Zbyvajicich devet bran overuje, jestli system funguje —
tahle overuje, jestli ho smime na realnych lidech pustit. Muze zastavit pilot
i pri technicky bezvadnem stavu, proto patri mezi brany, ne do poznamek.

Vecny podklad je v `docs/zpracovani-osobnich-udaju.md`: inventura udaju, toky,
treti strany, doby uchovani a deset otazek, ktere musi rozhodnout clovek.

- Existuje pravni zaklad pro kazdou kategorii zpracovani.
- Zasady ochrany osobnich udaju jsou hotove a verejne dostupne na URL.
  (Tentyz dokument vyzaduje i Google Play.)
- Je splnena informacni povinnost vuci subjektum, ktere s nami nemaji vztah:
  pisatele SMS a osoby na blacklistu.
- Retencni uloha bezi a doby uchovani jsou odsouhlasene, ne vychozi.
- Existuje zaznam o cinnostech zpracovani.
- DPIA je hotova, nebo je zduvodnene, proc neni potreba.
- Je jasne, kde fyzicky lezi databaze a zalohy, a ktere treti strany dostavaji
  jake udaje.
- Je popsany postup pro zadost o export a vymaz udaju konkretni osoby, vcetne
  odpovedne osoby. System na to nema endpoint, takze to bude rucni.
- Monitoring vykonu operatorek (`OperatorMetrics`, `OperatorWorkSession`) ma
  vlastni pravni zaklad a zamestnankyne o nem vedi.

Go/no-go:

- No-go, pokud neexistuje pravni zaklad pro preposilani SMS tretich osob.
- No-go, pokud chybi verejne zasady ochrany osobnich udaju.
- No-go, pokud se nemaze nic a data by se hromadila bez lhuty od prvniho dne.
- No-go, pokud nikdo neni urceny k vyrizovani zadosti subjektu.

## 10. Rollback plan

Frontend:

- Vratit hosting na predchozi build/release.
- Nebo revertovat posledni commit a znovu deploynout.

Backend:

- Zastavit deploy.
- Vratit predchozi commit/tag.
- Spustit `npm install` jen pokud se menily dependencies.
- Spustit `npx prisma migrate deploy`, pokud rollback pouziva kompatibilni schema.
- Restartovat PM2/sluzbu.

Database:

- Preferovat restore do nove DB a prepnout `DATABASE_URL`.
- In-place restore jen jako posledni moznost.
- Po restore spustit health, login a Relay smoke.

Android Relay:

- Mit ulozenou predchozi stabilni APK.
- Pri chybe nove APK vratit predchozi verzi na pilotnim telefonu.
- Po downgrade znovu overit `DEVICE_SECRET`, verify binding a outbox.

## 11. Pilot go/no-go

Go:

- Vsechny brany 1-9 jsou splnene.
- Existuje cerstva overena zaloha.
- Existuje rollback postup a odpovedna osoba.
- Pilot je omezeny na maly pocet uzivatelu/profilu.

No-go:

- CI nebo smoke testy padaji.
- Neni overena zaloha.
- Stripe webhook neaktivuje platbu.
- Relay ztraci SMS.
- Monitoring neni dostupny a nikdo nesleduje logy.
- Chybi pravni zaklad nebo verejne zasady ochrany osobnich udaju.
