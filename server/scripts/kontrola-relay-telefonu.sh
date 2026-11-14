#!/usr/bin/env bash
#
# Co se opravdu stalo s relay telefonem — čtení z produkční databáze.
#
# Slouží k živému testu dvou telefonů (brána 5 v docs/pilot-readiness-checklist.md):
# člověk posílá SMS z druhého telefonu, tahle kontrola odpovídá na otázku,
# jestli dorazily, komu se připsaly a jestli je operátorka uvidí.
#
# ── DVĚ VĚCI, KTERÉ TENHLE SKRIPT DRŽÍ ZÁMĚRNĚ ───────────────────────────────
#
# 1. NIC NEZAPISUJE, a není to jen slib v komentáři: spojení se otevírá
#    s `default_transaction_read_only=on`, takže i kdyby někdo do dotazu níž
#    omylem napsal UPDATE, databáze ho odmítne. Produkční data testem projít
#    nesmí — to je celý rozdíl mezi kontrolou a zásahem.
#
# 2. NEVYPISUJE OSOBNÍ ÚDAJE. Tenhle skript spouští workflow ve VEŘEJNÉM
#    repozitáři (viz docs/… a paměť „repozitář je veřejný"), takže jeho výstup
#    si přečte kdokoli. Proto jen počty, stáří v sekundách a verdikty —
#    žádné telefonní číslo, text zprávy, e-mail ani installationId. Když
#    potřebujete vidět konkrétní zprávu, je v dashboardu.
#
# Použití (na serveru):
#   PROFIL="Testovaci profil A" OKNO_MIN=30 CEKANO_SMS=10 \
#     bash /root/nexus-backend/scripts/kontrola-relay-telefonu.sh
#
set -uo pipefail

PROFIL="${PROFIL:-Testovaci profil A}"
OKNO_MIN="${OKNO_MIN:-30}"
CEKANO_SMS="${CEKANO_SMS:-0}"       # 0 = jen vypiš, nehodnoť počet
MEZ_LASTSEEN_S="${MEZ_LASTSEEN_S:-150}"  # outbox polling je po 30 s

CHYBY=0
chyba() { echo "::error::$*"; CHYBY=$((CHYBY+1)); }
varuj() { echo "::warning::$*"; }

# ── DATABASE_URL ─────────────────────────────────────────────────────────────
# Stejná cesta jako v obnovovaci-zkouska.sh: v cronu/SSH není prostředí
# aplikace, adresa se tedy čte z jejího .env přes dotenv.
if [ -z "${DATABASE_URL:-}" ] && [ -f /root/nexus-backend/.env ]; then
  DATABASE_URL="$(cd /root/nexus-backend && node -e "require('dotenv').config(); process.stdout.write(process.env.DATABASE_URL || '')" 2>/dev/null)"
fi
if [ -z "${DATABASE_URL:-}" ]; then
  echo "::error::DATABASE_URL se nedá zjistit — není co čís." >&2
  exit 1
fi

# Pojistka z komentáře výš, vynucená databází. `PGOPTIONS` platí pro celé
# spojení, takže se vztahuje na každý dotaz v tomhle skriptu.
export PGOPTIONS='-c default_transaction_read_only=on'

# Heslo se nikdy nesmí dostat do výpisu ani do chybové hlášky.
bez_hesla() { printf '%s' "$1" | sed -E 's#(//[^:/@]+):[^@]*@#\1:***@#'; }

dotaz() { psql "$DATABASE_URL" -t -A -F'|' -v ON_ERROR_STOP=1 -c "$1" 2>&1; }

if ! psql "$DATABASE_URL" -q -c 'SELECT 1;' >/dev/null 2>&1; then
  echo "::error::Na databázi $(bez_hesla "$DATABASE_URL") se nedá připojit." >&2
  exit 1
fi

# `psql -v` neumí bezpečně dosadit řetězec do WHERE, a jméno profilu přichází
# z vnějšku. Escapování apostrofů je tedy na nás.
PROFIL_SQL="$(printf '%s' "$PROFIL" | sed "s/'/''/g")"

echo
echo "── 1. Profil a kdo ho vlastní ──"

