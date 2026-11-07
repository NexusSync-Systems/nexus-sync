import React, { useState, useCallback, useEffect, useRef } from 'react';
import axios from 'axios';
import { Capacitor } from '@capacitor/core';
import { Device } from '@capacitor/device';
import * as tokenStore from '../services/tokenStore';
import { generateSecureInstallationId } from '../utils/installationId';

/**
 * Čím se tahle aplikace páruje: relay telefon se SIM kartou, nebo plná
 * aplikace. Server podle toho drží dvě nezávislé vazby na jeden profil —
 * jinak si je modelčin relay a její plná aplikace přehazují (viz #188).
 *
 * Tři zdroje, protože každý sám o sobě má slepé místo: varianta buildu
 * (`__APP_VARIANT__`) platí pro APK, `?mode=relay` pro relay v prohlížeči
 * a applicationId pro případ, že by se relay sestavil bez té konstanty.
 */
const zjistiVariantuAplikace = (deviceInfo) => {
  if (typeof __APP_VARIANT__ !== 'undefined' && __APP_VARIANT__ === 'relay') return 'relay';
  if (deviceInfo?.id === 'com.nexushub.relay') return 'relay';
  try {
    if (new URLSearchParams(window.location.search).get('mode') === 'relay') return 'relay';
  } catch (_err) { /* bez window se rozhoduje podle buildu */ }
  return 'full';
};

/**
 * Custom hook to manage authentication state and logic for Nexus Hub.
 */
