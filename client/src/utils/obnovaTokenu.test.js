import { describe, it, expect } from 'vitest';
import {
  PREDSTIH_S,
  prodlevaPredVyprsenim,
  zbyvaDoVyprseniS,
  rozhodniZdrojObnovy,
  rozhodniPoOdpovedi,
  prodlevaPoObnove,
  MIN_PRODLEVA_PO_OBNOVE_MS,
} from './obnovaTokenu';

const token = (payload) =>
  ['hlavicka', Buffer.from(JSON.stringify(payload)).toString('base64'), 'podpis'].join('.');

describe('prodleva před vypršením', () => {
  it('obnovuje s předstihem', () => {
    expect(prodlevaPredVyprsenim(3600)).toBe((3600 - PREDSTIH_S) * 1000);
  });

  it('u tokenu kratšího než předstih obnovuje hned, ne v minulosti', () => {
    // setTimeout se zápornou prodlevou se spustí okamžitě, takže by z toho
    // byla smyčka bez pauzy. Nula je tu správná odpověď.
    expect(prodlevaPredVyprsenim(60)).toBe(0);
    expect(prodlevaPredVyprsenim(0)).toBe(0);
    expect(prodlevaPredVyprsenim(-5000)).toBe(0);
  });

  it('nesmyslný vstup nespadne do NaN', () => {
    // NaN v setTimeout znamená „hned" a tiše by to rozjelo tu samou smyčku.
    expect(prodlevaPredVyprsenim(undefined)).toBe(0);
    expect(prodlevaPredVyprsenim('nic')).toBe(0);
  });
});

describe('prodleva po úspěšné obnově', () => {
  it('u normálního tokenu je stejná jako běžné plánování', () => {
    expect(prodlevaPoObnove(3600)).toBe(prodlevaPredVyprsenim(3600));
  });

  it('nikdy neplánuje obnovu okamžitě', () => {
    // Kdyby server začal vydávat token kratší než předstih, okamžitá obnova
    // by byla horká smyčka: telefon by obnovoval bez pauzy do vybití.
    expect(prodlevaPoObnove(60)).toBe(MIN_PRODLEVA_PO_OBNOVE_MS);
    expect(prodlevaPoObnove(0)).toBe(MIN_PRODLEVA_PO_OBNOVE_MS);
    expect(prodlevaPoObnove(undefined)).toBe(MIN_PRODLEVA_PO_OBNOVE_MS);
  });
});

describe('kolik zbývá do vypršení', () => {
  const nyni = 1_700_000_000_000;

  it('spočítá to z tokenu', () => {
    const t = token({ exp: Math.floor(nyni / 1000) + 900 });
    expect(zbyvaDoVyprseniS(t, nyni)).toBe(900);
  });

  it('u vypršelého tokenu vrátí zápornou hodnotu, ne null', () => {
    const t = token({ exp: Math.floor(nyni / 1000) - 10 });
    expect(zbyvaDoVyprseniS(t, nyni)).toBe(-10);
  });

  it('nepřečtitelný token je null, a to je jiná odpověď než nula', () => {
    // Kdyby se „nerozumím" slilo s „vypršel", nerozpoznaný token by spustil
    // obnovu nebo odhlášení. O platnosti rozhoduje server, ne tenhle parser.
    expect(zbyvaDoVyprseniS('')).toBeNull();
    expect(zbyvaDoVyprseniS(null)).toBeNull();
    expect(zbyvaDoVyprseniS('nene')).toBeNull();
    expect(zbyvaDoVyprseniS('a.b.c')).toBeNull();
    expect(zbyvaDoVyprseniS(token({ bezExp: 1 }), nyni)).toBeNull();
  });
});

describe('odkud vzít refresh token', () => {
  it('uložený token má přednost před cookie i na webu', () => {
    // Cookie je na téhle topologii cross-site blokovaná, takže uložený
    // token je ta spolehlivější cesta, ne záložní.
    expect(rozhodniZdrojObnovy({ nativni: false, maRefreshToken: true })).toBe('telo');
    expect(rozhodniZdrojObnovy({ nativni: true, maRefreshToken: true })).toBe('telo');
  });

  it('web bez uloženého tokenu to zkusí cookie', () => {
    expect(rozhodniZdrojObnovy({ nativni: false, maRefreshToken: false })).toBe('cookie');
  });

  it('nativní aplikace bez uloženého tokenu nemůže obnovit — a NESMÍ se odhlásit', () => {
    // Takhle vypadá relay telefon přihlášený před touhle změnou. Odhlásit ho
    // při povýšení aplikace by znamenalo spárovaný telefon čekající na heslo.
    expect(rozhodniZdrojObnovy({ nativni: true, maRefreshToken: false })).toBe('nelze');
  });
});

describe('co po odpovědi serveru', () => {
  it('token v odpovědi znamená obnoveno', () => {
    expect(rozhodniPoOdpovedi({ ok: true, maToken: true })).toBe('obnoveno');
  });

  it('odmítnutí serverem je definitivní — odhlásit', () => {
    expect(rozhodniPoOdpovedi({ ok: false, maToken: false })).toBe('odhlasit');
  });

  it('odpověď 200 bez tokenu se taky bere jako odmítnutí', () => {
    expect(rozhodniPoOdpovedi({ ok: true, maToken: false })).toBe('odhlasit');
  });

  it('odmítnutý pokus vedený cookie se nebere jako odhlášení', () => {
    // Cross-site blokovanou cookie server nevidí, takže odmítnutí neříká nic
    // o platnosti sezení. Odhlásit kvůli tomu by znamenalo vyhodit
    // přihlášeného člověka kvůli pravidlu prohlížeče o cookies.
    expect(rozhodniPoOdpovedi({ ok: false, maToken: false, zdroj: 'cookie' })).toBe('bez_obnovy');
    // S tokenem v těle je odmítnutí naopak odpověď o sezení.
    expect(rozhodniPoOdpovedi({ ok: false, maToken: false, zdroj: 'telo' })).toBe('odhlasit');
  });

  it('síťová chyba NENÍ odmítnutí — opakovat', () => {
    // Tohle je ta polovina chyby z #189, kvůli které stačila jedna vteřina
    // bez signálu a sezení bylo tiše mrtvé až do obnovení stránky.
    expect(rozhodniPoOdpovedi({ sitovaChyba: true })).toBe('opakovat');
    // A platí to i tehdy, když by ostatní příznaky vypadaly na odmítnutí.
    expect(rozhodniPoOdpovedi({ sitovaChyba: true, ok: false, maToken: false })).toBe('opakovat');
  });
});
