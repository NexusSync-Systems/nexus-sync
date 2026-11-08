import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { pripojObnovuSpojeni } from './socketObnova';
import { STAV_PRIPOJENO, STAV_OBNOVUJE_SE, STAV_ODMITNUTO } from '../utils/obnovaSpojeni';

/**
 * Falešný socket.io klient. Stačí `on`/`off`/`connect` a vlastnosti
 * `active` a `connected` — testovací prostředí klienta je `node`, takže
 * skutečný socket ani prohlížeč tu k dispozici nejsou.
 */
function falesnySocket({ active = true, connected = false } = {}) {
  const posluchaci = {};
  return {
    active,
    connected,
    pocetConnect: 0,
    on(udalost, fn) {
      (posluchaci[udalost] = posluchaci[udalost] || []).push(fn);
    },
    off(udalost, fn) {
      posluchaci[udalost] = (posluchaci[udalost] || []).filter((f) => f !== fn);
    },
    connect() {
      this.pocetConnect += 1;
    },
    /** Vyvolá událost, jako by přišla ze serveru. */
    vyvolej(udalost, ...args) {
      (posluchaci[udalost] || []).forEach((fn) => fn(...args));
    },
    pocetPosluchacu(udalost) {
      return (posluchaci[udalost] || []).length;
    },
  };
}

const CHYBA_TOKENU = { message: 'Authentication error: jwt expired' };

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('odmítnutí kvůli přihlášení', () => {
  it('vyžádá nový token a spojení zkusí znovu', () => {
    // Jádro opravy. `active: false` je to, co socket.io nastaví, když
    // spojení odmítne serverová middleware — a pak už sám NIKDY nezkusí
    // znovu. Dřív tím prohlížeč o socket přišel natrvalo.
    const socket = falesnySocket({ active: false });
    const onAuthFailure = vi.fn();
    const setStav = vi.fn();
    vi.spyOn(console, 'error').mockImplementation(() => {});

    pripojObnovuSpojeni(socket, { onAuthFailure, setStav });
    socket.vyvolej('connect_error', CHYBA_TOKENU);

    expect(onAuthFailure).toHaveBeenCalledTimes(1);
    expect(setStav).toHaveBeenCalledWith(STAV_ODMITNUTO);
    expect(socket.pocetConnect).toBe(0);  // zkouší se až po prodlevě

    vi.advanceTimersByTime(5000);
    expect(socket.pocetConnect).toBe(1);
  });

  it('zkouší dál, i když vyžádání tokenu spadne', () => {
    // Kdyby výjimka z obnovy tokenu zastavila i opakování, zůstala by
    // aplikace přesně v tom tichém stavu, který tohle opravuje.
    const socket = falesnySocket({ active: false });
    const setStav = vi.fn();
    vi.spyOn(console, 'error').mockImplementation(() => {});

    pripojObnovuSpojeni(socket, {
      onAuthFailure: () => { throw new Error('síť je dole'); },
      setStav,
    });
    socket.vyvolej('connect_error', CHYBA_TOKENU);

    vi.advanceTimersByTime(5000);
    expect(socket.pocetConnect).toBe(1);
  });

  it('prodlevy mezi pokusy rostou', () => {
    const socket = falesnySocket({ active: false });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    pripojObnovuSpojeni(socket, { onAuthFailure: vi.fn(), setStav: vi.fn() });

    socket.vyvolej('connect_error', CHYBA_TOKENU);
    vi.advanceTimersByTime(5000);
    expect(socket.pocetConnect).toBe(1);

    socket.vyvolej('connect_error', CHYBA_TOKENU);
    vi.advanceTimersByTime(5000);
    expect(socket.pocetConnect).toBe(1);   // druhý pokus je až za 10 s
    vi.advanceTimersByTime(5000);
    expect(socket.pocetConnect).toBe(2);
  });

  it('opakované chyby nenastackují víc časovačů', () => {
    const socket = falesnySocket({ active: false });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    pripojObnovuSpojeni(socket, { onAuthFailure: vi.fn(), setStav: vi.fn() });

    for (let i = 0; i < 5; i += 1) socket.vyvolej('connect_error', CHYBA_TOKENU);
    vi.advanceTimersByTime(5000);

    expect(socket.pocetConnect).toBe(1);
  });
});

describe('chyby, které si socket.io řeší sám', () => {
  it('do aktivního opakování nezasahuje', () => {
    // active === true: socket.io další pokus udělá samo. Vlastní časovač by
    // tu jen zdvojoval pokusy a dělal z jednoho výpadku dva.
    const socket = falesnySocket({ active: true });
    const onAuthFailure = vi.fn();
    const setStav = vi.fn();
    vi.spyOn(console, 'error').mockImplementation(() => {});

    pripojObnovuSpojeni(socket, { onAuthFailure, setStav });
    socket.vyvolej('connect_error', { message: 'xhr poll error' });

    vi.advanceTimersByTime(120000);
    expect(socket.pocetConnect).toBe(0);
    expect(onAuthFailure).not.toHaveBeenCalled();
    expect(setStav).toHaveBeenCalledWith(STAV_OBNOVUJE_SE);
  });
});

describe('hlášení stavu', () => {
  it('rozpad spojení ohlásí jako obnovování', () => {
    const socket = falesnySocket();
    const setStav = vi.fn();
    pripojObnovuSpojeni(socket, { setStav });

    socket.vyvolej('disconnect', 'transport close');
    expect(setStav).toHaveBeenCalledWith(STAV_OBNOVUJE_SE);
  });

  it('po připojení hlásí připojeno a vynuluje počítadlo', () => {
    const socket = falesnySocket({ active: false });
    const setStav = vi.fn();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    pripojObnovuSpojeni(socket, { onAuthFailure: vi.fn(), setStav });

    socket.vyvolej('connect_error', CHYBA_TOKENU);
    socket.vyvolej('connect_error', CHYBA_TOKENU);  // prodleva by byla 10 s
    socket.vyvolej('connect');

    expect(setStav).toHaveBeenLastCalledWith(STAV_PRIPOJENO);

    // Po úspěšném připojení se počítá znovu od pěti sekund.
    socket.vyvolej('connect_error', CHYBA_TOKENU);
    vi.advanceTimersByTime(5000);
    expect(socket.pocetConnect).toBe(1);
  });

  it('připojení zruší naplánovaný pokus', () => {
    const socket = falesnySocket({ active: false });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    pripojObnovuSpojeni(socket, { onAuthFailure: vi.fn(), setStav: vi.fn() });

    socket.vyvolej('connect_error', CHYBA_TOKENU);
    socket.connected = true;
    socket.vyvolej('connect');
    vi.advanceTimersByTime(60000);

    expect(socket.pocetConnect).toBe(0);
  });
});

describe('úklid', () => {
  it('odvěsí posluchače a zruší čekající pokus', () => {
    const socket = falesnySocket({ active: false });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const uklid = pripojObnovuSpojeni(socket, { onAuthFailure: vi.fn(), setStav: vi.fn() });

    socket.vyvolej('connect_error', CHYBA_TOKENU);
    uklid();
    vi.advanceTimersByTime(60000);

    // Jinak by se odhlášený nebo odmontovaný socket pokoušel připojovat dál.
    expect(socket.pocetConnect).toBe(0);
    expect(socket.pocetPosluchacu('connect')).toBe(0);
    expect(socket.pocetPosluchacu('connect_error')).toBe(0);
    expect(socket.pocetPosluchacu('disconnect')).toBe(0);
  });

  it('bez socketu nespadne', () => {
    expect(() => pripojObnovuSpojeni(null, {})()).not.toThrow();
  });
});
