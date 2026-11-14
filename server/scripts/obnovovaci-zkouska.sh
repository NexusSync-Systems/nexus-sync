#!/usr/bin/env bash
#
# Obnovovací zkouška zálohy — JEDINÁ kontrola, která zálohu opravdu obnoví.
#
# Co už existuje a co tedy tahle zkouška NEDĚLÁ:
#
#   - `backup-postgres.sh` při vzniku ověří velikost, čitelnost archivu
#     (`pg_restore --list`) a checksum;
#   - `sifrovana-kopie.sh` zašifruje a hned zkušebně rozšifruje, na shodu
#     sha256 s původním souborem;
#   - `kontrola-veku.sh` a `Hlídka serveru` hlídají, že záloha vzniká
#     a není starší než 36 hodin.
#
# Žádná z nich ale neodpovídá na otázku, kvůli které zálohy existují:
# VZNIKNE Z TOHO FUNKČNÍ DATABÁZE? Čitelný archiv a obnovitelná databáze
# nejsou totéž. Tahle zkouška proto obnoví dump do dočasné databáze a
# podívá se, co v ní je.
#
# Obnovuje se ROZŠIFROVANÁ kopie `.gpg`, ne původní dump. Právě ta kopie
# opouští server, takže tvrzení, které chceme mít podložené, je „soubor,
# který odvážíme, se dá přeměnit na běžící databázi" — a to se nedokáže
# obnovením jiného souboru.
#
# TOHLE ZAPISUJE: zakládá a maže dočasnou databázi. Čtení zůstává čtením
# jen u produkční databáze, ze které se berou počty řádků na srovnání.
#
# Použití na serveru (volá to workflow `obnovovaci-zkouska.yml` přes SSH):
#
#   sudo bash /root/nexus-backend/scripts/obnovovaci-zkouska.sh
#
# Pro zkoušku nasucho jde všechno přenastavit přes proměnné prostředí
# (BACKUP_DIR, HESLO, DATABASE_URL, SPRAVCE_URL, DOCASNA_DB, MIN_VOLNO_MB).
set -uo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/nexus}"
HESLO="${HESLO:-/root/zaloha-heslo.txt}"
DOCASNA_DB="${DOCASNA_DB:-nexus_obnova_zkouska}"
MIN_VOLNO_MB="${MIN_VOLNO_MB:-2048}"
# Tabulky, na kterých se pozná, že v obnovené databázi jsou DATA, ne jen
# prázdné schéma. Shodné se seznamem ve verify-restore-postgres.sh.
TABULKY="${TABULKY:-Agency User Profile Chat Message Subscription DeviceBinding}"

CHYBA=0
chyba() { echo "::error::$*" >&2; CHYBA=$((CHYBA+1)); }
krok()  { echo; echo "── $* ──"; }

# ── Konfigurace produkční databáze ───────────────────────────────────────────
# Stejný způsob, jakým ji čte backup-postgres.sh: z prostředí, jinak z .env
# vedle aplikace. Tím se zkouška nemůže rozejít s tím, co se zálohuje.
if [ -z "${DATABASE_URL:-}" ] && [ -f /root/nexus-backend/.env ]; then
  DATABASE_URL="$(cd /root/nexus-backend && node -e "require('dotenv').config(); process.stdout.write(process.env.DATABASE_URL || '')" 2>/dev/null)"
fi
if [ -z "${DATABASE_URL:-}" ]; then
  echo "::error::DATABASE_URL se nedá zjistit — bez ní není s čím srovnávat." >&2
  exit 1
fi

# Adresa, pod kterou se zakládá a maže dočasná databáze. Na `postgres` se
# připojit musíme, protože do databáze, kterou právě zakládáme, to nejde.
if [ -z "${SPRAVCE_URL:-}" ]; then
  SPRAVCE_URL="$(printf '%s' "$DATABASE_URL" | sed -E 's#(/)[^/?]+(\?|$)#\1postgres\2#')"
