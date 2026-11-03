/**
 * RelayContext – lightweight context for Nexus Relay app.
 * Contains ONLY what the Relay app needs: auth + basic API calls.
 * Does NOT import: AgencyDataGateway, AnalyticsService, ContentSyncService,
 * CommunicationService, useChatLogic, useNexusData, usePermissions, etc.
 */
import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import { Capacitor } from '@capacitor/core';
import { TRANSLATIONS } from '../translations';
import * as tokenStore from '../services/tokenStore';


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

      const { token: newToken, user: operator } = res.data;
      if (!newToken) return { success: false, error: 'Neplatná odpověď serveru' };

      tokenStore.setToken(newToken); // #5 (nativ perzistuje, web jen paměť)
      localStorage.setItem('nexus_isLoggedIn', 'true');
      localStorage.setItem('nexus_activeOperator', JSON.stringify(operator));
      axios.defaults.headers.common['Authorization'] = `Bearer ${newToken}`;

      setToken(newToken);
      setActiveOperator(operator);
      setIsLoggedIn(true);
      return { success: true };
    } catch (err) {
      const msg = err.response?.data?.message || err.message || 'Přihlášení selhalo';
      return { success: false, error: msg };
    }
  }, []);

  const onLogout = useCallback(() => {
    tokenStore.clear(); // #5
    localStorage.removeItem('nexus_isLoggedIn');
    localStorage.removeItem('nexus_activeOperator');
    delete axios.defaults.headers.common['Authorization'];
    setToken(null);
    setActiveOperator(null);
    setIsLoggedIn(false);
  }, []);

  // Translation helper (relay only needs a subset)
  const t = useCallback((key) => {
    const dict = TRANSLATIONS[lang] || TRANSLATIONS['cz'];
    return dict?.[key] || key;
  }, [lang]);

  const isNativeApp = Capacitor.isNativePlatform();

  const value = {
    // auth
    isLoggedIn, token, activeOperator, onLogin, onLogout,
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
