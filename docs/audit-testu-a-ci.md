# Audit automatizovaných testů a CI

Stav k 5. 11. 2026, repozitář `NexusSync-Systems/nexus-sync`.

Rozsah: co se testuje, co se v CI opravdu spouští, jak čitelné jsou výsledky
a jestli má smysl zakládat issues automaticky. **Není to bezpečnostní audit
aplikace** — ten je jiná práce.

## Co existuje

| Vrstva | Nástroj | Souborů | Spouští CI |
| --- | --- | --- | --- |
| server | jest | 69 | ano, `Lint & Test` |
| server – bezpečnost relay | jest | z toho 2 | ano, zvlášť a dřív než zbytek |
| klient | vitest | 8 | ano, `Build Client` |
| E2E | Playwright | 38 | **jen 13** |
| android nativní | Playwright | 2 | ne |
| schema drift | prisma | — | ano |
| oprávnění v manifestu | vlastní | — | ano |
| údržba instance | vlastní | — | ano (od #156) |

Pro úplnost: klientské testy **běží**, jen ne v úloze `Lint & Test`, kde by je
člověk čekal — jsou v `Build Client` ([ci.yml:134](../.github/workflows/ci.yml)).
Sám jsem se na to při auditu napálil.

## Nálezy

### 1. Sedmdesát dva procent E2E testů se nikdy nespustí — vysoká

**Důkaz.** `test:all:e2e` v `package.json` je ruční výčet 13 souborů, zatímco
v `tests/` jich je 38.

| | |
| --- | --- |
| testů běžících v CI | 46 |
| testů ležících ladem | **118** v 25 souborech |
| podíl nespouštěného | **72 %** |

**Nejsou vyřazené schválně.** Žádná z nich nemá podmínku na proměnnou
prostředí a `git log -S'test:all:e2e' -- package.json` vrací jen dva commity:
ten, který výčet založil, a jeden o dokumentaci. Specifikace tedy přibývaly
a do výčtu se nikdy nedopsaly.

**Co leží ladem** (výběr, ne úplný seznam):

| Oblast | Soubory |
| --- | --- |
| peníze | `stripe_billing`, `stripe_payment_e2e` |
| bezpečnost | `feature_locks_fail_closed` |
| data a compliance | `audit_logs`, `blacklist_panel` |
| jádro produktu | `calendar_booking`, `calendar_safety`, `onboarding`, `navigation` |
| relay | `device_bindings_bez_profilu`, `relay_status_odznak`, `zarizeni_neodpovida` |
| plošné | `zadna_stranka_nepada`, `sanity` |

**Scénář selhání.** Kdokoli rozbije fail-closed chování zámků funkcí nebo
platební tok, CI zůstane zelené. Test, který na to existuje, se nespustí.

**Návrh opravy.** Zrušit ruční výčet. `npx playwright test` bez argumentů
spustí všechno, co v `tests/` je — a nová specifikace se tím zapojí sama.

**Pozor, není to přepnutí jedné volby.** Těch 118 testů nikdo dlouho
nespouštěl, takže část bude padat nebo být nestabilní. Postup musí být:
nejdřív je spustit a změřit, pak rozhodnout u každého zvlášť (opravit /
odložit s uvedeným důvodem / smazat). Zapnout to naslepo by znamenalo
natrvalo červené CI, což je horší než dnešní stav — na červenou se přestane
koukat.

### 2. Tři ruční seznamy téhož, které se rozcházejí — střední

**Důkaz.**

| Kde | Kolik specifikací |
| --- | --- |
| `test:e2e` (package.json) | 9 |
| `test:all:e2e` (package.json) | 13 |
| `scripts/summarize-tests.js:6` | 4 |

**Scénář selhání.** Vývojář spustí `npm run test:e2e`, projde mu to, a v CI
padne něco, co jeho výčet neobsahoval. Nebo naopak: oprava se ověří lokálně
seznamem, který v CI neběží.

Je to táž vada, která dnes způsobila dvě jiné chyby v tomhle repozitáři:
rozcházející se seznamy CORS originů (#152) a dva různé seznamy plánů
s API přístupem (#148). Ruční seznam téhož na dvou místech se rozejde vždy,
je to jen otázka času.

**Návrh opravy.** Jeden zdroj: Playwright projekty v `playwright.config.js`.
`test:e2e` ať je podmnožina definovaná značkou (`--grep @rychle`), ne výčtem
jmen.

### 3. Pokrytí se neměří a nemá práh — střední

**Důkaz.** `server/package.json:22` definuje `test:ci` s `--coverage`, ale
**CI volá `npm test`**, tedy variantu bez pokrytí ([ci.yml:48](../.github/workflows/ci.yml)).
`coverageThreshold` v jest konfiguraci **není nastavený**.

**Scénář selhání.** Přibude controller bez jediného testu a nic to neohlásí.
Dnes není jak říct, jestli pokrytí roste, nebo klesá.

**Návrh opravy.** V CI volat `test:ci`, souhrn vypsat do shrnutí úlohy (viz
nález 4) a práh zavést **až podle naměřené hodnoty**, ne od stolu. Práh
nastavený nad skutečnost udělá z CI překážku, kterou lidi obcházejí.

### 4. Výsledky testů nejsou v Actions čitelné — střední

**Důkaz.** `$GITHUB_STEP_SUMMARY` se v repozitáři používá na třech místech
a **ani jedno se netýká testů** — jsou to `release-aab.yml` a stav pojistky
relay field testu.

**Scénář selhání.** Úloha zčervená a jediné, co je vidět, je její název.
Co přesně padlo, se zjistí jen rozkliknutím logu a jeho projetím. Přesně
tohle mě dnes u PR #157 stálo tři kola hledání.

Playwright report **se jako artefakt ukládá** (39 MB), ale je to příloha ke
stažení, ne souhrn na první pohled.

**Návrh opravy.** Do shrnutí úlohy psát tabulku: kolik prošlo, kolik padlo,
jména padlých testů a první řádek chyby. U jestu stačí `--reporter=summary`,
u Playwrightu existuje reportér, který do shrnutí píše sám.

### 5. `summarize-tests.js` počítá špatně a nikdo ho nevolá — nízká

**Důkaz.** `scripts/summarize-tests.js:14` počítá celkový počet jako
`results.config.projects.length * results.suites.length` s komentářem
„Rough estimate". Je to odhad, ne počet. Skript navíc v CI nikde neběží,
je jen v `package.json` jako `test:summary`.

**Návrh opravy.** Buď ho nahradit reportérem z nálezu 4, nebo smazat.
Nástroj, který hlásí nepřesná čísla a nikdo ho nespouští, je horší než žádný:
jednou se podle něj někdo rozhodne.

## K automatickému zakládání issues

**Zatímco je repozitář veřejný, nedoporučuju to.** Issues veřejného
repozitáře vidí kdokoli a zůstávají čitelné navždy — u selhání testů je to
mírnější než u infrastruktury, ale pořád to zveřejňuje jména testů, cesty
a útržky chyb.

Dnešní náhrada, která nic nezveřejňuje: GitHub posílá mail o spadlém běhu
naplánovaného workflow. Tak je postavená i `Hlídka serveru`.

**Pokud se repozitář zasoukromí** (doporučeno zvlášť, viz
`docs/jak-neprijit-o-server.md` a rozpor s `LICENSE`, která říká
„PROPRIETARY — All Rights Reserved"), automatické issues dávají smysl.
Pak ale s těmito pravidly, jinak se z nich stane šum, který nikdo nečte:

- **jedno issue na příčinu, ne na běh** — jinak jich přibude dvacet denně
- **aktualizovat existující**, když padá totéž znovu, a sám zavřít, když to
  přestane padat
- **jen z masteru**, ne z PR; v PR je od toho kontrola u PR
- **bez logů v těle** — odkaz na běh stačí, tělo má nést jméno testu
  a scénář

## Fázovaný plán

### Fáze 1 — vědět, na čem jsme (nic se nerozbije)

1. Spustit všech 38 specifikací **mimo hlavní běh**, jen pro změření, kolik
   z těch 118 testů vůbec prochází.
2. Zapnout `test:ci` s pokrytím a naměřit výchozí hodnotu. Zatím bez prahu.
3. Shrnutí úlohy s tabulkou výsledků — levné a hned to zpřehlední dnešek.

### Fáze 2 — zapojit, co prochází

4. Specifikace, které prošly, zapojit do hlavního běhu.
5. Ty, které padají, probrat jednu po druhé: opravit, nebo označit značkou
   a uvést proč. **Nemazat, dokud není jasné, jestli je vadný test, nebo kód** —
   u `feature_locks_fail_closed` a plateb to může být nález, ne nefunkční test.
6. Zrušit ruční výčty, nechat jeden zdroj.

### Fáze 3 — udržet to

7. Práh pokrytí podle naměřené hodnoty, ne od stolu.
8. Rozhodnout o viditelnosti repozitáře; teprve pak případně automatické issues.
9. `summarize-tests.js` nahradit, nebo smazat.

### Fáze 4 — co chybí úplně

10. **Žádné testy API vrstvy proti běžící databázi** mimo E2E. Dnes se
    kontrolery testují jest testy s mocky a pak rovnou celým prohlížečem;
    mezivrstva chybí.
11. **Android nativní testy** (`tests/android/`) v CI neběží vůbec.
12. **Žádný zátěžový ani výkonnostní test** — u pilotu to nevadí, u provozu
    s agenturami to bude chybět.
