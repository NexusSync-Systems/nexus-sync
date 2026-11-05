/**
 * NexusSms.js
 * Capacitor plugin wrapper pro SMS interceptor (nexusRelay varianta).
 * V nexusFull variantě se plugin ignoruje — SMS přicházejí přes Socket.IO ze serveru.
 */
import { NexusRelay } from './nexusRelay';
import { useState, useEffect, useRef, useCallback } from 'react';
import axios from 'axios';

// Registrace Capacitor pluginu (funguje jen v Android nexusRelay APK)
const NexusRelayPlugin = NexusRelay;

// ── Detekce varianty APK ────────────────────────────────────────────────────
//
// __APP_VARIANT__ je konstanta, kterou dosazuje Vite při buildu
// (vite.config.js, z VITE_APP_VARIANT). Dosazuje ale HOLÝ IDENTIFIKÁTOR —
// zápis `window.__APP_VARIANT__` je přístup k vlastnosti, ten Vite nenahradí
// a `window.__APP_VARIANT__` za běhu nikdo nenastavuje. Vycházelo tedy
// vždycky 'full', i v relay APK.
//
// Důsledek byl, že se relay chovala jako plná aplikace: nativní posluchač
// příchozích SMS se nezaregistroval, místo něj běžela socketová větev
// určená pro full, a odchozí SMS šly přes API serveru místo přes telefon.
// Ostatní místa v kódu (App.jsx, Sidebar, MobileBottomNav, useOperatorWebRTC)
// to čtou správně — jen tady byl překlep.
export const APP_VARIANT = (typeof __APP_VARIANT__ !== 'undefined' ? __APP_VARIANT__ : 'full'); // 'relay' | 'full'
export const isRelayVariant = APP_VARIANT === 'relay';

// ── useSmsRelay hook ────────────────────────────────────────────────────────
/**
 * Hook pro SMS interceptor.
 *
 * V nexusRelay APK:
 *   - Naslouchá příchozím SMS přes NexusSmsReceiver → NexusRelayPlugin event
 *   - Může zjistit/nastavit výchozí SMS aplikaci
 *
 * V nexusFull APK / prohlížeči:
 *   - Příchozí SMS sem NEPŘICHÁZEJÍ přes tento hook. Relay je posílá nativně
 *     na POST /api/device/relay, server je uloží jako Message(INBOUND)
 *     a rozešle událost `new_message`, kterou konzumuje chat. Hook `useSmsRelay`
 *     tady slouží jen k odesílání.
 *
 * @param {Object} options
 * @param {Function} options.onIncoming - callback (sms: {from, body, timestamp})
 * @param {String} options.API_BASE - Base URL for API requests
 */
export function useSmsRelay({ onIncoming, API_BASE } = {}) {
  const [isDefaultSmsApp, setIsDefaultSmsApp] = useState(false);
  const [incomingSms, setIncomingSms]         = useState(null);
  const onIncomingRef = useRef(onIncoming);
  useEffect(() => { onIncomingRef.current = onIncoming; }, [onIncoming]);

  // ── Zkontroluj stav výchozí SMS aplikace ──────────────────────────────────
  useEffect(() => {
    NexusRelayPlugin.isDefaultSmsApp()
      .then(r => setIsDefaultSmsApp(!!r?.isDefault))
      .catch(() => setIsDefaultSmsApp(false));
  }, []);

  // ── nexusRelay varianta: nativní SMS event ────────────────────────────────
  useEffect(() => {
    if (!isRelayVariant) return;

    let listener;
    NexusRelayPlugin.addListener('onSmsReceived', (data) => {
      const sms = {
        from:      data.sender  || data.from || 'Neznámé číslo',
        body:      data.body    || data.message || '',
        timestamp: data.timestamp || Date.now(),
      };
      setIncomingSms(sms);
      onIncomingRef.current?.(sms);
    }).then(l => { listener = l; });

    return () => { listener?.remove?.(); };
  }, [API_BASE]);

  // Posluchač `sms:incoming` tu byl odstraněný spolu se serverovou route
  // POST /api/sms/incoming, která tu událost jako jediná vysílala a kterou
  // relay nikdy nepoužil. Živá cesta příchozích zpráv jde přes `new_message`
  // (viz hlavička výš a server/src/controllers/deviceController.js).

  const sendSms = async (to, text) => {
    if (isRelayVariant) {
      if (NexusRelayPlugin.sendSms) {
        return NexusRelayPlugin.sendSms({ to, text });
      }
      return Promise.reject(new Error('Plugin sendSms method missing'));
    } else {
      // API_BASE už na /api končí — s dalším /api z toho vzniklo
      // …/api/api/sms/send a odeslání padalo na 404.
      const url = API_BASE ? `${API_BASE}/sms/send` : '/api/sms/send';
      return axios.post(url, { to, text });
    }
  };

  const configureRelay = useCallback((config) =>
    NexusRelayPlugin.configureRelay ? NexusRelayPlugin.configureRelay(config) : Promise.resolve(),
  []);

  return {
    isDefaultSmsApp,
    incomingSms,
    clearIncomingSms:     () => setIncomingSms(null),
    sendSms,
    sendSmsNative:        (to, text) => NexusRelayPlugin.sendSms ? NexusRelayPlugin.sendSms({ to, text }) : Promise.reject(new Error('Missing')),
    getSmsHistory:        (lastTimestamp = 0, limit = 500) => NexusRelayPlugin.getSmsHistory ? NexusRelayPlugin.getSmsHistory({ lastTimestamp, limit }) : Promise.resolve({ messages: [] }),
    syncHistory:          (options = {}) => NexusRelayPlugin.syncHistory ? NexusRelayPlugin.syncHistory(options) : Promise.resolve({ synced: 0, failed: 0, skipped: 0 }),
    configureRelay,
    requestDefaultSmsApp: () => NexusRelayPlugin.requestDefaultSmsApp().then(() =>
      NexusRelayPlugin.isDefaultSmsApp().then(r => setIsDefaultSmsApp(!!r?.isDefault))
    ),
  };
}
