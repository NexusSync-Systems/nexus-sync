#!/usr/bin/env bash
#
# Nainstaluje cron pro udrzuj-instanci.sh. Spouští se Z NASAZENÍ, ne z cronu.
#
# PROČ TAKHLE: na server se nedá zapisovat ručně — zápis přes SSH je mimo to,
# co smím dělat. Nasazení z CI ale tělo skriptu spouští jako root, takže tohle
# je jediná cesta, jak se cron na server dostane. Současně je to lepší cesta:
# co je v repozitáři, se po přestavbě serveru nainstaluje samo a nikdo si
# nemusí pamatovat, že to má dodělat ručně.
#
# Skripty záloh v tomhle adresáři jsou oproti tomu jen KOPIE toho, co leží
# v /root/nexus-zalohy/ — ty si server drží sám, protože musí fungovat i bez
# klonu repozitáře. Viz README.md vedle.
#
# Je idempotentní: při každém nasazení zkontroluje, že cron odpovídá tomuhle
# souboru, a zapisuje jen při rozdílu. Opakované nasazení tedy nic nemění.
set -uo pipefail

CRON=/etc/cron.d/nexus-udrzba
MINUTY="${NEXUS_UDRZBA_MINUTY:-4,34}"

# Cesta se bere z místa, odkud skript běží, ne natvrdo. Kdyby se layout
# na serveru změnil, cron bude pořád ukazovat na správný soubor.
KDE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKRIPT="$KDE/udrzuj-instanci.sh"

if [ ! -f "$SKRIPT" ]; then
  echo "❌ Nenašel jsem $SKRIPT — cron neinstaluji."
  echo "   Cron ukazující na neexistující soubor by selhával každou půlhodinu."
  exit 1
fi

# Bit x nese git a rsync ho zachová, ale kdyby ne, cron by jen tiše selhával.
if [ ! -x "$SKRIPT" ]; then
  chmod +x "$SKRIPT" || { echo "❌ $SKRIPT není spustitelný a chmod neprošel."; exit 1; }
  echo "   (doplnil jsem bit x na $SKRIPT)"
fi

# /etc/cron.d vyžaduje uživatele v šestém poli, mód 644 a vlastníka root.
# Soubor nesmí mít v názvu tečku, jinak ho cron ignoruje — proto "nexus-udrzba".
OBSAH="# Spravuje nasazení z CI: server/scripts/server-cron/instaluj-udrzbu.sh
# Ruční změny tady PŘEPÍŠE příští nasazení. Vypínač je /etc/nexus-udrzba-vypnuto.
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
$MINUTY * * * * root $SKRIPT"

if [ -f "$CRON" ] && [ "$(cat "$CRON")" = "$OBSAH" ]; then
  echo "✓ Cron údržby instance je už nastavený (minuty $MINUTY), nemění se."
else
  printf '%s\n' "$OBSAH" > "$CRON" || { echo "❌ Nelze zapsat $CRON (běží to jako root?)"; exit 1; }
  chmod 644 "$CRON"
  chown root:root "$CRON" 2>/dev/null || true
  echo "✓ Nastaven cron údržby instance: $CRON (minuty $MINUTY)"
fi

# Cron, který neběží, by znamenal, že zátěž nikdy nevznikne a instance zůstane
# nečinná — přesně stav, který tohle má řešit. Proto se to ověří a nahlásí.
if ! systemctl is-active --quiet cron 2>/dev/null; then
  echo "::warning::Služba cron NEBĚŽÍ — údržba instance se nespustí. Na serveru: systemctl enable --now cron"
fi
