# Testovací agentura a profily na novém serveru

Stav k 3. 11. 2026. Databáze na `api.nexusstack.eu` je prázdná: jeden uživatel
(`dias.zd@gmail.com`, role App Owner, bez agentury), žádná agentura, žádný profil.

Relay telefon se proto nemá k čemu připojit — `configureRelay`
v `client/src/components/RelayMode.jsx` potřebuje `profileId` a `installationId`,
a ty bez agentury a profilu nevzniknou.

## NESPOUŠTĚJTE `prisma/seed.js` na tomhle serveru

Seed je hotový a kompletní — zakládá dvě agentury, šest rolí, šest uživatelů,
profily, rezervace i bezpečnostní relace. Na tenhle server ale nepatří, a to
ze dvou důvodů:

**1. Přepsal by vám vlastní účet.** Seed uživatele **aktualizuje podle e-mailu**
(`server/prisma/seed.js`, větev „Updating existing user"), a `dias.zd@gmail.com`
je v jeho seznamu s heslem `password123`. Spuštění by tedy vašemu vlastnickému
účtu nastavilo veřejně známé heslo — na serveru dostupném z internetu.

**2. Všechny ostatní účty mají taky slabá známá hesla** (`password123`,
`Nexus2024!`). Jsou v repozitáři, tedy veřejné vůči komukoli, kdo ho vidí.

Proto má seed pojistku: při `NODE_ENV=production` odmítne běžet, dokud
nenastavíte `ALLOW_PROD_SEED=true`. **Tu pojistku neobcházejte.** Je tam přesně
kvůli tomuhle stroji.

## Co na backendu chybí

**Katalog rolí.** V databázi je jediná role: globální šablona `App Owner`.
Chybí `Agency Admin`, `Manager`, `Senior Operator`, `Operator` i `Model`.

Zakládání agentury to **nezablokuje** — `authController.registerAgency` si
s chybějící šablonou poradí a použije zapsaná výchozí oprávnění
(`defaultPerms`). Vytvoří agenturu, k ní roli `Agency Admin` a jejího prvního
uživatele. Další role by se musely zakládat zvlášť.

## Nejkratší cesta: jeden skript

`scripts/nachystej-testovaci-agenturu.js` udělá celý postup níž najednou —
agenturu, operátorské účty, profily i jejich přiřazení.

```bash
(umask 077; printf '%s\n' 'TvojeHeslo1' > ~/.nexus-test-admin-heslo)
```

```bash
node scripts/nachystej-testovaci-agenturu.js --ano
```

Bez přepínače `--ano` jen vypíše, co by udělal, a skončí. Heslo se bere ze
souboru, takže se neobjeví v historii příkazů ani ve výpisu procesů; hesla
operátorek se vygenerují a připíší do `~/nexus-testovaci-ucty.txt` s právy 600,
ne na obrazovku.

**Pravidla hesla: aspoň 8 znaků, velké písmeno, malé písmeno a číslice.**
Malé písmeno nevyžaduje `validatePassword` v kontroleru, ale zod schéma
`strongPassword`, které běží před ním — bez něj server vrátí 400.

Dá se pustit znovu: agentura i účty se přeskočí (server hlídá unikátní e-mail)
a profily se přeskakují podle jména, protože `Profile` v databázi unikátní
omezení nemá a jinak by vznikly duplicity.

**Pojistka:** po přihlášení skript ověří, že je opravdu v agentuře, kterou
čeká. Kdyby nakonfigurovaný e-mail patřil skutečnému účtu, jinak by do jeho
ostré agentury v tichosti nasypal testovací účty a profily.

**Spouští to člověk.** Zakládání účtů na ostrém serveru je rozhodnutí někoho,
kdo za ten server odpovídá.

Zbytek téhle stránky popisuje tytéž kroky ručně, pro případ, že by bylo potřeba
udělat jen některý z nich.

## Postup ručně

### 1. Založení agentury

`POST /api/auth/register-agency` nevyžaduje přihlášení. Potřebuje
`agencyName`, `fullName`, `email` a `password`; heslo prochází kontrolou
ve `validatePassword`.

```bash
read -rsp "Heslo pro správce agentury: " HESLO; echo
curl -sS -X POST https://api.nexusstack.eu/api/auth/register-agency \
  -H "Content-Type: application/json" \
  -d "$(python3 - "$HESLO" <<'PY'
import json, sys
print(json.dumps({
    "agencyName": "Testovaci agentura",
    "fullName":   "Spravce testovaci agentury",
    "email":      "test-admin@nexusstack.eu",
    "password":   sys.argv[1],
}))
PY
)"
unset HESLO
```

Heslo se čte z klávesnice a nejde do historie shellu ani do výpisu procesů.
**Uložte si ho do správce hesel**, server ho zpátky nevydá.

Vznikne tím agentura, role `Agency Admin` pro ni a uživatel s tou rolí.
Vlastnického účtu `dias.zd@gmail.com` se to nedotkne.

### 2. Přihlášení jako správce agentury

```bash
curl -sS -X POST https://api.nexusstack.eu/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"test-admin@nexusstack.eu","password":"..."}'
```

Z odpovědi si vezměte `token`.

### 3. Profily

`POST /api/profiles`. Povinné je jen `name`; `phoneNumber`, `bio`, `commission`
a další jsou volitelné (`server/prisma/schema.prisma`, model `Profile`).

```bash
TOKEN="..."
for JMENO in "Testovaci profil A" "Testovaci profil B"; do
  curl -sS -X POST https://api.nexusstack.eu/api/profiles \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"$JMENO\",\"status\":\"offline\"}"
  echo
done
```

### 4. Teprve pak relay

Relay se přihlašuje **týmž účtem** jako web. Po přihlášení potřebuje vybraný
profil — `RelayMode.jsx` bere `profileId` z přihlášeného operátora nebo
z aktivního profilu.

Aplikace v telefonu už novou adresu má (ověřeno v balíčku:
`api.nexusstack.eu` 1×, zaniklý host 0×), takže stačí přihlásit a vybrat profil.

## Proč se to nedělá vlastnickým účtem

App Owner je od provozní části **záměrně oddělený**:
`chatController` vrací `App Owner cannot access messages`, `bookingController`
odmítá přístup k rezervacím. Je to role pro správu platformy, ne pro provoz
agentury. Pro zkoušení relaye je proto potřeba účet uvnitř agentury.

## Až bude po zkoušení

Testovací agentura, její profily i účty v databázi zůstanou. Před ostrým
pilotem je smažte, ať se nepletou do skutečných dat — a nezapomeňte, že
`docs/zpracovani-osobnich-udaju.md` počítá s retencí od prvního dne.
