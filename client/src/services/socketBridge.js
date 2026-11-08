// socketBridge — drží aktuální socket.io instanci MIMO `window`.
//
// Dřív byl socket na `window._nexusSocket`, což je globál dosažitelný jakýmkoli
// skriptem ve stránce (včetně XSS payloadu → emit/listen jako přihlášený uživatel).
// Modulová proměnná je uzavřená v closure bundlu — cizí skript ji z `window`
// nevytáhne. Zároveň slouží jako most mezi variantami aplikace (full app používá
// NexusContext, relay app RelayContext) — obě zapíšou socket sem přes setSocket,
// takže sdílené komponenty (např. RelayMode) ho dostanou v obou.
import { useSyncExternalStore } from 'react';
import { STAV_PRIPOJENO, STAV_OBNOVUJE_SE, STAV_ODMITNUTO } from '../utils/obnovaSpojeni';

let currentSocket = null;
const listeners = new Set();

export function setSocket(socket) {
  currentSocket = socket || null;
  for (const fn of listeners) {
    try { fn(); } catch { /* ignore listener error */ }
  }
}

// --- Stav spojení -----------------------------------------------------------
//
// Oddělený store, ne součást socketu: konzumenti socketu (useNexusData,
// TeamChat) se nemají překreslovat při každém pípnutí spojení, a naopak pruh
// o stavu spojení nepotřebuje socket samotný. Hlavně ale platí, že rozpadlé
// spojení MUSÍ být vidět — bez toho „nefunguje to" vypadá úplně stejně jako
// „nikdo nepíše", a to je ten tichý stav, kvůli kterému tohle vzniklo.
// Konstanty samotné žijí v utils/obnovaSpojeni.js (čistý modul bez Reactu),
// odsud se jen přeposílají, aby je konzumenti socketu měli po ruce.
export { STAV_PRIPOJENO, STAV_OBNOVUJE_SE, STAV_ODMITNUTO };

// Výchozí stav je „připojeno", aby pruh neblikal na přihlašovací obrazovce
// a při startu, kdy socket ještě není. Zhoršení stavu vždy ohlásí až událost.
let stavSpojeni = STAV_PRIPOJENO;
const stavListeners = new Set();

export function setStavSpojeni(stav) {
  if (stav === stavSpojeni) return;
  stavSpojeni = stav;
  for (const fn of stavListeners) {
    try { fn(); } catch { /* ignore listener error */ }
  }
}

export function getStavSpojeni() {
  return stavSpojeni;
}

export function subscribeStavSpojeni(fn) {
  stavListeners.add(fn);
  return () => stavListeners.delete(fn);
}

export function getSocket() {
  return currentSocket;
}

export function subscribeSocket(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// React hook: vrací aktuální socket a překreslí konzumenta, jakmile se socket
// objeví/změní (nahrazuje dřívější „počkej na window._nexusSocket" polling).
// useSyncExternalStore je přesně pro tenhle případ (external store mimo React).
export function useSocketBridge() {
  return useSyncExternalStore(subscribeSocket, getSocket, getSocket);
}

// React hook pro stav spojení (viz STAV_* výše).
export function useStavSpojeni() {
  return useSyncExternalStore(subscribeStavSpojeni, getStavSpojeni, getStavSpojeni);
}
