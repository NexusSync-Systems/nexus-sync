/**
 * Veřejné adresy, které server skládá do odpovědí a e-mailů.
 *
 * Proč to není na pěti místech inline: do 3. 11. 2026 bylo. Každé místo mělo
 * zapsanou výchozí hodnotu `https://nexus-api.myvnc.com` — server, který toho
 * dne přestal existovat. Odkazy ke stažení APK, OTA i odkazy v e-mailech tedy
 * tiše mířily nikam, místo aby bylo vidět, že chybí nastavení.
 *
 * Zapsaná adresa je tu proto zakázaná. Když proměnná chybí, funkce vrátí
 * prázdný řetězec a jednou varuje do logu — volající si s tím poradí lépe než
 * mrtvý odkaz (klient `DownloadsView.jsx` i `DeviceSetupView.jsx` mají vlastní
 * záložní `${API_BASE}/vultr/...`, které se odvozuje z prostředí).
 */

const logger = require('../services/logger');

const jizVarovano = new Set();

const varujJednou = (klic, zprava) => {
  if (jizVarovano.has(klic)) return;
  jizVarovano.add(klic);
  logger.warn(zprava);
};

/**
 * Základ API bez koncového lomítka, např. `https://api.example.eu`.
 * Z něj se skládají odkazy `${api}/api/vultr/download-relay.apk`.
 */
const apiBaseUrl = () => {
  const hodnota = (process.env.API_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!hodnota) {
    varujJednou(
      'API_BASE_URL',
      'API_BASE_URL není nastavená — odkazy ke stažení APK a OTA se nebudou ' +
      'skládat. Nastav ji na adresu API bez /api na konci.'
    );
  }
  return hodnota;
};

/**
 * Adresa WEBOVÉ aplikace, ne API. Používá se v e-mailech.
 *
 * `APP_URL` se dřív ve výchozím stavu rovnala adrese API, což bylo špatně
 * dvakrát: ten host zanikl, a hlavně API žádnou stránku neservíruje (v
 * `app.js` je staticky jen `/downloads`). Odkaz na reset hesla tedy nevedl na
 * formulář ani na starém serveru.
 *
 * Když `APP_URL` chybí, vezme se první `https://` origin z `ALLOWED_ORIGINS` —
 * tedy adresa webu, kterou server musí znát kvůli CORS. Jedno nastavení navíc
 * tak nepotřebujeme.
 */
const webAppUrl = () => {
  const prime = (process.env.APP_URL || '').trim().replace(/\/+$/, '');
  if (prime) return prime;

  const zOrigins = (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(o => o.trim())
    .find(o => o.startsWith('https://'));

  if (zOrigins) {
    varujJednou(
      'APP_URL',
      `APP_URL není nastavená, beru adresu webu z ALLOWED_ORIGINS (${zOrigins}). ` +
      'Pokud web běží jinde, nastav APP_URL.'
    );
    return zOrigins.replace(/\/+$/, '');
  }

  varujJednou(
    'APP_URL_chybi',
    'APP_URL ani ALLOWED_ORIGINS nejsou nastavené — odkazy v e-mailech ' +
    '(reset hesla, pozvánky) nebudou fungovat.'
  );
  return '';
};

module.exports = { apiBaseUrl, webAppUrl };
