#!/usr/bin/env bash
#
# Zašifrovaná záloha konfigurace serveru (.env).
#
# PROČ: noční záloha zálohuje PostgreSQL. Konfiguraci ne — a ta existuje
# JEN na tom stroji. Zjištěno 5. 11. 2026: v adresáři záloh nebyl ani jeden
# soubor s konfigurací.
#
# Čtyři hodnoty z .env nejsou nikde jinde a nasazení je po přestavbě serveru
# nedoplní, protože nejsou v GitHub secretech:
#
#   ENCRYPTION_KEY       AES-256-GCM klíč, kterým profileController.js šifruje
#                        profile.credentials. Bez něj zálohu databáze obnovíte,
#                        ale přístupové údaje profilů z ní nedostane nikdo.
#   SIP_ENCRYPTION_KEY   totéž pro SIP
#   DEVICE_SECRET        bez něj se všechny relay telefony musí spárovat znovu
#   JWT_SECRET           bez něj se musí znovu přihlásit všichni
#
# Záloha databáze, kterou nejde rozšifrovat, není záloha. Tohle je ta chybějící
# polovina.
#
# Šifruje se TÍMŽ heslem jako dumpy (/root/zaloha-heslo.txt), schválně: jedno
# heslo k zapamatování, a kdo má odvezené dumpy, má i konfiguraci k nim.
#
# CO TO NEŘEŠÍ: na serveru leží heslo vedle archivu, takže proti útočníkovi
# s rootem tohle neochrání nic. Smysl je v tom, že kopie, která OPOUŠTÍ server,
# je šifrovaná. Stejná vlastnost jako u dumpů.
set -euo pipefail
umask 077

# Všechny cesty jdou přepsat, aby šel skript spustit v testu. Výchozí hodnoty
# jsou produkční; test si podstrčí vlastní, ať nesahá na skutečné heslo.
HESLO="${NEXUS_ZALOHA_HESLO:-/root/zaloha-heslo.txt}"
ZDROJ="${NEXUS_ENV_SOUBOR:-/root/nexus-backend/.env}"
BACKUP_DIR="${NEXUS_BACKUP_DIR:-/var/backups/nexus}"
PONECHAT_DNI="${NEXUS_KONFIG_RETENCE:-14}"

[ -f "$HESLO" ] || { echo "❌ Chybí $HESLO" >&2; exit 1; }
DELKA="$(head -n 1 "$HESLO" | tr -d '\r\n' | wc -c | tr -d '[:space:]')"
[ "${DELKA:-0}" -ge 20 ] || { echo "❌ První řádek hesla má jen ${DELKA} B" >&2; exit 1; }

[ -f "$ZDROJ" ] || { echo "❌ Nenašel jsem konfiguraci $ZDROJ — není co zálohovat" >&2; exit 1; }
[ -s "$ZDROJ" ] || { echo "❌ $ZDROJ je prázdný — odmítám to vydávat za zálohu" >&2; exit 1; }

mkdir -p "$BACKUP_DIR"
SOUCET="$(sha256sum "$ZDROJ" | cut -d' ' -f1)"

# Konfigurace se mění zřídka. Bez tohohle by tu po roce leželo 365 totožných
# archivů a v tom se nedá poznat, KDY se co změnilo.
#
# SC2012 (`find` místo `ls`) se tu nehodí: jde o řazení podle času a jména si
# tenhle skript generuje sám ve tvaru konfigurace_<ISO8601>.env.gpg, takže
# mezery ani jiné záludnosti v nich být nemůžou.
# shellcheck disable=SC2012
NEJNOVEJSI="$(ls -t "$BACKUP_DIR"/konfigurace_*.env.gpg 2>/dev/null | head -1)"
if [ -n "$NEJNOVEJSI" ] && [ -f "$NEJNOVEJSI.sha256-obsahu" ]; then
  if [ "$(cut -d' ' -f1 < "$NEJNOVEJSI.sha256-obsahu")" = "$SOUCET" ]; then
    echo "✓ Konfigurace se od poslední zálohy nezměnila, novou nedělám: $(basename "$NEJNOVEJSI")"
    exit 0
  fi
fi

CIL="$BACKUP_DIR/konfigurace_$(date -u +%Y%m%dT%H%M%SZ).env.gpg"

# Heslo NIKDY argumentem — argumenty vidí v `ps` všichni uživatelé stroje.
# A šifruje se rovnou ze zdroje: nešifrovaná kopie .env nesmí v adresáři
# záloh vzniknout ani na okamžik.
gpg --batch --yes --quiet \
    --passphrase-file "$HESLO" \
    --symmetric --cipher-algo AES256 \
    --output "$CIL" "$ZDROJ"

# Zašifrovaný soubor, který nikdo nezkusil otevřít, je jen naděje.
ROZSIFROVANY="$(gpg --batch --quiet --passphrase-file "$HESLO" --decrypt "$CIL" 2>/dev/null | sha256sum | cut -d' ' -f1)"
if [ "$SOUCET" != "$ROZSIFROVANY" ]; then
  echo "❌ Rozšifrovaný archiv nesouhlasí s konfigurací — mažu ho" >&2
  rm -f "$CIL"
  exit 1
fi

echo "$SOUCET  $(basename "$ZDROJ")" > "$CIL.sha256-obsahu"

# ── Retence s pojistkou ───────────────────────────────────────────────────
#
# Samotné `find -mtime +N -delete` by tady byla past: konfigurace se mění
# zřídka, takže po čtrnácti dnech beze změny by smazalo JEDINOU kopii, co
# existuje. Nejnovější archiv se proto nemaže nikdy, bez ohledu na stáří.
NECHAT="$(basename "$CIL")"
find "$BACKUP_DIR" -maxdepth 1 -name 'konfigurace_*.env.gpg' -mtime "+$PONECHAT_DNI" \
     ! -name "$NECHAT" -delete 2>/dev/null || true
find "$BACKUP_DIR" -maxdepth 1 -name 'konfigurace_*.env.gpg.sha256-obsahu' -mtime "+$PONECHAT_DNI" \
     ! -name "$NECHAT.sha256-obsahu" -delete 2>/dev/null || true

# Jen název a velikost. Obsah .env se do logu nedostane ani omylem.
echo "✅ Konfigurace zašifrována a zkušebně rozšifrována: $(basename "$CIL") ($(stat -c %s "$CIL") B)"
