/**
 * Jak dlouho se co uchovává.
 *
 * GDPR čl. 5(1)(e) říká, že osobní údaje se nesmí držet déle, než je pro daný
 * účel nutné. Do téhle chvíle neměl projekt ŽÁDNOU úklidovou úlohu: body trasy,
 * zprávy i přístupové logy rostly navždy. U polohových dat je to nejcitlivější —
 * trasa z loňské schůzky nemá účel, ke kterému by se dala obhájit.
 *
 * Výchozí doby jsou schválně krátké. Prodloužení je rozhodnutí s právním
 * dopadem, takže si ho nasazení musí nastavit vědomě přes env, místo aby ho
 * dostalo mlčky jako výchozí stav.
 *
 * Hodnoty se čtou PŘI KAŽDÉM BĚHU, ne při načtení modulu. Kdyby se modul načetl
 * dřív než dotenv, úloha by napořád pracovala s výchozími čísly a tvrdila, že
 * žádná konfigurace není — přesně ta chyba, která se už jednou stala ve
 * fioSyncWorkeru.
 */

/** 0 = nemazat vůbec. */
const NEMAZAT = 0;

function dni(klic, vychozi) {
  const raw = process.env[klic];
  if (raw === undefined || raw === '') return vychozi;

  const n = Number(raw);
  // Záporná nebo nečíselná hodnota by se jinak propsala do data hranice a
  // udělala z úklidu mazání do budoucnosti. Radši výchozí hodnota.
  if (!Number.isFinite(n) || n < 0) return vychozi;
  return Math.floor(n);
}

/**
 * Doby uchování ve dnech.
 *
 * auditLog je schválně NEMAZAT: AuditLog nese `integrityHash`, řetěz SHA-256
 * podpisů přes předchozí záznam. Smazání nejstarších řádků ten řetěz utne a
 * kontrola integrity od té chvíle nemá na čem začít — ověřování auditu by
 * hlásilo poškození, které žádné není. Bezpečnostní audit má navíc vlastní
 * právní titul (oprávněný zájem), takže ho krátká retence netlačí. Kdo ho mazat
 * chce, musí si to zapnout a vědět, co tím ztratí.
 */
function doby() {
  return {
    // Trasa z bezpečnostní relace. Po vyřešené schůzce už nemá účel; smysl má
    // jen po dobu, kdy se incident ještě může došetřovat.
    safetyLocationPoint: dni('RETENTION_SAFETY_LOCATIONS_DAYS', 7),

    // Polohy z GPS trackerů — totéž, jen přicházejí z jiného zdroje.
    gpsTrackerLocation: dni('RETENTION_TRACKER_LOCATIONS_DAYS', 7),

    // Polohy při SOS. Delší doba než u běžné relace: tady je reálná šance, že
    // se k záznamu bude někdo vracet (pojišťovna, policie, stížnost).
    sosLocationUpdate: dni('RETENTION_SOS_LOCATIONS_DAYS', 90),

    // Obsah zpráv. Obchodní záznam, ale ne navždy.
    message: dni('RETENTION_MESSAGES_DAYS', 365),

    // Logy přístupu k datům. Slouží k doložení, kdo se na co díval.
    dataAccessLog: dni('RETENTION_ACCESS_LOGS_DAYS', 180),

    auditLog: dni('RETENTION_AUDIT_LOGS_DAYS', NEMAZAT),
  };
}

/** Datum, před kterým se maže. `null` = pro tenhle druh dat se nemaže nic. */
function hranice(poctDni, ted = new Date()) {
  if (!poctDni || poctDni <= 0) return null;
  return new Date(ted.getTime() - poctDni * 24 * 60 * 60 * 1000);
}

module.exports = { doby, hranice, NEMAZAT };
