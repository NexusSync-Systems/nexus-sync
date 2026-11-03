# Vydávání do Google Play

Stav k 3. 11. 2026: v Play zatím **nic není**. Tenhle dokument popisuje, co
kolem toho existuje v repozitáři a co chybí.

## Co už je hotové

`.github/workflows/release-aab.yml` (ruční spuštění) staví **oba podepsané
AAB** v jednom běhu — `com.nexushub.app` a `com.nexushub.relay` — a ověřuje,
že otisk podpisu odpovídá keystoru. Kdyby konfigurace podepisování tiše
vypadla, zjistí se to tady, ne až odmítnutým uploadem.

`versionCode` roste s číslem běhu workflow, což Play vyžaduje.

Od 3. 11. 2026 umí workflow i **nahrát na track `internal`** — přepínačem
`nahrat_do_play` při spuštění, výchozí je vypnuto.

## Proč nahrávání není automatické

Každý běh sahá na podepisovací klíč a každé vydání spotřebuje `versionCode`,
který už se nikdy nepoužije. Hlavně ale odsouhlasit prohlášení k oprávněním
a formulář Data safety je rozhodnutí člověka. Přepínač to rozhodnutí přenáší
na toho, kdo workflow spouští — nedělá ho za něj.

## Co chybí

**Servisní účet.** Založit v Google Cloudu, v Play Console mu dát přístup
k aplikaci, JSON klíč uložit jako secret `PLAY_SERVICE_ACCOUNT_JSON`.
Bez něj krok nahrání neproběhne a napíše do souhrnu běhu proč.

**První nahrání musí být ruční.** Dokud aplikace v Play Console neexistuje
a nemá vyplněný záznam, CI nemá kam nahrávat.

**Záznam aplikace**: popis, hodnocení obsahu, cílová skupina, formulář
Data safety a **veřejná URL zásad ochrany osobních údajů**. To poslední dnes
neexistuje — je k tomu návrh v `docs/zasady-ochrany-osobnich-udaju-NAVRH.md`
a je nehotový záměrně, viz tam.

## Relay do Play nepatří

Z nahrávání je vyloučená **natvrdo, ne přepínačem**. Žádá `READ_SMS`,
`SEND_SMS`, `WRITE_SMS` a `READ_CALL_LOG`; Play tahle oprávnění pouští jen
výchozímu SMS klientovi s doloženým povoleným účelem a „přeposílá SMS na
server" mezi povolené účely nepatří.

Relay se instaluje ručně a aktualizuje přes OTA. Ověřeno 3. 11. 2026 na
zařízení Xiaomi s HyperOS: instalace přes `adb` je zablokovaná, dokud se
v Možnostech pro vývojáře nezapne **Instalace přes USB**; přes Soubory →
Stažené jde vždycky.

## Plná aplikace a poloha na pozadí

`nexusFull` žádá `ACCESS_BACKGROUND_LOCATION` — taky omezené oprávnění.
Chce deklaraci a video, jak se funkce používá. Pro bezpečnostní doprovod je
to obhajitelné, ale je to přezkum navíc a týká se produkce, ne interního
testování.

## Obsahová politika

Aplikace pro správu escortní agentury spadá pod pravidla Play o sexuálně
orientovaném obsahu a službách. **Není ověřeno, jak to Play posoudí** —
posuzuje podle svých pravidel, ne podle místního práva. Stojí za to si to
ujasnit předem; opakovaná zamítnutí se u vývojářského účtu počítají.

## Postup prvního vydání

1. Vyplnit záznam aplikace v Play Console včetně URL zásad
2. Spustit `release-aab.yml` **bez** `nahrat_do_play`, stáhnout AAB z artefaktů
3. Nahrát ručně, projít prohlášeními a přezkumem
4. Teprve pak založit `PLAY_SERVICE_ACCOUNT_JSON` a používat přepínač
