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
  `VITE_API_URL` produkcniho API. K 3. 11. 2026 ho tam zamerne NEMA: nahledy
  by na produkci stejne nedosahly, protoze CORS porovnava originy presne
  a adresa nahledu obsahuje cislo pull requestu. Kdyby to nekdo zprovoznil
  zastupnym znakem pro `*--nexus-sync.netlify.app`, zapisoval by s realnymi
  uzivateli nahled z libovolneho pull requestu do jejich dat.

Go/no-go:

- No-go, pokud nahledy na Netlify miri na produkcni API a CORS produkce je pro ne otevreny.
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

**Postup krok za krokem je v `docs/zivy-test-dvou-telefonu.md`** — vcetne toho,
jak si po kazdem kroku overit, co doopravdy lezi v databazi (workflow
`Kontrola relay telefonu`, jen pro cteni). Podrobne testy a logcat jsou
v `docs/android-relay-field-test.md`.

Musi projit:

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
  Tohle je rucni krok a zadne CI ho za vas neudela: hlasil by se na App Ownera
  heslem z workflow, takze uloha, ktera to delala, je od 15. 11. 2026 odstranena.
  Automaticky bezi jen obycejny `/health` v `Hlidka serveru`, kazde dve hodiny.
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

### Distribuce a zasady Obchodu Play

Tahle cast brany chybela a neni to pravni otazka v uzkem smyslu -- je to
otazka, jestli aplikaci vubec smime rozdavat tak, jak ji rozdavame.

Relay se do Obchodu Play **nedava**, instaluje se stranou z vlastniho serveru
(`/api/vultr/download-relay.apk`). Je to vedome rozhodnuti, ne provizorium.
Duvod: `nexusRelay` zada celou omezenou sadu opravneni -- `READ_SMS`,
`RECEIVE_SMS`, `SEND_SMS`, `WRITE_SMS`, `RECEIVE_MMS`, `READ_CALL_LOG`,
`READ_PHONE_STATE`, `CALL_PHONE`, `MANAGE_OWN_CALLS`. Byt vychozi SMS
aplikace je sice povolene pouziti, ale nas ucel neni "zrcadlit zpravy na
druhe zarizeni tehoz cloveka" -- je to "preposlat je operatorkam, ktere na ne
odpovidaji jmenem majitelky cisla". Takovy ucel v povolenem seznamu neni.
Vlastni manifest to rika presne: "Forwards SMS and call events from
a dedicated relay handset to the operator console."

Tvrdsi pravidlo nez SMS zasady je to o stalkerware: sledovat jineho cloveka
je zakazane **i s jeho vedomim a souhlasem**. Vyjimku maji rodicovska kontrola
a sprava firemnich zarizeni, a i ty musi mit v manifestu `IsMonitoringTool`,
trvale oznameni, vlastni ikonu, byt zdarma a nepouzivat platby v Play.
`nexusRelay` priznak `IsMonitoringTool` nema.

Co je naopak v nas prospech a nesmi se to pokazit: varianta, ktera cte SMS,
**nema polohu**. `ACCESS_BACKGROUND_LOCATION` je jen v `nexusFull`. Zpravy
a poloha v jednom balicku jsou presne podpis te kategorie, takze slouceni
obou variant do jednoho APK by riziko zvedlo.

Musi byt splnene:

- Je zapsane, ze relay se nedava do Obchodu, a vi to i ten, kdo bude stavet
  dalsi verzi.
- Modelka vi, ze se jeji prichozi SMS ze SIM karty preposilaji a kdo je cte.
  Je to totez, co resi informacni povinnost vys, jen z druhe strany: Google
  se pta na souhlas majitelky telefonu, GDPR na lidi, kteri ji pisou.
- Pri instalaci se overilo, co rekne Play Protect. Skenuje i aplikace
  instalovane mimo Obchod a aplikace, ktera cte vsechny SMS a posila je na
  server, je kandidat na klasifikaci. Dusledek by nebyl "zamitnuto
  v Obchode", ale varovani pri instalaci nebo vypnuti aplikace na telefonu.
  Predpovedet to nejde, zjisti se az na telefonu -- proto je to krok 0
  v `docs/zivy-test-dvou-telefonu.md`.
- Je rozhodnute, jestli pridat `IsMonitoringTool`. Na sideloadu nic nerozbije
  a je to cestne oznaceni toho, co aplikace dela; pro Obchod by bylo povinne.
- `READ_CALL_LOG` ma znamy duvod. **Neni to nepouzite opravneni**, i kdyz se
  `CallLog` v kodu necte: potrebuje ho `PhoneStateListener`, aby na Androidu
  9-11 vubec dorucil cislo volajiciho (`minSdk` je 24, takze takove telefony
  jsou v rozsahu). Na Androidu 12+ ho nahrazuje
  `TelephonyCallback.CallStateListener`, ktery cislo uz z principu nenese --
  kod tam udalost zahodi (`from == null`) a hovory hlasi `NexusInCallService`,
  ktery tohle opravneni nepotrebuje. Pokud pilotni telefon pojede na Androidu
  12+, da se opravneni omezit pres `android:maxSdkVersion="30"` a jedno
  omezene opravneni z manifestu zmizi. Pred zivym testem to zamerne nemenime
  -- vynutilo by to novy build APK uprostred zkousky.
