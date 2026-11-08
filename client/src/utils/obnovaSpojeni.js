// Rozhodování o obnově socketového spojení.
//
// Záměrně bez Reactu a bez socket.io, aby to šlo testovat: testovací prostředí
// klienta je `node`, ne jsdom (viz EnvironmentBadge.test.jsx). Hook si odsud
// bere jen rozhodnutí, samotné volání `socket.connect()` zůstává v něm.

// Stavy spojení. Žijí tady, a ne v socketBridge, aby šly použít i v čistých
// funkcích níž — socketBridge potřebuje React, tenhle modul ne.
export const STAV_PRIPOJENO = 'pripojeno';
export const STAV_OBNOVUJE_SE = 'obnovuje_se';
export const STAV_ODMITNUTO = 'odmitnuto';

/** Dál už prodlevu nezvětšujeme — po minutě se zkouší pořád stejně často. */
export const PRODLEVA_MAX_MS = 60000;

/** První pokus za 5 s, pak dvojnásobky až na strop. `pokus` se počítá od 1. */
export const prodlevaObnovy = (pokus) => {
  const n = Number.isFinite(pokus) && pokus >= 1 ? Math.floor(pokus) : 1;
  // 2 ** 20 už přeteče přes strop, dál se nepočítá (Infinity * 0 = NaN).
  if (n > 20) return PRODLEVA_MAX_MS;
  return Math.min(5000 * 2 ** (n - 1), PRODLEVA_MAX_MS);
};

/**
 * Odmítl server spojení kvůli přihlášení? Hláška chodí ze socketové
 * middleware (`Authentication error: ...`), takže se poznává podle textu.
 * Kdyby se text na serveru změnil, spadne to do větve „zkus_znovu" —
 * tedy pořád se to zkouší dál, jen bez vyžádání nového tokenu.
 */
export const jeChybaAutentizace = (zprava) =>
  /authentication|unauthorized|neplatn|jwt|token/i.test(String(zprava || ''));

/**
 * Co udělat po `connect_error`.
 *
 * `aktivni` je `socket.active`. Tohle je jádro celé opravy: socket.io sám
 * opakuje jen chyby, u kterých `active === true` (spadlá síť, nedostupný
 * server). Když spojení odmítne serverová middleware, nastaví `active` na
 * `false` a **pokus už nikdy nezopakuje** — pro klienta je to definitivní
 * odpověď. Bez tohoto rozhodnutí zůstal prohlížeč navždy bez socketu a
 * operátorce se tiše přestaly ukazovat nové zprávy.
 */
export const rozhodniPoChybe = ({ aktivni, zprava } = {}) => {
  if (aktivni) return 'ceka_socketio';
  if (jeChybaAutentizace(zprava)) return 'obnov_token';
  return 'zkus_znovu';
};

/**
 * Co o spojení napsat uživateli. Vrací `null`, když není co hlásit.
 *
 * Oddělené od komponenty schválně: pravidlo „při funkčním spojení pruh NENÍ
 * vidět" je potřeba umět otestovat, a testovací prostředí klienta je `node`,
 * takže komponentu s hookem vykreslit nelze.
 */
export const hlaskaSpojeni = (stav, lang = 'cz') => {
  const cz = lang !== 'en';

  if (stav === STAV_OBNOVUJE_SE) {
    return {
      barva: '#f59e0b',
      testid: 'stav-spojeni-obnovuje',
      text: cz
        ? 'Spojení se serverem se obnovuje — nové zprávy se nemusí zobrazovat.'
        : 'Reconnecting to the server — new messages may not appear.',
    };
  }

  if (stav === STAV_ODMITNUTO) {
    return {
      barva: '#ef4444',
      testid: 'stav-spojeni-odmitnuto',
      text: cz
        ? 'Spojení odmítnuto, obnovuji přihlášení. Pokud hláška nezmizí, obnovte stránku.'
        : 'Connection refused, renewing sign-in. If this stays, reload the page.',
    };
  }

  return null;
};
