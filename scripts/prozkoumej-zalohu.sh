#!/usr/bin/env bash
# =============================================================================
# Prozkoumání nalezené zálohy — na vlastním stroji, bez instalace Postgresu
# =============================================================================
# Odpovídá na otázku „jak je ta záloha stará a co v ní je", než se podle ní
# začne rozhodovat o pilotu.
#
# Použití:
#   ./scripts/prozkoumej-zalohu.sh /cesta/k/nexus_….dump
#
# Co dělá:
#   1. ověří sha256, pokud leží soubor .sha256 vedle,
#   2. přečte hlavičku dumpu — čas vytvoření a verzi Postgresu, ze kterého
#      vznikl (nezávisle na tom, jak se soubor jmenuje),
#   3. zvedne ZAHODITELNÝ kontejner s Postgresem 16, obnoví do něj dump,
#   4. vypíše počty řádků u tabulek, které hlídá pilot-readiness-checklist,
#      a čas poslední zprávy,
#   5. kontejner zase smaže.
#
# Nikam se nepřipojuje a nic nemodifikuje: databáze vzniká a zaniká
# v kontejneru. Dump se otevírá jen pro čtení.
#
# Záloha je ve formátu --format=custom (viz server/scripts/backup-postgres.sh),
# proto pg_restore a ne psql.
# =============================================================================

set -euo pipefail

DUMP="${1:-}"
KONTEJNER="nexus-zaloha-kontrola-$$"
HESLO="kontrola-$$"
OBRAZ="postgres:16"

if [ -z "$DUMP" ]; then
  echo "Použití: $0 /cesta/k/nexus_….dump" >&2
  exit 2
fi

if [ ! -f "$DUMP" ]; then
  echo "Soubor neexistuje: $DUMP" >&2
  exit 2
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker není nainstalovaný. Jiná cesta je nainstalovat postgresql-client" >&2
  echo "a použít server/scripts/verify-restore-postgres.sh proti vlastní databázi." >&2
  exit 2
fi

if ! docker info >/dev/null 2>&1; then
  echo "Docker démon neběží — spusťte Docker Desktop a zkuste to znovu." >&2
  exit 2
fi

uklid() {
  docker rm -f "$KONTEJNER" >/dev/null 2>&1 || true
}
trap uklid EXIT

echo "=== 1. Integrita ==="
if [ -f "$DUMP.sha256" ]; then
  # Soubor .sha256 obsahuje původní cestu, proto se kontroluje podle hodnoty.
  ocekavany="$(awk '{print $1}' "$DUMP.sha256")"
  if command -v sha256sum >/dev/null 2>&1; then
    skutecny="$(sha256sum "$DUMP" | awk '{print $1}')"
  else
    skutecny="$(shasum -a 256 "$DUMP" | awk '{print $1}')"
  fi
  if [ "$ocekavany" = "$skutecny" ]; then
    echo "  sha256 souhlasí — soubor není poškozený."
  else
    echo "  POZOR: sha256 NESOUHLASÍ. Dump je poškozený nebo podvržený." >&2
    echo "  Pokračuju, ale obsahu nevěřte." >&2
  fi
else
  echo "  Soubor .sha256 vedle dumpu není — integritu nelze ověřit."
fi

echo
echo "=== 2. Odkud a kdy dump je ==="
# Hlavička dumpu nese čas vytvoření i verzi serveru. Spolehlivější než jméno
# souboru, které mohl někdo přepsat.
# Řádky hlavičky jsou odsazené mezerami za středníkem, proto [[:space:]]*.
docker run --rm -i "$OBRAZ" pg_restore --list < "$DUMP" 2>/dev/null \
  | grep -E "^;[[:space:]]*(Archive created at|dbname|TOC Entries|Dumped from database version)" \
  | sed -E 's/^;[[:space:]]*/  /' \
  || echo "  Hlavičku nelze přečíst — není to dump ve formátu custom?"

# „Dumped from database version" je důležitý: dump z novějšího Postgresu se do
# staršího obnovit nedá. Když je tam 17 a výš, změňte OBRAZ v tomhle skriptu
# i verzi Postgresu na novém serveru.

echo
echo "=== 3. Obnova do zahoditelné databáze ==="
docker run -d --name "$KONTEJNER" \
  -e POSTGRES_PASSWORD="$HESLO" \
  -e POSTGRES_DB=kontrola \
  "$OBRAZ" >/dev/null
echo "  kontejner $KONTEJNER nastartován"

printf "  čekám na databázi"
for _ in $(seq 1 60); do
  if docker exec "$KONTEJNER" pg_isready -U postgres -d kontrola >/dev/null 2>&1; then
    echo " — připravena"
    break
  fi
  printf "."
  sleep 1
done

if ! docker exec "$KONTEJNER" pg_isready -U postgres -d kontrola >/dev/null 2>&1; then
  echo " — nenaběhla do 60 s" >&2
  exit 1
fi

docker cp "$DUMP" "$KONTEJNER:/tmp/zaloha.dump" >/dev/null
# --no-owner/--no-acl: role z původního serveru tady neexistují a nejsou
# potřeba. Chyby na nich by jinak zbytečně zastínily skutečné problémy.
if docker exec "$KONTEJNER" pg_restore \
      --username postgres --dbname kontrola \
      --no-owner --no-acl /tmp/zaloha.dump 2>/tmp/pg_restore_err_$$; then
  echo "  obnova proběhla bez chyb"
else
  echo "  obnova skončila s chybami (u starších dumpů běžné, data bývají v pořádku):"
  head -5 "/tmp/pg_restore_err_$$" | sed 's/^/    /'
fi
rm -f "/tmp/pg_restore_err_$$"

dotaz() {
  docker exec "$KONTEJNER" psql -U postgres -d kontrola -tAc "$1" 2>/dev/null || true
}

echo
echo "=== 4. Co v záloze je ==="
# Tabulky, které jmenuje brána 3 v docs/pilot-readiness-checklist.md.
for t in Agency User Profile Chat Message Subscription DeviceBinding BlacklistEntry; do
  existuje="$(dotaz "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='$t';")"
  if [ "$existuje" = "1" ]; then
    printf "  %-16s %s\n" "$t" "$(dotaz "SELECT COUNT(*) FROM \"$t\";")"
  else
    printf "  %-16s tabulka v záloze není\n" "$t"
  fi
done

echo
echo "=== 5. Kam záloha sahá v čase ==="
for radek in "Message:createdAt:poslední zpráva" "Chat:lastMessageAt:poslední aktivita chatu" "AuditLog:timestamp:poslední audit"; do
  t="${radek%%:*}"; zbytek="${radek#*:}"; sloupec="${zbytek%%:*}"; popis="${zbytek#*:}"
  existuje="$(dotaz "SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='$t' AND column_name='$sloupec';")"
  if [ "$existuje" = "1" ]; then
    hodnota="$(dotaz "SELECT COALESCE(MAX(\"$sloupec\")::text, 'žádné záznamy') FROM \"$t\";")"
    printf "  %-26s %s\n" "$popis" "$hodnota"
  fi
done

echo
echo "Hotovo. Kontejner se teď smaže, v systému nic nezůstane."
