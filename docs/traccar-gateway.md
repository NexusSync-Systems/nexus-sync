# Traccar gateway pro fyzické GPS+SIM trackery

Levné GPS+SIM trackery („puky" GT06/Teltonika/…) **nemluví HTTP** — posílají raw TCP
vendor protokolem. [Traccar](https://www.traccar.org/) (open-source) tyto protokoly
dekóduje a umí pozice **HTTP-forwardovat** na náš endpoint. Nexus tak nepotřebuje
psát TCP parsery pro každý protokol.

```
GPS+SIM tracker  --raw TCP (GT06/Teltonika/…)-->  Traccar  --HTTP JSON forward-->  Nexus /api/trackers/traccar-forward
                                                                                       └─> uloží GpsTrackerLocation, napojí na SafetySession/SOS, socket na mapu
```

## 1. Nasazení Traccaru na VPS (Docker)

```yaml
# docker-compose.yml
services:
  traccar:
    image: traccar/traccar:latest
    restart: unless-stopped
    ports:
      - "8082:8082"        # web UI
      - "5000-5150:5000-5150"  # protokolové porty (každý tracker typ má svůj)
      - "5000-5150:5000-5150/udp"
    volumes:
      - ./traccar.xml:/opt/traccar/conf/traccar.xml:ro
      - traccar-data:/opt/traccar/data
volumes:
  traccar-data:
```

`traccar.xml` (position forwarding na Nexus):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE properties SYSTEM "http://java.sun.com/dtd/properties.dtd">
<properties>
  <entry key="config.default">./conf/default.xml</entry>

  <!-- Forward každou dekódovanou pozici jako JSON na Nexus -->
  <entry key="forward.enable">true</entry>
  <entry key="forward.type">position</entry>
  <entry key="forward.url">https://api.nexusstack.eu/api/trackers/traccar-forward</entry>
  <entry key="forward.json">true</entry>
  <entry key="forward.header">x-forward-secret: ZMĚŇ_MĚ_dlouhé_náhodné_tajemství</entry>
</properties>
```

## 2. Nexus konfigurace

Na serveru nastav env proměnnou se **stejným** tajemstvím:

```
TRACCAR_FORWARD_SECRET=ZMĚŇ_MĚ_dlouhé_náhodné_tajemství
```

Endpoint `POST /api/trackers/traccar-forward` ověří header `x-forward-secret`
(nebo `?secret=`) proti `TRACCAR_FORWARD_SECRET`. Bez nastavené env vrací 503.

## 3. Přidání trackeru

1. V Traccaru přidej zařízení s **Identifier = IMEI** trackeru a nastav tracker,
   aby posílal na `IP_VPS:<port protokolu>` (port podle typu — viz Traccar docs).
2. V Nexusu **spáruj stejné IMEI** (manažer → párování trackeru) — vytvoří se
   `GpsTracker` připnutý na profil. Mapování Traccar→Nexus je právě přes to IMEI
   (`device.uniqueId`).
3. Jakmile tracker pošle pozici, Traccar ji forwardne → objeví se na mapě a
   napojí se na aktivní SafetySession/SOS stejně jako telefon.

## Co endpoint z Traccar payloadu čte
`device.uniqueId` → IMEI (lookup trackeru) · `position.latitude/longitude` ·
`position.speed` (uzly → km/h) · `position.course` → heading · `position.accuracy` ·
`position.attributes.batteryLevel` → baterie · `position.fixTime` → capturedAt.
