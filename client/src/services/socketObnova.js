// Obnova socketového spojení — oddělená od Reactu, aby šla otestovat.
//
// Celé tohle vzniklo kvůli jedné tiché poruše: když serverová middleware
// odmítla socket (vypršelý token), socket.io si nastavilo `active === false`
// a pokus už NIKDY nezopakovalo. Prohlížeč operátorky zůstal bez socketu,
// vypadal přitom úplně normálně a nové zprávy do něj jen přestaly chodit.
// Dalo se z toho dostat jedině obnovením stránky — o kterém ale nic nedalo
// vědět, že je potřeba.
import {
  prodlevaObnovy,
  rozhodniPoChybe,
  STAV_PRIPOJENO,
  STAV_OBNOVUJE_SE,
  STAV_ODMITNUTO,
} from '../utils/obnovaSpojeni';

/**
 * Navěsí na socket obnovu spojení a hlášení stavu.
 *
 * @param {object} socket socket.io klient (stačí `on`/`off`/`connect`
 *   a vlastnosti `active`, `connected` — v testu falešný objekt).
 * @param {object} [cfg]
 * @param {Function} [cfg.onAuthFailure] Vyžádání nového tokenu.
 * @param {Function} [cfg.setStav] Zápis stavu spojení do UI.
 * @returns {Function} úklid — odvěsí posluchače a zruší naplánovaný pokus.
 */
export function pripojObnovuSpojeni(socket, { onAuthFailure, setStav } = {}) {
  if (!socket) return () => {};

  let pokus = 0;
  let timer = null;

  const zrusTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  // Ruční pokus. Používá se JEN tam, kde si socket.io samo nepomůže
  // (`active === false`) — jinak by si dvě opakování lezla do cesty.
  const naplanujPokus = () => {
    if (timer) return;
    pokus += 1;
    timer = setTimeout(() => {
      timer = null;
      // Socket se mezitím mohl zrušit (odhlášení) nebo už být připojený.
      if (!socket.connected) socket.connect();
    }, prodlevaObnovy(pokus));
  };

  const naConnect = () => {
    pokus = 0;
    zrusTimer();
    setStav?.(STAV_PRIPOJENO);
  };

  // Rozpad spojení socket.io opakuje samo, jen o tom dosud nikdo nevěděl.
  const naDisconnect = () => setStav?.(STAV_OBNOVUJE_SE);

  const naChybu = (err) => {
    const rozhodnuti = rozhodniPoChybe({ aktivni: socket.active, zprava: err?.message });

    if (rozhodnuti === 'ceka_socketio') {
      setStav?.(STAV_OBNOVUJE_SE);
      return;
    }

    if (rozhodnuti === 'obnov_token') {
      setStav?.(STAV_ODMITNUTO);
      try {
        onAuthFailure?.();
      } catch (chyba) {
        console.error('[Socket] Vyžádání nového tokenu selhalo:', chyba);
      }
      // Zkoušíme dál i se starým tokenem: kdyby obnova tokenu selhala
      // (třeba na síti), tohle je jediná cesta zpátky bez obnovení stránky.
      naplanujPokus();
      return;
    }

    setStav?.(STAV_OBNOVUJE_SE);
    naplanujPokus();
  };

  socket.on('connect', naConnect);
  socket.on('disconnect', naDisconnect);
  socket.on('connect_error', naChybu);

  return () => {
    zrusTimer();
    socket.off?.('connect', naConnect);
    socket.off?.('disconnect', naDisconnect);
    socket.off?.('connect_error', naChybu);
  };
}