fi

# ── Pojistka: nikdy nesahat na produkční databázi ────────────────────────────
# verify-restore-postgres.sh porovnává celé URL. To nestačí: stejná databáze
# se dá zapsat i jinou adresou (jiný host, jiné heslo, `localhost` proti
# `127.0.0.1`). Proto se porovnává i JMÉNO databáze, a to je ta hodnota,
# kterou pg_restore opravdu použije.
PROD_DB="$(printf '%s' "$DATABASE_URL" | sed -E 's#^.*/([^/?]+)(\?.*)?$#\1#')"
if [ "$DOCASNA_DB" = "$PROD_DB" ]; then
  echo "::error::Dočasná databáze se jmenuje stejně jako produkční ($PROD_DB). Odmítám pokračovat." >&2
  exit 1
fi
case "$DOCASNA_DB" in
  *obnova*|*zkouska*|*test*) : ;;
  *) echo "::error::Jméno dočasné databáze ($DOCASNA_DB) nenese 'obnova', 'zkouska' ani 'test'. Odmítám pokračovat." >&2; exit 1 ;;
esac

PRACOVNI=""
uklid() {
  # Uklízí se VŽDY, i při pádu uprostřed. Dočasná databáze s kopií dat, která
  # na serveru zůstane ležet, je horší než neprovedená zkouška.
  [ -n "$PRACOVNI" ] && rm -rf "$PRACOVNI"
  if [ -n "${DB_ZALOZENA:-}" ]; then
    psql "$SPRAVCE_URL" -q -v ON_ERROR_STOP=0 \
      -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$DOCASNA_DB';" \
      >/dev/null 2>&1
    if psql "$SPRAVCE_URL" -q -c "DROP DATABASE IF EXISTS \"$DOCASNA_DB\";" >/dev/null 2>&1; then
      echo "✓ dočasná databáze smazána"
    else
      echo "::error::DOČASNOU DATABÁZI $DOCASNA_DB NEŠLO SMAZAT — leží na serveru s kopií dat." >&2
    fi
  fi
}
trap uklid EXIT

krok "1. Který soubor se bude obnovovat"
# shellcheck disable=SC2012
GPG="$(ls -t "$BACKUP_DIR"/nexus_*.dump.gpg 2>/dev/null | head -1 || true)"
if [ -z "$GPG" ]; then
  chyba "v $BACKUP_DIR není žádná šifrovaná kopie — není co obnovovat"
  exit 1
fi
VEK_H=$(( ( $(date +%s) - $(stat -c %Y "$GPG" 2>/dev/null || stat -f %m "$GPG") ) / 3600 ))
echo "šifrovaná kopie: $(basename "$GPG"), ${VEK_H} h stará, $(wc -c < "$GPG" | tr -d ' ') B"

krok "2. Rozšifrování a shoda s tím, co se šifrovalo"
[ -f "$HESLO" ] || { chyba "chybí heslo $HESLO — archiv nikdo neotevře"; exit 1; }
PRACOVNI="$(mktemp -d)"
DUMP="$PRACOVNI/obnova.dump"
if ! gpg --batch --quiet --pinentry-mode loopback \
         --passphrase-file "$HESLO" \
         --output "$DUMP" --decrypt "$GPG" 2>/dev/null; then
  chyba "šifrovanou kopii NELZE rozšifrovat — záloha je nepoužitelná"
  exit 1
fi
# `.sha256-obsahu` zapsala sifrovana-kopie.sh a je v něm součet PŮVODNÍHO
# dumpu. Tím se pozná poškození, které vzniklo až PO zašifrování — kontrola
# při vzniku na to nedosáhne.
OCEKAVANY="$(cut -d' ' -f1 < "$GPG.sha256-obsahu" 2>/dev/null)"
SKUTECNY="$(sha256sum "$DUMP" 2>/dev/null | cut -d' ' -f1)"
if [ -z "$OCEKAVANY" ]; then
  echo "::warning::k šifrované kopii chybí .sha256-obsahu, poškození po zašifrování nejde vyloučit"
