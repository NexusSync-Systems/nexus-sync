#!/usr/bin/env bash
#
# Drží instanci nad mezí nečinnosti, při které ji Oracle Cloud smí zabavit.
#
# PROČ: Always Free instance je podle dokumentace Oracle nečinná, když za
# 7 dní platí VŠECHNY tyhle podmínky zároveň:
#
#     CPU utilization for the 95th percentile is less than 20%
#     Network utilization is less than 20%
#     Memory utilization is less than 20%   (jen ARM shapes)
#
#   https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm
#
# Stačí tedy prolomit JEDNU. Síť by znamenala držet ~96 Mbps (20 % z 0,48 Gbps),
# což je nesmysl. CPU je jediná dosažitelná.
#
# Měřeno 5. 11. 2026 ze sysstatu za tři dny (261 vzorků):
#   průměr 0,79 % · medián 0,37 % · 95. percentil 2,22 % · maximum 18,12 %
# Tedy devětkrát pod mezí. Bez tohohle skriptu je ten server kandidát na zabavení.
#
# JAK: 95. percentil ≥ 20 % znamená, že víc než 5 % vzorků musí být nad 20 %.
# OCI Monitoring vzorkuje po minutě, tedy 504 z 10 080 minut týdne. Pět minut
# zátěže dvakrát za hodinu dává 1 680 minut (16,7 %) — trojá rezerva na
# vynechané běhy, rebooty a nasazení.
#
# Zátěž je jedno vlákno ze dvou, takže během běhu je vytížení instance ~50 %.
#
# POZOR PŘI OVĚŘOVÁNÍ: lokální `sar` na tomhle stroji vzorkuje po DESETI
# minutách, takže pětiminutovou zátěž zprůměruje na ~25 % a vypadá to těsně.
# Oracle měří po minutě, kde je to ~50 %. Z `sar` se proto nedá číst, jestli
# opatření funguje — spolehlivý údaj je POČET úspěšných běhů v tomhle logu
# (čeká se 48 za den). Tak to taky kontroluje hlídka v CI.
#
# BEZPEČNOST APLIKACE: `nice -n 19` znamená, že cokoli jiného má přednost —
# aplikace tedy o CPU nepřijde. Na měřené vytížení to vliv nemá, procesor je
# vytížený bez ohledu na prioritu. Zátěž je čistě výpočetní (`/dev/zero` je
# v jádře), takže nesahá na disk ani na síť. Žádná paměť se nealokuje.
#
# CO TOHLE NEŘEŠÍ: Oracle si vyhrazuje právo Always Free zdroje odebrat i tak
# a dokumentace neříká, jestli instanci zastaví, nebo smaže. Tohle snižuje
# pravděpodobnost, nedává záruku. Zárukou je jedině odvezená záloha
# a postup přestavby — viz docs/jak-neprijit-o-server.md.
set -uo pipefail

LOG=/var/log/nexus-udrzba.log
TEP=/var/log/nexus-udrzba-posledni.txt
STOPKA=/etc/nexus-udrzba-vypnuto
ZAMEK=/run/lock/nexus-udrzba.lock
SEKUND="${NEXUS_UDRZBA_SEKUND:-300}"
LOG_MAX_RADKU=2000

ted() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }
zapis() { echo "$(ted) $*" >> "$LOG" 2>/dev/null || true; }

# Vypínač bez nasazení. Kdyby zátěž někdy překážela, `touch /etc/nexus-udrzba-vypnuto`
# ji zastaví okamžitě a nasazení ho nepřepíše.
if [ -e "$STOPKA" ]; then
  zapis "VYPNUTO: existuje $STOPKA, nespouštím zátěž"
  exit 0
fi

# Jeden běh zároveň. Bez tohohle by se při zpomaleném stroji běhy vrstvily
# a zátěž by rostla, místo aby zůstala na nastavené úrovni.
exec 9>"$ZAMEK" 2>/dev/null || exit 0
if ! flock -n 9; then
  zapis "PŘESKAKUJI: předchozí běh ještě neskončil"
  exit 0
fi

# `timeout` vrací 124, když proces sám ukončí — to je tady ten očekávaný konec,
# ne chyba. Čímkoli jiným skončit nemá.
START=$(date +%s)
timeout "$SEKUND" nice -n 19 sha256sum /dev/zero >/dev/null 2>&1
KOD=$?
TRVANI=$(( $(date +%s) - START ))

if [ "$KOD" -eq 124 ]; then
  ZATIZENI="$(awk '{print $1}' /proc/loadavg 2>/dev/null || echo '?')"
  zapis "OK: zátěž ${TRVANI}s (cíl ${SEKUND}s), load po běhu ${ZATIZENI}"
  echo "$(ted) ok ${TRVANI}s" > "$TEP" 2>/dev/null || true
else
  # Sem spadne chybějící sha256sum, zabitý proces i cokoli nečekaného.
  # Hlídka v CI čte $TEP — když se přestane obnovovat, založí se chyba.
  zapis "SELHALO: návratový kód $KOD po ${TRVANI}s (čekáno 124 od timeout)"
fi

# Log se jinak plní navždy: 48 řádků denně na stroji, kde nikdo nic nemaže.
RADKU="$(wc -l < "$LOG" 2>/dev/null || echo 0)"
if [ "$RADKU" -gt "$LOG_MAX_RADKU" ]; then
  tail -n $(( LOG_MAX_RADKU / 2 )) "$LOG" > "$LOG.novy" 2>/dev/null \
    && mv "$LOG.novy" "$LOG" 2>/dev/null \
    && zapis "log zkrácen z $RADKU řádků"
fi
