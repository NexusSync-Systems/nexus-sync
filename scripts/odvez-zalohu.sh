#!/usr/bin/env bash
#
# Odveze nejnovější šifrovanou zálohu databáze ze serveru na tenhle stroj.
#
# Proč to existuje: 3. 11. 2026 zmizel produkční server a jediné kopie databáze
# byly tři zipy, ve kterých byl nezměněný vývojový soubor. Záloha, která leží
# jen na témže stroji jako databáze, padne spolu s ním.
#
# Skript NEVĚŘÍ tomu, že přenos stačí. Odvezený archiv rozšifruje a porovná
# kontrolní součet s původním souborem na serveru. Bez téhle zkoušky je
# „záloha" jen soubor, o kterém se nikdo neodváží tvrdit, že jde otevřít.
#
# Použití:
#
#   bash scripts/odvez-zalohu.sh
#
# Heslo: skript ho hledá v souboru podle ZALOHA_HESLO_FILE (výchozí
# ~/.nexus-zaloha-heslo). Když ho nenajde, archiv přesto odveze, ale ohlásí,
# že ho NEOVĚŘIL — tichého přeskočení kontroly se tu nedopouštíme.
#
# Heslo patří do správce hesel. Bez něj archiv nikdo neotevře, ani vy.
set -uo pipefail

SERVER="${ZALOHA_SERVER:-ubuntu@api.nexusstack.eu}"
KLIC="${ZALOHA_SSH_KEY:-$HOME/.ssh/nexus_hub_ed25519}"
CIL="${ZALOHA_CIL:-$HOME/Zalohy/nexus-hub}"
HESLO="${ZALOHA_HESLO_FILE:-$HOME/.nexus-zaloha-heslo}"
PONECHAT="${ZALOHA_PONECHAT:-7}"
VZDALENY_DIR=/var/backups/nexus

[ -f "$KLIC" ] || { echo "❌ Klíč $KLIC neexistuje" >&2; exit 1; }
mkdir -p "$CIL" && chmod 700 "$CIL"

na_serveru() { ssh -i "$KLIC" -o ConnectTimeout=20 "$SERVER" "sudo bash -c '$1'"; }

# Glob se musí vyhodnotit AŽ pod rootem — /var/backups/nexus má práva 700,
# takže pod uživatelem ubuntu se jméno souboru vůbec nezjistí.
NAZEV="$(na_serveru 'ls -t '"$VZDALENY_DIR"'/nexus_*.dump.gpg 2>/dev/null | head -1 | xargs -r -n1 basename')"
[ -n "$NAZEV" ] || { echo "❌ Na serveru není žádná šifrovaná záloha. Spustil cron /root/nexus-zalohy/nocni-zaloha.sh?" >&2; exit 1; }

echo "Odvážím $NAZEV"
na_serveru "cat $VZDALENY_DIR/$NAZEV" > "$CIL/$NAZEV.cast" || { echo "❌ Přenos archivu selhal" >&2; rm -f "$CIL/$NAZEV.cast"; exit 1; }
na_serveru "cat $VZDALENY_DIR/$NAZEV.sha256-obsahu" > "$CIL/$NAZEV.sha256-obsahu" || { echo "❌ Přenos kontrolního součtu selhal" >&2; rm -f "$CIL/$NAZEV.cast" "$CIL/$NAZEV.sha256-obsahu"; exit 1; }

VELIKOST="$(wc -c < "$CIL/$NAZEV.cast" | tr -d '[:space:]')"
[ "${VELIKOST:-0}" -ge 1024 ] || { echo "❌ Odvezený archiv má jen ${VELIKOST} B" >&2; rm -f "$CIL/$NAZEV.cast"; exit 1; }

mv "$CIL/$NAZEV.cast" "$CIL/$NAZEV"
chmod 600 "$CIL/$NAZEV" "$CIL/$NAZEV.sha256-obsahu"

if [ -f "$HESLO" ]; then
  OCEKAVANY="$(cut -d' ' -f1 < "$CIL/$NAZEV.sha256-obsahu")"

  # Rozšifrování se posuzuje podle NÁVRATOVÉHO KÓDU gpg, ne podle výsledného
  # součtu. Při špatném heslu gpg nevypíše nic, takže součet prázdného vstupu
  # (e3b0c442…) je pořád platný řetězec — a hláška by pak mířila na poškozený
  # archiv, i když je ve skutečnosti špatný klíč. To je rozdíl, který při
  # obnově rozhoduje, kam se jít podívat.
  ROZSIFROVANY="$(mktemp)"
  trap 'rm -f "$ROZSIFROVANY"' EXIT
  if ! gpg --batch --quiet --pinentry-mode loopback \
          --passphrase-file "$HESLO" \
          --decrypt "$CIL/$NAZEV" > "$ROZSIFROVANY" 2>/dev/null; then
    echo "❌ Archiv se nepodařilo rozšifrovat. Nejčastěji je to špatné heslo v $HESLO." >&2
    echo "   (Archiv sám zůstal v $CIL — nemaže se, dokud není jasné, co je vadné.)" >&2
    exit 1
  fi

  SKUTECNY="$(shasum -a 256 < "$ROZSIFROVANY" | cut -d' ' -f1)"
  if [ "$OCEKAVANY" != "$SKUTECNY" ]; then
    echo "❌ Rozšifrovalo se, ale obsah NESOUHLASÍ s původním souborem na serveru." >&2
    echo "   Heslo je tedy správné a vadný je přenos nebo archiv." >&2
    exit 1
  fi
  echo "✅ Odvezeno a ověřeno rozšifrováním: $CIL/$NAZEV (${VELIKOST} B)"
else
  echo "⚠️  Odvezeno, ale NEOVĚŘENO: soubor s heslem $HESLO neexistuje."
  echo "    Archiv tu leží, ale nikdo nezkusil, jestli se dá otevřít."
  echo "    Ulož heslo do $HESLO (chmod 600) a spusť skript znovu."
fi

# Starší kopie se promazávají, ať notebook nezarůstá osobními údaji.
POCET="$(ls -t "$CIL"/nexus_*.dump.gpg 2>/dev/null | wc -l | tr -d '[:space:]')"
if [ "${POCET:-0}" -gt "$PONECHAT" ]; then
  ls -t "$CIL"/nexus_*.dump.gpg | tail -n +$((PONECHAT + 1)) | while IFS= read -r stary; do
    rm -f "$stary" "$stary.sha256-obsahu"
    echo "    promazáno staré: $(basename "$stary")"
  done
fi
