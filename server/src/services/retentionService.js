const prisma = require('./db');
const logger = require('./logger');
const { doby, hranice } = require('../config/retention');

/**
 * Úklid osobních údajů po uplynutí doby uchování.
 *
 * Nejdůležitější pravidlo celého souboru: ÚKLID NIKDY NESMÍ SÁHNOUT NA ŽIVÝ
 * INCIDENT. Běžící, čekající nebo eskalovaná bezpečnostní relace a neuzavřený
 * SOS poplach jsou situace, kde někdo může být v ohrožení a trasa je to jediné,
 * co o něm víme. Proto se všude maže podle stavu nadřazeného záznamu
 * (`RESOLVED` / `resolved`), ne podle stáří samotného bodu — starý bod živé
 * relace zůstává.
 *
 * Druhé pravidlo: úloha nesmí shodit cron. Každý druh dat se uklízí zvlášť a
 * selhání jednoho nezastaví ostatní, protože jinak by jedna rozbitá tabulka
 * zastavila úklid všech ostatních a nikdo by si toho nevšiml.
 */

/** Jeden druh dat: spočítá, smaže, vrátí počet. Chybu zaloguje a vrátí null. */
async function uklid(nazev, povoleno, smaz) {
  if (!povoleno) return null;

  try {
    const { count } = await smaz();
    if (count > 0) logger.info(`[Retence] ${nazev}: smazáno ${count} záznamů`);
    return count;
  } catch (error) {
    logger.error(`[Retence] ${nazev} selhalo: ${error.message}`);
    return null;
  }
}

/**
 * Body trasy z bezpečnostních relací.
 *
 * Maže se podle `resolvedAt` relace, ne podle `capturedAt` bodu: rozhodující
 * je, jak dlouho je schůzka uzavřená, ne jak starý je jednotlivý bod.
 */
function uklidSafetyPoints(hranice) {
  return prisma.safetyLocationPoint.deleteMany({
    where: {
      session: {
        state: 'RESOLVED',
        resolvedAt: { not: null, lt: hranice },
      },
    },
  });
}

/**
 * Polohy z GPS trackerů.
 *
 * Tyhle můžou existovat i bez relace (tracker hlásí průběžně), takže se maže
 * podle stáří bodu — ale jen pokud nevisí na nevyřešené relaci ani na
 * neuzavřeném SOS.
 */
function uklidTrackerPoints(hranice) {
  return prisma.gpsTrackerLocation.deleteMany({
    where: {
      capturedAt: { lt: hranice },
      OR: [{ safetySessionId: null }, { safetySession: { state: 'RESOLVED' } }],
      AND: [{ OR: [{ sosAlertId: null }, { sosAlert: { status: 'resolved' } }] }],
    },
  });
}

/** Polohy při SOS — jen z uzavřených poplachů. */
function uklidSosPoints(hranice) {
  return prisma.sOSLocationUpdate.deleteMany({
    where: {
      sosAlert: {
        status: 'resolved',
        resolvedAt: { not: null, lt: hranice },
      },
    },
  });
}

/**
 * Souřadnice uložené PŘÍMO na poplachu.
 *
 * SOSAlert nese vlastní lat/lng/accuracy — první polohu v okamžiku spuštění.
 * Mazat jen podřízené SOSLocationUpdate tedy polohu nesmaže: zůstane na
 * poplachu napořád, a u poplachu, který žádné další body nedostal, je to
 * dokonce JEDINÁ uložená poloha. Proto se nuluje za stejných podmínek.
 */
function uklidSosSouradnice(hranice) {
  return prisma.sOSAlert.updateMany({
    where: {
      status: 'resolved',
      resolvedAt: { not: null, lt: hranice },
      OR: [{ lat: { not: null } }, { lng: { not: null } }, { accuracy: { not: null } }],
    },
    data: { lat: null, lng: null, accuracy: null },
  });
}

