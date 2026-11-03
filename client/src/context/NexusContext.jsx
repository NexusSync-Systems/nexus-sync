import React, { 
  useState, useEffect, useCallback, useMemo, useRef 
} from 'react';
import { Capacitor } from '@capacitor/core';
import { App as CapacitorApp } from '@capacitor/app';
import { useAuth } from '../hooks/useAuth';
import { useNexusData } from '../hooks/useNexusData';
import { getSocket } from '../services/socketBridge';
import { ensurePhoneTracking, stopPhoneTracking } from '../services/phoneTracker';
import { setAppOwnerBypass, useFeatureLock, isFeatureLocked as isFeatureLockedNow } from '../config/featureLocks';
import { getOrCreateInstallationId } from '../utils/installationId';
import { sestavOdchoziCil, najdiDidProfilu } from '../utils/sipDial';
import { AgencyDataGateway } from '../services/agency/AgencyDataGateway';
import { AnalyticsService } from '../services/analytics/AnalyticsService';
import { ContentSyncService } from '../services/content/ContentSyncService';
import { CommunicationService } from '../services/communication/CommunicationService';
import { WhatsAppAdapter } from '../services/communication/WhatsAppAdapter';
import { SMSAdapter } from '../services/communication/SMSAdapter';
import { WebChatAdapter } from '../services/communication/WebChatAdapter';
import { TRANSLATIONS } from '../translations';
import { NexusContext } from './ContextObject';
import { usePermissions } from '../hooks/usePermissions';
import { useChatLogic } from '../hooks/useChatLogic';
import { useSocket } from '../hooks/useSocket';
import { initPushNotifications } from '../services/pushService';

// API Configuration
// IMPORTANT: Capacitor WebView ALWAYS reports hostname as 'localhost' even on a real device,
// so we MUST use Capacitor.isNativePlatform() to distinguish native apps from web dev.
//
// VITE_API_URL má přednost a zapéká se při buildu (.github/workflows/ci.yml).
// Dřív tady adresa byla NATVRDO a tenhle soubor jediný ji z prostředí nečetl —
// přitom je to hlavní provider pro přihlášení i data. Správně nastavený build
// tedy posílal zbytek aplikace na novou adresu, ale přihlášení pořád na
// nexus-api.myvnc.com, server, který už neexistuje. A protože se build i
// nasazení povedly, nic na to neupozornilo.
//
// Zbývající hodnoty jsou jen záloha pro vývoj: nativní prostředí a prohlížeč
// mimo localhost na starou adresu, localhost na místní backend.
const API_BASE = import.meta.env.VITE_API_URL
  || (Capacitor.isNativePlatform()
    ? 'https://nexus-api.myvnc.com/api'
    : (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
      ? 'http://localhost:5000'
      : 'https://nexus-api.myvnc.com/api'));

/**
 * Main Provider for Nexus Hub.
 * Centralizes all global states: Auth, Data, Navigation, I18n.
 */

// Cesty, které smí vidět nepřihlášený návštěvník a u kterých se drží landing.
//
// Tenhle seznam byl rozepsaný na pěti místech zvlášť (`p === '/' || p === '/guide'
// || ...`). Přidat šestou veřejnou cestu znamenalo trefit všechny — a když se na
// jedno zapomnělo, odkaz fungoval, ale po obnovení stránky spadl návštěvník do
// přihlašovací obrazovky. Nic nespadlo, nikde chyba, jen to nefungovalo.
export const VEREJNE_CESTY = ['/', '/guide', '/downloads', '/prezentace'];

// Která veřejná cesta odpovídá které záložce. '/' zůstává na dashboardu.
const ZALOZKA_CESTY = { '/guide': 'guide', '/downloads': 'downloads', '/prezentace': 'presentation' };

export const jeVerejnaCesta = (cesta) => VEREJNE_CESTY.includes(cesta);

