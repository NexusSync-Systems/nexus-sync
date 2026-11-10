/**
 * Rozhodování o obnově access tokenu — bez Reactu a bez sítě, aby to šlo
 * otestovat. Zapojení (časovače, fetch, stav) zůstává v useAuth a
 * RelayContext; tady jsou jen pravidla, na kterých záleží.
 *
 * Access token žije hodinu (`ACCESS_TOKEN_EXPIRY = '1h'` na serveru). Co se
 * stane, když se neobnoví, bylo vidět na #189: socket dostane při handshake
 * odmítnutí, opakuje pokus, ten se odmítne taky — a tohle se opakuje navždy,
 * protože token nemá kdo vyměnit. Relay aplikace v tomhle stavu byla celá
 * (`RelayContext` umí jen přihlásit a odhlásit), a tenhle modul vznikl proto,
 * aby obě aplikace rozhodovaly stejně.
 */

/**
 * O kolik dřív než vyprší se obnovuje. Pět minut je rezerva na pomalou síť
 * a na rozdíl hodin mezi telefonem a serverem.
 */
export const PREDSTIH_S = 300;

/**
 * Za jak dlouho naplánovat obnovu, když token vyprší za `expiresInSec`.
 *
 * Nikdy ne zápornou hodnotu: `setTimeout` s negativním zpožděním se spustí
 * okamžitě, což by u už vypršelého tokenu udělalo smyčku bez prodlevy.
 */
export const prodlevaPredVyprsenim = (expiresInSec) => {
  const n = Number(expiresInSec);
  if (!Number.isFinite(n)) return 0;
  return Math.max((n - PREDSTIH_S) * 1000, 0);
};

/**
 * Nejkratší prodleva mezi dvěma naplánovanými obnovami.
 *
 * Při startu se u vypršelého tokenu obnovuje okamžitě, a to je správně. Po
 * ÚSPĚŠNÉ obnově ale okamžitá další obnova znamená horkou smyčku: kdyby
 * server začal vydávat token s platností kratší než předstih, telefon by
 * obnovoval bez pauzy, dokud mu nedojde baterie. Server dnes vydává hodinu,
 * takže se to nestane — tohle je pojistka, ne oprava.
 */
export const MIN_PRODLEVA_PO_OBNOVE_MS = 30_000;

/** Prodleva po úspěšné obnově: nikdy okamžitě, viz konstanta výš. */
export const prodlevaPoObnove = (expiresInSec) =>
  Math.max(prodlevaPredVyprsenim(expiresInSec), MIN_PRODLEVA_PO_OBNOVE_MS);

/**
 * Kolik sekund zbývá do vypršení tokenu, nebo `null`, když se to nedá zjistit.
 *
 * `null` je důležité odlišit od nuly: nula znamená „vypršel, obnov hned",
 * kdežto `null` znamená „tomuhle tokenu nerozumím" — a to není důvod
 * k odhlášení, protože zdroj pravdy o platnosti je server, ne tenhle parser.
 */
export const zbyvaDoVyprseniS = (token, nyniMs = Date.now()) => {
  if (typeof token !== 'string' || !token) return null;
  const casti = token.split('.');
  if (casti.length !== 3) return null;
  try {
    const payload = JSON.parse(atob(casti[1]));
    if (typeof payload?.exp !== 'number') return null;
    return payload.exp - Math.floor(nyniMs / 1000);
  } catch {
    return null;
  }
};

/**
 * Odkud vzít refresh token, nebo že obnovit nelze.
 *
 * Uložený token má přednost před cookie na VŠECH platformách. Důvod je
 * v `tokenStore.js`: web běží na jiné registrovatelné doméně než API, takže
 * refresh cookie je z pohledu prohlížeče third-party a prohlížeče ji
 * cross-site blokují. Spoléhat se na ni by znamenalo obnovu, která tu a tam
 * mlčky nefunguje.
 *
 * `'nelze'` NENÍ chyba a hlavně NENÍ důvod k odhlášení. Takhle vypadá relay
 * telefon, který se přihlásil ještě před touhle změnou: refresh token tehdy
 * nikdo neuložil (`RelayContext.onLogin` ho z odpovědi zahazoval), takže ho
 * v úložišti nemá. Odhlásit ho při povýšení aplikace by znamenalo, že
 * spárovaný telefon v pilotu najednou čeká na heslo — a příchozí SMS mu
 * přitom fungují dál, protože jdou přes `deviceSecret`, ne přes token.
 */
export const rozhodniZdrojObnovy = ({ nativni, maRefreshToken } = {}) => {
  if (maRefreshToken) return 'telo';
  return nativni ? 'nelze' : 'cookie';
};

/**
 * Co dělat po odpovědi serveru na obnovu.
 *
 * Rozdíl mezi `'odhlasit'` a `'opakovat'` je to podstatné: odpověď serveru je
 * definitivní (odhlášený refresh token se sám nespraví), ale síťová chyba
 * není odpověď. Jedna vteřina bez signálu nebo restart backendu při nasazení
 * nesmí vypadat jako odhlášení — to byla druhá polovina chyby z #189.
 *
 * `'bez_obnovy'` je pro odmítnutí pokusu vedeného COOKIE. Na téhle topologii
 * je refresh cookie cross-site blokovaná, takže odmítnutí neříká nic o tom,
 * jestli sezení platí — server prostě žádný token neviděl. Odhlásit kvůli
 * tomu by znamenalo vyhodit přihlášeného člověka kvůli pravidlu prohlížeče
 * o cookies. Opakovat taky nemá smysl: podruhé ji server neuvidí stejně.
 *
 * Pozor, tohle je pravidlo RELAY aplikace. `useAuth` v plné aplikaci se
 * v tomhle bodě rozhoduje po svém (odhlašuje) a tenhle modul mu to
 * nepřepisuje — sjednocovat obě chování je jiná úvaha než tahle oprava.
 */
export const rozhodniPoOdpovedi = ({ sitovaChyba, ok, maToken, zdroj } = {}) => {
  if (sitovaChyba) return 'opakovat';
  if (ok && maToken) return 'obnoveno';
  if (zdroj === 'cookie') return 'bez_obnovy';
  return 'odhlasit';
};