/**
 * Poslední známá poloha trackeru.
 *
 * GpsTracker si drží lastLat/lastLng/lastAccuracy/lastCapturedAt jako cache
 * posledního hlášení. Historii v GpsTrackerLocation uklidíme, ale tahle kopie
 * by přežila — u trackeru, který přestal hlásit, by jeho poslední poloha
 * zůstala uložená navždy.
 *
 * Podmínka na lastCapturedAt zároveň zaručuje, že čerstvé hlášení se nesmaže:
 * jakmile tracker pošle novou polohu, časové razítko je mimo hranici a
 * záznam se neaktualizuje. Tracker, jehož polohy visí na nevyřešené relaci
 * nebo neuzavřeném SOS, se vynechává úplně.
 */
function uklidTrackerPosledniPoloha(hranice) {
  return prisma.gpsTracker.updateMany({
    where: {
      lastCapturedAt: { not: null, lt: hranice },
      OR: [{ lastLat: { not: null } }, { lastLng: { not: null } }, { lastAccuracy: { not: null } }],
      locations: {
        none: {
          OR: [
            { safetySession: { state: { not: 'RESOLVED' } } },
            { sosAlert: { status: { not: 'resolved' } } },
          ],
        },
      },
    },
    data: { lastLat: null, lastLng: null, lastAccuracy: null, lastCapturedAt: null },
  });
}

/** Obsah zpráv. */
function uklidZpravy(hranice) {
  return prisma.message.deleteMany({ where: { createdAt: { lt: hranice } } });
}

/**
 * Logy přístupu k datům.
 *
 * Řádky s `violation: true` jsou pokusy o neoprávněný přístup — bezpečnostní
 * důkaz, ne provozní záznam. Ty se nemažou: zahodit je po půl roce by znamenalo
 * zahodit jedinou stopu o tom, že se někdo hrabal, kam neměl.
 */
function uklidPristupoveLogy(hranice) {
  return prisma.dataAccessLog.deleteMany({
    where: { timestamp: { lt: hranice }, violation: false },
  });
}

/** Auditní log. Viz komentář u `auditLog` v config/retention.js. */
function uklidAuditniLogy(hranice) {
  return prisma.auditLog.deleteMany({ where: { timestamp: { lt: hranice } } });
}

/**
 * Projde všechny druhy dat. Vrací přehled { druh: počet | null }, kde null
 * znamená „vypnuto nebo selhalo" — volající (cron) ho jen zaloguje.
 */
async function spustUklid(ted = new Date()) {
  const d = doby();

  const h = {
    safetyLocationPoint: hranice(d.safetyLocationPoint, ted),
    gpsTrackerLocation: hranice(d.gpsTrackerLocation, ted),
    sosLocationUpdate: hranice(d.sosLocationUpdate, ted),
    message: hranice(d.message, ted),
    dataAccessLog: hranice(d.dataAccessLog, ted),
    auditLog: hranice(d.auditLog, ted),
  };

  const vysledek = {
    safetyLocationPoint: await uklid('Body trasy (relace)', h.safetyLocationPoint, () => uklidSafetyPoints(h.safetyLocationPoint)),
    gpsTrackerLocation: await uklid('Polohy trackerů', h.gpsTrackerLocation, () => uklidTrackerPoints(h.gpsTrackerLocation)),
    gpsTrackerLast: await uklid('Poslední poloha trackerů', h.gpsTrackerLocation, () => uklidTrackerPosledniPoloha(h.gpsTrackerLocation)),
    sosLocationUpdate: await uklid('Polohy SOS', h.sosLocationUpdate, () => uklidSosPoints(h.sosLocationUpdate)),
    sosAlertSouradnice: await uklid('Souřadnice poplachů', h.sosLocationUpdate, () => uklidSosSouradnice(h.sosLocationUpdate)),
    message: await uklid('Zprávy', h.message, () => uklidZpravy(h.message)),
    dataAccessLog: await uklid('Logy přístupu', h.dataAccessLog, () => uklidPristupoveLogy(h.dataAccessLog)),
    auditLog: await uklid('Auditní logy', h.auditLog, () => uklidAuditniLogy(h.auditLog)),
  };

  const celkem = Object.values(vysledek).reduce((s, n) => s + (n || 0), 0);
  logger.info(`[Retence] Úklid hotov, smazáno celkem ${celkem} záznamů`);

  return vysledek;
}

module.exports = { spustUklid };
