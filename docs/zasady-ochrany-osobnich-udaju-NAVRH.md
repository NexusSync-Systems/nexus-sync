# Zásady ochrany osobních údajů — NÁVRH K PRÁVNÍ REVIZI

> **Tohle není hotový dokument a nesmí se zveřejnit v téhle podobě.**
>
> Je to návrh sestavený z toho, co systém podle kódu skutečně dělá
> (`docs/zpracovani-osobnich-udaju.md`, ověřeno proti `master`). Vyplňuje
> strukturu, kterou vyžaduje GDPR čl. 13 a 14 a kterou chce Google Play
> u publikované aplikace.
>
> **Místa označená `[DOPLNIT]` nejsou opomenutí.** Jsou to body, kde odpověď
> nevyplývá z kódu a patří člověku — většinou právníkovi. Vyplnit je odhadem by
> znamenalo zveřejnit tvrzení o právním základu, které nikdo neposoudil.
>
> Nejzávažnější z nich je hned ten první: **dokud není jasné, kdo je správce,
> není jasné, čím jménem je celý dokument psaný.**

---

## 1. Kdo zpracovává vaše údaje

[DOPLNIT: obchodní firma, sídlo, IČO, kontaktní e-mail.]

[DOPLNIT — otevřená otázka č. 1 z věcného podkladu: je správcem agentura, která
systém používá, a provozovatel systému zpracovatelem? Nebo je provozovatel
u některých zpracování správcem sám? Liší se to podle datové sady — platby,
blacklist a provozní metriky mohou spadat jinam než obsah komunikace.
**Na téhle odpovědi stojí celý zbytek dokumentu**, protože určuje, kdo tohle
prohlášení vydává a komu se podávají žádosti.]

[DOPLNIT: pověřenec pro ochranu osobních údajů — jestli je jmenovaný, jeho
kontakt. Pro kombinaci obsahu komunikace, sledování polohy a soupisu osob se
pověřenec obvykle zvažuje.]

## 2. Jaké údaje zpracováváme

Systém se skládá z webové konzole, mobilní aplikace pro pracovníky agentury
a z relay zařízení — telefonu se SIM kartou, který přijímá a odesílá SMS.

### 2.1 Obsah komunikace

Odeslané a přijaté SMS včetně textu, telefonních čísel obou stran a času.
Zprávy jsou v databázi **v otevřené podobě** — nejsou šifrované na úrovni
aplikace.

### 2.2 Poloha

Při bezpečnostní relaci (doprovod pracovnice na schůzku) se zaznamenává poloha
v čase. Dále polohy z GPS sledovačů a polohy při SOS události.

### 2.3 Hodnocení a soupisy osob

Záznamy o klientech, poznámky k nim a blacklist — soupis osob s negativním
hodnocením, který může obsahovat jméno, telefonní číslo a registrační značku
vozidla.

### 2.4 Provozní údaje o pracovnících

Přihlášení, činnost v konzoli, přístupy k datům napříč agenturami, audit.

### 2.5 Identifikátory a platby

Přihlašovací údaje, identifikátory zařízení, push tokeny, identifikátory
zákazníka u platební brány.

## 3. Proč to zpracováváme a na jakém základě

| Účel | Právní základ |
| --- | --- |
| Poskytování služby objednateli (agentuře) | [DOPLNIT] |
| Bezpečnost pracovnic — doprovod, SOS | [DOPLNIT — otevřená otázka č. 5: souhlas, nebo oprávněný zájem s posouzením?] |
| Soupis rizikových osob (blacklist) | [DOPLNIT — otevřená otázka č. 3] |
| Evidence a vyřizování komunikace s klienty | [DOPLNIT] |
| Platby a účetnictví | [DOPLNIT] |
| Bezpečnostní audit | [DOPLNIT] |

### Zvláštní upozornění: pisatelé SMS

**Kdokoli, kdo napíše na číslo relay telefonu, se stává subjektem údajů.**
Tito lidé s provozovatelem nemají žádný vztah, nic nepodepsali a o existenci
systému nevědí. Totéž platí pro osoby vedené na blacklistu.

Na tyhle případy dopadá **čl. 14 GDPR** (údaje nezískané od subjektu), který
ukládá informační povinnost i vůči nim.

[DOPLNIT — otevřené otázky č. 2 a 3: jaký je právní základ a jak se vůči těmto
lidem plní informační povinnost. Dnes se neplní nijak.]

## 4. Komu údaje předáváme

| Příjemce | K čemu | Co se předává |
| --- | --- | --- |
| Stripe | platby a předplatné | identifikátory zákazníka a platby |
| Fio banka | párování plateb | platební údaje |
| Firebase (Google) | hosting webu, push notifikace | push tokeny zařízení |
| Telegram | provozní upozornění | obsah upozornění |
| Poskytovatel serveru | provoz systému | vše, co je na serveru |

