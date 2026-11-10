/**
 * RelayContext – lightweight context for Nexus Relay app.
 * Contains ONLY what the Relay app needs: auth + basic API calls.
 * Does NOT import: AgencyDataGateway, AnalyticsService, ContentSyncService,
 * CommunicationService, useChatLogic, useNexusData, usePermissions, etc.
 */
import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import axios from 'axios';
import { Capacitor } from '@capacitor/core';
import { TRANSLATIONS } from '../translations';
import * as tokenStore from '../services/tokenStore';
import { prodlevaObnovy } from '../utils/obnovaSpojeni';
import {
  prodlevaPoObnove,
  zbyvaDoVyprseniS,
  rozhodniZdrojObnovy,
  rozhodniPoOdpovedi,
} from '../utils/obnovaTokenu';


import { API_BASE } from '../constants/config';
const RelayContext = createContext(null);

export const useRelay = () => {
  const ctx = useContext(RelayContext);
  if (!ctx) throw new Error('useRelay must be used inside RelayProvider');
  return ctx;
};

export const RelayProvider = ({ children }) => {
  const [isLoggedIn, setIsLoggedIn] = useState(() => localStorage.getItem('nexus_isLoggedIn') === 'true');
  const [token, setToken] = useState(() => tokenStore.getToken()); // #5
  const [activeOperator, setActiveOperator] = useState(() => {
    try {
      const s = localStorage.getItem('nexus_activeOperator');
      return s && s !== 'undefined' ? JSON.parse(s) : null;
    } catch { return null; }
  });
  const [lang, setLang] = useState(() => localStorage.getItem('nexus_lang') || 'cz');
  const [toasts, setToasts] = useState([]);

  const isNativeApp = Capacitor.isNativePlatform();

  // Obnova access tokenu. Do téhle chvíle ji relay aplikace neměla vůbec:
  // token žije hodinu a `RelayContext` umí jen přihlásit a odhlásit, takže se
  // po hodině socket marně opakoval a `/device/verify` tiše selhávalo. SMS to
  // nepoložilo (jdou přes `deviceSecret`), ale živé spojení ano.
  const casovacObnovyRef = useRef(null);
  const casovacOpakovaniRef = useRef(null);
  const pokusRef = useRef(0);
  const probihaRef = useRef(null);
  const naplanujObnovuRef = useRef(null);

  // Set axios auth header whenever token changes
  useEffect(() => {
    if (token) {
      axios.defaults.headers.common['Authorization'] = `Bearer ${token}`;
    } else {
      delete axios.defaults.headers.common['Authorization'];
    }
  }, [token]);

  const showToast = useCallback((message, type = 'info') => {
    const id = Date.now();
    setToasts(prev => [...prev, { id, message, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000);
  }, []);

  const onLogin = useCallback(async (email, password) => {
    try {
      const installationId = localStorage.getItem('nexus_installation_id') || `relay_${Date.now()}`;
      localStorage.setItem('nexus_installation_id', installationId);

      const res = await axios.post(`${API_BASE}/auth/login`, {
        email,
        password,
        installationId,
        appVariant: 'relay',
        platform: Capacitor.isNativePlatform() ? 'android' : 'web',
      });

      const { token: newToken, user: operator, refreshToken, expiresIn } = res.data;
      if (!newToken) return { success: false, error: 'Neplatná odpověď serveru' };

      tokenStore.setToken(newToken); // #5 (nativ perzistuje, web jen paměť)
      // Bez tohohle řádku nebylo co obnovovat: server refresh token v odpovědi
      // posílá, ale relay ho zahazoval, takže sezení končilo s platností
      // access tokenu, tedy po hodině.
      if (refreshToken) localStorage.setItem('nexus_refreshToken', refreshToken);
      localStorage.setItem('nexus_isLoggedIn', 'true');
      localStorage.setItem('nexus_activeOperator', JSON.stringify(operator));
      axios.defaults.headers.common['Authorization'] = `Bearer ${newToken}`;

      setToken(newToken);
      setActiveOperator(operator);
      setIsLoggedIn(true);
      pokusRef.current = 0;
      naplanujObnovuRef.current?.(expiresIn || 3600);
      return { success: true };
    } catch (err) {
      const msg = err.response?.data?.message || err.message || 'Přihlášení selhalo';
      return { success: false, error: msg };
    }
  }, []);

  const onLogout = useCallback(() => {
    if (casovacObnovyRef.current) clearTimeout(casovacObnovyRef.current);
    if (casovacOpakovaniRef.current) clearTimeout(casovacOpakovaniRef.current);
    casovacObnovyRef.current = null;
    casovacOpakovaniRef.current = null;
    tokenStore.clear(); // #5
    localStorage.removeItem('nexus_refreshToken');
    localStorage.removeItem('nexus_isLoggedIn');
    localStorage.removeItem('nexus_activeOperator');
    delete axios.defaults.headers.common['Authorization'];
    setToken(null);
    setActiveOperator(null);
    setIsLoggedIn(false);
  }, []);

  const naplanujOpakovani = useCallback(() => {
    if (casovacOpakovaniRef.current) return;
    pokusRef.current += 1;
    const prodleva = prodlevaObnovy(pokusRef.current);
    console.warn(`[Relay] Obnova tokenu selhala, další pokus za ${Math.round(prodleva / 1000)} s`);
    casovacOpakovaniRef.current = setTimeout(() => {
      casovacOpakovaniRef.current = null;
      naplanujObnovuRef.current?.(0);
    }, prodleva);
  }, []);

  const obnovToken = useCallback(async () => {
    // Víc současných obnov by si navzájem zneplatnilo refresh token: server
    // ho při každé obnově otáčí, takže druhá v řadě by dostala odmítnutí
    // a odhlásila telefon.
    if (probihaRef.current) return probihaRef.current;

    const ulozeny = localStorage.getItem('nexus_refreshToken');
    const zdroj = rozhodniZdrojObnovy({ nativni: isNativeApp, maRefreshToken: !!ulozeny });
    if (zdroj === 'nelze') {
      // Telefon přihlášený před touhle změnou. Nepřihlašovat, nespouštět
      // opakování — jen říct proč, ať se to v logu pozná od chyby sítě.
      console.warn('[Relay] Obnova tokenu není možná: chybí uložený refresh token. Sezení vydrží do vypršení, pak je potřeba přihlášení.');
      return null;
    }

    probihaRef.current = (async () => {
      let odpoved;
      let data = null;
      try {
        const res = await fetch(`${API_BASE}/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(zdroj === 'telo' ? { refreshToken: ulozeny } : {}),
        });
        data = await res.json().catch(() => null);
        odpoved = { ok: res.ok, maToken: !!data?.token, zdroj };
      } catch (err) {
        console.error('[Relay] Obnova tokenu — chyba sítě:', err?.message || err);
        odpoved = { sitovaChyba: true, zdroj };
      }

      switch (rozhodniPoOdpovedi(odpoved)) {
        case 'obnoveno': {
          tokenStore.setToken(data.token);
          if (data.refreshToken) localStorage.setItem('nexus_refreshToken', data.refreshToken);
          axios.defaults.headers.common['Authorization'] = `Bearer ${data.token}`;
          setToken(data.token);
          pokusRef.current = 0;
          // Přes ref, ne přímo: `naplanujObnovu` je definovaná až pod touhle
          // funkcí, protože ji sama volá. Effect níž naplánuje obnovu ještě
          // podruhé (token se změnil) — nevadí, plánuje se jedinou cestou,
          // která nejdřív ruší předchozí časovač.
          naplanujObnovuRef.current?.(data.expiresIn);
          console.log('[Relay] Token obnoven');
          return data.token;
        }
        case 'opakovat':
          naplanujOpakovani();
          return null;
        case 'bez_obnovy':
          console.warn('[Relay] Server obnovu odmítl, ale šla přes cookie — sezení se nezahazuje.');
          return null;
        default:
          console.warn('[Relay] Refresh token je neplatný, odhlašuji.');
          onLogout();
          return null;
      }
    })().finally(() => { probihaRef.current = null; });

    return probihaRef.current;
  }, [isNativeApp, naplanujOpakovani, onLogout]);

  /**
   * Jediné místo, kde se rozhoduje „obnovit hned" proti „obnovit za chvíli".
   *
   * Hned se obnovuje VÝHRADNĚ u tokenu, který už vypršel — tedy při startu
   * aplikace s uloženým starým tokenem a po naplánovaném opakování. Všechno
   * ostatní jde přes podlahu `prodlevaPoObnove`, aby krátkodobý token
   * nerozjel obnovu bez pauzy. Dřív to tady bylo rozdělené na dvě cesty
   * (úspěšná obnova měla podlahu, effect ne) a ta bez podlahy tu druhou
   * přepsala, takže pojistka nedělala nic.
   */
  const naplanujObnovu = useCallback((expiresInSec) => {
    if (casovacObnovyRef.current) clearTimeout(casovacObnovyRef.current);
    casovacObnovyRef.current = null;

    const n = Number(expiresInSec);
    // Nečitelná hodnota ze serveru se bere jako běžná hodina, ne jako
    // „obnov hned": „hned" by se s další nečitelnou odpovědí zacyklilo.
    const sekundy = Number.isFinite(n) ? n : 3600;
    if (sekundy <= 0) return obnovToken();

    casovacObnovyRef.current = setTimeout(() => { obnovToken(); }, prodlevaPoObnove(sekundy));
    return undefined;
  }, [obnovToken]);

  useEffect(() => { naplanujObnovuRef.current = naplanujObnovu; }, [naplanujObnovu]);

  // Po startu aplikace: token je z úložiště, takže o jeho zbývající platnosti
  // nic nevíme, dokud se nepodívá do payloadu. `null` znamená „nerozumím
  // tomuhle tokenu" a tehdy se záměrně nic neplánuje — o platnosti rozhoduje
  // server, ne tenhle parser, a odhlašovat kvůli nepřečtenému payloadu by
  // bylo horší než nechat první 401 rozhodnout.
  useEffect(() => {
    if (!isLoggedIn || !token) return;
    const zbyva = zbyvaDoVyprseniS(token);
    if (zbyva === null) {
      console.warn('[Relay] Platnost tokenu se nedá přečíst, obnova se neplánuje.');
      return;
    }
    naplanujObnovu(zbyva > 0 ? zbyva : 0);
  }, [isLoggedIn, token, naplanujObnovu]);

  // Čekající opakování se ruší VÝHRADNĚ při odmontování. Schválně to není
  // v efektu výš: ten se spouští znovu při každé změně tokenu a zahodil by
  // rozplánovaný pokus — přesně ta tichá smrt sezení, kterou tohle řeší
  // (viz #189).
  useEffect(() => () => {
    if (casovacObnovyRef.current) clearTimeout(casovacObnovyRef.current);
    if (casovacOpakovaniRef.current) clearTimeout(casovacOpakovaniRef.current);
  }, []);

  // Translation helper (relay only needs a subset)
  const t = useCallback((key) => {
    const dict = TRANSLATIONS[lang] || TRANSLATIONS['cz'];
    return dict?.[key] || key;
  }, [lang]);

  const value = {
    // auth
    isLoggedIn, token, activeOperator, onLogin, onLogout, obnovToken,
    // UI helpers
    lang, setLang, t, showToast, toasts,
    // App info
    API_BASE, isNativeApp,
    // Relay-specific: full operator object with token for RelayMode
    operator: activeOperator ? {
      ...activeOperator,
      token,
      profileId: activeOperator.profileId || activeOperator.activeProfileId,
      installationId: localStorage.getItem('nexus_installation_id'),
    } : null,
  };

  return <RelayContext.Provider value={value}>{children}</RelayContext.Provider>;
};

export default RelayContext;
