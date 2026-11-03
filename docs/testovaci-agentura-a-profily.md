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

## Postup

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