- Kdyby to nekdy melo byt v Obchode, jedina realna cesta je privatni aplikace
  v Managed Google Play s firemnim zapisem zarizeni, ne verejne vydani.
  `nexusFull` ma vlastni prekazku: `ACCESS_BACKGROUND_LOCATION` patri
  k nejvic zkoumanym opravnenim a chce zvlastni zduvodneni a video.
- Zneni zasad je overene proti zivym strankam, ne proti teto poznamce. Zasady
  se meni: k cervenci 2026 prestava byt `READ_CALL_LOG` povoleny pro
  overovani uctu telefonatem. Nas pripad to neni, ale ukazuje to, ze seznam
  povolenych pouziti nestoji na miste.

### Co presne relay cte, a ze na tom zavisi typ telefonu

Relay nema **zadny filtr odesilatele**. `handleRelay`
(`server/src/controllers/deviceController.js`) ulozi kazdou prichozi SMS,
ktera na cislo relay SIM dojde, a zalozi k ni chat. `BlacklistEntry` je
registr nebezpecnych klientu (telefon, znacka, duvod, zavaznost), ne filtr
zprav, a relay cesta ho vubec necte. Android strana o SIM nevi nic:
`NexusSmsReceiver` vytahne z PDU odesilatele a text, `subscriptionId` nikam
neposila.

Navic se pri kazdem uspesnem pripojeni spusti import historie. `RelayMode.jsx`
vola `syncSmsHistory`, kdyz je `connected`, a `RelayModeView.jsx` mu preda
`{ limit: 500, lookbackMs: 31 dni }`. Nativni cast se zepta na
`Telephony.Sms.Inbox.CONTENT_URI` s podminkou `date > since`, kde `since` je
pri PRVNIM behu `now - 31 dni`, protoze `lastSyncAt` je jeste nula. Dalsi behy
uz jsou prirustkove. Dusledek: prvni pripojeni nahraje az 500 prichozich SMS
za posledni mesic z celeho inboxu, bez ohledu na odesilatele.

Proto zalezi, jaky telefon relay je:

| Scenar | Stav |
| --- | --- |
| **Vyhrazeny telefon** jen pro relay | Soucasny navrh je presne pro tenhle pripad a je v poradku. Import historie nema co nahrat a preposilat vsechno je spravne, protoze na tom cisle nic jineho nechodi. |
| **Osobni telefon** pouzivany i jako relay | Soucasny navrh tohle **neumi bezpecne**. Prvni pripojeni nahraje mesic soukrome korespondence a dal se preposila kazda prichozi SMS: banka, rodina, lekar. Relay je navic v tomhle scenari jeji vychozi SMS aplikace. |

Ze je kod postaveny na prvnim scenari, rika i komentar v
`NexusRelayPlugin.java`: "Relay je zarizeni se SIM, ktere nikam nechodi."

Druhy scenar **neni nastaveni, ale funkce**. Nejcistsi pravidlo je *pracovni
SIM*: preposilat jen zpravy prijate na pracovni SIM a zpravy z osobni SIM
nesmi telefon vubec opustit. Dnes to nejde na zadnem kroku cesty -- receiver
`subscriptionId` necte, payload ho nenese, server ho neuklada a `handleRelay`
nefiltruje. Alternativa "preposilat jen od cisel, ktera uz maji chat" je
leciva jen zdanlive: prvni zprava noveho klienta by nikdy nedosla, cili by to
rozbilo presne to, k cemu relay je.

Musi byt splnene:

- Je rozhodnute, ktery scenar pilot pouziva, a je to zapsane v postupu testu.
- Pokud osobni telefon: existuje filtr podle pracovni SIM od Androidu az po
  `handleRelay` a je overene, ze zprava z osobni SIM telefon neopusti.
- Import historie pri pripojeni ma vedome nastavene okno. 31 dni je vychozi
  stav, ktery nikdo nezvolil, ne rozhodnuti.

Go/no-go:

- No-go, pokud neexistuje pravni zaklad pro preposilani SMS tretich osob.
- No-go, pokud chybi verejne zasady ochrany osobnich udaju. Navrh je
  v `docs/zasady-ochrany-osobnich-udaju-NAVRH.md` a je zamerne nehotovy —
  ma 18 mist, kde odpoved nevyplyva z kodu. Vyplnit je odhadem a zverejnit
  by znamenalo zavazne prohlaseni o pravnim zakladu, ktery nikdo neposoudil.
- No-go, pokud se nemaze nic a data by se hromadila bez lhuty od prvniho dne.
- No-go, pokud nikdo neni urceny k vyrizovani zadosti subjektu.
- No-go, pokud se relay dostane do verejneho Obchodu Play s touhle sadou
  opravneni a timhle ucelem.
- No-go, pokud modelka nevi, ze jeji prichozi SMS cte nekdo jiny.
- No-go, pokud se SMS varianta a varianta s polohou slouci do jednoho APK.
- No-go, pokud se jako relay pouzije osobni telefon bez filtru podle
  pracovni SIM.
- No-go, pokud prvni pripojeni nahraje zpravy, ktere s praci nemaji co delat.

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
