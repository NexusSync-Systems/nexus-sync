/**
 * Global Configuration for Nexus Hub Client
 *
 * `API_BASE` je JEDINÉ místo, kde se rozhoduje, kam klient mluví.
 *
 * Do 3. 11. 2026 mělo stejný výraz zkopírovaný dvacet souborů, každý s vlastní
 * zapsanou záložní hodnotou `https://nexus-api.myvnc.com/api`. Když ten server
 * zanikl, opravil se v #146 jediný z nich; ostatních devatenáct mířilo dál na
 * mrtvý host a projevilo se to až v prohlížeči uživatele.
 *
 * Zapsaná adresa je tu proto zakázaná. V produkčním buildu bez `VITE_API_URL`
 * není správná hodnota žádná — web a API žijí na různých jménech a jedno
 * z druhého odvodit nelze. Místo tiché mrtvé adresy se tedy nahlas ohlásí
 * chyba a `API_BASE` zůstane prázdný: požadavky pak zjevně selžou proti
 * vlastnímu webu, místo aby odcházely na cizí zaniklý stroj.
 *
 * Build bez té proměnné navíc odmítne CI (viz ci.yml, kroky „Ověřit
 * VITE_API_URL" v build-android a deploy-frontend).
 */

const zEnv = (import.meta.env.VITE_API_URL || '').trim().replace(/\/+$/, '');

const vyvojovyZaklad = () => {
  // Android emulátor nevidí localhost hostitele, musí na 10.0.2.2.
  const jeAndroid = typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent);
  const jeLocalhost = typeof window !== 'undefined' && window.location.hostname === 'localhost';
  const host = jeLocalhost && jeAndroid ? '10.0.2.2' : 'localhost';
  return `http://${host}:3000/api`;
};

const urciZaklad = () => {
  if (zEnv) return zEnv;
  if (import.meta.env.DEV) return vyvojovyZaklad();

  // Produkční build bez nastavené adresy. Nemlčet.
  console.error(
    '[Nexus] VITE_API_URL není nastavená. Tenhle build nemá kam posílat ' +
    'požadavky a aplikace nebude fungovat. Nastav VITE_API_URL při buildu ' +
    '(např. https://api.example.eu/api).'
  );
  return '';
};

export const API_BASE = urciZaklad();

/** Adresa serveru bez `/api` — pro Socket.IO a stahování souborů. */
export const SERVER_ORIGIN = API_BASE.replace(/\/api$/, '');

/** Jen jméno hostitele, pro zobrazení uživateli. Prázdné, když adresa chybí. */
export const API_HOST = (() => {
  if (!API_BASE) return '';
  try {
    return new URL(API_BASE).host;
  } catch {
    return '';
  }
})();

export const APP_VERSION = import.meta.env.VITE_APP_VERSION || 'v3.50.4-local';