ZAZNAM="$(dotaz "SELECT p.id, COALESCE(p.\"ownerId\",''), COALESCE(r.name,'')
                 FROM \"Profile\" p
                 LEFT JOIN \"User\" u ON u.id = p.\"ownerId\"
                 LEFT JOIN \"Role\" r ON r.id = u.\"roleId\"
                 WHERE p.name = '$PROFIL_SQL';")"

if [ -z "$ZAZNAM" ]; then
  chyba "profil zadaného jména v databázi není — zkontrolovat PROFIL"
  exit 1
fi
if [ "$(printf '%s\n' "$ZAZNAM" | wc -l | tr -d '[:space:]')" != "1" ]; then
  chyba "jménu odpovídá víc profilů; Profile.name není unikátní, předat jiný"
  exit 1
fi

PROFIL_ID="${ZAZNAM%%|*}"
ZBYTEK="${ZAZNAM#*|}"
OWNER_ID="${ZBYTEK%%|*}"
OWNER_ROLE="${ZBYTEK#*|}"

if [ -z "$OWNER_ID" ]; then
  # Přesně tahle mezera posílala relay telefon modelky pod účet operátorky.
  chyba "profil nemá vlastníka (ownerId je prázdné) — telefon se připíše operátorce"
else
  echo "✓ profil má vlastní účet vlastníka, role: ${OWNER_ROLE:-(bez role)}"
fi

PRIRAZENO="$(dotaz "SELECT count(*) FROM \"_ProfileAssignees\" WHERE \"A\" = '$PROFIL_ID';")"
echo "přiřazených operátorek: $PRIRAZENO"
if [ "${PRIRAZENO:-0}" -lt 1 ]; then
  chyba "k profilu není přiřazená žádná operátorka — chat nikdo neuvidí"
fi

# Vlastnictví a přiřazení jsou dvě různé věci; když je účet vlastníka zároveň
# v assignees, test „operátorka vidí chat" by prošel i bez operátorky.
if [ -n "$OWNER_ID" ]; then
  OWNER_JE_ASSIGNEE="$(dotaz "SELECT count(*) FROM \"_ProfileAssignees\"
                              WHERE \"A\" = '$PROFIL_ID' AND \"B\" = '$OWNER_ID';")"
  if [ "${OWNER_JE_ASSIGNEE:-0}" -gt 0 ]; then
    varuj "účet vlastníka je zároveň v assignees — test viditelnosti pro operátorku tím není průkazný"
  fi
fi

echo
echo "── 2. Vazby zařízení ──"

