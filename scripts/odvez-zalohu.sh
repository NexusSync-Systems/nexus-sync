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
#
# ── Tři pravidla, která tu platí, protože nástroj na zálohy nesmí data ztratit ─
#
# 1. Hotová kopie se NIKDY nepřepíše něčím neověřeným. Nový archiv se stahuje
#    pod vlastním jménem, ověří se, a až pak nahradí předchozí.
# 2. Dva souběžné běhy si nesmí šlapat po souborech. Hlídá to zámek.
# 3. Retence musí být celé číslo ≥ 1. Nula by promazala i právě odvezenou
#    zálohu a skript by skončil s kódem 0 — tedy „hotovo" a prázdný adresář.
set -uo pipefail

SERVER="${ZALOHA_SERVER:-ubuntu@api.nexusstack.eu}"
KLIC="${ZALOHA_SSH_KEY:-$HOME/.ssh/nexus_hub_ed25519}"
CIL="${ZALOHA_CIL:-$HOME/Zalohy/nexus-hub}"
HESLO="${ZALOHA_HESLO_FILE:-$HOME/.nexus-zaloha-heslo}"
PONECHAT="${ZALOHA_PONECHAT:-7}"
VZDALENY_DIR=/var/backups/nexus

# ── Kontrola vstupů PŘED jakýmkoli mazáním ───────────────────────────────────
# Dřív se PONECHAT použil až v promazávání. Hodnota 0 tam prošla a `tail -n +1`
# pak předal ke smazání VŠECHNY archivy včetně toho právě odvezeného — skript
# skončil úspěchem a bez jediné zálohy mimo server.
case "$PONECHAT" in
  ''|*[!0-9]*)
    echo "❌ ZALOHA_PONECHAT musí být celé číslo, dostal jsem '$PONECHAT'." >&2
    exit 2 ;;
esac
if [ "$PONECHAT" -lt 1 ]; then
  echo "❌ ZALOHA_PONECHAT musí být aspoň 1, dostal jsem $PONECHAT." >&2
  echo "   Nula by smazala i zálohu, kterou tenhle běh právě odvezl." >&2
  exit 2
fi

[ -f "$KLIC" ] || { echo "❌ Klíč $KLIC neexistuje" >&2; exit 1; }
mkdir -p "$CIL" && chmod 700 "$CIL"

# ── Zámek ────────────────────────────────────────────────────────────────────
# `mkdir` je atomický na Linuxu i na macOS, na rozdíl od `[ -f ] && touch`.
ZAMEK="$CIL/.zamek-odvozu"
if ! mkdir "$ZAMEK" 2>/dev/null; then
  KDO="$(cat "$ZAMEK/pid" 2>/dev/null || echo neznámý)"
  echo "❌ Jiný odvoz už běží (zámek $ZAMEK, pid $KDO)." >&2
  echo "   Když žádný neběží, je zámek po spadlém běhu: rmdir po smazání $ZAMEK/pid." >&2
  exit 1
fi
echo $$ > "$ZAMEK/pid"

STAGING=""
uklid() {
  [ -n "$STAGING" ] && rm -f "$STAGING" "$STAGING.sha256-obsahu" "$STAGING.rozsifrovany"
  rm -f "$ZAMEK/pid"
  rmdir "$ZAMEK" 2>/dev/null || true
}
trap uklid EXIT

na_serveru() { ssh -i "$KLIC" -o ConnectTimeout=20 "$SERVER" "sudo bash -c '$1'"; }

# Glob se musí vyhodnotit AŽ pod rootem — /var/backups/nexus má práva 700,
# takže pod uživatelem ubuntu se jméno souboru vůbec nezjistí.
NAZEV="$(na_serveru 'ls -t '"$VZDALENY_DIR"'/nexus_*.dump.gpg 2>/dev/null | head -1 | xargs -r -n1 basename')"
[ -n "$NAZEV" ] || { echo "❌ Na serveru není žádná šifrovaná záloha. Spustil cron /root/nexus-zalohy/nocni-zaloha.sh?" >&2; exit 1; }

CILOVY="$CIL/$NAZEV"
UZ_TU_JE=0
[ -f "$CILOVY" ] && UZ_TU_JE=1

# Vlastní jméno pro tenhle běh: souběžné běhy si tak nešlapou po mezivýsledku
# a hotová kopie zůstává nedotčená, dokud není nová ověřená.
STAGING="$CIL/.stahovani-$$-$(date -u +%Y%m%dT%H%M%SZ)-$NAZEV"

echo "Odvážím $NAZEV"
na_serveru "cat $VZDALENY_DIR/$NAZEV" > "$STAGING" \
  || { echo "❌ Přenos archivu selhal" >&2; exit 1; }
na_serveru "cat $VZDALENY_DIR/$NAZEV.sha256-obsahu" > "$STAGING.sha256-obsahu" \
  || { echo "❌ Přenos kontrolního součtu selhal" >&2; exit 1; }

VELIKOST="$(wc -c < "$STAGING" | tr -d '[:space:]')"
if [ "${VELIKOST:-0}" -lt 1024 ]; then
  echo "❌ Odvezený archiv má jen ${VELIKOST} B" >&2
  exit 1
fi

