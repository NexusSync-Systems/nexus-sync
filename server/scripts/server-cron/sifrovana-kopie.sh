#!/usr/bin/env bash
#
# Zašifruje nejnovější zálohu, aby šla odvézt ze serveru.
#
# Kopie, která opouští server, patří do šifrované podoby — na cizím disku,
# v cloudu nebo na notebooku jsou to osobní údaje bez jakékoli ochrany.
# Heslo se NIKDY nepředává argumentem: argumenty jsou v `ps` vidět všem
# uživatelům stroje, proto jen --passphrase-file.
#
# Bez hesla z /root/zaloha-heslo.txt (a jeho kopie MIMO server) archiv nikdo
# neotevře. Zadní vrátka nejsou.
set -euo pipefail
umask 077

HESLO=/root/zaloha-heslo.txt
BACKUP_DIR=/var/backups/nexus

[ -f "$HESLO" ] || { echo "❌ Chybí $HESLO" >&2; exit 1; }
DELKA="$(head -n 1 "$HESLO" | tr -d '\r\n' | wc -c | tr -d '[:space:]')"
[ "${DELKA:-0}" -ge 20 ] || { echo "❌ První řádek hesla má jen ${DELKA} B" >&2; exit 1; }

DUMP="$(ls -t "$BACKUP_DIR"/nexus_*.dump 2>/dev/null | head -1)"
[ -n "$DUMP" ] || { echo "❌ Žádná záloha k zašifrování" >&2; exit 1; }

CIL="$DUMP.gpg"
gpg --batch --yes --quiet \
    --passphrase-file "$HESLO" \
    --symmetric --cipher-algo AES256 \
    --output "$CIL" "$DUMP"

# Ověření, že se to dá zpátky rozšifrovat, a to na shodu s původním souborem.
# Zašifrovaný soubor, který nikdo nezkusil otevřít, je jen naděje — a přesně
# tak vypadaly ty tři zipy, které 3. 11. 2026 nešly použít.
PUVODNI="$(sha256sum "$DUMP" | cut -d' ' -f1)"
ROZSIFROVANY="$(gpg --batch --quiet --passphrase-file "$HESLO" --decrypt "$CIL" 2>/dev/null | sha256sum | cut -d' ' -f1)"

if [ "$PUVODNI" != "$ROZSIFROVANY" ]; then
  echo "❌ Rozšifrovaný archiv nesouhlasí s původním souborem — mažu ho" >&2
  rm -f "$CIL"
  exit 1
fi

echo "$PUVODNI  $(basename "$DUMP")" > "$CIL.sha256-obsahu"
find "$BACKUP_DIR" -name 'nexus_*.dump.gpg' -mtime +14 -delete
find "$BACKUP_DIR" -name 'nexus_*.dump.gpg.sha256-obsahu' -mtime +14 -delete
echo "✅ Zašifrováno a zkušebně rozšifrováno: $CIL"