# Bez filtru na appVariant si relay telefon a plná aplikace přehazovaly jednu
# aktivní vazbu (#188). Proto se počítají odděleně.
VAZBY="$(dotaz "SELECT \"appVariant\", active, count(*),
                       COALESCE(MIN(EXTRACT(EPOCH FROM (now() - \"lastSeenAt\")))::int, -1)
                FROM \"DeviceBinding\" WHERE \"profileId\" = '$PROFIL_ID'
                GROUP BY 1,2 ORDER BY 1,2;")"

if [ -z "$VAZBY" ]; then
  chyba "profil nemá ani jednu vazbu zařízení — telefon není spárovaný"
else
  echo "varianta | aktivní | počet | nejčerstvější lastSeenAt"
  printf '%s\n' "$VAZBY" | while IFS='|' read -r V A P S; do
    printf '%-8s | %-7s | %5s | %s s\n' "$V" "$A" "$P" "$S"
  done
fi

RELAY_AKTIVNI="$(dotaz "SELECT count(*) FROM \"DeviceBinding\"
                        WHERE \"profileId\" = '$PROFIL_ID'
                          AND \"appVariant\" = 'relay' AND active = true;")"
if [ "${RELAY_AKTIVNI:-0}" -lt 1 ]; then
  chyba "žádná AKTIVNÍ relay vazba — příchozí SMS nemá kam dorazit"
elif [ "${RELAY_AKTIVNI:-0}" -gt 1 ]; then
  varuj "aktivních relay vazeb je $RELAY_AKTIVNI; jedna modelka = jeden telefon, zbytek jsou pozůstatky"
fi

RELAY_STARI="$(dotaz "SELECT COALESCE(MIN(EXTRACT(EPOCH FROM (now() - \"lastSeenAt\")))::int, -1)
                      FROM \"DeviceBinding\" WHERE \"profileId\" = '$PROFIL_ID'
                        AND \"appVariant\" = 'relay' AND active = true;")"
if [ "${RELAY_STARI:--1}" -ge 0 ] && [ "${RELAY_STARI}" -gt "$MEZ_LASTSEEN_S" ]; then
  # Telefon se hlásí přes příchozí relay i přes outbox polling (30 s).
  varuj "relay se neohlásil ${RELAY_STARI} s (mez ${MEZ_LASTSEEN_S} s) — telefon spí, nemá data nebo neběží služba"
fi

echo
echo "── 3. Příchozí SMS za posledních $OKNO_MIN min ──"

PRISLO="$(dotaz "SELECT count(*) FROM \"Message\" m
                 JOIN \"Chat\" c ON c.id = m.\"chatId\"
                 WHERE c.\"profileId\" = '$PROFIL_ID'
                   AND m.direction = 'INBOUND' AND m.transport = 'sms'
                   AND m.\"createdAt\" > now() - interval '$OKNO_MIN minutes';")"
echo "uloženo příchozích SMS: ${PRISLO:-?}"

# Duplicita z inbox fallbacku = tatáž zpráva uložená dvakrát krátce po sobě.
# POZOR: shodný text dvou ZÁMĚRNĚ stejných SMS se tady počítá taky, proto
# v postupu posílat rozlišitelné texty (1/10, 2/10, …).
DVOJNICI="$(dotaz "SELECT count(*) FROM (
                     SELECT m1.id FROM \"Message\" m1
                     JOIN \"Chat\" c ON c.id = m1.\"chatId\"
                     JOIN \"Message\" m2 ON m2.\"chatId\" = m1.\"chatId\"
                          AND m2.id <> m1.id AND m2.text = m1.text
                          AND abs(EXTRACT(EPOCH FROM (m2.\"createdAt\" - m1.\"createdAt\"))) < 120
                     WHERE c.\"profileId\" = '$PROFIL_ID'
                       AND m1.direction = 'INBOUND' AND m1.transport = 'sms'
                       AND m1.\"createdAt\" > now() - interval '$OKNO_MIN minutes'
                     GROUP BY m1.id) d;")"
echo "z toho zpráv, které mají dvojníka: ${DVOJNICI:-?}"
if [ "${DVOJNICI:-0}" -gt 0 ]; then
  chyba "v okně jsou duplicitní příchozí SMS ($DVOJNICI) — buď fallback ukládá podruhé, nebo se posílaly shodné texty"
fi

if [ "${CEKANO_SMS:-0}" -gt 0 ]; then
  if [ "${PRISLO:-0}" -eq "$CEKANO_SMS" ]; then
    echo "✓ dorazilo přesně ${CEKANO_SMS}/${CEKANO_SMS}"
  else
    chyba "čekáno $CEKANO_SMS příchozích SMS, uloženo ${PRISLO:-0}"
  fi
fi

echo
echo "── 4. Odchozí zprávy, které uvízly ──"

# No-go z brány 5: outbox nesmí zůstat v pending_relay déle než 2 minuty.
UVIZLE="$(dotaz "SELECT count(*) FROM \"Message\" m
                 JOIN \"Chat\" c ON c.id = m.\"chatId\"
                 WHERE c.\"profileId\" = '$PROFIL_ID'
                   AND m.status = 'pending_relay'
                   AND m.\"createdAt\" < now() - interval '2 minutes';")"
echo "v pending_relay déle než 2 min: ${UVIZLE:-?}"
if [ "${UVIZLE:-0}" -gt 0 ]; then
  chyba "odchozí zprávy uvízly v pending_relay ($UVIZLE) — telefon je neodeslal"
fi

echo
echo "── Verdikt ──"
if [ "$CHYBY" -eq 0 ]; then
  echo "✅ Relay telefon odpovídá tomu, co brána 5 požaduje (v rozsahu, který jde vyčíst z databáze)."
  exit 0
fi
echo "❌ Nalezeno $CHYBY věcí, které bráně 5 nevyhovují."
exit 1