# ── Ověření PŘED zveřejněním ─────────────────────────────────────────────────
OVERENO=0
if [ -f "$HESLO" ]; then
  OCEKAVANY="$(cut -d' ' -f1 < "$STAGING.sha256-obsahu")"

  # Rozšifrování se posuzuje podle NÁVRATOVÉHO KÓDU gpg, ne podle výsledného
  # součtu. Při špatném heslu gpg nevypíše nic, takže součet prázdného vstupu
  # (e3b0c442…) je pořád platný řetězec — a hláška by pak mířila na poškozený
  # archiv, i když je ve skutečnosti špatný klíč. To je rozdíl, který při
  # obnově rozhoduje, kam se jít podívat.
  if ! gpg --batch --quiet --pinentry-mode loopback \
          --passphrase-file "$HESLO" \
          --decrypt "$STAGING" > "$STAGING.rozsifrovany" 2>/dev/null; then
    echo "❌ Archiv se nepodařilo rozšifrovat. Nejčastěji je to špatné heslo v $HESLO." >&2
    VADNY="$CIL/VADNY-$(date -u +%Y%m%dT%H%M%SZ)-$NAZEV"
    mv "$STAGING" "$VADNY" && STAGING=""
    echo "   Stažený soubor jsem nechal jako $(basename "$VADNY") — nemaže se, dokud není jasné, co je vadné." >&2
    [ "$UZ_TU_JE" = 1 ] && echo "   Dřívější ověřená kopie $NAZEV zůstala nedotčená." >&2
    exit 1
  fi

  SKUTECNY="$(shasum -a 256 < "$STAGING.rozsifrovany" | cut -d' ' -f1)"
  if [ "$OCEKAVANY" != "$SKUTECNY" ]; then
    echo "❌ Rozšifrovalo se, ale obsah NESOUHLASÍ s původním souborem na serveru." >&2
    echo "   Heslo je tedy správné a vadný je přenos nebo archiv." >&2
    VADNY="$CIL/VADNY-$(date -u +%Y%m%dT%H%M%SZ)-$NAZEV"
    mv "$STAGING" "$VADNY" && STAGING=""
    echo "   Stažený soubor jsem nechal jako $(basename "$VADNY")." >&2
    [ "$UZ_TU_JE" = 1 ] && echo "   Dřívější ověřená kopie $NAZEV zůstala nedotčená." >&2
    exit 1
  fi
  rm -f "$STAGING.rozsifrovany"
  OVERENO=1
fi

# Neověřenou kopií se hotová kopie nepřepisuje. Stejné jméno znamená tutéž
# zálohu, takže by to byl čistý downgrade: ověřené za neověřené.
if [ "$OVERENO" = 0 ] && [ "$UZ_TU_JE" = 1 ]; then
  NEOVERENY="$CIL/NEOVERENY-$(date -u +%Y%m%dT%H%M%SZ)-$NAZEV"
  mv "$STAGING" "$NEOVERENY" && STAGING=""
  echo "⚠️  $NAZEV už tu je a soubor s heslem $HESLO neexistuje, takže jsem nový stažený"
  echo "    archiv NEMOHL ověřit. Hotovou kopii proto nepřepisuji; nový leží jako"
  echo "    $(basename "$NEOVERENY"). Ulož heslo a spusť skript znovu."
  exit 0
fi

# ── Zveřejnění ───────────────────────────────────────────────────────────────
mv "$STAGING.sha256-obsahu" "$CILOVY.sha256-obsahu"
mv "$STAGING" "$CILOVY"
STAGING=""
chmod 600 "$CILOVY" "$CILOVY.sha256-obsahu"

if [ "$OVERENO" = 1 ]; then
  echo "✅ Odvezeno a ověřeno rozšifrováním: $CILOVY (${VELIKOST} B)"
else
  echo "⚠️  Odvezeno, ale NEOVĚŘENO: soubor s heslem $HESLO neexistuje."
  echo "    Archiv tu leží, ale nikdo nezkusil, jestli se dá otevřít."
  echo "    Ulož heslo do $HESLO (chmod 600) a spusť skript znovu."
fi

# ── Promazání starších kopií ─────────────────────────────────────────────────
# Notebook nemá zarůstat osobními údaji. Maže se až tady, po úspěšném
# zveřejnění, a jen nad hotovými archivy — ne nad VADNY-* a NEOVERENY-*,
# o kterých má rozhodnout člověk.
#
# Archiv, který tenhle běh právě zveřejnil, se NIKDY nemaže. Řadí se podle času
# souboru, a kdyby měl jiný archiv čas v budoucnosti (posunuté hodiny, kopie se
# zachovanými časy), propadl by ten nový na konec seznamu a smazal by se — tedy
# „odvezeno a ověřeno" a hned nato prázdno. Vyzkoušeno, ne odhadnuto.
POCET="$(ls -t "$CIL"/nexus_*.dump.gpg 2>/dev/null | wc -l | tr -d '[:space:]')"
if [ "${POCET:-0}" -gt "$PONECHAT" ]; then
  ls -t "$CIL"/nexus_*.dump.gpg | tail -n +$((PONECHAT + 1)) | while IFS= read -r stary; do
    if [ "$stary" = "$CILOVY" ]; then
      echo "    ponechávám právě odvezený: $(basename "$stary")"
      continue
    fi
    rm -f "$stary" "$stary.sha256-obsahu"
    echo "    promazáno staré: $(basename "$stary")"
  done
fi