export const NexusProvider = ({ children }) => {
  // --- 1. SETTINGS & PERSISTENCE ---
  const getSafeStorage = (key, fallback) => {
    try { return localStorage.getItem(key) || fallback; } 
    catch { return fallback; }
  };

  const [pathname, setPathname] = useState(typeof window !== 'undefined' ? window.location.pathname : '/');
  const [authInitialTab, setAuthInitialTab] = useState('login');

  const [lang, setLangState] = useState(() => {
    if (typeof window !== 'undefined') {
      const path = window.location.pathname;
      if (path.startsWith('/en')) return 'en';
      if (path.startsWith('/cz')) return 'cz';
    }
    return getSafeStorage('nexus_lang', 'cz');
  });

  const setLang = useCallback((newLang) => {
    setLangState(newLang);
    try {
      localStorage.setItem('nexus_lang', newLang);
    } catch (_err) { /* ignore */ }


    if (typeof window !== 'undefined') {
      const currentPath = window.location.pathname;
      const cleanPath = currentPath.replace(/^\/(en|cz)/, '') || '/';
      
      let targetPath = cleanPath;
      if (newLang !== 'cz') {
        targetPath = `/${newLang}${cleanPath === '/' ? '' : cleanPath}`;
      }
      
      if (targetPath !== currentPath) {
        window.history.pushState(null, '', targetPath);
        setPathname(targetPath);
      }
    }
  }, []);
  
  const [activeMarket, _setActiveMarket] = useState(() => getSafeStorage('nexus_active_market', 'UK'));
  const setActiveMarket = useCallback((market) => {
    _setActiveMarket(market);
    try { localStorage.setItem('nexus_active_market', market); } catch { /* ignore */ }
  }, []);
  
  // Auth & Routing States (Moved up to prevent hoisting errors)

  const [activeTab, setActiveTab] = useState(() => {
    if (typeof window !== 'undefined') {
      const path = window.location.pathname.substring(1);
      if (path && path !== '' && path !== 'dashboard' && path !== 'login' && path !== 'register') return path;
    }
    return localStorage.getItem('nexus_active_tab') || 'dashboard';
  });

  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(() => {
    try {
      const savedUser = localStorage.getItem('nexus_activeOperator');
      const user = savedUser ? JSON.parse(savedUser) : null;
      const userId = user?.id || user?._id || user?.userId;
      const key = userId ? `nexus_sidebar_collapsed_${userId}` : 'nexus_sidebar_collapsed_guest';
      return localStorage.getItem(key) === 'true';
    } catch (_err) {
      return localStorage.getItem('nexus_sidebar_collapsed_guest') === 'true';
    }
  });

  const [isMobile, setIsMobile] = useState(typeof window !== 'undefined' ? window.innerWidth <= 768 : false);
  const isNativeApp = Capacitor.isNativePlatform();
  
  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth <= 768);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // --- 2. NAVIGATION & ROUTING LOGIC ---
  const [showLanding, setShowLanding] = useState(() => {
    if (typeof window !== 'undefined') {
      const path = window.location.pathname;
      const cleanPath = path.replace(/^\/(en|cz)/, '') || '/';
      return jeVerejnaCesta(cleanPath);
    }
    return true;
  });

  const navigate = useCallback((path, authTab = 'login') => {
    if (typeof window === 'undefined') return;
    
    // If navigating to login/register/guide, set the auth tab if provided
    if (authTab) setAuthInitialTab(authTab);

    // Ensure language prefix is preserved (unless strictly root as requested)
    let targetPath = path;
    const clean = path.replace(/^\/(en|cz)/, '') || '/';

    if (clean === '/') {
      targetPath = '/';
      setShowLanding(true);
      setActiveTab('dashboard');
    } else if (lang !== 'cz' && !path.startsWith(`/${lang}`)) {
      targetPath = `/${lang}${path === '/' ? '' : path}`;
    }
    
    if (!jeVerejnaCesta(clean)) {
      setShowLanding(false);
    } else if (clean !== '/') {
      setShowLanding(true);
    }

    window.history.pushState(null, '', targetPath);
    setPathname(targetPath);
  }, [lang]);

  // Sync showLanding and activeTab with pathname

  useEffect(() => {
    const p = pathname.replace(/^\/(en|cz)/, '') || '/';
    if (jeVerejnaCesta(p)) {
      setTimeout(() => {
        setShowLanding(true);
        setActiveTab(ZALOZKA_CESTY[p] || 'dashboard');
      }, 0);
    } else {
      setTimeout(() => {
        setShowLanding(false);
        const tab = p.split('/')[1] || p.substring(1);
        if (tab && tab !== '' && tab !== 'dashboard' && tab !== 'login' && tab !== 'register') {
          setActiveTab(tab);
        }
        // Handle special auth routes
        if (tab === 'register') {
          setAuthInitialTab('register-agency');
        } else if (tab === 'login') {
          setAuthInitialTab('login');
        }
      }, 0);
    }
    
    setTimeout(() => {
      if (pathname.startsWith('/en')) setLangState('en');
      else if (pathname.startsWith('/cz')) setLangState('cz');
    }, 0);
    
    // Save to localStorage for persistence
    localStorage.setItem('nexus_active_tab', p.split('/')[1] || p.substring(1) || 'dashboard');
  }, [pathname]);


  // Handle browser back/forward buttons
  useEffect(() => {
    const handlePopState = () => {
      setPathname(window.location.pathname);
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const [hasSeenOnboarding, setHasSeenOnboarding] = useState(() => 
    localStorage.getItem('nexus_hasSeenOnboarding') === 'true' || 
    localStorage.getItem('nexus_onboarding_seen') === 'true'
  );
  const [showOnboarding, setShowOnboarding] = useState(() => 
    isNativeApp &&
    localStorage.getItem('nexus_hasSeenOnboarding') !== 'true' && 
    localStorage.getItem('nexus_onboarding_seen') !== 'true'
  );

  // --- 3. CORE IDENTITY & AUTH ---
  const [activeOperatorState, setActiveOperatorState] = useState(null);
  const [activeProfileId, setActiveProfileId] = useState(() => localStorage.getItem('nexus_active_profile_id') || 'all');

  const [messages, setMessages] = useState([]);
  const [selectedChatId, setSelectedChatId] = useState(null);
  const [messageValue, setMessageValue] = useState('');
  const [isHistoryLoading, setIsHistoryLoading] = useState(false);
  const [_chatHistory, _setChatHistory] = useState([]);
  const [onlineOnly, setOnlineOnly] = useState(false);
  const [_relaySimSlot, _setRelaySimSlot] = useState(() => localStorage.getItem('nexus_relay_sim_slot') || 'auto');
  const [_relayLogs, _setRelayLogs] = useState(() => {
    try {
      const saved = localStorage.getItem('nexus_relay_logs');
      return saved ? JSON.parse(saved) : [];
    } catch { return []; }
  });
  const [_isRelayActive, setIsRelayActive] = useState(() => localStorage.getItem('nexus_relay_active') === 'true');
  const [isRelayMode, setIsRelayMode] = useState(() => localStorage.getItem('nexus_relay_active') === 'true');

  // Voice Guardian & Audio Sentinel
  const [voiceGuardianActive, setVoiceGuardianActive] = useState(false);
  const [audioSentinelActive, setAudioSentinelActive] = useState(false);
  const handleToggleVoiceGuardian = useCallback(async () => {
    // Dokud je Voice SOS uzamčené, neotvírej mikrofon — nesahali bychom na
    // něj kvůli ničemu (detekce neexistuje) a uživatelka by viděla indikátor
    // nahrávání u funkce, která nic nehlídá.
    if (isFeatureLockedNow('voice-sos')) return;
    const next = !voiceGuardianActive;
    setVoiceGuardianActive(next);
    if (next) {
      try {
        const stream = await navigator.mediaDevices?.getUserMedia({ audio: true });
        window._voiceGuardianStream = stream;
      } catch (_err) {
        console.warn('[VoiceGuardian] Mic permission denied', _err);
        setVoiceGuardianActive(false);
      }
    } else {
      if (window._voiceGuardianStream) {
        window._voiceGuardianStream.getTracks().forEach(t => t.stop());
        window._voiceGuardianStream = null;
      }
    }
  }, [voiceGuardianActive]);

  const [_sosActive, _setSosActive] = useState(false);
  const [showPanicConfirm, setShowPanicConfirm] = useState(false);
  const [checkinMinutes, setCheckinMinutes] = useState(30);
  const [checkinTimerEnd, setCheckinTimerEnd] = useState(null);
  const [nowTs, setNowTs] = useState(() => Date.now());
  const [hrThreshold, setHrThreshold] = useState(130);
  const [heartRate] = useState(0);
  const [isBluetoothConnected, setIsBluetoothConnected] = useState(false);
  const [incomingGhostCall, setIncomingGhostCall] = useState(false);
  const [ghostCallScheduledAt, setGhostCallScheduledAt] = useState(null);
  const [linkedSessionId, setLinkedSessionId] = useState(null);
  const [incomingRelayCall, setIncomingRelayCall] = useState(null);
  const [lastEmergencyAlert, setLastEmergencyAlert] = useState(null);
  const [lastRelayCommand, setLastRelayCommand] = useState(null);

  // UI Modals
  const [isEditProfileOpen, setIsEditProfileOpen] = useState(false);
  const [editingProfileData, setEditingProfileData] = useState(null);
  const [isAddAgencyOpen, setIsAddAgencyOpen] = useState(false);
  const [isAddUserOpen, setIsAddUserOpen] = useState(false);
  const [isBugReportOpen, setIsBugReportOpen] = useState(false);
  const [agencyDetailModalData, setAgencyDetailModalData] = useState(null);
  const [_addUserModalAgencyId, _setAddUserModalAgencyId] = useState(null);
  const [_toasts, _setToasts] = useState([]);
  const [_mobileView, _setMobileView] = useState('list');
  const [_activeContextTab, _setActiveContextTab] = useState('history');
  const [_inlinePanelTab, _setInlinePanelTab] = useState('notes');
  const [calViewDate, setCalViewDate] = useState(new Date());

  const availableServers = useMemo(() => [
    { id: 'main-hub', name: 'Main Hub', ip: '78.141.202.139' },
    { id: 'ai-node', name: 'AI Node (Hetzner)', ip: '178.105.39.179' }
  ], []);
  const [selectedServerId, setSelectedServerId] = useState('main-hub');

  // POZOR: chatScrollRef ani isUserScrolled se tady NEVYTVÁŘEJÍ.
  //
  // Kontext si dřív zakládal vlastní dvojici a tu vystavoval komponentám —
  // takže InboxView připojil DOM na kontextový ref, zatímco posouvání
  // v useChatLogic sahalo na svůj vlastní, který nebyl připojený k ničemu.
  // `chatScrollRef.current` tam byl vždycky null a automatický posun na
  // konec konverzace tím pádem NIKDY nefungoval. Kód existoval a vypadal
  // správně, jen nikam nedosáhl.
  //
  // Refy se proto berou z chatLogic (viz níž ve `value`).
  // Profily přihlášeného uživatele — v refu, protože socket handlery se registrují
  // dřív, než je myProfiles spočítané, a nesmí se kvůli nim přepojovat socket.
  const myProfilesRef = useRef([]);
  const ghostCallTimerRef = useRef(null);
  const activeOperatorRef = useRef(null);

  // ── Vytáčení odchozích hovorů ──────────────────────────────────────────────
  // SIP spojení drží SipManager (jedna instance na celou aplikaci). Kontext ho
  // sem nepřebírá — jen si nechá zaregistrovat vytáčecí funkci, aby na ni
  // dosáhla schránka. Přesouvat UA do kontextu by znamenalo sáhnout do
  // funkční telefonie kvůli jednomu tlačítku.
  const sipDialerRef = useRef(null);
  const registerSipDialer = useCallback((fn) => { sipDialerRef.current = fn; }, []);

  const t = useCallback((key, params = {}) => {
    try {
      if (!key || typeof key !== 'string') return key || '';
      const safeTranslations = (typeof TRANSLATIONS !== 'undefined' && TRANSLATIONS) || {};
      const langSet = safeTranslations[lang] || safeTranslations['en'] || {};
      let text = key.split('.').reduce((obj, k) => (obj && obj[k]) ? obj[k] : null, langSet) || key;
      if (params && typeof params === 'object') {
        Object.entries(params).forEach(([k, v]) => {
          if (typeof text === 'string') {
            text = text.replace(new RegExp(`\\{\\{${k}\\}\\}`, 'g'), String(v));
            text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
          }
        });
      }
      return text;
    } catch (_err) { return String(key || ''); }
  }, [lang]);

  const showToast = useCallback((message, type = 'info') => {
    const id = Date.now();
    _setToasts(prev => [...prev.slice(-4), { id, message, type }]);
    setTimeout(() => _setToasts(prev => prev.filter(t => t.id !== id)), 4000);
  }, []);

  const setRelayActiveStable = useCallback((val) => {
    setIsRelayActive(val);
    localStorage.setItem('nexus_relay_active', String(val));
  }, []);

  const auth = useAuth({ 
    API_BASE,
    _t: t,
    setIsRelayMode: setRelayActiveStable, 
    setSelectedChatId, 
    setActiveProfileId, 
    setShowLanding 
  });
  const { activeOperator: authUser, token, handleLogout: logout, isLoggedIn, handleLogin } = auth;

  // Redirect unauthenticated users from protected routes to login
  useEffect(() => {
    if (!isLoggedIn) {
      const clean = pathname.replace(/^\/(en|cz)/, '') || '/';
      if (!jeVerejnaCesta(clean) && clean !== '/login' && clean !== '/register' && clean !== '/logout') {
        setTimeout(() => navigate('/login', 'login'), 0);
      }
    }
  }, [isLoggedIn, pathname, navigate]);

  // Inicializovat push notifikace po přihlášení
  useEffect(() => {
    if (isLoggedIn && token && isNativeApp) {
      initPushNotifications(API_BASE, token, (notification, isAction) => {
        console.log('[NexusContext] Push Notification:', notification, 'isAction:', isAction);
        // Můžeme sem případně přidat logika na otevření chatu (isAction = kliknutí na notifikaci)
      });
    }
  }, [isLoggedIn, token, isNativeApp]);

  const memoizedSetActiveOperator = useCallback((op) => setActiveOperatorState(op), []);
  const memoizedSetMessages = useCallback((msgs) => setMessages(msgs), []);
  const memoizedNormalizeProfileId = useCallback((id) => id, []);
  const [activeSafetySession, setActiveSafetySession] = useState(null);
  const [isTimerActive, setIsTimerActive] = useState(false);
  const [timeLeft, setTimeLeft] = useState(0);

  // Odpočet tiká vteřinu po vteřině a ZÁMĚRNĚ jde i do záporu: po vypršení
  // se v kalendáři ukáže „OVERTIME" a tlačítko „JSEM V POŘÁDKU (+10 min)".
  // Zastavit ho na nule by ten nejdůležitější stav schovalo.
  useEffect(() => {
    if (!isTimerActive) return undefined;
    const t = setInterval(() => setTimeLeft(prev => (typeof prev === 'number' ? prev : 0) - 1), 1000);
    return () => clearInterval(t);
  }, [isTimerActive]);

  // mm:ss, u přetažení s mínusem.
  const formatSafetyTime = useCallback((totalSeconds) => {
    const s = Math.abs(Math.round(Number(totalSeconds) || 0));
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(s % 60).padStart(2, '0');
    return `${(Number(totalSeconds) || 0) < 0 ? '-' : ''}${mm}:${ss}`;
  }, []);


  const nexusData = useNexusData({
    token, isLoggedIn, API_BASE, activeProfileId,
    activeMarket,
    setActiveOperator: memoizedSetActiveOperator,
    normalizeProfileId: memoizedNormalizeProfileId,
    setMessages: memoizedSetMessages,
    // Dřív sem šly prázdné funkce, takže si useNexusData běžící relaci
    // vyžádal ze serveru a zahodil ji. Odpočet se proto po znovunačtení
    // stránky neobnovil a panel v kalendáři se neměl z čeho vykreslit.
    setActiveSafetySession,
    setIsTimerActive,
    setTimeLeft,
    showToast, lang
  });

  const activeOperator = useMemo(() => {
    const raw = activeOperatorState || authUser;
    if (!raw) return null;
    const role = String(raw.role || '').toUpperCase().replace(/\s+/g, '_');
    return {
      ...raw,
      isAppOwner: role === 'APP_OWNER',
      isAdmin: role === 'ADMIN' || role === 'AGENCY_ADMIN',
      isManager: role === 'MANAGER',
      isSeniorOperator: role === 'SENIOR_OPERATOR' || role === 'SENIOR_OPERÁTOR',
      isOperator: role === 'OPERATOR',
      isModel: role === 'MODEL'
    };
  }, [activeOperatorState, authUser]);

  // --- 4. CHAT & MESSAGING LOGIC ---
  const chatLogic = useChatLogic({
    token,
    API_BASE,
    activeOperator,
    activeProfileId,
    _showToast: showToast,
    t,
    addNotification: (n) => showToast(n.message, n.type === '_err' ? 'error' : 'info'),
    _playNotificationSound: () => {},
    profiles: nexusData.profiles,
    messages,
    setMessages,
    selectedChatId,
    setSelectedChatId,
    isHistoryLoading,
    setIsHistoryLoading
  });

  // Refy na posouvání chatu se berou z chatLogic — tam na ně sahají efekty,
  // které posouvají konverzaci na konec. Kontext si dřív zakládal vlastní
  // dvojici a vystavoval ji komponentám, takže DOM visel na jednom refu
  // a posouvání koukalo do druhého: `current` byl vždycky null a automatický
  // posun NIKDY nefungoval.
  const { chatScrollRef, isUserScrolled } = chatLogic;

  const { 
    chatMessages, fetchChatMessages, handleSendMessage,
    // handleTranslate z chatLogic se nerozbaluje — useChatLogic ho nikdy
    // nedefinoval, takže by to bylo undefined. Skutečná obsluha je
    // v useNexusData.
    handleSaveNote, handleDeleteNote, clientNotes, internalNote, setInternalNote,
    filteredMessages, setActiveContactId, selectedChat, typingProfiles, handleRefreshMessages
  } = chatLogic;

  const handleIncomingRelayCall = useCallback((data = {}) => {
    const caller = data.from || data.caller || data.callerId || data.phone || (lang === 'cz' ? 'Neznámé číslo' : 'Unknown caller');
    const profileName = data.profileName || data.profile?.name || data.name || '';
    setIncomingRelayCall({
      ...data,
      caller,
      profileName,
      receivedAt: Date.now()
    });
    showToast(
      lang === 'cz'
        ? `Příchozí hovor${profileName ? ` pro ${profileName}` : ''}: ${caller}`
        : `Incoming call${profileName ? ` for ${profileName}` : ''}: ${caller}`,
      'info'
    );
  }, [lang, showToast]);

  const handleEmergencySocketAlert = useCallback((data = {}) => {
    setLastEmergencyAlert({ ...data, receivedAt: Date.now() });
    _setSosActive(true);
    const profileName = data.profileName || data.profile?.name || data.profileId || '';
    showToast(
      lang === 'cz'
        ? `SOS alert${profileName ? `: ${profileName}` : ''}`
        : `SOS alert${profileName ? `: ${profileName}` : ''}`,
      'error'
    );
  }, [lang, showToast]);

  const handleRelayCommandSocket = useCallback((data = {}) => {
    setLastRelayCommand({ ...data, receivedAt: Date.now() });
    if (['SYNC_WEB_PROFILE', 'BOOST_PROFILE'].includes(data.type)) {
      showToast(
        lang === 'cz' ? 'Relay příkaz byl odeslán do zařízení.' : 'Relay command was sent to the device.',
        'info'
      );
    }
  }, [lang, showToast]);

  // --- Socket.io Integration ---
  const socket = useSocket(
    token,
    (d) => {
      const message = d?.message || d;
      if (message) chatLogic.upsertIncomingMessage(message);
    },
    (d) => {
      const message = d?.message || d;
      if (!message) return;
      setMessages(p => p.map(m => {
        const sameMessage = m.id === message.id;
        const sameChat = message.chatId && (m.id === message.chatId || m.chatId === message.chatId);
        return sameMessage || sameChat ? { ...m, ...message, id: m.id, chatId: m.chatId || message.chatId } : m;
      }));
    },
    handleIncomingRelayCall,
    handleEmergencySocketAlert,
    handleIncomingRelayCall,
    handleRelayCommandSocket,
    (d) => d?.type === 'SYNC_COMPLETED' && showToast(lang === 'cz' ? '✅ Synchronizace dokončena' : '✅ Sync completed', 'success'),
    (d) => nexusData.applyTrackerLocation?.(d),
    // Fantomový hovor od operátora. Event chodí do celé agentury, takže si ho
    // vezme jen zařízení té modelky, které se týká — operátoři ho ignorují.
    (d) => {
      if (!d?.profileId) return;
      // Server posílá událost do osobní místnosti modelky, takže sem dorazí jen
      // tomu, komu patří. Role se ověřuje ještě tady jako druhá pojistka — hovor
      // nesmí vyskočit operátorovi. Shodu profilu NEkontrolujeme: modelka svůj
      // profil ve `myProfiles` (spravované profily) nemá.
      if (!activeOperatorRef.current?.isModel) return;
      setGhostCallScheduledAt(null);   // vzdálený hovor zvoní hned, žádný odpočet
      setIncomingGhostCall(true);
    }
  );

  // --- Capacitor Connection Recovery ---
  useEffect(() => {
    if (isNativeApp && Capacitor.isPluginAvailable('App')) {
      const listener = CapacitorApp.addListener('appStateChange', (state) => {
        if (state.isActive) {
          console.log('[NexusContext] App resumed. Reconnecting socket and fetching messages.');
          const activeSocket = getSocket();
          if (activeSocket) {
            activeSocket.disconnect();
            setTimeout(() => {
              const s = getSocket();
              if (s) s.connect();
            }, 500);
          }
          if (selectedChatId) {
            fetchChatMessages(selectedChatId);
          }
        }
      });
      return () => {
        listener.then(l => l.remove());
      };
    }
  }, [isNativeApp, selectedChatId, fetchChatMessages]);

  // --- 5. PERMISSIONS & PROFILES ---
  const { isAllowed, activeRole: normalizedRole } = usePermissions(activeOperator, activeOperator?.permissions);

  const activeProfile = useMemo(() => {
    if (!activeProfileId || activeProfileId === 'all') return null;
    return (nexusData.profiles || []).find(p => String(p.id) === String(activeProfileId));
  }, [activeProfileId, nexusData.profiles]);

  const linkedTracker = useMemo(() => {
    const activeTrackers = (nexusData.trackers || []).filter(t => t.active !== false);
    if (!activeTrackers.length) return null;
    if (activeProfileId && activeProfileId !== 'all') {
      return activeTrackers.find(t => String(t.profileId || '') === String(activeProfileId)) || activeTrackers[0];
    }
    return activeTrackers[0];
  }, [nexusData.trackers, activeProfileId]);

  const gpsHistory = useMemo(() => nexusData.gpsHistory || [], [nexusData.gpsHistory]);
  const lastTrackerUpdate = useMemo(() => {
    const value = linkedTracker?.lastSeenAt || linkedTracker?.lastCapturedAt;
    if (!value) return null;
    const ts = new Date(value).getTime();
    return Number.isNaN(ts) ? null : ts;
  }, [linkedTracker]);

  useEffect(() => {
    if (!checkinTimerEnd) return undefined;
    const intervalId = window.setInterval(() => setNowTs(Date.now()), 1000);
    return () => window.clearInterval(intervalId);
  }, [checkinTimerEnd]);

  const checkinTimerEndTs = checkinTimerEnd ? new Date(checkinTimerEnd).getTime() : null;
  const checkinRemaining = checkinTimerEndTs ? Math.max(0, checkinTimerEndTs - nowTs) : 0;

  const startCheckinTimer = useCallback(() => {
    const endAt = new Date(Date.now() + Number(checkinMinutes || 30) * 60000);
    setCheckinTimerEnd(endAt.toISOString());
  }, [checkinMinutes]);

  const resetCheckinTimer = useCallback(() => {
    setCheckinTimerEnd(null);
    setLinkedSessionId(null);
  }, []);

  const triggerSOS = useCallback(async (type = 'manual') => {
    _setSosActive(true);
    try {
      await fetch(`${API_BASE}/sos`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        },
        body: JSON.stringify({
          type,
          profileId: activeProfileId && activeProfileId !== 'all' ? activeProfileId : null,
          lat: linkedTracker?.lastLat ?? null,
          lng: linkedTracker?.lastLng ?? null,
          accuracy: linkedTracker?.lastAccuracy ?? null
        })
      });
    } catch (_err) {
      console.warn('[Safety] SOS trigger failed:', _err);
    }
  }, [token, activeProfileId, linkedTracker]);

  const cancelSOS = useCallback(() => {
    _setSosActive(false);
  }, []);

  // ── Telefon jako GPS tracker (Model, native) — gating A+B+C ──────────────────
  // Reportuj polohu na /ingest, když platí KTERÉKOLIV z: manuální přepínač (B) /
  // aktivní check-in schůzky (A) / aktivní SOS (C). Jinak mlč (baterie + soukromí).
  const [manualTrackingOn, setManualTrackingOnState] = useState(() => {
    try { return localStorage.getItem('nexus_manual_tracking') === '1'; } catch { return false; }
  });
  const setManualTracking = useCallback((on) => {
    setManualTrackingOnState(!!on);
    try { localStorage.setItem('nexus_manual_tracking', on ? '1' : '0'); } catch { /* ignore */ }
  }, []);

  const phoneTrackingActive =
    manualTrackingOn || _sosActive || (!!checkinTimerEnd && checkinRemaining > 0);

  // Reaktivní stav zámku — když ho App Owner přepne, efekt níž se přehodnotí.
  const phoneTrackingLocked = useFeatureLock('phone-tracking');

  useEffect(() => {
    const roleUpper = String(activeOperator?.role?.name || activeOperator?.role || '')
      .toUpperCase().replace(/\s+/g, '_');
    if (!isNativeApp || roleUpper !== 'MODEL' || !token) return;

    // Bezpečnostní pojistka: dokud je funkce uzamčená (neověřená na zařízení),
    // NEspouštěj reálné sledování — ani při check-inu/SOS. Ať nikdo nespoléhá na
    // něco, co ještě nemusí fungovat.
    if (phoneTrackingLocked) { stopPhoneTracking().catch(() => {}); return; }

    if (phoneTrackingActive) {
      // Bez installationId by sledování tiše neběželo — u bezpečnostní funkce
      // nepřípustné. Když ID chybí, vygenerujeme a uložíme ho (stabilní pseudo-IMEI).
      const installationId = getOrCreateInstallationId();
      if (installationId) ensurePhoneTracking(API_BASE, token, installationId).catch(() => {});
    } else {
      stopPhoneTracking().catch(() => {});
    }
  }, [phoneTrackingActive, phoneTrackingLocked, isNativeApp, token, activeOperator]);

  // App Owner vidí zamčené funkce odemčené (může je otestovat). Ostatní role ne.
  useEffect(() => {
    setAppOwnerBypass(!!activeOperator?.isAppOwner);
  }, [activeOperator?.isAppOwner]);

  // Při odmountování (logout / teardown) zastav sledování.
  useEffect(() => () => { stopPhoneTracking().catch(() => {}); }, []);

  const confirmDeparture = useCallback(() => {
    resetCheckinTimer();
  }, [resetCheckinTimer]);

  // Naplánovaný fantomový hovor. Dřív se zpoždění ignorovalo (hovor zazvonil hned)
  // a `ghostCallScheduledAt` se po odzvonění ani odmítnutí nevynulovalo, takže
  // v UI zůstal viset odpočet, který šel do záporu („Vyzvánění začne za −52s").
  const triggerGhostCall = useCallback((delay = 0) => {
    const ms = Math.max(0, Number(delay || 0) * 1000);
    if (ghostCallTimerRef.current) clearTimeout(ghostCallTimerRef.current);

    const fire = () => {
      ghostCallTimerRef.current = null;
      setGhostCallScheduledAt(null);   // odpočet skončil, ať nepokračuje do minusu
      setIncomingGhostCall(true);
    };

    if (ms === 0) {
      setGhostCallScheduledAt(null);
      fire();
      return;
    }
    setGhostCallScheduledAt(Date.now() + ms);
    ghostCallTimerRef.current = setTimeout(fire, ms);
  }, []);

  // Zrušení naplánovaného hovoru při odchodu z appky (jinak by zazvonil "z ničeho nic").
  useEffect(() => () => {
    if (ghostCallTimerRef.current) clearTimeout(ghostCallTimerRef.current);
  }, []);

  const verifyIdentity = useCallback(async () => true, []);
  const playBeep = useCallback(() => {}, []);

  const myProfiles = useMemo(() => {
    const all = nexusData.profiles || [];
    if (!activeOperator) return [];
    
    // Admins, App Owners, Managers and Senior Operators usually see all profiles in this agency setup
    if (activeOperator.isAppOwner || activeOperator.isAdmin || activeOperator.isManager || activeOperator.isSeniorOperator) {
      return all;
    }
    
    // Explicit role string check as safety fallback
    const role = String(activeOperator.role || '').toUpperCase().replace(/\s+/g, '_');
    if (['ADMIN', 'AGENCY_ADMIN', 'APP_OWNER', 'MANAGER', 'SENIOR_OPERATOR', 'SENIOR_OPERÁTOR'].includes(role)) {
      return all;
    }
    
    // For regular operators, filter by assigned profiles using multiple possible field names
    return all.filter(p => {
      const opId = activeOperator.id || activeOperator._id;
      return (
        p.operatorIds?.includes(opId) || 
        p.assignedOperatorIds?.includes(opId) ||
        p.assignees?.includes(opId) ||
        (Array.isArray(p.operators) && p.operators.some(o => (o.id || o._id || o) === opId))
      );
    });
  }, [nexusData.profiles, activeOperator]);

  useEffect(() => { myProfilesRef.current = myProfiles; }, [myProfiles]);
  useEffect(() => { activeOperatorRef.current = activeOperator; }, [activeOperator]);

  const navigateStable = useCallback((path, tab) => navigate(path, tab), [navigate]);

  const daysLeft = useMemo(() => {
    const activeSub = nexusData?.activeSubscription;
    if (!activeSub) return 0;
    const now = new Date();
    const expiresAt = new Date(activeSub.expiresAt);
    return Math.max(0, Math.ceil((expiresAt - now) / 86400000));
  }, [nexusData]);

  // ── Odchozí hovor ──────────────────────────────────────────────────────────
  // Klient uvidí číslo modelky, ne číslo agentury. DID se bere ze seznamu ze
  // serveru — kdyby si ho skládal prohlížeč, dalo by se volat pod cizím
  // číslem. Dialplan to stejně odmítne, ale hlásit to chceme dřív a srozumitelně.
  const DUVODY_HOVORU = useMemo(() => ({
    cz: {
      sipNepripojen:     'Telefonie není připojená. Zkus to za chvíli.',
      chybiDid:          'Tenhle profil nemá přiřazené telefonní číslo, není pod čím volat.',
      chybiCislo:        'U konverzace není číslo klienta.',
      nepouzitelneDid:   'Číslo profilu má divný tvar, volat pod ním nejde.',
      nepouzitelneCislo: 'Číslo klienta má divný tvar, volat na něj nejde.',
      jinyHovor:         'Jeden hovor už běží.',
      chybiCil:          'Nepodařilo se sestavit cíl hovoru.',
      vytaceniSelhalo:   'Vytáčení selhalo.',
    },
    en: {
      sipNepripojen:     'Telephony is not connected. Try again shortly.',
      chybiDid:          'This profile has no phone number assigned, there is nothing to call from.',
      chybiCislo:        'The conversation has no client number.',
      nepouzitelneDid:   'The profile number has an odd format and cannot be used.',
      nepouzitelneCislo: 'The client number has an odd format and cannot be dialled.',
      jinyHovor:         'A call is already in progress.',
      chybiCil:          'Could not compose the call target.',
      vytaceniSelhalo:   'Dialling failed.',
    },
  }), []);

  const startCall = useCallback((profileId, cisloKlienta, popis = {}) => {
    const hlaska = (duvod) => {
      const sada = DUVODY_HOVORU[lang === 'cz' ? 'cz' : 'en'];
      showToast(sada[duvod] || sada.vytaceniSelhalo, 'error');
    };

    const dialer = sipDialerRef.current;
    if (!dialer) { hlaska('sipNepripojen'); return { ok: false, duvod: 'sipNepripojen' }; }

    const did = najdiDidProfilu(nexusData.sipDids, profileId);
    const slozeni = sestavOdchoziCil(did, cisloKlienta);
    if (!slozeni.ok) { hlaska(slozeni.duvod); return slozeni; }

    const vysledek = dialer(slozeni.cil, {
      cislo:        cisloKlienta,
      jmenoKlienta: popis.jmenoKlienta || '',
      jmenoModelky: popis.jmenoModelky || null,
    });
    if (!vysledek?.ok) hlaska(vysledek?.duvod);
    return vysledek || { ok: false, duvod: 'vytaceniSelhalo' };
  }, [DUVODY_HOVORU, lang, showToast, nexusData.sipDids]);

  const value = useMemo(() => ({
    socket,
    t, lang, setLang, activeTab, setActiveTab, activeMarket, setActiveMarket,
    pathname, navigate: navigateStable, authInitialTab, setAuthInitialTab,
    loading: nexusData.isDataLoading, activeOperator, isLoggedIn, token,
    logout, onLogin: handleLogin, onRegisterAgency: auth.handleRegisterAgency, onRegisterUser: auth.handleRegisterUser,
    // Reset hesla byl hotový na serveru i v useAuth, jen ho nikdo nevystavil
    // do kontextu, takže se k němu z přihlašovací obrazovky nedalo dostat.
    onResetRequest: auth.handleResetRequest,
    API_BASE, showLanding, setShowLanding, hasSeenOnboarding, setHasSeenOnboarding, showOnboarding, setShowOnboarding,
    isMobile, isNativeApp, isSidebarOpen, setIsSidebarOpen,
    isSidebarCollapsed, setIsSidebarCollapsed,
    messages, selectedChatId, setSelectedChatId, messageValue, setMessageValue,
    isEditProfileOpen, setIsEditProfileOpen, isAddAgencyOpen, setIsAddAgencyOpen,
    isAddUserOpen, setIsAddUserOpen, isBugReportOpen, setIsBugReportOpen,
    editingProfileData, setEditingProfileData,
    handleEditProfile: (profile) => { setEditingProfileData(profile); setIsEditProfileOpen(true); },
    agencyDetailModalData, setAgencyDetailModalData,
    // Bezpečnostní hlídání u rezervace. Obsluhy jsou v useNexusData, stav
    // odpočtu tady — CalendarView si obojí bere z kontextu.
    activeSafetySession, isTimerActive, timeLeft, formatSafetyTime,
    activeTimerEvent: (nexusData.calendar || []).find(e => e?.id && e.id === activeSafetySession?.bookingId) || null,
    // Překladový panel ve schránce. Obsluha i stav jsou v useNexusData;
    // handleTranslate tu dřív bylo vystavené, ale nikdo ho nedefinoval,
    // takže bylo undefined.
    sourceText: nexusData.sourceText,
    setSourceText: nexusData.setSourceText,
    translatedText: nexusData.translatedText,
    isTranslating: nexusData.isTranslating,
    translateTargetLang: nexusData.translateTargetLang,
    setTranslateTargetLang: nexusData.setTranslateTargetLang,
    fetchAllReferrals: nexusData.fetchAllReferrals,
    handleConfirmReferral: nexusData.handleConfirmReferral,
    isMaintenanceMode: nexusData.isMaintenanceMode,
    setIsMaintenanceMode: nexusData.setIsMaintenanceMode,
    globalAnnouncement: nexusData.globalAnnouncement,
    setGlobalAnnouncement: nexusData.setGlobalAnnouncement,
    publishGlobalAnnouncement: nexusData.publishGlobalAnnouncement,
    handleCheckIn: nexusData.handleCheckIn,
    handleCheckOut: nexusData.handleCheckOut,
    handleSafetyImOk: nexusData.handleSafetyImOk,
    isSafetyLoading: nexusData.isSafetyLoading,
    handleEditBooking: nexusData.handleEditBooking,
    handleDeleteBooking: nexusData.handleDeleteBooking,
    calViewDate, setCalViewDate, showPanicConfirm, setShowPanicConfirm,
    // Kalendář a okno rezervace. useNexusData tohle všechno vrací, jenže
    // kontext si z něj vybírá jednotlivé hodnoty a tyhle se nikdy nevyjmenovaly.
    // CalendarView i GlobalModalContainer si je berou z kontextu, takže
    // dostávaly výchozí hodnoty: příznak false, obsluha prázdná funkce.
    // Kliknutí na „Přidat akci" proto neudělalo vůbec nic — tlačítko šlo
    // zmáčknout a žádné okno se neotevřelo.
    isBookingModalOpen: nexusData.isBookingModalOpen,
    setIsBookingModalOpen: nexusData.setIsBookingModalOpen,
    newBookingForm: nexusData.newBookingForm,
    setNewBookingForm: nexusData.setNewBookingForm,
    handleSaveBooking: nexusData.handleSaveBooking,
    handleExportICS: nexusData.handleExportICS,
    isCalendarSyncOpen: nexusData.isCalendarSyncOpen,
    setIsCalendarSyncOpen: nexusData.setIsCalendarSyncOpen,
    calendarSyncUrl: nexusData.calendarSyncUrl,
    setCalendarSyncUrl: nexusData.setCalendarSyncUrl,
    handleSaveCalendarSync: nexusData.handleSaveCalendarSync,
    setSelectedScheduleEvent: nexusData.setSelectedScheduleEvent,

    // Druhá dávka téhož: useNexusData tyhle hodnoty vrací, kontext si je
    // ale nikdy nevyjmenoval. Komponenty si je berou s výchozími hodnotami,
    // takže se ovládání vykreslilo a nereagovalo. Rozpis v
    // docs/context-contract-audit.md.
    //
    // GlobalFeaturesView — celá obrazovka globálních funkcí a trénování.
    globalFeatures: nexusData.globalFeatures,
    globalSettings: nexusData.globalSettings,
    handleUpdateGlobalSetting: nexusData.handleUpdateGlobalSetting,
    isTraining: nexusData.isTraining,
    trainingProgress: nexusData.trainingProgress,
    onStartTraining: nexusData.onStartTraining,
    onResetTraining: nexusData.onResetTraining,
    // WebProfilesView — přihlašovací údaje, synchronizace, stav relaye.
    handleSaveCredentials: nexusData.handleSaveCredentials,
    handleSyncAll: nexusData.handleSyncAll,
    isSyncing: nexusData.isSyncing,
    syncProgress: nexusData.syncProgress,
    syncStatus: nexusData.syncStatus,
    relayOnline: nexusData.relayOnline,
    // ProfilesView — přiřazování profilů a přepínání stavu operátorky.
    setProfiles: nexusData.setProfiles,
    handleSaveAssignees: nexusData.handleSaveAssignees,
    toggleOperatorStatus: nexusData.toggleOperatorStatus,
    // Zbytek jednotlivě.
    agencySettings: nexusData.agencySettings,
    clientNames: nexusData.clientNames,
    updateClientName: nexusData.updateClientName,
    calendar: nexusData.calendar,

    // Třetí dávka. `stats` je z nich nejdůležitější: v DashboardHome na něm
    // visí všechna čísla (zprávy, hovory, tržby, grafy), takže se dosud
    // zobrazovaly samé nuly. `initData` si berou modály a volají ho po
    // uložení — bez něj se seznam po přidání uživatele neobnovil.
    stats: nexusData.stats,
    // Načítací kostry dashboardu. DashboardHome je přepíná na pěti místech
    // a bez tohohle příznaku se nikdy nezobrazily.
    //
    // Dřív tu stálo, že to zapnout nejde, protože s kostrami mizí panel
    // týmového chatu. Byl to CHYBNÝ ZÁVĚR z jediného běhu: spec
    // salon_keys_and_chat „Odeslání zprávy funguje" byl nestabilní sám
    // o sobě (na nedotčeném masteru padal 3× z 16). Skutečnou příčinou bylo
    // přepisování nepotvrzených zpráv v TeamChatPanel — opraveno v #98.
    isBackgroundLoading: nexusData.isBackgroundLoading,

    // Načítací brána při startu. App.jsx z nich skládá
    //   isSyncing = isLoggedIn && isDataLoading && !hasHydrated
    // a při ní vrací načítací obrazovku místo rozhraní. Dosud byly obě
    // undefined, takže se brána nikdy nezavřela a aplikace se vykreslila
    // okamžitě — i s prázdnými daty, což je přesně to problikávání, kterému
    // měla zabránit. (Kontext je vystavuje i pod jménem `loading`, ale
    // App.jsx si je bere pod těmito.)
    isDataLoading: nexusData.isDataLoading,
    hasHydrated: nexusData.hasHydrated,
    fetchClientByPhone: nexusData.fetchClientByPhone,
    initData: nexusData.initData,

    // Čtvrtá dávka — tady už to nejsou hodnoty z useNexusData.
    //
    // Tyhle tři stavy si kontext drží od začátku pod podtržítkem a nikdy je
    // nevystavil (stejný případ jako _mobileView). Komponenty je čekaly, takže
    // přepínání záložek v postranním panelu schránky a předvyplnění agentury
    // v okně „přidat uživatele" nefungovalo.
    activeContextTab: _activeContextTab, setActiveContextTab: _setActiveContextTab,
    inlinePanelTab: _inlinePanelTab, setInlinePanelTab: _setInlinePanelTab,
    addUserModalAgencyId: _addUserModalAgencyId, setAddUserModalAgencyId: _setAddUserModalAgencyId,

    // Dvě jména, pod kterými si tytéž hodnoty žádají jiné komponenty.
    // App.jsx si myProfiles přejmenovává na assignedProfiles a CalendarView
    // si calendar přejmenovává na bookingSchedule — WebProfilesView a
    // InboxView si je ale berou rovnou pod tím druhým jménem.
    assignedProfiles: myProfiles,
    bookingSchedule: nexusData.calendar,
    chatScrollRef, isUserScrolled, showToast, _toasts, toasts: _toasts, setToasts: _setToasts,
    // Stav se tu držel od začátku (ř. 283), jen se nikdy nevystavil. InboxView
    // si ho bere z kontextu, takže dostával výchozí 'list' a prázdnou funkci:
    // setMobileView('chat') nic neudělalo a podmínka na ř. 534 zůstala nepravdivá.
    // Na telefonu tedy nešlo otevřít konverzaci — seznam se nikdy nepřepnul na
    // detail. Nešlo to poznat, protože schránka byla v testech vždycky prázdná
    // a na žádnou konverzaci se nedalo kliknout.
    mobileView: _mobileView, setMobileView: _setMobileView,
    availableServers, selectedServerId, setSelectedServerId,
    // TV nástěnka do kanceláře. TvDashboard je hotová obrazovka (GPS stream,
    // stav SOS, biometrické varování, baterie, tep, počty relayů) a všechny
    // hodnoty, které potřebuje, kontext vystavuje — chyběl jen přepínač,
    // takže ji nešlo zapnout. ViewRouter ho čte na řádku 27.
    //
    // Odvozeno z adresy, ne z vlastního stavu: na televizi se otevře
    // https://…/tv a zůstane tam. Kdyby to byl přepínač v aplikaci, musel by
    // ho někdo na té televizi po každém restartu naklikat.
    isTvMode: activeTab === 'tv',
    // Odchozí hovory: schránka volá startCall, SipManager si přes
    // registerSipDialer zaregistruje vytáčení. sipDids říká, pod jakým
    // číslem se u kterého profilu smí volat.
    startCall, registerSipDialer, sipDids: nexusData.sipDids,
    isAllowed, activeRole: normalizedRole,
    isAppOwner: activeOperator?.isAppOwner,
    // Zámky nedodělaných funkcí (admin UI v GlobalFeaturesView)
    featureLocks: nexusData.featureLocks,
    handleFeatureLockToggle: nexusData.handleFeatureLockToggle,
    lockableFeatures: nexusData.lockableFeatures,
    activeProfile, activeProfileId, setActiveProfileId, 
    myProfiles, profiles: nexusData.profiles, _profiles: nexusData.profiles,
    operators: nexusData.operators,
    agencies: nexusData.agencies,
    sessions: nexusData.sessions,
    handleRevokeBinding: nexusData.handleRevokeBinding,
    onlineOnly, setOnlineOnly,
    totalUnread: messages.filter(m => m.status === 'unread').length,
    activeSubscription: nexusData.activeSubscription,
    subscriptionHistory: nexusData.subscriptionHistory,
    subscriptionPlans: nexusData.subscriptionPlans,
    fetchPlans: nexusData.fetchPlans,
    updatePlans: nexusData.updatePlans,
    isPlansLoading: nexusData.isPlansLoading,
    isStartingSubscription: nexusData.isStartingSubscription,
    onStartSubscription: nexusData.onStartSubscription,
    onCancelSubscription: nexusData.onCancelSubscription,
    startCheckout: nexusData.startCheckout,
    startBillingPortal: nexusData.startBillingPortal,
    daysLeft,
    // Safety - Voice Guardian & Audio Sentinel
    voiceGuardianActive, handleToggleVoiceGuardian,
    audioSentinelActive, setAudioSentinelActive,
    sosActive: _sosActive, triggerSOS, cancelSOS,
    manualTrackingOn, setManualTracking, phoneTrackingActive,
    linkedSessionId, setLinkedSessionId, checkinMinutes, setCheckinMinutes,
    checkinTimerEnd, checkinRemaining, startCheckinTimer, resetCheckinTimer, confirmDeparture,
    SAFETY_SUGGESTIONS: ['15m', '30m', '45m', '60m', '1.5h', '2h'],
    onDelayBooking: nexusData.handleDelayBooking,
    trackers: nexusData.trackers || [],
    linkedTracker, linkedTrackerId: linkedTracker?.imei || linkedTracker?.id || null,
    lastTrackerUpdate, trackerProvisioning: nexusData.trackerProvisioning,
    isPairingTracker: nexusData.isPairingTracker,
    handlePairTracker: nexusData.handlePairTracker,
    handleUnpairTracker: nexusData.handleUnpairTracker,
    gpsHistory, _gpsHistory: gpsHistory,
    batteryLevel: linkedTracker?.lastBattery ?? 100,
    incomingGhostCall, setIncomingGhostCall, ghostCallScheduledAt, triggerGhostCall, verifyIdentity,
    heartRate, hrThreshold, setHrThreshold, isBluetoothConnected, setIsBluetoothConnected,
    incomingRelayCall, setIncomingRelayCall, lastEmergencyAlert, lastRelayCommand,
    activeBioWarning: false,
    playBeep,
    // Relay mode
    isRelayMode, setIsRelayMode,
    // Chat Logic
    chatMessages, isHistoryLoading, fetchChatMessages, handleSendMessage,
    handleSaveNote, handleDeleteNote, clientNotes, internalNote, setInternalNote,
    // Přebíjí handleTranslate z chatLogic o řádek výš — tam je undefined,
    // protože useChatLogic ho nikdy nedefinoval. Skutečná obsluha je
    // v useNexusData a musí být uvedená POZDĚJI, aby vyhrála.
    handleTranslate: nexusData.handleTranslate,
    filteredMessages, setActiveContactId, selectedChat, typingProfiles, handleRefreshMessages,
    handleSyncChatHistory: nexusData.handleSyncChatHistory
  }), [
    t, lang, setLang, activeTab, setActiveTab, activeMarket, setActiveMarket, pathname, navigateStable, authInitialTab,
    nexusData.isDataLoading, activeOperator, isLoggedIn, token, logout, handleLogin,
    auth.handleRegisterAgency, auth.handleRegisterUser, auth.handleResetRequest, showToast,
    showLanding, hasSeenOnboarding, showOnboarding, isMobile, isNativeApp, isSidebarOpen, isSidebarCollapsed,
    messages, selectedChatId, messageValue, isEditProfileOpen, isAddAgencyOpen,
    isAddUserOpen, isBugReportOpen, agencyDetailModalData, editingProfileData, calViewDate, showPanicConfirm, _toasts,
    availableServers, selectedServerId, setSelectedServerId,
    isAllowed, normalizedRole, activeProfile, activeProfileId, myProfiles, nexusData.profiles,
    nexusData.featureLocks, nexusData.handleFeatureLockToggle, nexusData.lockableFeatures,
    nexusData.operators, nexusData.agencies, nexusData.sessions, nexusData.handleRevokeBinding, onlineOnly,
    nexusData.activeSubscription, nexusData.subscriptionHistory, nexusData.subscriptionPlans, nexusData.fetchPlans,
    nexusData.updatePlans, nexusData.isPlansLoading, nexusData.isStartingSubscription, nexusData.onStartSubscription,
    nexusData.onCancelSubscription, nexusData.startCheckout, nexusData.startBillingPortal, daysLeft,
    voiceGuardianActive, handleToggleVoiceGuardian, audioSentinelActive, _sosActive, triggerSOS, cancelSOS,
    manualTrackingOn, setManualTracking, phoneTrackingActive,
    linkedSessionId, checkinMinutes, checkinTimerEnd, checkinRemaining, startCheckinTimer, resetCheckinTimer, confirmDeparture,
    nexusData.handleDelayBooking, nexusData.trackers, linkedTracker, lastTrackerUpdate, nexusData.trackerProvisioning,
    nexusData.isPairingTracker, nexusData.handlePairTracker, nexusData.handleUnpairTracker, gpsHistory,
    incomingGhostCall, ghostCallScheduledAt, triggerGhostCall, verifyIdentity, heartRate, hrThreshold, isBluetoothConnected,
    incomingRelayCall, lastEmergencyAlert, lastRelayCommand, playBeep,
    isRelayMode,
    // Chat Logic Deps
    chatMessages, isHistoryLoading, fetchChatMessages, handleSendMessage,
    handleSaveNote, handleDeleteNote, clientNotes, internalNote, setInternalNote,
    filteredMessages, setActiveContactId, selectedChat, typingProfiles, handleRefreshMessages,
    nexusData.handleSyncChatHistory,
    socket
  , _mobileView,
    nexusData.isBookingModalOpen, nexusData.setIsBookingModalOpen, nexusData.newBookingForm, nexusData.setNewBookingForm, nexusData.handleSaveBooking, nexusData.handleExportICS, nexusData.isCalendarSyncOpen, nexusData.setIsCalendarSyncOpen, nexusData.calendarSyncUrl, nexusData.setCalendarSyncUrl, nexusData.handleSaveCalendarSync, nexusData.setSelectedScheduleEvent,
    nexusData.agencySettings, nexusData.calendar, nexusData.clientNames, nexusData.globalFeatures, nexusData.globalSettings, nexusData.handleSaveAssignees, nexusData.handleSaveCredentials, nexusData.handleSyncAll, nexusData.handleUpdateGlobalSetting, nexusData.isSyncing, nexusData.isTraining, nexusData.onResetTraining, nexusData.onStartTraining, nexusData.relayOnline, nexusData.setProfiles, nexusData.syncProgress, nexusData.syncStatus, nexusData.toggleOperatorStatus, nexusData.trainingProgress, nexusData.stats, nexusData.fetchClientByPhone, nexusData.initData, _activeContextTab, _setActiveContextTab, _inlinePanelTab, _setInlinePanelTab, _addUserModalAgencyId, _setAddUserModalAgencyId, nexusData.updateClientName, activeSafetySession, isTimerActive, timeLeft, formatSafetyTime, nexusData.handleCheckIn, nexusData.handleCheckOut, nexusData.handleSafetyImOk, nexusData.isSafetyLoading, nexusData.handleEditBooking, nexusData.handleDeleteBooking, nexusData.fetchAllReferrals, nexusData.handleConfirmReferral, nexusData.isMaintenanceMode, nexusData.setIsMaintenanceMode, nexusData.globalAnnouncement, nexusData.setGlobalAnnouncement, nexusData.publishGlobalAnnouncement, nexusData.sourceText, nexusData.setSourceText, nexusData.translatedText, nexusData.isTranslating, nexusData.translateTargetLang, nexusData.setTranslateTargetLang, nexusData.handleTranslate, nexusData.isBackgroundLoading, nexusData.hasHydrated, startCall, registerSipDialer, nexusData.sipDids, chatScrollRef, isUserScrolled]);

  return (
    <NexusContext.Provider value={value}>
      {children}
    </NexusContext.Provider>
  );
};
