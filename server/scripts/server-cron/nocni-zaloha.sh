#!/usr/bin/env bash
#
# Noční záloha databáze. Spouští cron, viz `crontab -l` roota.
#
# Proč obal a ne rovnou skript z repozitáře: cron při nenulovém návratovém
# kódu pošle mail rootovi, a na tomhle stroji žádná pošta nakonfigurovaná není.
# Selhání by tedy nikdo nikdy neviděl — tedy přesně to, co 3. 11. 2026 stálo
# produkční data. Obal proto píše do logu a při chybě nechá v adresáři záloh
# nápadný soubor SELHALO-*.txt, který je vidět i při pouhém `ls`.
set -uo pipefail

LOG=/var/log/nexus-zaloha.log
BACKUP_DIR=/var/backups/nexus
export BACKUP_DIR
export RETENTION_DAYS=14

ted() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }
zapis() { echo "$(ted) $*" >> "$LOG"; }

cd /root/nexus-backend || { zapis "CHYBA: /root/nexus-backend neexistuje"; exit 1; }

zapis "start"
VYSTUP="$(bash scripts/backup-postgres.sh 2>&1)"
KOD=$?

echo "$VYSTUP" | while IFS= read -r r; do zapis "  $r"; done

if [ "$KOD" -ne 0 ]; then
  ZNACKA="$BACKUP_DIR/SELHALO-$(date -u +%Y%m%dT%H%M%SZ).txt"
  {
    echo "Noční záloha selhala $(ted), návratový kód $KOD."
    echo
    echo "$VYSTUP"
  } > "$ZNACKA" 2>/dev/null || true
  zapis "CHYBA: záloha selhala (kód $KOD), značka $ZNACKA"
  exit "$KOD"
fi

# Úspěch maže značky po předchozích selháních, aby v adresáři nezůstaly navždy.
rm -f "$BACKUP_DIR"/SELHALO-*.txt 2>/dev/null || true

# Sifrovana kopie pro odvoz ze serveru. Selze-li, zaloha sama uz hotova je,
# takze to neni duvod hlasit cely beh jako chybu — ale do logu to patri.
VYSTUP_S="$(/root/nexus-zalohy/sifrovana-kopie.sh 2>&1)"
KOD_S=$?
echo "$VYSTUP_S" | while IFS= read -r r; do zapis "  $r"; done
if [ "$KOD_S" -ne 0 ]; then
  zapis "VAROVANI: sifrovana kopie selhala (kod $KOD_S) — zaloha na serveru je, odvezt ji nejde"
fi

zapis "hotovo"
