/**
 * Jediný seznam originů, které smí do API z prohlížeče.
 *
 * Do 3. 11. 2026 byly seznamy dva a rozcházely se. `app.js` znal čtyři
 * firebase domény, `socket.js` jen dvě — a chyběla v nich právě ta, na které
 * aplikace běží (`nexus-sync-8d50b.web.app`). HTTP tedy prošlo a Socket.IO
 * vrátilo 403. Projevilo by se to tak, že by operátorka **nedostávala příchozí
 * SMS v reálném čase**: odesílání přes socket funguje (relay se hlásí
 * z Capacitoru, ten povolený byl), ale příjem do schránky by čekal na načtení
 * stránky. Schránka by vypadala prázdná, ne rozbitá.
 *
 * Rozdíly byly tři, ne jeden:
 *   1. `socket.js` neměl obě domény `nexus-sync-8d50b.*`
 *   2. `socket.js` neměl `http://localhost` z Capacitoru
 *   3. `socket.js` pouštěl `http://localhost:5173` a `:3000` **i v produkci**,
 *      zatímco `app.js` je omezuje na vývoj
 *
 * Třetí z nich je ten nenápadný: dva seznamy se neliší jen tím, co chybí, ale
 * i tím, co jeden povoluje navíc. Proto tu nejde o doplnění chybějících
 * položek, ale o to, aby existoval jen jeden.
 */

const logger = require('../services/logger');

/** Firebase hosting. Dvě jména na projekt: `.web.app` a `.firebaseapp.com`. */
const FIREBASE_ORIGINS = [
  'https://nexus-hub.firebaseapp.com',
  'https://nexus-hub.web.app',
  'https://nexus-sync-8d50b.firebaseapp.com',
  'https://nexus-sync-8d50b.web.app'
];

/** Capacitor WebView se hlásí vždy odsud, ať běží na jakémkoli telefonu. */
const CAPACITOR_ORIGINS = [
  'https://localhost',
  'http://localhost',
  'capacitor://localhost'
];

/** Vývojové servery. Do produkce nepatří — tam je to zbytečně otevřené. */
const DEV_ORIGINS = [
  'http://localhost:5173',
  'http://localhost:3000'
];

const jeProdukce = () => process.env.NODE_ENV === 'production';

const zPromenne = () => (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

/**
 * Celý seznam. Čte se za běhu, ne při načtení modulu, aby šel v testech
 * měnit a aby restart s jinou `ALLOWED_ORIGINS` zabral bez dalších zásahů.
 */
const povoleneOriginy = () => [
  ...zPromenne(),
  ...FIREBASE_ORIGINS,
  ...CAPACITOR_ORIGINS,
  ...(jeProdukce() ? [] : DEV_ORIGINS)
];

/**
 * Požadavek bez originu (mobilní aplikace, curl, server-to-server) prochází.
 * CORS chrání prohlížeč před cizí stránkou, ne API před klientem bez prohlížeče.
 */
const originPovolen = (origin) => !origin || povoleneOriginy().includes(origin);

let jizVarovano = false;

/**
 * Zavolat jednou při startu. Bez `ALLOWED_ORIGINS` projde z prohlížeče jen
 * firebase a Capacitor — web na vlastní doméně dostane 403, které v UI vypadá
 * jako chyba přihlášení. Přesně to se 3. 11. 2026 stalo na novém serveru.
 */
const varujKdyzChybiWebOrigin = () => {
  if (jizVarovano || !jeProdukce()) return;
  if (zPromenne().some(o => o.startsWith('https://'))) return;
  jizVarovano = true;
  logger.warn(
    'ALLOWED_ORIGINS neobsahuje zadny https origin — web na vlastni domene ' +
    'dostane z API 403 (CORS). Nastav napr. ALLOWED_ORIGINS=https://example.eu'
  );
};

module.exports = {
  FIREBASE_ORIGINS,
  CAPACITOR_ORIGINS,
  DEV_ORIGINS,
  povoleneOriginy,
  originPovolen,
  varujKdyzChybiWebOrigin
};
