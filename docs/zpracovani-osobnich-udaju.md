# Zpracování osobních údajů — věcný podklad

## K čemu tenhle dokument je

Je to **inventura toho, co systém skutečně dělá s osobními údaji**, sestavená ze zdrojového kódu — datového modelu, kontrolerů a konfigurace. Slouží jako vstup pro právníka, který z toho sestaví zásady ochrany osobních údajů, záznam o činnostech zpracování a případně DPIA.

**Není to právní posouzení.** Nestanovuje právní základ, nerozhoduje o rolích správce a zpracovatele a netvrdí, že je něco v souladu nebo v rozporu. Tam, kde rozhodnutí patří člověku, je otázka v sekci [Otevřené otázky](#otevřené-otázky-pro-právní-revizi).

Ověřeno proti commitu na `master` z 3. 11. 2026. Co pochází z neslučeného PR #136, je výslovně označené.

---

## 1. Kdo je v systému kdo

Role (`server/prisma/seed*.js`): **App Owner**, **Agency Admin**, **Manager**, **Senior Operator**, **Operator**, **Model**.

Data jsou oddělená po agenturách (`agencyId` téměř na každé tabulce). Přístup napříč agenturami se loguje do `DataAccessLog` včetně příznaku `violation`.

### Kategorie subjektů údajů

| Subjekt | Kdo to je | Ví o zpracování? |
| --- | --- | --- |
| Zaměstnanci / operátorky | `User` — přihlašují se, pracují v konzoli | Ano, je to pracovní nástroj |
| Modelky | `Profile`, `User` s rolí Model | Ano |
| Klienti | `Client`, `Booking`, `ClientNote` | Pravděpodobně částečně |
| **Pisatelé SMS** | `Message`, `Chat.externalId` — kdokoli, kdo napíše na relay telefon | **Ne** |
| **Osoby na blacklistu** | `BlacklistEntry` — jméno, telefon, registrační značka | **Ne** |

Poslední dvě kategorie jsou z právního hlediska nejexponovanější: tito lidé s vámi nemají žádný vztah, nic nepodepsali a o existenci systému nevědí.

---

## 2. Inventář údajů

### 2.1 Obsah komunikace

| Tabulka | Co obsahuje | Kde vzniká |
| --- | --- | --- |
| `Message` | `text` (obsah SMS), `direction`, `transport`, `status` | Relay telefon → backend; odpovědi z konzole |
| `Chat` | `externalId` (telefonní číslo protistrany), `lastMessageAt` | Automaticky při první zprávě |
| `ChannelMessage` | `body`, `from`, `to`, `mediaUrls`, `mediaType` | Omnichannel kanály a webhooky |
| `CallLog` | `from` (číslo volajícího), `duration`, `status` | Relay telefon / SIP |
| `TeamMessage` | `text`, `author`, `room` | Interní chat |
| `ClientNote` | `text` (volný text o klientovi), `clientPhone`, `authorName` | Zápis operátorky |

Obsah komunikace je nejcitlivější kategorie běžných údajů v celém systému.

### 2.2 Poloha

| Tabulka | Co obsahuje | Kde vzniká |
| --- | --- | --- |
| `SafetyLocationPoint` | `lat`, `lng`, `accuracy`, `capturedAt` | Aplikace během bezpečnostní relace |
| `GpsTrackerLocation` | `lat`, `lng`, `accuracy`, `speedKph`, `heading`, `battery`, `raw` | GPS tracker |
| `GpsTracker` | `imei`, poslední známá pozice, `secretHash` | Registrace trackeru |
| `SOSLocationUpdate`, `SOSAlert` | `lat`, `lng`, `accuracy`, kdo potvrdil a vyřešil | Tísňové volání |

Jde o **přesné polohové stopy v čase**, ne o jednorázové údaje. `GpsTrackerLocation.raw` navíc drží surovou zprávu zařízení.

### 2.3 Hodnocení a soupisy osob

| Tabulka | Co obsahuje | Poznámka |
| --- | --- | --- |
| `BlacklistEntry` | `phone`, `licensePlate`, `name`, `description`, `severity` | Soupis osob s negativním hodnocením |
| `BlacklistReport` | `comment`, `reportedByName` | Jednotlivá hlášení k záznamu |
| `Client` | `phone`, `name`, `totalSpent`, `lastVisit`, `tags`, `preferences`, `notes` | Profilování klientů |
| `QaRecord`, `QaReview` | `rating`, `comment`, `category` | Hodnocení kvality |

PR #136 u blacklistu nahrazuje volný text výčtem důvodů (`blacklistReasons`), což riziko snižuje — pole `description` ale zůstává.

### 2.4 Monitoring zaměstnanců

| Tabulka | Co obsahuje |
| --- | --- |
| `OperatorWorkSession` | `loginAt`, `logoutAt`, `lastActivityAt`, `currentTalent` |
| `OperatorMetrics` | `messagesHandled`, `avgResponseTime`, `maxResponseTime`, `resolutionRate`, `onlineMinutes`, `activeMinutes` |

Tohle je sledování výkonu zaměstnanců. V EU má obvykle vlastní režim a vlastní informační povinnost, nezávisle na ostatním zpracování.

### 2.5 Identifikátory, přístupy a platby

| Tabulka | Co obsahuje |
| --- | --- |
| `User` | `email`, `password` (hash), `name`, `securityPin` |
| `DeviceBinding` | `installationId`, `model`, `deviceName`, `sipUser`, `sipPassword`, `sipServer` |
| `PushDevice` | `token`, `platform`, `lastSeenAt` |
| `DataAccessLog` | `ipAddress`, `userAgent`, `action`, `resourceType`, `violation` |
| `AuditLog` | `action`, `details`, `integrityHash` |
| `Subscription` | `stripeCustomerId`, `stripeSubscriptionId`, `amountPaid`, `paymentRef` |
| `RefreshToken`, `ApiKey`, `SalonKey`, `SalonKeyLog` | Přístupové tokeny a klíče |

---

## 3. Toky dat

**SMS a hovory.** SMS přijde na relay telefon → aplikace ji přepošle na backend (autentizace `installationId` + HMAC z `DEVICE_SECRET`, bez Bearer tokenu) → uloží se do `Message` → zobrazí se v konzoli. Odpovědi tečou opačně přes outbox. Hovory vedou přes SIP/Asterisk, metadata do `CallLog`.

**Poloha.** Aplikace nebo GPS tracker → backend → `SafetyLocationPoint` / `GpsTrackerLocation`. Při SOS navíc `SOSLocationUpdate`.

**Návrhy odpovědí (AI).** `aiController` volá `aiService`, který mluví s **Ollamou** na `AI_BASE_URL`, výchozí `http://127.0.0.1:11434/api`, model `llama3.1:8b-instruct-q4_0`. Ve výchozí konfiguraci tedy **obsah zpráv neodchází žádné cizí AI službě** — model běží lokálně. Do `AiSuggestion` se ukládá jen metadatum (zdroj, model, výsledek), ne text.

> Pozor: tohle platí, dokud `AI_BASE_URL` míří na vlastní stroj. Přesměrování na hostovanou službu by z toho udělalo předání obsahu komunikace třetí straně.

---

## 4. Třetí strany

Z kódu (`server/src`):

| Služba | Role | Co se jí předává |
| --- | --- | --- |
| **Stripe** | Platby a předplatné | Identifikátory zákazníka a platby; `stripeCustomerId` u nás |
| **Fio banka** | Bankovní synchronizace (`fioSyncWorker`) | Platební údaje |
| **Firebase** | Hosting frontendu, push notifikace (FCM) | Push tokeny zařízení |
| **Telegram** | Provozní alerty (`api.telegram.org`) | Obsah alertů — záleží, co se do nich píše |
| **Vultr / Hetzner** | Infrastruktura (API volání v kódu) | Vše, co leží na serveru |
| **Ollama** | Návrhy odpovědí | Obsah zpráv — **lokálně**, viz výš |
| **Asterisk** | SIP telefonie | Hovorová signalizace a metadata |

Kromě toho: GSM operátor relay telefonu vidí veškerý SMS i hovorový provoz už z povahy věci.

**Nezjištěno z kódu:** fyzické umístění databáze a záloh. V kódu jsou volání na API Vultru i Hetzneru; který z nich hostuje produkci a v jakém regionu, je potřeba doplnit — má to vliv na otázku přenosů mimo EU.

---

## 5. Doby uchování

### Současný stav na `master`

**Žádná data se nemažou.** Systém nemá retenční úlohu; zprávy, polohy i logy se hromadí bez konce.

### Co by zavedlo PR #136 (neslučené)

Denní úloha ve 3:00, doby nastavitelné přes prostředí:

| Datová sada | Výchozí doba | Proměnná |
| --- | --- | --- |
| `SafetyLocationPoint` | 7 dní | `RETENTION_SAFETY_LOCATIONS_DAYS` |
| `GpsTrackerLocation` | 7 dní | `RETENTION_TRACKER_LOCATIONS_DAYS` |
| `SOSLocationUpdate` | 90 dní | `RETENTION_SOS_LOCATIONS_DAYS` |
| `Message` | 365 dní | `RETENTION_MESSAGES_DAYS` |
| `DataAccessLog` | 180 dní | `RETENTION_ACCESS_LOGS_DAYS` |
| `AuditLog` | neomezeně (0) | `RETENTION_AUDIT_LOGS_DAYS` |

### Co by ani po #136 nemělo žádnou lhůtu

`Chat`, `ChannelMessage`, `CallLog`, `ClientNote`, `Client`, `BlacklistEntry`, `BlacklistReport`, `Booking`, `QaRecord`, `QaReview`, `TeamMessage`, `OperatorWorkSession`, `OperatorMetrics`, `EmergencyEvent`, `AiSuggestion`, `PushDevice`, `DeviceBinding`.

Tedy i po sloučení #136 by bez lhůty zůstal obsah omnichannel zpráv, seznam volání, poznámky o klientech, blacklist a metriky operátorek. #136 je začátek retenční politiky, ne celá.

---

## 6. Zabezpečení — co je skutečně zavedené

**Šifrované v databázi**, dvěma různými klíči:

- `Profile.credentials` — `encrypt()` z `utils/encryption.js`, klíč `ENCRYPTION_KEY`.
- SIP hesla (`DeviceBinding.sipPassword`, `SipTrunk`) — `services/sipEncryption.js`, klíč **`SIP_ENCRYPTION_KEY`** (hex o 64 znacích, jinou délku funkce odmítne).

**Nešifrované v databázi:** obsah zpráv, telefonní čísla, jména, polohové body, blacklist, poznámky. Chrání je přístup k databázi a aplikační autorizace, ne šifrování na úrovni sloupců.

**Hesla i bezpečnostní PIN** jsou hashované bcryptem s cost 12 (`User.password`, `User.securityPin`) — tedy neobnovitelné, ne jen zašifrované.

**Práva subjektů:** v kódu není žádný endpoint pro export ani výmaz údajů konkrétní osoby. Ověřeno hledáním v `server/src` — nic takového neexistuje. Žádost by se dnes řešila ručním zásahem do databáze.

**Zálohy:** PR #136 přidává `archive-encrypted.sh` — `pg_dump` zašifrovaný GPG se passphrase ze souboru.

**Přístup a dohled:** oddělení po `agencyId`, RBAC podle rolí, `AuditLog` s `integrityHash`, `DataAccessLog` s IP a `violation` příznakem, bezpečnostní PIN pro citlivé akce.

**Logy CI:** terénní test dřív vypisoval do logu běhu části odpovědí serveru, tedy obsah SMS a čísla. Opraveno v #143 (redakce) a #142 (klíče).

---

## 7. Otevřené otázky pro právní revizi

Technika na ně odpověď nedá:

1. **Správce vs. zpracovatel.** Je správcem agentura a vy zpracovatel, nebo jste u některých zpracování správcem sám? Liší se to podle datové sady (platby, blacklist, metriky).
2. **Právní základ pro pisatele SMS.** Tito lidé nedali souhlas a nejsou vaši klienti. Jaký je základ a jak se plní informační povinnost?
3. **Blacklist.** Soupis osob s negativním hodnocením, vedený bez jejich vědomí. Jaký právní základ, jak dlouho, jak se takový záznam napadá a maže?
4. **Monitoring operátorek.** Vlastní základ, vlastní informování, případně projednání se zaměstnanci.
5. **Poloha.** Sledování polohy lidí v čase — souhlas, nebo oprávněný zájem s posouzením? Je výchozích 7 dní obhajitelné?
6. **DPIA.** Obsah komunikace + sledování polohy + soupis osob je kombinace, která posouzení vlivu obvykle vyžaduje.
7. **Umístění dat.** Kde fyzicky leží databáze a zálohy, a kam sahají Stripe a Firebase.
8. **Práva subjektů.** Systém dnes nemá postup na výmaz ani export údajů konkrétní osoby. Jak se bude vyřizovat žádost pisatele SMS, kterého nelze dohledat jinak než podle čísla?
9. **Relay telefon.** Čí je SIM, kdo je účastník, jak je informována protistrana hovoru.
10. **Doby uchování** z tabulky výš — potvrdit, nebo opravit, a doplnit datové sady bez lhůty.

---

## 8. Co z toho plyne pro pilot

`docs/pilot-readiness-checklist.md` má deset bran a **žádná není právní**. K dokumentu výš proto patří tři poznámky k pilotu:

- Pilot bez právního základu a informační povinnosti je rizikový nezávisle na tom, jak dobře funguje technika.
- Spouštět pilot na současném stavu znamená začít s **nulovou retencí** — data by se hromadila od prvního dne. Sloučení #136 by to zmírnilo, byť ne vyřešilo.
- Chybí postup pro žádosti subjektů. U pilotu s malým počtem uživatelů to jde zvládnout ručně, ale musí být jasné kdo a jak.

Zvažte přidání jedenácté brány: *právní podklady hotové a odsouhlasené*.
