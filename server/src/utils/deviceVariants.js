/**
 * Dvě přihrádky vazeb zařízení na jeden profil.
 *
 * Modelka potřebuje dva telefony, ne jeden: relay se SIM kartou, na kterou
 * chodí SMS, a plnou aplikaci, kde vidí kalendář, zprávy a bezpečnostní
 * tlačítka. Jsou to dvě různé aplikace (`com.nexushub.relay`
 * a `com.nexushub.app`), takže každá má svůj `installationId` a vlastní
 * vazbu.
 *
 * Párování přitom po sobě deaktivuje všechny ostatní aktivní vazby téhož
 * profilu, aby na profil zůstala jedna. Bez rozlišení varianty si proto obě
 * aplikace tu jednu vazbu přehazovaly: přihlášení v plné aplikaci vyřadilo
 * relay (přestaly chodit SMS), spárování relaye vyřadilo plnou.
 */

const VARIANTA_RELAY = 'relay';
const VARIANTA_PLNA = 'full';

/**
 * Z toho, co pošle klient, udělá jednu ze dvou známých hodnot.
 *
 * NEZNÁMÁ A CHYBĚJÍCÍ HODNOTA JE RELAY, ne plná aplikace. Starší APK pole
 * neposílají a všechny vazby z doby před migrací založil relay telefon.
 * Kdyby se neznámá hodnota brala jako plná aplikace, vypadly by ty telefony
 * z výběru pro odesílání SMS, z hlášení „relay je online" i z noční hlídky —
 * a to všechno mlčky, protože chybějící relay se chová jako „prostě to
 * přestalo chodit".
 */
const normalizujVariantu = (hodnota) =>
  (String(hodnota || '').trim().toLowerCase() === VARIANTA_PLNA ? VARIANTA_PLNA : VARIANTA_RELAY);

/**
 * Filtr do dotazů, které míní „relay telefon", ne jakékoli spárované
 * zařízení. Rozsyp ho do `where`: `{ ...JEN_RELAY, active: true }`.
 *
 * Pozor na opačnou chybu: cesty, které zařízení jen OVĚŘUJÍ podle
 * `installationId` a tajemství (relayAuthMiddleware, deviceOrUserAuth),
 * tohle použít nesmí — ty musí přijmout telefon, který se hlásí, ať je to
 * kterákoli aplikace.
 */
const JEN_RELAY = { appVariant: VARIANTA_RELAY };

module.exports = { VARIANTA_RELAY, VARIANTA_PLNA, normalizujVariantu, JEN_RELAY };