**Mobilní operátor** relay telefonu vidí veškerý SMS a hovorový provoz už
z povahy věci — bez ohledu na nastavení systému.

Návrhy odpovědí připravuje **jazykový model běžící lokálně** na serveru; obsah
zpráv se k tomuto účelu nikam neodesílá.

[DOPLNIT — otevřená otázka č. 7: kde fyzicky leží databáze a zálohy a zda
dochází k předávání mimo EU, zejména u Stripe a Firebase.]

## 5. Jak dlouho údaje uchováváme

Hodnoty jsou nastavitelné; níže jsou výchozí.

| Údaj | Výchozí doba |
| --- | --- |
| Polohy při bezpečnostní relaci | 7 dní |
| Polohy ze sledovačů | 7 dní |
| Polohy při SOS | 90 dní |
| Zprávy | 365 dní |
| Logy přístupů k datům | 180 dní |
| Bezpečnostní audit | neomezeně |

Bezpečnostní audit se nemaže záměrně: nese řetěz kontrolních součtů a smazání
nejstarších záznamů by ten řetěz přetrhlo.

[DOPLNIT — otevřená otázka č. 10: potvrdit nebo opravit. A doplnit datové sady,
které dnes žádnou lhůtu nemají — záznamy o klientech, blacklist, nahrávky
a přílohy.]

## 6. Vaše práva

Máte právo na přístup ke svým údajům, jejich opravu, výmaz, omezení
zpracování, přenositelnost a právo vznést námitku. Máte také právo podat
stížnost u Úřadu pro ochranu osobních údajů.

[DOPLNIT: kontakt, na který se žádost podává, a lhůta vyřízení.]

[DOPLNIT — otevřená otázka č. 8: systém dnes nemá postup pro výmaz ani export
údajů konkrétní osoby. **Než se tenhle dokument zveřejní, musí takový postup
existovat** — slibovat právo, které se nemá jak uplatnit, je horší než mlčet.
Zvlášť u pisatele SMS, kterého nelze dohledat jinak než podle čísla.]

## 7. Rozhodování automatizovanými prostředky

Systém připravuje návrhy odpovědí, ale **odpověď odesílá člověk**. Nedochází
k rozhodování, které by mělo právní účinky nebo se obdobně významně dotýkalo,
výhradně automatizovanými prostředky.

[DOPLNIT: potvrdit, že to platí i pro blacklist — zařazení na soupis je
rozhodnutí člověka, ale jeho dopad na dotčenou osobu je podstatný.]

## 8. Děti

Služba není určena osobám mladším 18 let a vědomě o nich neshromažďujeme údaje.

## 9. Mobilní aplikace

Aplikace existuje ve dvou podobách a každá má jiný rozsah:

**Pracovní aplikace** žádá o přístup k poloze včetně polohy na pozadí. Slouží
k bezpečnostnímu doprovodu pracovnice během schůzky.

**Relay aplikace** žádá o přístup k SMS a záznamu hovorů. Běží na vyhrazeném
telefonu agentury a slouží k přeposílání zpráv mezi klientem a konzolí.

[DOPLNIT — otevřená otázka č. 9: čí je SIM karta v relay telefonu, kdo je
účastníkem a jak je o zpracování informována protistrana.]

## 10. Změny

[DOPLNIT: jak se oznamují změny a od kdy je dokument účinný.]

---

## Co musí být hotové, než se tohle zveřejní

1. **Role správce** (otázka č. 1) — bez ní dokument nemá vydavatele.
2. **Právní základ** pro pisatele SMS a pro blacklist (otázky č. 2 a 3).
3. **Funkční postup pro práva subjektů** (otázka č. 8). Zveřejněné zásady jsou
   veřejný slib; jakmile vyjdou, může se kdokoli dovolat výmazu.
4. **Umístění dat** (otázka č. 7) — kvůli odstavci o předávání.
5. **DPIA** (otázka č. 6) — kombinace obsahu komunikace, sledování polohy
   a soupisu osob posouzení vlivu obvykle vyžaduje.

Plné znění otázek je v `docs/zpracovani-osobnich-udaju.md`, oddíl 7.

**Pozor na pořadí.** Google Play i brána 9 pilotního checklistu vyžadují
veřejnou URL zásad. Je svůdné vyplnit mezery odhadem, aby se odškrtla
položka — ale zveřejněné zásady jsou závazné prohlášení vůči komukoli, koho se
zpracování týká. Nesprávné tvrzení o právním základu je horší než chybějící
dokument.
