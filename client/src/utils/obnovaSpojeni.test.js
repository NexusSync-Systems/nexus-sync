import { describe, it, expect } from 'vitest';
import {
  prodlevaObnovy,
  jeChybaAutentizace,
  rozhodniPoChybe,
  hlaskaSpojeni,
  PRODLEVA_MAX_MS,
  STAV_PRIPOJENO,
  STAV_OBNOVUJE_SE,
  STAV_ODMITNUTO,
} from './obnovaSpojeni';

describe('prodleva mezi pokusy', () => {
  it('roste po dvojnásobcích od pěti sekund', () => {
    expect(prodlevaObnovy(1)).toBe(5000);
    expect(prodlevaObnovy(2)).toBe(10000);
    expect(prodlevaObnovy(3)).toBe(20000);
    expect(prodlevaObnovy(4)).toBe(40000);
  });

  it('zastaví se na minutě a dál neroste', () => {
    expect(prodlevaObnovy(5)).toBe(PRODLEVA_MAX_MS);
    expect(prodlevaObnovy(50)).toBe(PRODLEVA_MAX_MS);
    // Velké číslo nesmí dát NaN (Infinity * 0) a tím zabít časovač.
    expect(prodlevaObnovy(5000)).toBe(PRODLEVA_MAX_MS);
  });

  it('nesmyslný vstup bere jako první pokus', () => {
    for (const vstup of [undefined, null, 0, -3, NaN, 'dva', {}]) {
      expect(prodlevaObnovy(vstup)).toBe(5000);
    }
  });
});

describe('poznání autentizační chyby', () => {
  it('pozná hlášku ze socketové middleware', () => {
    expect(jeChybaAutentizace('Authentication error: jwt expired')).toBe(true);
    expect(jeChybaAutentizace('Authentication error: Invalid token')).toBe(true);
  });

  it('běžnou síťovou chybu za autentizační nepovažuje', () => {
    expect(jeChybaAutentizace('xhr poll error')).toBe(false);
    expect(jeChybaAutentizace('timeout')).toBe(false);
    expect(jeChybaAutentizace(undefined)).toBe(false);
  });
});

describe('rozhodnutí po connect_error', () => {
  it('dokud socket.io samo opakuje, nepleteme se do toho', () => {
    // active === true: socket.io další pokus udělá samo. Druhé opakování by
    // tu jen zdvojovalo pokusy.
    expect(rozhodniPoChybe({ aktivni: true, zprava: 'xhr poll error' })).toBe('ceka_socketio');
    expect(rozhodniPoChybe({ aktivni: true, zprava: 'Authentication error: jwt expired' }))
      .toBe('ceka_socketio');
  });

  it('odmítnutí kvůli přihlášení si vyžádá nový token', () => {
    // Tohle je ta tichá porucha: active === false znamená, že socket.io
    // další pokus NEUDĚLÁ. Bez téhle větve zůstal prohlížeč bez socketu.
    expect(rozhodniPoChybe({ aktivni: false, zprava: 'Authentication error: jwt expired' }))
      .toBe('obnov_token');
  });

  it('jiné definitivní odmítnutí zkouší dál samo', () => {
    expect(rozhodniPoChybe({ aktivni: false, zprava: 'server shutting down' }))
      .toBe('zkus_znovu');
    // Bez údajů taky nesmí skončit nicneděláním.
    expect(rozhodniPoChybe({})).toBe('zkus_znovu');
    expect(rozhodniPoChybe()).toBe('zkus_znovu');
  });
});

describe('hláška o stavu spojení', () => {
  it('při funkčním spojení nehlásí nic', () => {
    // Opačný směr je stejně důležitý jako ten první: pruh, který svítí pořád,
    // si uživatel odnaučí vidět.
    expect(hlaskaSpojeni(STAV_PRIPOJENO)).toBeNull();
    expect(hlaskaSpojeni(undefined)).toBeNull();
  });

  it('obnovování a odmítnutí rozliší', () => {
    const obnova = hlaskaSpojeni(STAV_OBNOVUJE_SE);
    const odmitnuto = hlaskaSpojeni(STAV_ODMITNUTO);

    expect(obnova.testid).toBe('stav-spojeni-obnovuje');
    expect(odmitnuto.testid).toBe('stav-spojeni-odmitnuto');
    expect(obnova.barva).not.toBe(odmitnuto.barva);
    // U odmítnutí musí uživatel vědět, co má udělat, když to nepřestane.
    expect(odmitnuto.text).toMatch(/obnovte stránku/i);
  });

  it('umí anglicky', () => {
    expect(hlaskaSpojeni(STAV_OBNOVUJE_SE, 'en').text).toMatch(/Reconnecting/);
    expect(hlaskaSpojeni(STAV_OBNOVUJE_SE, 'cz').text).toMatch(/obnovuje/);
  });
});