export function useAuth({ API_BASE, _t, setIsRelayMode, _setSelectedChatId, _setActiveProfileId, setShowLanding }) {
  const [isLoggedIn, setIsLoggedIn] = useState(() => {
    return localStorage.getItem('nexus_isLoggedIn') === 'true';
  });
  // Access token: zdroj pravdy je tokenStore (na webu jen v paměti — #5). Na reloadu
  // je na webu null a bootstrap effect ho obnoví přes refresh cookie.
  const [token, setToken] = useState(() => tokenStore.getToken());
  const [activeOperator, setActiveOperator] = useState(() => {
    try {
      const saved = localStorage.getItem('nexus_activeOperator');
      if (saved && saved !== 'undefined' && saved !== 'null') {
        let parsed = null;
        try {
          parsed = JSON.parse(saved);
        } catch (_err) {
          console.error('[Auth] Failed to parse saved operator', _err);
          return null;
        }

        // POZOR: role/jméno z localStorage jsou jen UI/display, NENÍ to autorizace —
        // localStorage je uživatelsky editovatelné. O právech rozhoduje výhradně server
        // (role/agency checks). Proto tu záměrně žádný klientský override role/jména
        // neděláme (dřív se tu App Ownerovi přepisovalo jméno + byla tu duplicitní
        // podmínka `role === 'App Owner' || role === 'App Owner'`).
        return parsed;
      }
      return null;
    } catch { return null; }
  });
  const [activeClient, setActiveClient] = useState(() => {
    try {
      const saved = localStorage.getItem('nexus_activeClient');
      if (saved && saved !== 'undefined' && saved !== 'null') {
        let parsed = null;
        try {
          parsed = JSON.parse(saved);
        } catch (_err) {
          console.error('[Auth] Failed to parse saved client', _err);
          return null;
        }
        if (parsed) return parsed;
      }
      return null;
    } catch { return null; }
  });

  const [appVariant, setAppVariant] = useState('full');
  const [showResetPassword, setShowResetPassword] = useState(false);
  const [tempUser, setTempUser] = useState(null);
  const [originalOperator, setOriginalOperator] = useState(null);
  const [isLoginLoading, setIsLoginLoading] = useState(false);
  const refreshTimerRef = useRef(null);
  const scheduleTokenRefreshRef = useRef(null);

  const isNativeApp = Capacitor.isNativePlatform();

  const handleLogoutInternal = useCallback(() => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    const lang = localStorage.getItem('nexus_lang') || 'cz';
    tokenStore.clear(); // vymazat in-memory access token + relay secret (#5)
    localStorage.clear(); // Nuclear option to ensure no stale data remains
    // Preserve onboarding state so returning users don't see onboarding again after logout
    localStorage.setItem('nexus_hasSeenOnboarding', 'true');
    localStorage.setItem('nexus_onboarding_seen', 'true');
    if (lang && lang !== 'cz') {
      window.location.href = `/${lang}/logout`;
    } else {
      window.location.href = '/logout';
    }
  }, []);

  const handleLogout = useCallback(() => {
    const storedRefreshToken = localStorage.getItem('nexus_refreshToken');
    // credentials:'include' so the server can revoke/clear the httpOnly refresh cookie (web)
    fetch(`${API_BASE}/auth/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(storedRefreshToken ? { refreshToken: storedRefreshToken } : {}),
    }).catch(() => {});
    handleLogoutInternal();
  }, [API_BASE, handleLogoutInternal]);

  const refreshPromiseRef = useRef(null);

  const performRefresh = useCallback(async () => {
    if (refreshPromiseRef.current) return refreshPromiseRef.current;
    
    const storedRefreshToken = localStorage.getItem('nexus_refreshToken');
    // Native/Capacitor uses the body refresh token; web relies on the httpOnly cookie.
    if (isNativeApp && !storedRefreshToken) {
      handleLogoutInternal();
      return null;
    }

    refreshPromiseRef.current = (async () => {
      try {
        const res = await fetch(`${API_BASE}/auth/refresh`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(storedRefreshToken ? { refreshToken: storedRefreshToken } : {}),
        });
        
        const data = await res.json();
        if (res.ok && data.token) {
          tokenStore.setToken(data.token); // #5: web = jen paměť, nativ = perzistuje
          if (isNativeApp && data.refreshToken) localStorage.setItem('nexus_refreshToken', data.refreshToken);
          localStorage.setItem('nexus_isLoggedIn', 'true');
          setToken(data.token);
          if (setShowLanding) setShowLanding(false);
          if (scheduleTokenRefreshRef.current) {
            scheduleTokenRefreshRef.current(data.expiresIn || 3600);
          }
          console.log('[Auth] Token refreshed');
          return data.token;
        } else {
          console.warn('[Auth] Refresh failed, logging out');
          handleLogoutInternal();
          return null;
        }
      } catch (_err) {
        console.error('[Auth] Refresh _err:', _err);
        return null;
      } finally {
        refreshPromiseRef.current = null;
      }
    })();

    return refreshPromiseRef.current;
  }, [API_BASE, handleLogoutInternal, setShowLanding, isNativeApp]);

  const scheduleTokenRefresh = useCallback((expiresInSec) => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    
    if (expiresInSec <= 0) {
      return performRefresh();
    }

    const refreshMs = Math.max((expiresInSec - 300) * 1000, 0);
    refreshTimerRef.current = setTimeout(() => {
      performRefresh();
    }, refreshMs);
  }, [performRefresh]);

  useEffect(() => {
    scheduleTokenRefreshRef.current = scheduleTokenRefresh;
  }, [scheduleTokenRefresh]);

  // #5 bootstrap (web): access token žije jen v paměti, takže po reloadu je null,
  // i když je uživatel přihlášený (flag nexus_isLoggedIn zůstává). Obnovíme ho přes
  // httpOnly refresh cookie. isBootstrapping drží UI na loaderu, dokud token není
  // zpět — jinak by komponenty pálily API volání bez tokenu a spadly na 401.
  const [isBootstrapping, setIsBootstrapping] = useState(
    () => !isNativeApp && isLoggedIn && !tokenStore.getToken()
  );
  const didBootstrapRef = useRef(false);
  useEffect(() => {
    if (didBootstrapRef.current) return;
    if (!isNativeApp && isLoggedIn && !token) {
      didBootstrapRef.current = true;
      performRefresh().finally(() => setIsBootstrapping(false));
    } else if (isBootstrapping) {
      setIsBootstrapping(false);
    }
  }, [isNativeApp, isLoggedIn, token, performRefresh, isBootstrapping]);

  useEffect(() => {
    if (isLoggedIn && token) {
      try {
        const payload = JSON.parse(atob(token.split('.')[1]));
        const expiresIn = payload.exp - Math.floor(Date.now() / 1000);
        if (expiresIn > 0) {
          scheduleTokenRefresh(expiresIn);
        } else {
          // Token already expired — web refreshes via the httpOnly cookie, native via the stored token
          const storedRefreshToken = localStorage.getItem('nexus_refreshToken');
          if (!isNativeApp || storedRefreshToken) scheduleTokenRefresh(0);
        }
      } catch (_err) {
        console.warn('[Auth] Token parsing failed', _err);
      }
    }
    return () => { if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current); };
  }, [isLoggedIn, token, scheduleTokenRefresh, isNativeApp]);

  // Detect App Variant
  useEffect(() => {
    const detectVariant = async () => {
      if (isNativeApp) {
        try {
          const info = await Device.getInfo();
          if (info.id === 'com.nexushub.relay') {
            setAppVariant('relay');
          }
        } catch (_err) { console.error('Variant detection failed', _err); }
      } else {
        const params = new URLSearchParams(window.location.search);
        if (params.get('mode') === 'relay') {
          setAppVariant('relay');
        }
      }
    };
    detectVariant();
  }, [isNativeApp]);

  const shouldAutoRelay = useCallback((operator) => {
    if (!operator) return false;
    const role = (operator.role?.name || operator.role || '').toUpperCase();
    return role === 'RELAY_NODE' || role === 'RELAY' || operator.isRelayOnly;
  }, []);

  const verifyNativeDeviceBinding = useCallback(async (authToken, operator) => {
    if (!isNativeApp || !authToken || !operator) return;
    try {
      const info = await Device.getInfo();
      const deviceId = (await Device.getId()).identifier;
      let installationId = localStorage.getItem('nexus_installation_id');
      if (!installationId) {
        installationId = generateSecureInstallationId();
        localStorage.setItem('nexus_installation_id', installationId);
      }

      const verifyRes = await axios.post(`${API_BASE}/device/verify`, {
        installationId,
        profileId: operator.profileId || operator.activeProfileId || null,
        appVariant: zjistiVariantuAplikace(info),
        model: info.model,
        platform: info.platform,
        deviceName: info.name || deviceId || 'Nexus Relay'
      }, {
        headers: { Authorization: `Bearer ${authToken}` }
      });

      // Ulož per-device relay secret (odvozený serverem) pro WebRTC signaling (#5)
      if (verifyRes?.data?.deviceSecret) {
        tokenStore.setRelaySecret(verifyRes.data.deviceSecret);
      }

      console.log('[Native] Device binding verified');
    } catch (_err) {
      console.warn('[Native] Device binding failed', _err.message);
    }
  }, [isNativeApp, API_BASE]);

  const maybePromptRcsAccessOnFirstLogin = useCallback(async (operator) => {
    if (!isNativeApp) return;
    const prompted = localStorage.getItem('nexus_relay_rcs_first_login_prompted') === 'true';
    if (prompted) return;
    if (shouldAutoRelay(operator)) return;

    try {
      const plugin = window.Capacitor?.Plugins?.NexusRelay;
      if (plugin?.requestRcsAccess) {
        const res = await plugin.requestRcsAccess();
        if (res.granted) {
          localStorage.setItem('nexus_relay_rcs_first_login_prompted', 'true');
        }
      }
    } catch (_err) {
      console.warn('[RCS] Initial request failed', _err);
    }
  }, [isNativeApp, shouldAutoRelay]);

  const handleLogin = useCallback(async (email, password) => {
    setIsLoginLoading(true);
    try {
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, password }),
      });

      if (res.ok) {
        const data = await res.json();
        tokenStore.setToken(data.token); // #5: web = jen paměť, nativ = perzistuje
        if (isNativeApp && data.refreshToken) localStorage.setItem('nexus_refreshToken', data.refreshToken);
        localStorage.setItem('nexus_isLoggedIn', 'true');
        localStorage.setItem('nexus_activeOperator', JSON.stringify(data.user));
        setToken(data.token);
        setActiveOperator(data.user);
        setIsLoggedIn(true);
        
        // Schedule token refresh before expiry
        scheduleTokenRefresh(data.expiresIn || 3600);
        
        void verifyNativeDeviceBinding(data.token, data.user);
        void maybePromptRcsAccessOnFirstLogin(data.user);
        
        if (window.Notification && window.Notification.permission === 'default') {
          window.Notification.requestPermission().catch(() => {});
        }
        
        if (shouldAutoRelay(data.user)) {
          setIsRelayMode(true);
        } else {
          // For Model role on native, auto-start relay background service
          const role = (data.user.role?.name || data.user.role || '').toUpperCase();
          if (isNativeApp && role === 'MODEL') {
            try {
              const plugin = window.Capacitor?.Plugins?.NexusRelay;
              if (plugin?.startBackgroundService) {
                await plugin.startBackgroundService({
                  token: data.token,
                  userId: data.user.id,
                  profileId: data.user.profileId || data.user.activeProfileId
                });
                console.log('[Relay] Background service started for Model');
              }
            } catch (_err) {
              console.warn('[Relay] Background service start failed:', _err.message);
            }
          }
          window.location.href = '/dashboard';
        }
        return { success: true };
      } else {
        const errorData = await res.json().catch(() => ({}));
        if (res.status >= 500) {
          return { success: false, _err: 'serverError' };
        }
        return { success: false, _err: errorData.message || 'loginError' };
      }
    } catch (_err) {
      console.error('[Auth] Login failed:', _err);
      return { success: false, _err: 'connectionError', detail: _err.message || String(_err) };
    } finally {
      setIsLoginLoading(false);
    }
  }, [API_BASE, isNativeApp, maybePromptRcsAccessOnFirstLogin, scheduleTokenRefresh, setIsRelayMode, shouldAutoRelay, verifyNativeDeviceBinding]);


  const handleRegisterAgency = useCallback(async (data) => {
    try {
      const res = await fetch(`${API_BASE}/auth/register-agency`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) return { success: true, inviteCode: body.inviteCode };
      return { success: false, _err: body.message || 'Registration failed' };
    } catch (_err) {
      console.error('[Auth] Agency registration failed:', _err);
      return { success: false, _err: 'Connection _err' };
    }
  }, [API_BASE]);

  const handleRegisterUser = useCallback(async (data) => {
    try {
      const res = await fetch(`${API_BASE}/auth/register-user`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) return { success: true };
      return { success: false, _err: body.message || 'Registration failed' };
    } catch (_err) {
      console.error('[Auth] User registration failed:', _err);
      return { success: false, _err: 'Connection _err' };
    }
  }, [API_BASE]);

  const handleResetRequest = useCallback(async (email) => {
    try {
      await fetch(`${API_BASE}/auth/reset-password-request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      return true;
    } catch (_err) {
      console.error('[Auth] Reset request failed:', _err);
      return false;
    }
  }, [API_BASE]);

  const handleResetRequired = useCallback((user) => {
    setTempUser(user);
    setShowResetPassword(true);
  }, []);

  const handleResetComplete = useCallback((newPassword, operators = [], setOperators) => {
    if (!tempUser) return;
    
    const operatorsList = operators || [];
    const updatedOperators = operatorsList.map(op => 
      op.id === tempUser.id ? { ...op, password: newPassword, mustResetPassword: false } : op
    );
    setOperators(updatedOperators);
    
    const updatedUser = (updatedOperators || []).find(op => op.id === tempUser.id);
    if (updatedUser) {
      handleLogin(updatedUser.email, newPassword);
    }
    
    setShowResetPassword(false);
    setTempUser(null);
  }, [handleLogin, tempUser]);

  return React.useMemo(() => ({
    isLoggedIn, setIsLoggedIn,
    token, setToken,
    activeOperator, setActiveOperator,
    activeClient, setActiveClient,
    appVariant, setAppVariant,
    showResetPassword, setShowResetPassword,
    tempUser, setTempUser,
    originalOperator, setOriginalOperator,
    isLoginLoading,
    isBootstrapping,
    isNativeApp,
    handleLogin,
    handleLogout,
    handleRegisterAgency,
    handleRegisterUser,
    handleResetRequest,
    handleResetRequired,
    handleResetComplete,
    verifyNativeDeviceBinding,
    maybePromptRcsAccessOnFirstLogin,
    shouldAutoRelay,
    scheduleTokenRefresh
  }), [
    isLoggedIn, token, activeOperator, activeClient, appVariant,
    showResetPassword, tempUser, originalOperator, isLoginLoading, isBootstrapping,
    isNativeApp, handleLogin, handleLogout, handleRegisterAgency,
    handleRegisterUser, handleResetRequest, handleResetRequired, 
    handleResetComplete, verifyNativeDeviceBinding, 
    maybePromptRcsAccessOnFirstLogin, shouldAutoRelay,
    scheduleTokenRefresh
  ]);
}
