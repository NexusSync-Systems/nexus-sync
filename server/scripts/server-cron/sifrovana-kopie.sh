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

# `|| true` je tu nutnost: když žádný dump neexistuje, glob se nerozvine,
# `ls` skončí nenulově a `pipefail` to propustí `set -e`, které skript zabije
# dřív, než se dostane na řádek níž. Hláška „Žádná záloha k zašifrování" byla
# tím pádem NEDOSAŽITELNÁ a skript umíral mlčky s nenulovým kódem — což by
# v cronu, který nemá kam poslat mail, nikdo nezjistil.
#
# Na serveru to nevyplavalo jen proto, že tam dump vždycky existuje. Odhalil
# to až test v CI nad prázdným adresářem (5. 11. 2026).
# shellcheck disable=SC2012
DUMP="$(ls -t "$BACKUP_DIR"/nexus_*.dump 2>/dev/null | head -1 || true)"
[ -n "$DUMP" ] || { echo "❌ Žádná záloha k zašifrování" >&2; exit 1; }

CIL="$DUMP.gpg"

# `--pinentry-mode loopback`: GnuPG 2.1+ se i při zadaném --passphrase-file
# obrací na agenta a v dávkovém běhu na čerstvém stroji nemá koho se zeptat —
# skončí kódem 2, často bez jediného řádku na výstupu. Na současném serveru je
# agent nastavený a projde to i bez toho, ale tenhle soubor je zároveň předloha
# pro PŘESTAVBU serveru, kde by to tiše selhalo.
#
# Zjištěno 5. 11. 2026, když na tomhle přesně spadla úloha v CI.
gpg --batch --yes --quiet \
    --pinentry-mode loopback \
    --passphrase-file "$HESLO" \
    --symmetric --cipher-algo AES256 \
    --output "$CIL" "$DUMP"

# Ověření, že se to dá zpátky rozšifrovat, a to na shodu s původním souborem.
# Zašifrovaný soubor, který nikdo nezkusil otevřít, je jen naděje — a přesně
# tak vypadaly ty tři zipy, které 3. 11. 2026 nešly použít.
PUVODNI="$(sha256sum "$DUMP" | cut -d' ' -f1)"
ROZSIFROVANY="$(gpg --batch --quiet --pinentry-mode loopback \
                    --passphrase-file "$HESLO" --decrypt "$CIL" 2>/dev/null \
                | sha256sum | cut -d' ' -f1)"

if [ "$PUVODNI" != "$ROZSIFROVANY" ]; then
  echo "❌ Rozšifrovaný archiv nesouhlasí s původním souborem — mažu ho" >&2
  rm -f "$CIL"
  exit 1
fi

echo "$PUVODNI  $(basename "$DUMP")" > "$CIL.sha256-obsahu"
find "$BACKUP_DIR" -name 'nexus_*.dump.gpg' -mtime +14 -delete
find "$BACKUP_DIR" -name 'nexus_*.dump.gpg.sha256-obsahu' -mtime +14 -delete
echo "✅ Zašifrováno a zkušebně rozšifrováno: $CIL"