elif [ "$OCEKAVANY" != "$SKUTECNY" ]; then
  chyba "rozšifrovaný dump NESOUHLASÍ se součtem z doby šifrování"
  exit 1
else
  echo "✓ rozšifrováno a součet souhlasí"
fi

krok "3. Je na to místo"
VOLNO_MB=$(( $(df -k "$PRACOVNI" | awk 'NR==2{print $4}') / 1024 ))
echo "volné místo: ${VOLNO_MB} MB (mez ${MIN_VOLNO_MB} MB)"
if [ "$VOLNO_MB" -lt "$MIN_VOLNO_MB" ]; then
  chyba "málo místa na obnovení — zkouška by mohla zaplnit disk a shodit zálohy i aplikaci"
  exit 1
fi

krok "4. Obnovení do dočasné databáze $DOCASNA_DB"
psql "$SPRAVCE_URL" -q -c "DROP DATABASE IF EXISTS \"$DOCASNA_DB\";" >/dev/null 2>&1
if ! psql "$SPRAVCE_URL" -q -c "CREATE DATABASE \"$DOCASNA_DB\";" >/dev/null 2>&1; then
  chyba "dočasnou databázi nelze založit"
  exit 1
fi
DB_ZALOZENA=1
OBNOVA_URL="$(printf '%s' "$SPRAVCE_URL" | sed -E "s#(/)postgres(\?|$)#\1$DOCASNA_DB\2#")"

# `--exit-on-error` schválně: bez něj pg_restore chyby vypíše, ale skončí
# nulou, takže by zkouška hlásila úspěch nad polovinou databáze.
CHYBY_OBNOVY="$PRACOVNI/obnova.log"
if ! pg_restore --no-owner --no-acl --exit-on-error \
       --dbname "$OBNOVA_URL" "$DUMP" > "$CHYBY_OBNOVY" 2>&1; then
  chyba "obnovení SELHALO"
  echo "--- posledních 15 řádků pg_restore ---" >&2
  tail -15 "$CHYBY_OBNOVY" >&2
  exit 1
fi
echo "✓ pg_restore prošel bez chyby"

krok "5. Co v obnovené databázi je"
TABULEK=$(psql "$OBNOVA_URL" -t -A -c \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';" 2>/dev/null)
echo "tabulek v public: ${TABULEK:-0}"
if [ "${TABULEK:-0}" -lt 10 ]; then
  chyba "obnovená databáze má jen ${TABULEK:-0} tabulek — to není celá databáze"
fi

# Počty řádků vedle sebe. Rozdíly jsou NORMÁLNÍ: záloha je až den stará
# a retenční úloha mezitím maže staré zprávy a body trasy. Proto se tím
# zkouška nezastavuje — hlásí se jako údaj pro člověka. Zastaví ji až
# tabulka, která v obnovené databázi vůbec není.
printf '%-16s %10s %10s\n' "tabulka" "v záloze" "na produkci"
for T in $TABULKY; do
  Z=$(psql "$OBNOVA_URL" -t -A -c "SELECT count(*) FROM \"$T\";" 2>/dev/null)
  P=$(psql "$DATABASE_URL" -t -A -c "SELECT count(*) FROM \"$T\";" 2>/dev/null)
  printf '%-16s %10s %10s\n' "$T" "${Z:-CHYBÍ}" "${P:-?}"
  if [ -z "$Z" ]; then
    chyba "tabulka $T v obnovené databázi NEEXISTUJE"
  fi
done

krok "Verdikt"
if [ "$CHYBA" -gt 0 ]; then
  echo "Obnovovací zkouška NAŠLA $CHYBA problém(ů)."
  exit 1
fi
echo "✅ Záloha z $(basename "$GPG") se obnovila do funkční databáze."
