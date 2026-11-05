# Noční průchod aplikací — 5. 11. 2026

Průchod webem jako **Testovaci Operatorka Druhá** (`test-op2`, role Operator,
bez přiřazeného profilu) proti produkci, plus telefon přes adb.

Řazeno podle závažnosti. U každého nálezu je **doklad**, ne dojem. Na konci je
seznam toho, co jsem **neprošel** — ať to nevypadá jako prověřené.

---

## 1. Operátorce padá hlavní načtení dat (vysoká)

`useNexusData.js:464` načítá dvanáct věcí naráz přes `Promise.all`. Tři
z nich **nemají `.catch()`**:

```js
axiosWithTiming(`${API_BASE}/chats`, …),            // bez catch
axiosWithTiming(`${API_BASE}/device/bindings`, …),  // bez catch
axiosWithTiming(`${API_BASE}/agency/stats`, …),     // bez catch
```

A `/agency/stats` operátorce **vrací 403**. Změřeno jejím vlastním tokenem:

```
403  /agency/stats
200  /chats                 pole(1)
200  /device/bindings
200  /profiles              pole(3)      ← data existují
403  /analytics/summary     (.catch() má → neuškodí)
403  /admin/features        (.catch() má → neuškodí)
```

U `Promise.all` stačí jedno odmítnutí a padne celý blok. Operátorka tedy
nedostane nic z toho načtení, přestože `/profiles` jí vrací tři modelky.
To odpovídá hlášenému „nevidím žádnou přiřazenou modelku".

**Oprava:** buď `.catch(() => null)` i na ty tři, nebo `Promise.allSettled`.
Lepší je druhé — jinak se stejná past vrátí s dalším endpointem.

**Pozn.:** samotné 403 na `/agency/stats` může být správně (statistiky
agentury operátorce nepatří). Vadné je, že to shodí všechno ostatní.

---

## 2. Dashboard operátorky ukazuje samé nuly (střední)

VYŘEŠENÉ ZPRÁVY 0, REZERVACÍ CELKEM 0, RŮST PROVIZÍ 0 %, TREND PŘÍJMŮ prázdný.

Všechno se čte jako `stats?.X || 0` a `stats` se plní právě z toho načtení,
které padá podle nálezu 1. Je to tedy nejspíš následek, ne samostatná chyba —
ale i kdyby se načtení opravilo, zůstává otázka, **jestli má operátorka
dashboard s čísly agentury vůbec vidět**, když na `/agency/stats` nemá právo.

Dnes jí ukazuje nuly, což je horší než neukázat nic: vypadá to, že agentura
nic nedělá.

---

## 3. Klik na Dashboard funguje (nepotvrzeno jako chyba)

Hlášeno jako nefunkční. **Nereprodukoval jsem to.** Klik přepne na
`/dashboard` a volání odejdou:

```
18:43:43  GET /api/agency/relay-status   200
18:43:43  GET /api/team-chat/unread      200
18:43:43  GET /api/chats                 200
18:43:53  GET /api/chats                 200   ← dotaz každých 10 s
```

Pravděpodobně šlo o to, co popisuje nález 2 — stránka se otevře, ale je
prázdná. Kdyby se to opakovalo jinak, potřebuju vědět, co přesně se nestalo.

---

## 4. Socket se po startu nepřipojí a už to nezkouší (střední)

V konzoli se opakuje:

```
WebSocket connection to 'wss://api.nexusstack.eu/socket.io/' failed
Socket connection _err: websocket error
```

**Server za to nemůže** — ověřeno třemi pokusy:

```
polling handshake           200, upgrades: ["websocket"]
raw WebSocket               OTEVŘENO
CONNECT s tokenem operátorky 40{"sid":"qL_rrXL_Pb-6UbpcAAAI"}   ← přijato
```

Přenos i ověření fungují. Chyba je tedy na straně klienta — a za dvacet
sekund sledování **nepřišel žádný další pokus o spojení**, takže to po
neúspěchu nezkouší znovu.

Důsledek: web nemá živé aktualizace a jede na desetisekundovém dotazování
`/api/chats`. Souvisí to s tím, proč je odchozí zpráva pomalá.

---

## 5. Co funguje (ověřeno, ne předpokládáno)

- **Příchozí SMS** projde celou cestou: telefon → `/api/device/relay` →
  `Message(INBOUND)` v databázi → vidět v Doručených.
- **Odchozí zpráva** z webu dorazí do telefonu; v chatu je vidět
  („odpovídám ha", 19:36). Zpoždění do 30 s je dané
  `POLL_INTERVAL_S = 30` v `NexusRelayForegroundService`.
- Oprava `profileId` z #177 je v provozu: poslední HTTP 400 v 19:35:53,
  od 19:36:23 chodí `?profileId=cmw3fvzg…`.

---

## Co jsem NEPROŠEL

Není to prověřené a nemá se to tak brát:

- CRM, Kalendář, Rezervace, Blacklist, Bezpečnost/SOS, Tým, Nastavení,
  Fakturace
- cokoli pod rolí manažerky nebo app ownera
- mobilní rozložení webu
- obrazovky relaye kromě hlavní (Číselník, Zprávy)
- odesílání SMS z telefonu ven (nechtěl jsem posílat skutečné zprávy
  na cizí čísla)

---

## Dodatek: plošný oťuk API pod rolí operátorky

Třicet GET endpointů jejím vlastním tokenem. Jen čtení, nic se nezapisovalo.

**Projde (200) — 16 endpointů:**
`/agency/settings`, `/agency/relay-status`, `/profiles`, `/chats`,
`/bookings`, `/clients`, `/blacklist`, `/trackers`, `/sos/active`,
`/team-chat/messages`, `/referrals/stats`, `/subscriptions/current`,
`/sip/config`, `/salon-keys`, `/emergencies`, `/device/bindings`

**Odmítnuto (403) — 7 endpointů:**
`/agency/stats`, `/audit-logs`, `/qa/reviews`, `/trunks`,
`/analytics/summary`, `/developer/keys`, `/admin/features`

Tohle vypadá **správně** — jsou to věci pro manažerku a výš. Problém není
403 sama o sobě, ale že jedna z nich (`/agency/stats`) shazovala celé
načtení; to řeší #180.

**Vrátilo 404 — 7 cest:** `/inventory`, `/notes`, `/safety/sessions`,
`/payouts`, `/billing/invoices`, `/calls`, `/ai/suggestions`.
**Neberte to jako nález.** Ty cesty jsem odhadl podle názvů modulů a
nejspíš jsem minul skutečné podcesty. Ověřené to není.

### Co z toho plyne k rozsahu operátorky

`/profiles` jí vrací **tři modelky**, ačkoli nemá přiřazenou ani jednu —
tedy přesně to, co opravuje #179, zatím na produkci platí.

Stejnou otázku si zaslouží `/clients` a `/blacklist`: obojí operátorce
projde a obojí je dnes omezené nejspíš jen agenturou. Do #179 jsem je
nezahrnul, protože vaše pravidlo mluvilo o chatech a modelkách —
jestli má platit i na klienty, je to další místo.
