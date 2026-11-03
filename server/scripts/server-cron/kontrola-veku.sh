#!/usr/bin/env bash
#
# Hlídá, že záloha vůbec vzniká. Cron, který tiše přestane běhat, je horší než
# žádný — vypadá to zařízeně. Tahle kontrola proto denně ověří, že nejnovější
# záloha není starší než 36 hodin, a jinak křičí do logu a nechá značku.
set -uo pipefail
LOG=/var/log/nexus-zaloha.log
BACKUP_DIR=/var/backups/nexus
MEZ_HODIN=36

ted() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }
NEJNOVEJSI="$(ls -t "$BACKUP_DIR"/nexus_*.dump 2>/dev/null | head -1)"

if [ -z "$NEJNOVEJSI" ]; then
  echo "$(ted) KONTROLA: v $BACKUP_DIR není ŽÁDNÁ záloha" >> "$LOG"
  echo "V $BACKUP_DIR není žádná záloha ($(ted))." > "$BACKUP_DIR/ZADNA-ZALOHA.txt" 2>/dev/null || true
  exit 1
fi

VEK_S=$(( $(date +%s) - $(stat -c %Y "$NEJNOVEJSI") ))
VEK_H=$(( VEK_S / 3600 ))
if [ "$VEK_H" -gt "$MEZ_HODIN" ]; then
  echo "$(ted) KONTROLA: nejnovější záloha je ${VEK_H} h stará (mez ${MEZ_HODIN} h): $NEJNOVEJSI" >> "$LOG"
  echo "Nejnovější záloha je ${VEK_H} h stará, mez je ${MEZ_HODIN} h. Cron možná neběží. ($(ted))" > "$BACKUP_DIR/ZALOHA-ZASTARALA.txt" 2>/dev/null || true
  exit 1
fi

rm -f "$BACKUP_DIR"/ZADNA-ZALOHA.txt "$BACKUP_DIR"/ZALOHA-ZASTARALA.txt 2>/dev/null || true
echo "$(ted) KONTROLA: v pořádku, nejnovější záloha ${VEK_H} h stará" >> "$LOG"
