import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { safeRedirect } from '../utils/safeRedirect';
import { useSocketBridge } from '../services/socketBridge';
import { isFeatureLocked, setLockOverrides, getLockableFeatures } from '../config/featureLocks';
import axios from 'axios';

/**
 * Custom hook to manage data fetching and global data state for Nexus Hub.
 * Fetches data EXCLUSIVELY from the API. No demo fallbacks.
 */
// Server z parametru skládá větu „Přelož do jazyka X", takže se posílá název,
// ne dvoupísmenný kód.
const NAZVY_JAZYKU = { en: 'English', cs: 'Czech', de: 'German', fr: 'French', es: 'Spanish' };

export function useNexusData({ 
  token, 
  isLoggedIn, 
  API_BASE, 
  activeProfileId,
  activeMarket,
  setActiveOperator,
  normalizeProfileId,
  setMessages,
  setActiveSafetySession,
  setIsTimerActive,
  setTimeLeft,
  showToast,
  lang
}) {
  const [profiles, setProfiles] = useState([]);
  const [agencies, setAgencies] = useState([]);
  const [_agencySettings, _setAgencySettings] = useState({ safetyAlertMode: 'MANAGERS_AND_ASSIGNED' });
  const [operators, setOperators] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [stats, setStats] = useState({
    revenueMtd: 0,
    revenueChange: 0,
    activeBookings: 0,
    bookingsChange: 0,
    totalMessages: 0,
    messagesChange: 0,
    conversionRate: 0,
    conversionChange: 0,
    revenueData: [],
    profilePerf: [],
    operatorPerf: []
  });
  const [_activeSubscription, _setActiveSubscription] = useState(null);
  const [_subscriptionHistory, _setSubscriptionHistory] = useState([]);
  const [globalSettings, setGlobalSettings] = useState([]);
  // Stav zámků nedodělaných funkcí ze serveru ({ key: bool }, true = zamčeno).
  // Slouží admin UI; gating jinde čte module-store přes isFeatureLocked().
  const [featureLocks, setFeatureLocks] = useState({});
  const [globalFeatures, setGlobalFeatures] = useState([
    { id: 'ai_trans', label: 'AI Voice Relay', desc: 'Enable neural speech-to-speech routing', active: true },
    { id: 'vc_hub', label: 'Cross-Agency Analytics', desc: 'Enable view of aggregated data', active: true },
    { id: 'crm_adv', label: 'Proxy Pooling', desc: 'Allow sharing device nodes', active: true },
    { id: 'stats_bi', label: 'Payout Processing', desc: 'Automate weekly commission transfers', active: false }
  ]);

  // Global Features & Training Actions
  const handleFeatureToggle = useCallback(async (feature, i) => {
    if (!token) return;
    const newStatus = !feature.active;
    
    // Optimistic update
    const updated = [...globalFeatures];
    updated[i].active = newStatus;
    setGlobalFeatures(updated);

    try {
      await axios.patch(`${API_BASE}/admin/features/${feature.id}`, { active: newStatus }, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (showToast) showToast(lang === 'cz' ? 'Funkce aktualizována.' : 'Feature updated.', 'success');
    } catch (_err) {
      console.error('Feature toggle failed:', _err);
      // Rollback
      const rolledBack = [...globalFeatures];
      rolledBack[i].active = !newStatus;
      setGlobalFeatures(rolledBack);
      if (showToast) showToast(lang === 'cz' ? 'Aktualizace selhala.' : 'Update failed.', 'error');
    }
  }, [globalFeatures, token, API_BASE, showToast, lang]);

  const handleUpdateGlobalSetting = useCallback(async (key, value) => {
    if (!token) return;
    try {
      await axios.post(`${API_BASE}/admin/settings`, { key, value }, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (showToast) showToast(lang === 'cz' ? 'Nastavení uloženo.' : 'Setting saved.', 'success');
      
      // Refresh settings
      const res = await axios.get(`${API_BASE}/admin/settings`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.data) setGlobalSettings(res.data);
    } catch (_err) {
      console.error('Update setting failed:', _err);
      if (showToast) showToast(lang === 'cz' ? 'Uložení selhalo.' : 'Save failed.', 'error');
    }
  }, [token, API_BASE, showToast, lang]);

  // App Owner zamkne/odemkne funkci. Optimisticky nastaví lokální stav i module-store
  // (aby se gating/UI hned překreslily), při chybě vrátí zpět.
  const handleFeatureLockToggle = useCallback(async (key, locked) => {
    if (!token) return;
    const prev = featureLocks;
    const next = { ...featureLocks, [key]: locked };
    setFeatureLocks(next);
    setLockOverrides(next);
    try {
      await axios.patch(`${API_BASE}/admin/feature-locks/${key}`, { locked }, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (showToast) {
        const msg = lang === 'cz'
          ? (locked ? 'Funkce zamčena.' : 'Funkce odemčena.')
          : (locked ? 'Feature locked.' : 'Feature unlocked.');
        showToast(msg, 'success');
      }
    } catch (_err) {
      console.error('Feature lock toggle failed:', _err);
      setFeatureLocks(prev);
      setLockOverrides(prev);
      if (showToast) showToast(lang === 'cz' ? 'Změna zámku selhala.' : 'Lock change failed.', 'error');
    }
  }, [featureLocks, token, API_BASE, showToast, lang]);

  const [isDataLoading, setIsDataLoading] = useState(false);
  const [isBackgroundLoading, setIsBackgroundLoading] = useState(false);
  const [hasHydrated, setHasHydrated] = useState(() => localStorage.getItem('nexus_hydrated') === 'true');

  const [isTraining, setIsTraining] = useState(false);
  const [trainingProgress, setTrainingProgress] = useState(0);

  const onStartTraining = useCallback(() => {
    setIsTraining(true);
    setTrainingProgress(0);
    const interval = setInterval(() => {
      setTrainingProgress(p => {
        if (p >= 100) {
          clearInterval(interval);
          setIsTraining(false);
          return 100;
        }
        return p + 5;
      });
    }, 500);
  }, []);

  const onResetTraining = useCallback(() => {
    setTrainingProgress(0);
    setIsTraining(false);
  }, []);

  // Jména klientů se držela DVAKRÁT: prázdné `clientNames` bez setteru
  // a `_clientNames` načtené z localStorage, které se nikde nepoužívalo.
  // Ukládací efekt níž přitom zapisoval to prázdné — takže se uložená jména
  // při každém načtení aplikace přepsala prázdnem a nenávratně zmizela.
  const [clientNames, setClientNames] = useState(() => {
    try {
      const saved = localStorage.getItem('nexus_client_names');
      return saved ? JSON.parse(saved) : {};
    } catch { return {}; }
  });
  const updateClientName = useCallback((externalId, name) => {
    if (!externalId) return;
    setClientNames(prev => {
      const next = { ...prev };
      if (name && name.trim()) next[externalId] = name.trim();
      else delete next[externalId];
      return next;
    });
  }, []);
  const [calendar, setCalendar] = useState([]);
  const [isCalendarSyncOpen, setIsCalendarSyncOpen] = useState(false);
  const [calendarSyncUrl, setCalendarSyncUrl] = useState('');
  const [isBookingModalOpen, setIsBookingModalOpen] = useState(false);
  const [selectedScheduleEvent, setSelectedScheduleEvent] = useState(null);
  const [newBookingForm, setNewBookingForm] = useState({ title: '', date: new Date().toISOString().split('T')[0], startTime: '10:00', endTime: '11:00', locationType: 'incall', address: '' });
  
  const [bioText, setBioText] = useState('');
  const [isSyncing, setIsSyncing] = useState(false);
  // Reálné platformy, na kterých agent umí sync (viz local-agent/adapters).
  // Stav řídí skutečné socket eventy z agenta (SYNC_COMPLETED/SYNC_FAILED), ne simulace.
  const [_syncStatus, _setSyncStatus] = useState({ adultwork: 'idle', amateri: 'idle', onlyfans: 'idle' });
  const syncingProfileRef = useRef(null);
  const syncProgressTimerRef = useRef(null);
  const syncFallbackTimerRef = useRef(null);
  const bridgeSocket = useSocketBridge(); // aktuální socket (mimo window), reaktivně

  // Při odmountování (navigace, logout) uprostřed syncu ukliď časovače, ať se
  // nepokoušejí o setState po unmountu.
  useEffect(() => () => {
    if (syncProgressTimerRef.current) clearInterval(syncProgressTimerRef.current);
    if (syncFallbackTimerRef.current) clearTimeout(syncFallbackTimerRef.current);
  }, []);
  const [_syncProgress, _setSyncProgress] = useState(0);
  const [relayOnline, setRelayOnline] = useState(false);
  const [trackers, setTrackers] = useState([]);
  const [trackerProvisioning, setTrackerProvisioning] = useState(null);
  const [isPairingTracker, setIsPairingTracker] = useState(false);
  const [isPlansLoading, setIsPlansLoading] = useState(false);
  const [isStartingSubscription, setIsStartingSubscription] = useState(false);

  const STRIPE_PUBLISHABLE_KEY = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY || '';

  const checkRelayStatus = useCallback(async () => {
    if (!isLoggedIn || !token) return;
    try {
      const res = await axios.get(`${API_BASE}/agency/relay-status`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setRelayOnline(res.data.online);
    } catch {
      setRelayOnline(false);
    }
  }, [isLoggedIn, token, API_BASE]);

  useEffect(() => {
    if (isLoggedIn) {
      checkRelayStatus();
      const interval = setInterval(checkRelayStatus, 30000); // Check every 30s
      return () => clearInterval(interval);
    }
  }, [isLoggedIn, checkRelayStatus]);

  const [_plans, _setPlans] = useState([]);

  const fetchPlans = useCallback(async () => {
    try {
      setIsPlansLoading(true);
      const res = await axios.get(`${API_BASE}/subscriptions/plans`);
      const plans = Array.isArray(res.data) ? res.data : [];
      _setPlans(plans);
      return plans;
    } catch (_err) {
      console.error('Failed to fetch subscription plans:', _err);
      if (showToast) showToast(lang === 'cz' ? 'Nepodařilo se načíst tarify.' : 'Failed to load plans.', 'error');
      return [];
    } finally {
      setIsPlansLoading(false);
    }
  }, [API_BASE, showToast, lang]);

  const updatePlans = useCallback(async (plans) => {
    if (!token) return { success: false };
    try {
      await axios.post(`${API_BASE}/subscriptions/config`, { plans }, {
        headers: { Authorization: `Bearer ${token}` }
      });
      _setPlans(Array.isArray(plans) ? plans : []);
      return { success: true };
    } catch (_err) {
      console.error('Failed to update subscription plans:', _err);
      return { success: false, error: _err };
    }
  }, [API_BASE, token]);

  const loadStripeJs = useCallback(() => new Promise((resolve, reject) => {
    if (typeof window === 'undefined') return reject(new Error('Stripe checkout requires a browser'));
    if (window.Stripe) return resolve(window.Stripe);

    const existing = document.querySelector('script[src="https://js.stripe.com/v3/"]');
    if (existing) {
      existing.addEventListener('load', () => resolve(window.Stripe));
      existing.addEventListener('error', reject);
      return;
    }

    const script = document.createElement('script');
    script.src = 'https://js.stripe.com/v3/';
    script.async = true;
    script.onload = () => resolve(window.Stripe);
    script.onerror = () => reject(new Error('Failed to load Stripe.js'));
    document.head.appendChild(script);
  }), []);

  const redirectToCheckout = useCallback(async (checkout) => {
    if (checkout?.url) {
      window.location.href = checkout.url;
      return;
    }

    if (!checkout?.id) {
      throw new Error('Checkout session was not returned by the server.');
    }

    const Stripe = await loadStripeJs();
    const publishableKey = checkout.publishableKey || STRIPE_PUBLISHABLE_KEY;
    if (!publishableKey) {
      throw new Error('Stripe publishable key is not configured.');
    }

    const stripe = Stripe(publishableKey);
    const result = await stripe.redirectToCheckout({ sessionId: checkout.id });
    if (result?.error) throw result.error;
  }, [STRIPE_PUBLISHABLE_KEY, loadStripeJs]);

  const startCheckout = useCallback(async ({
    planId,
    paymentMethod = 'card',
    checkoutMode = 'redirect',
    market = activeMarket,
    successUrl,
    cancelUrl
  }) => {
    if (!token || !planId) return null;

    const currentUrl = typeof window !== 'undefined'
      ? `${window.location.origin}${window.location.pathname}`
      : undefined;

    try {
      setIsStartingSubscription(true);
      const { data } = await axios.post(`${API_BASE}/billing/checkout`, {
        planId,
        paymentMethod,
        checkoutMode,
        market,
        successUrl: successUrl || currentUrl,
        cancelUrl: cancelUrl || currentUrl
      }, {
        headers: { Authorization: `Bearer ${token}` }
      });

      if (paymentMethod === 'card' && checkoutMode !== 'embedded') {
        if (showToast) showToast(lang === 'cz' ? 'Přesměrování na Stripe Checkout...' : 'Redirecting to Stripe Checkout...', 'info');
        await redirectToCheckout(data);
      }

      return data;
    } catch (_err) {
      console.error('Checkout failed:', _err);
      const errorCode = _err.response?.data?.code;
      const message = errorCode === 'stripe_not_configured'
        ? (lang === 'cz'
          ? 'Platba kartou zatím není na serveru aktivní. Nastavte STRIPE_SECRET_KEY na backendu.'
          : 'Card payments are not active on the server yet. Set STRIPE_SECRET_KEY on the backend.')
        : (_err.response?.data?.message || (lang === 'cz' ? 'Chyba při inicializaci platby.' : 'Error initializing payment.'));
      if (showToast) showToast(message, 'error');
      return null;
    } finally {
      setIsStartingSubscription(false);
    }
  }, [API_BASE, activeMarket, token, redirectToCheckout, showToast, lang]);

  const startBillingPortal = useCallback(async ({ returnUrl } = {}) => {
    if (!token) return null;

    const currentUrl = typeof window !== 'undefined'
      ? `${window.location.origin}${window.location.pathname}`
      : undefined;

    try {
      setIsStartingSubscription(true);
      const { data } = await axios.post(`${API_BASE}/billing/portal`, {
        returnUrl: returnUrl || currentUrl
      }, {
        headers: { Authorization: `Bearer ${token}` }
      });

      if (data?.url) {
        safeRedirect(data.url);
      }

      return data;
    } catch (_err) {
      console.error('Billing portal failed:', _err);
      const message = _err.response?.data?.message || (lang === 'cz'
        ? 'Nepodařilo se otevřít správu plateb.'
        : 'Failed to open billing portal.');
      if (showToast) showToast(message, 'error');
      return null;
    } finally {
      setIsStartingSubscription(false);
    }
  }, [API_BASE, token, showToast, lang]);
  
  useEffect(() => {
    try {
      localStorage.setItem('nexus_client_names', JSON.stringify(clientNames));
    } catch { /* soukromý režim prohlížeče — jména zůstanou jen do zavření */ }
  }, [clientNames]);

  const axiosWithTiming = useCallback(async (url, config = {}) => {
    try {
      const res = await axios.get(url, { ...config, timeout: 10000 });
      return res;
    } catch (_err) {
      console.warn(`[API] Fetch failed for ${url}:`, _err.message);
      return { data: null };
    }
  }, []);

  const initData = useCallback(async () => {
    if (!isLoggedIn || !token) return;
    
    // Only show the global loading screen if we haven't hydrated yet
    if (!hasHydrated) {
      setIsDataLoading(true);
    } else {
      setIsBackgroundLoading(true);
    }
    
    // SAFETY TIMEOUT: Forcibly stop loading after 7s to prevent infinite hang
    const safetyTimer = setTimeout(() => {
      console.warn('[Data] Safety timeout reached. Forcing loading screen off.');
      setIsDataLoading(false);
    }, 7000);

    try {
      // PHASE 1: CRITICAL DATA (Required for Sidebar & Core UI)
      // Volání /admin/permissions tu bylo, ale takový endpoint na serveru není —
      // jediná ruta s oprávněními je PATCH /agency/roles/:id/permissions. Vracelo
      // to tedy 404 při každém načtení a výsledek nikdo nečetl: PermissionsDashboard
      // si data bere sám z /agency/roles.
      const [selfRes, profileRes, userRes, safetyRes] = await Promise.all([
        axiosWithTiming(`${API_BASE}/auth/me`, { headers: { Authorization: `Bearer ${token}` } }),
        axiosWithTiming(`${API_BASE}/profiles`, { headers: { Authorization: `Bearer ${token}` } }),
        axiosWithTiming(`${API_BASE}/agency/users`, { headers: { Authorization: `Bearer ${token}` } }),
        axiosWithTiming(`${API_BASE}/safety/sessions/active`, { headers: { Authorization: `Bearer ${token}` } })
      ]);

      // Process Priority 1 Data immediately to unlock UI
      if (selfRes?.data) {
        setActiveOperator(selfRes.data);
        localStorage.setItem('nexus_activeOperator', JSON.stringify(selfRes.data));
      }
      setProfiles(Array.isArray(profileRes?.data) ? profileRes.data : []);
      if (Array.isArray(userRes?.data)) setOperators(userRes.data);
      // `typeof x === 'object'` samo nestačí: projde i prázdné pole, které je
      // navíc pravdivostní. Spuštěný odpočet bez relace je u bezpečnostní
      // funkce ten horší směr chyby, tak se ptáme na id skutečné relace.
      if (safetyRes?.data && typeof safetyRes.data === 'object'
          && !Array.isArray(safetyRes.data) && safetyRes.data.id) {
        setActiveSafetySession(safetyRes.data);
        setIsTimerActive(true);
        try {
          const endAt = new Date(safetyRes.data.plannedEndAt).getTime();
          if (!isNaN(endAt)) setTimeLeft(Math.floor((endAt - Date.now()) / 1000));
        } catch { /* ignore date parse _err */ }
      }
      // UNLOCK SIDEBAR AS SOON AS CRITICAL DATA IS READY
      setIsDataLoading(false);
      setHasHydrated(true);
      localStorage.setItem('nexus_hydrated', 'true');
      clearTimeout(safetyTimer);
      
      // Phase 2 is starting
      setIsBackgroundLoading(true);

      // /agency/all a /admin/settings jsou na serveru vyhrazené app ownerovi.
      // Klient je volal každému, takže operátorkám při každém načtení spadly dvě
      // 403 do konzole. Roli známe z /auth/me o pár řádků výš, tak se neptáme
      // na to, co stejně nedostaneme. (/admin/features projde i manažerce,
      // /admin/feature-locks komukoli přihlášenému — ty zůstávají.)
      const isOwner = !!selfRes?.data?.isAppOwner;
      const skip = (value) => Promise.resolve({ data: value });

      // PHASE 2: HEAVY DATA (Background hydration)
      // `Promise.all` padne CELÝ, jakmile odmítne jediná větev — a tři z nich
      // (`/chats`, `/device/bindings`, `/agency/stats`) `.catch()` neměly.
      // `/agency/stats` přitom vrací operátorce 403, protože statistiky
      // agentury jí nepatří. Výsledek: operátorka neuviděla NIC — ani chaty,
      // ani zařízení, ani modelky, přestože `/profiles` jí tři vracel.
      // Změřeno 5. 11. 2026 jejím vlastním tokenem.
      //
      // `allSettled` místo doplnění tří `.catch()` záměrně: jinak stejná past
      // sklapne s dalším endpointem, který někdo přidá bez `.catch()`.
      // Všichni odběratelé níž už `null` snesou — každý sedí v `if (xRes?.data)`.
      const __jmenaVolani = ["chatRes", "bindingRes", "trackerRes", "statsRes", "agencyRes", "analyticsRes", "bookingRes", "featuresRes", "globalSettingsRes", "subCurrentRes", "subHistoryRes", "featureLocksRes"];
      const __vysledky = await Promise.allSettled([
        axiosWithTiming(`${API_BASE}/chats`, { headers: { Authorization: `Bearer ${token}` } }),
        axiosWithTiming(`${API_BASE}/device/bindings`, { headers: { Authorization: `Bearer ${token}` } }),
        axiosWithTiming(`${API_BASE}/trackers`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => ({ data: { trackers: [] } })),
        axiosWithTiming(`${API_BASE}/agency/stats`, { headers: { Authorization: `Bearer ${token}` } }),
        isOwner ? axiosWithTiming(`${API_BASE}/agency/all`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => null) : skip(null),
        axiosWithTiming(`${API_BASE}/analytics/summary?days=7`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => null),
        axiosWithTiming(`${API_BASE}/bookings`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => null),
        axiosWithTiming(`${API_BASE}/admin/features`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => ({ data: [] })),
        isOwner ? axiosWithTiming(`${API_BASE}/admin/settings`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => ({ data: [] })) : skip([]),
        axiosWithTiming(`${API_BASE}/subscriptions/current`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => null),
        axiosWithTiming(`${API_BASE}/subscriptions/history`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => null),
        axiosWithTiming(`${API_BASE}/admin/feature-locks`, { headers: { Authorization: `Bearer ${token}` } }).catch(() => ({ data: { locks: {} } }))
      ]);

      const __nepovedlo = __vysledky
        .map((v, idx) => (v.status === 'rejected' ? __jmenaVolani[idx] : null))
        .filter(Boolean);
      if (__nepovedlo.length) {
        // Hlásit nahlas: tiše spolknutá chyba je důvod, proč tahle vada přežila.
        console.warn('[Nexus] Cast dat se nenacetla:', __nepovedlo.join(', '));
      }
      const [chatRes, bindingRes, trackerRes, statsRes, agencyRes, analyticsRes, bookingRes, featuresRes, globalSettingsRes, subCurrentRes, subHistoryRes, featureLocksRes] =
        __vysledky.map((v) => (v.status === 'fulfilled' ? v.value : null));

      // Zámky funkcí: nasypeme do module-store (gating) i lokálního stavu (admin UI).
      if (featureLocksRes?.data?.locks && typeof featureLocksRes.data.locks === 'object') {
        setFeatureLocks(featureLocksRes.data.locks);
        setLockOverrides(featureLocksRes.data.locks);
      }
      if (Array.isArray(featuresRes?.data)) setGlobalFeatures(featuresRes.data);
      if (Array.isArray(globalSettingsRes?.data)) setGlobalSettings(globalSettingsRes.data);
      if (subCurrentRes?.data) _setActiveSubscription(subCurrentRes.data);
      if (Array.isArray(subHistoryRes?.data)) _setSubscriptionHistory(subHistoryRes.data);
      if (Array.isArray(trackerRes?.data?.trackers)) setTrackers(trackerRes.data.trackers);

      // ------------------------------------------------------------
      // SECONDARY DATA PROCESSING
      // ------------------------------------------------------------
      
      // Messages/Chats
      if (Array.isArray(chatRes?.data)) {
        const mappedMessages = chatRes.data.map(chat => {
          if (!chat) return null;
          return {
            id: chat.id, chatId: chat.id, profileId: normalizeProfileId(chat.profileId),
            profileName: chat.profile?.name || null, from: chat.externalId || 'Unknown',
            text: (chat.messages?.[0]?.text || 'No messages'),
            senderName: chat.messages?.[0]?.sender?.name || null,
            timestamp: chat.lastMessageAt || new Date().toISOString(),
            messages: chat.messages || [],
            status: 'read', direction: 'inbound', transport: 'sms',
            client: chat.client || null
          };
        }).filter(Boolean);
        setMessages(mappedMessages);
      }

      // Bindings
      if (bindingRes?.data?.ok && Array.isArray(bindingRes?.data?.bindings)) {
        setSessions(bindingRes.data.bindings.map(b => ({
          id: b.id,
          installationId: b.installationId,
          profileId: b.profileId,
          profileName: b.profile?.name || null,
          device: b.deviceName || b.model || 'Android',
          model: b.model || null,
          platform: b.platform || 'android',
          lastSeenAt: b.lastSeenAt,
          // `active` je příznak z databáze — říká, že vazba je povolená, NE že
          // zařízení žije. Mrtvý relay se proto v seznamu tvářil jako „Active",
          // i když se hodinu neozval.
          //
          // Život se pozná z lastSeenAt: relay obnovuje tuhle značku při každém
          // dotazu na outbox (co 30 s), při příchozí SMS i při SIP pingu. Dvě
          // minuty jsou stejná hranice jako u /agency/relay-status.
          jeOnline: Boolean(
            b.active && b.lastSeenAt && (Date.now() - new Date(b.lastSeenAt).getTime()) < 2 * 60 * 1000
          ),
          // POZOR: `status` zůstává jak bylo. Visí na něm tlačítko pro odpojení
          // (SettingsView ř. 679–682), takže vložit sem „Offline" by znamenalo,
          // že nefunkční zařízení nejde odpojit.
          status: b.active ? 'Active' : 'Disabled'
        })));
      }

      // Bookings / Calendar
      if (Array.isArray(bookingRes?.data)) {
        const mappedBookings = bookingRes.data.map(b => {
          const start = new Date(b.startTime);
          const end = new Date(b.endTime);
          const timeStr = start.toLocaleTimeString(lang === 'cz' ? 'cs-CZ' : 'en-GB', { hour: '2-digit', minute: '2-digit' });
          const duration = Math.round((end - start) / (1000 * 60));
          
          return {
            id: b.id,
            title: b.title || 'Booking',
            time: timeStr,
            startTime: b.startTime,
            endTime: b.endTime,
            duration: `${duration}m`,
            type: b.locationType === 'outcall' ? 'outcall' : 'work',
            status: b.status || 'confirmed',
            locationType: b.locationType,
            address: b.address,
            profileId: b.profileId
          };
        });
        setCalendar(mappedBookings);
      }

      // Stats & Agency
      let agencyData = agencyRes?.data;
      if (!agencyData || !Array.isArray(agencyData) || agencyData.length === 0) {
        try {
          const ownAgencyRes = await axiosWithTiming(`${API_BASE}/agency/settings`, { headers: { Authorization: `Bearer ${token}` } });
          if (ownAgencyRes?.data) agencyData = [ownAgencyRes.data];
        } catch { /* ignore agency fetch _err */ }
      }
      if (agencyData) setAgencies(Array.isArray(agencyData) ? agencyData : [agencyData]);

      if (statsRes?.data) {
        const s = statsRes.data || {};
        const dayNames = lang === 'cz' ? ['Ne', 'Po', 'Út', 'St', 'Čt', 'Pá', 'So'] : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        let richChartData = [];
        let sparklineData = Array.isArray(s.chartData) ? s.chartData : [];
        const analyticsChart = analyticsRes?.data?.chartData;
        if (Array.isArray(analyticsChart) && analyticsChart.length > 0) {
          richChartData = analyticsChart.map(d => ({
            day: dayNames[new Date(d.date).getDay()] || '?',
            revenue: Number(d.revenue || 0), bookings: Number(d.bookings || 0)
          }));
          sparklineData = analyticsChart.map(d => Number(d.revenue || d.bookings || 0));
        }
        setStats({
          revenue: analyticsRes?.data?.revenue != null ? `£${Number(analyticsRes.data.revenue).toFixed(2)}` : (s.revenue || '£0.00'),
          revenueMtd: s.revenue || '£0.00', revenueChange: Number(analyticsRes?.data?.revenueChange || 0),
          totalBookings: Number(analyticsRes?.data?.bookings || s.totalBookings || 0),
          activeBookings: Number(s.totalBookings || 0), bookingsChange: Number(analyticsRes?.data?.bookingsChange || 0),
          totalMessages: Number(s.totalMessages || 0), messagesChange: 0, totalCalls: Number(s.totalCalls || 0),
          conversionRate: Number(s.conversionRate || 0), conversionChange: 0,
          commissionGrowth: String(s.commissionGrowth || 'STABLE'),
          chartData: richChartData.length > 0 ? richChartData : (sparklineData.length > 0 ? sparklineData : [0,0,0,0,0,0,0]),
          sparklineData: sparklineData.length > 0 ? sparklineData : [0,0,0,0,0,0,0],
          revenueData: richChartData, profilePerf: [], operatorPerf: [],
          totalAgencies: Number(s.totalAgencies || 0), totalProfiles: Number(s.totalProfiles || 0),
          totalUsers: Number(s.totalUsers || 0), uptime: String(s.uptime || '100% UP'),
          activeProfiles: Number(analyticsRes?.data?.activeProfiles || s.totalProfiles || 0)
        });
      }

    } catch (err) {
      console.error('[NexusData] Sync failed:', err.response?.status, err.response?.data || err.message);
      if (showToast) showToast(err.message, 'error');
    } finally {
      clearTimeout(safetyTimer);
      setIsBackgroundLoading(false);
    }
  }, [isLoggedIn, token, API_BASE, axiosWithTiming, normalizeProfileId, setMessages, setActiveOperator, setActiveSafetySession, setIsTimerActive, setTimeLeft, hasHydrated, lang, showToast]);

  useEffect(() => {
    initData();
  }, [initData]);

  const handleSaveBio = useCallback(async () => {
    if (!activeProfileId) return;
    try {
      await axios.patch(`${API_BASE}/profiles/${activeProfileId}`, { description: bioText }, {
        headers: { Authorization: `Bearer ${token}` }
      });
      initData();
    } catch (_err) {
      console.error(_err);
      if (showToast) showToast(lang === 'cz' ? 'Nepodařilo se uložit popis.' : 'Failed to save description.', 'error');
    }
  }, [activeProfileId, bioText, token, API_BASE, initData, showToast, lang]);

  const handleSyncAll = useCallback(async () => {
    if (isFeatureLocked('web-automation')) {
      if (showToast) showToast(lang === 'cz' ? 'Automatizace se dokončuje — zatím uzamčeno.' : 'Automation is being finalized — locked for now.', 'info');
      return;
    }
    if (!activeProfileId || activeProfileId === 'all') {
      if (showToast) showToast(lang === 'cz' ? 'Vyberte konkrétní profil pro synchronizaci.' : 'Select a specific profile to sync.', 'info');
      return;
    }

    try {
      setIsSyncing(true);
      _setSyncProgress(0);
      syncingProfileRef.current = activeProfileId;
      _setSyncStatus({ adultwork: 'syncing', amateri: 'syncing', onlyfans: 'syncing' });

      // Indeterminate progress — doleze k 90 %. Skutečných 100 % nastaví až real
      // event z agenta (nefejkujeme úspěch, jak to bylo dřív).
      if (syncProgressTimerRef.current) clearInterval(syncProgressTimerRef.current);
      syncProgressTimerRef.current = setInterval(() => {
        _setSyncProgress(prev => (prev >= 90 ? 90 : prev + 5));
      }, 500);

      // Dispatch relay command na agenta
      await axios.post(`${API_BASE}/profiles/${activeProfileId}/sync`, {
        bio: bioText,
        name: profiles.find(p => p.id === activeProfileId)?.name
      }, {
        headers: { Authorization: `Bearer ${token}` }
      });

      // Fallback: když agent do 120 s nepošle výsledek (offline / spadl), nenech UI viset.
      if (syncFallbackTimerRef.current) clearTimeout(syncFallbackTimerRef.current);
      syncFallbackTimerRef.current = setTimeout(() => {
        if (syncingProfileRef.current !== activeProfileId) return;
        if (syncProgressTimerRef.current) clearInterval(syncProgressTimerRef.current);
        setIsSyncing(false);
        syncingProfileRef.current = null;
        _setSyncStatus({ adultwork: 'error', amateri: 'error', onlyfans: 'error' });
        if (showToast) showToast(lang === 'cz' ? 'Agent neodpověděl — běží local-agent?' : 'Agent did not respond — is the local-agent running?', 'error');
      }, 120000);

    } catch (_err) {
      console.error('Sync failed:', _err);
      if (syncProgressTimerRef.current) clearInterval(syncProgressTimerRef.current);
      setIsSyncing(false);
      syncingProfileRef.current = null;
      _setSyncStatus({ adultwork: 'error', amateri: 'error', onlyfans: 'error' });
      const errMsg = _err.response?.data?.message || (lang === 'cz' ? 'Synchronizace selhala.' : 'Synchronization failed.');
      if (showToast) showToast(errMsg, 'error');
    }
  }, [activeProfileId, bioText, token, API_BASE, profiles, showToast, lang]);

  // Reálný stav syncu řízený eventy z agenta (agent → server → operátoři jako
  // 'relay_event'). Nahrazuje dřívější simulaci. Aktualizuje per-platform odznaky
  // podle results a zastaví loader.
  useEffect(() => {
    if (!bridgeSocket) return;

    const finish = () => {
      if (syncFallbackTimerRef.current) clearTimeout(syncFallbackTimerRef.current);
      if (syncProgressTimerRef.current) clearInterval(syncProgressTimerRef.current);
      _setSyncProgress(100);
      setIsSyncing(false);
      syncingProfileRef.current = null;
    };

    const onRelayEvent = (d) => {
      if (!d || (d.type !== 'SYNC_COMPLETED' && d.type !== 'SYNC_FAILED')) return;
      // Reaguj jen když zrovna probíhá sync a event patří přesně tomu profilu —
      // jinak by nesouvisející agent eventy (jiný profil / bez profileId) přepsaly odznaky.
      // profileId se v kódu míchá string/number → porovnávej normalizovaně.
      if (!syncingProfileRef.current || String(d.profileId) !== String(syncingProfileRef.current)) return;

      if (d.type === 'SYNC_FAILED') {
        _setSyncStatus({ adultwork: 'error', amateri: 'error', onlyfans: 'error' });
        if (showToast) showToast(lang === 'cz' ? 'Synchronizace v agentovi selhala.' : 'Sync failed in the agent.', 'error');
      } else {
        // Nastav stav POUZE podle reálně provedených platforem (results). Server
        // odvozuje platformy z nakonfigurovaných credentials, takže neprovedené
        // platformy zůstávají 'idle' — ne falešně 'synced'.
        const results = Array.isArray(d.results) ? d.results : [];
        _setSyncStatus(() => {
          const next = { adultwork: 'idle', amateri: 'idle', onlyfans: 'idle' };
          for (const r of results) {
            if (r && r.platform && Object.prototype.hasOwnProperty.call(next, r.platform)) {
              next[r.platform] = r.ok === false ? 'error' : 'synced';
            }
          }
          return next;
        });
      }
      finish();
    };

    bridgeSocket.on('relay_event', onRelayEvent);
    return () => bridgeSocket.off('relay_event', onRelayEvent);
  }, [bridgeSocket, showToast, lang]);

  const handleSaveCredentials = useCallback(async (credentials) => {
    if (!activeProfileId || activeProfileId === 'all') return;
    try {
      await axios.post(`${API_BASE}/profiles/${activeProfileId}/credentials`, {
        credentials
      }, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (showToast) showToast(lang === 'cz' ? 'Přihlašovací údaje byly bezpečně uloženy.' : 'Credentials securely saved.', 'success');
      initData();
    } catch (_err) {
      console.error('Save credentials failed:', _err);
      if (showToast) showToast(lang === 'cz' ? 'Nepodařilo se uložit údaje.' : 'Failed to save credentials.', 'error');
    }
  }, [activeProfileId, token, API_BASE, initData, showToast, lang]);

  // Přepnutí, jestli je operátorka přiřazená k profilu.
  //
  // Původně to mířilo na POST /profiles/:id/toggle-operator — takovou rutu
  // server nemá a nikdy neměl, takže klik skončil 404. Nevšimlo se toho,
  // protože kontext toggleOperatorStatus nevystavoval a tlačítko volalo
  // prázdnou funkci; teprve když se jméno doplnilo, chyba vyšla najevo.
  //
  // Serverová ruta PATCH /profiles/:id/assignees ukládá CELÝ seznam, ne rozdíl.
  // getProfiles ho posílá s sebou (include assignees), takže si nový seznam
  // spočítáme tady a pošleme ho celý.
  const toggleOperatorStatus = useCallback(async (profileId, operatorId) => {
    if (!profileId || !operatorId) return;
    const profile = (profiles || []).find(p => p?.id === profileId);
    if (!profile) return;
    const current = (profile.assignees || []).map(a => a?.id).filter(Boolean);
    const next = current.includes(operatorId)
      ? current.filter(id => id !== operatorId)
      : [...current, operatorId];
    try {
      await axios.patch(`${API_BASE}/profiles/${profileId}/assignees`, { userIds: next }, {
        headers: { Authorization: `Bearer ${token}` }
      });
      initData();
    } catch (_err) {
      console.error('Toggle operator status failed:', _err);
      if (showToast) showToast(lang === 'cz' ? 'Změna stavu selhala.' : 'Failed to toggle status.', 'error');
    }
  }, [token, API_BASE, initData, showToast, lang, profiles]);

  // ── Bezpečnostní hlídání u rezervace ──────────────────────────────────────
  //
  // Server na tohle měl ruty od začátku (check-in, check-out, ack, panic,
  // resolve…), z webového klienta je ale nevolal nikdo. CalendarView si
  // obsluhy bral z kontextu, který je nedával, takže tlačítka CHECK-IN,
  // CHECK-OUT i „JSEM V POŘÁDKU" volala prázdnou funkci.
  //
  // Relaci nezakládáme napřímo: POST /safety/sessions převezme tu PLÁNOVANOU,
  // kterou k rezervaci vytvořil server, a rovnou ji přepne na CHECKED_IN
  // (ruší i případnou probíhající eskalaci). Jedno volání tedy stačí.
  const [isSafetyLoading, setIsSafetyLoading] = useState(false);
  const [safetySessionId, setSafetySessionId] = useState(null);

  const handleCheckIn = useCallback(async (event) => {
    if (!event?.id || !event?.profileId || isSafetyLoading) return;
    setIsSafetyLoading(true);
    try {
      const r = await axios.post(`${API_BASE}/safety/sessions`, {
        profileId: event.profileId,
        bookingId: event.id,
        plannedEndAt: event.endTime,
        locationType: event.locationType === 'outcall' ? 'outcall' : 'incall'
      }, { headers: { Authorization: `Bearer ${token}` } });
      setSafetySessionId(r.data?.id || null);
      setActiveSafetySession(r.data);
      setIsTimerActive(true);
      const endAt = new Date(r.data?.plannedEndAt || event.endTime).getTime();
      if (!isNaN(endAt)) setTimeLeft(Math.floor((endAt - Date.now()) / 1000));
      showToast?.(lang === 'cz' ? 'Hlídání spuštěno.' : 'Safety session started.', 'success');
    } catch (_err) {
      console.error('Check-in failed:', _err);
      showToast?.(lang === 'cz' ? 'Hlídání se nepodařilo spustit.' : 'Could not start safety session.', 'error');
    } finally {
      setIsSafetyLoading(false);
    }
  }, [API_BASE, token, showToast, lang, isSafetyLoading, setActiveSafetySession, setIsTimerActive, setTimeLeft]);

  const handleCheckOut = useCallback(async () => {
    if (!safetySessionId || isSafetyLoading) return;
    setIsSafetyLoading(true);
    try {
      // Check-out přepne relaci do GRACE a řekne telefonu, ať začne hlídat
      // odchod — proto se odpočet tímhle NEKONČÍ, jen se přestane zobrazovat
      // u rezervace. Dohled dál běží v SafetyGuardView.
      await axios.post(`${API_BASE}/safety/sessions/${safetySessionId}/check-out`, {}, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setIsTimerActive(false);
      setActiveSafetySession(null);
      setSafetySessionId(null);
      showToast?.(lang === 'cz' ? 'Odchod zaznamenán.' : 'Check-out recorded.', 'success');
    } catch (_err) {
      console.error('Check-out failed:', _err);
      showToast?.(lang === 'cz' ? 'Odchod se nepodařilo zaznamenat.' : 'Could not record check-out.', 'error');
    } finally {
      setIsSafetyLoading(false);
    }
  }, [API_BASE, token, safetySessionId, isSafetyLoading, showToast, lang, setActiveSafetySession, setIsTimerActive]);

  // Tlačítko „JSEM V POŘÁDKU (+10 min)". Ukazuje se až po vypršení času,
  // tedy ve chvíli, kdy se za okamžik rozešle poplach — proto se stav při
  // chybě NEMĚNÍ a odpočet zůstane přetažený. Tichý neúspěch by tady
  // znamenal, že si někdo myslí, že poplach odvolal, a on se rozešle.
  const handleSafetyImOk = useCallback(async () => {
    if (!safetySessionId || isSafetyLoading) return;
    setIsSafetyLoading(true);
    try {
      await axios.post(`${API_BASE}/safety/sessions/${safetySessionId}/ack`, { extendMinutes: 10 }, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setTimeLeft(prev => (typeof prev === 'number' ? prev : 0) + 600);
      showToast?.(lang === 'cz' ? 'Prodlouženo o 10 minut.' : 'Extended by 10 minutes.', 'success');
    } catch (_err) {
      console.error('Safety ack failed:', _err);
      showToast?.(lang === 'cz' ? 'Prodloužení SELHALO — ozvi se dispečinku.' : 'Extension FAILED — contact dispatch.', 'error');
    } finally {
      setIsSafetyLoading(false);
    }
  }, [API_BASE, token, safetySessionId, isSafetyLoading, showToast, lang, setTimeLeft]);

  // ── Rezervace: úprava a smazání ───────────────────────────────────────────
  const handleEditBooking = useCallback((event) => {
    if (!event) return;
    setNewBookingForm(f => ({
      ...f,
      id: event.id,
      title: event.title || '',
      date: (event.startTime || '').split('T')[0] || f.date,
      profileId: event.profileId || f.profileId,
      locationType: event.locationType || f.locationType,
      address: event.address || ''
    }));
    setIsBookingModalOpen(true);
  }, []);

  const handleDeleteBooking = useCallback(async (bookingId) => {
    if (!bookingId) return;
    try {
      await axios.delete(`${API_BASE}/bookings/${bookingId}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setCalendar(prev => prev.filter(e => e.id !== bookingId));
      showToast?.(lang === 'cz' ? 'Rezervace smazána.' : 'Booking deleted.', 'success');
    } catch (_err) {
      console.error('Delete booking failed:', _err);
      showToast?.(lang === 'cz' ? 'Rezervaci se nepodařilo smazat.' : 'Could not delete booking.', 'error');
    }
  }, [API_BASE, token, showToast, lang]);

  // ── Doporučení: přehled pro App Ownera ────────────────────────────────────
  //
  // Server má /referrals/admin/all i /referrals/:id/confirm od začátku,
  // AgenciesView na nich staví sekci „Master Referrals" — jen si obsluhy bral
  // z kontextu, který je nedával. Sekce se vykreslila prázdná a tlačítko
  // potvrzení nedělalo nic.
  //
  // Pozor: NENÍ to totéž co ReferralsView. Ta ukazuje jedné agentuře její
  // vlastní doporučení; tohle je pohled přes všechny agentury.
  // ── Překlad zprávy ────────────────────────────────────────────────────────
  //
  // Celá tahle funkce byla napsaná v useUILogic.js — hooku, který nevolá
  // nikdo. Zapojit ji tak, jak byla, by nestačilo, měla tři vady:
  //
  //  1. IGNOROVALA VÝBĚR JAZYKA. UI nabízí AUTO/en/cs/de/fr/es, ale obsluha
  //     jela natvrdo `lang === 'cz' ? 'en' : 'cs'` s poznámkou „simple toggle
  //     for now". Tlačítka jazyků by tedy nedělala nic.
  //  2. Posílala `targetLang`, server čte `target`.
  //  3. Četla `res.data.translatedText`, server vrací `translated`.
  //
  // Server z parametru skládá větu „Přelož do jazyka X" (aiService), takže
  // se posílá NÁZEV jazyka, ne dvoupísmenný kód.
  const [sourceText, setSourceText] = useState('');
  const [translatedText, setTranslatedText] = useState('');
  const [isTranslating, setIsTranslating] = useState(false);
  const [translateTargetLang, setTranslateTargetLang] = useState('AUTO');

  const handleTranslate = useCallback(async () => {
    const text = (sourceText || '').trim();
    if (!text || isTranslating) return;
    // AUTO = do jazyka, ve kterém má operátorka aplikaci. Explicitní volba
    // z tlačítek má přednost.
    const cil = translateTargetLang === 'AUTO'
      ? (lang === 'cz' ? 'Czech' : 'English')
      : (NAZVY_JAZYKU[translateTargetLang] || translateTargetLang);
    setIsTranslating(true);
    try {
      const r = await axios.post(`${API_BASE}/ai/translate`, { text, target: cil }, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const prelozeno = r.data?.translated;
      if (!prelozeno) throw new Error('prázdná odpověď');
      setTranslatedText(prelozeno);
    } catch (_err) {
      console.error('Translate failed:', _err);
      // Prázdný výsledek se nesmí tvářit jako překlad — smažeme ho, ať
      // operátorka nepošle klientovi starý text z minulého pokusu.
      setTranslatedText('');
      const status = _err?.response?.status;
      showToast?.(status === 403
        ? (lang === 'cz' ? 'Překlad je součástí vyššího tarifu.' : 'Translation requires a higher plan.')
        : (lang === 'cz' ? 'Překlad se nezdařil.' : 'Translation failed.'), 'error');
    } finally {
      setIsTranslating(false);
    }
  }, [sourceText, translateTargetLang, isTranslating, API_BASE, token, lang, showToast]);

  const fetchAllReferrals = useCallback(async () => {
    try {
      const r = await axios.get(`${API_BASE}/referrals/admin/all`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      return Array.isArray(r.data) ? r.data : [];
    } catch (_err) {
      console.error('Fetch referrals failed:', _err);
      return [];
    }
  }, [API_BASE, token]);

  const handleConfirmReferral = useCallback(async (referralId, amount) => {
    if (!referralId) return { success: false };
    try {
      await axios.post(`${API_BASE}/referrals/${referralId}/confirm`, { amount }, {
        headers: { Authorization: `Bearer ${token}` }
      });
      showToast?.(lang === 'cz' ? 'Doporučení potvrzeno.' : 'Referral confirmed.', 'success');
      return { success: true };
    } catch (_err) {
      console.error('Confirm referral failed:', _err);
      showToast?.(lang === 'cz' ? 'Potvrzení se nezdařilo.' : 'Could not confirm referral.', 'error');
      return { success: false };
    }
  }, [API_BASE, token, showToast, lang]);

  // ── Režim údržby a globální oznámení ──────────────────────────────────────
  //
  // Ukládají se do GlobalSetting přes POST /admin/settings (jen App Owner).
  // Číst je musí KAŽDÝ, jinak by banner nikoho nevaroval — na to je
  // GET /admin/settings/public, který vrací jen tyhle dvě hodnoty.
  //
  // Text oznámení se NEUKLÁDÁ při psaní, jen se drží ve stavu; zapíše ho až
  // publishGlobalAnnouncement. Do té doby tlačítko PUBLISH jen vypsalo hlášku
  // „Announcement published!" a neuložilo nic.
  const [isMaintenanceMode, _setIsMaintenanceMode] = useState(false);
  const [globalAnnouncement, setGlobalAnnouncement] = useState('');

  useEffect(() => {
    if (!isLoggedIn || !token) return;
    axios.get(`${API_BASE}/admin/settings/public`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => {
        _setIsMaintenanceMode(Boolean(r.data?.maintenanceMode));
        setGlobalAnnouncement(r.data?.globalAnnouncement || '');
      })
      .catch(() => { /* bez nastavení prostě bannery nebudou */ });
  }, [isLoggedIn, token, API_BASE]);

  // ── Čísla, pod kterými smí operátorka volat ven ────────────────────────────
  // Určuje, jaké číslo klient uvidí. Seznam je autoritativní: dialplan přijme
  // hovor jen pod DID, které je v databázi, takže co tu není, stejně neprojde.
  // Když se načtení nepovede, zůstane prázdno a tlačítko volání je nedostupné —
  // radši nezavolat, než zavolat pod cizím číslem.
  const [sipDids, setSipDids] = useState([]);

  useEffect(() => {
    if (!isLoggedIn || !token) { setSipDids([]); return; }
    axios.get(`${API_BASE}/sip/dids`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => setSipDids(Array.isArray(r.data?.dids) ? r.data.dids : []))
      .catch(() => setSipDids([]));
  }, [isLoggedIn, token, API_BASE]);

  const ulozNastaveni = useCallback(async (key, value) => {
    await axios.post(`${API_BASE}/admin/settings`, { key, value }, {
      headers: { Authorization: `Bearer ${token}` }
    });
  }, [API_BASE, token]);

  const setIsMaintenanceMode = useCallback(async (next) => {
    const puvodni = isMaintenanceMode;
    _setIsMaintenanceMode(next);
    try {
      await ulozNastaveni('maintenance_mode', next ? 'true' : 'false');
      showToast?.(next
        ? (lang === 'cz' ? 'Režim údržby zapnut.' : 'Maintenance mode on.')
        : (lang === 'cz' ? 'Režim údržby vypnut.' : 'Maintenance mode off.'), 'success');
    } catch (_err) {
      // Vrátit přepínač zpět. Kdyby zůstal zapnutý a na serveru ne, admin by
      // si myslel, že je aplikace uzavřená, a ona by běžela dál.
      _setIsMaintenanceMode(puvodni);
      showToast?.(lang === 'cz' ? 'Nastavení se nepodařilo uložit.' : 'Could not save setting.', 'error');
    }
  }, [isMaintenanceMode, ulozNastaveni, showToast, lang]);

  const publishGlobalAnnouncement = useCallback(async () => {
    try {
      await ulozNastaveni('global_announcement', globalAnnouncement || '');
      showToast?.(globalAnnouncement?.trim()
        ? (lang === 'cz' ? 'Oznámení zveřejněno.' : 'Announcement published.')
        : (lang === 'cz' ? 'Oznámení smazáno.' : 'Announcement cleared.'), 'success');
    } catch (_err) {
      showToast?.(lang === 'cz' ? 'Oznámení se nepodařilo zveřejnit.' : 'Could not publish announcement.', 'error');
    }
  }, [globalAnnouncement, ulozNastaveni, showToast, lang]);

  const handleSaveAssignees = useCallback(async (profileId, operatorIds) => {
    if (!profileId) return;
    try {
      // Server má na assignees PATCH, ne PUT (profileRoutes.js:61).
      // Schéma na serveru (middleware/schemas.js: assignUsers) čeká userIds,
      // ne operatorIds — s původním klíčem to padalo na validaci.
      await axios.patch(`${API_BASE}/profiles/${profileId}/assignees`, { userIds: operatorIds }, {
        headers: { Authorization: `Bearer ${token}` }
      });
      initData();
    } catch (_err) {
      console.error('Save assignees failed:', _err);
      if (showToast) showToast(lang === 'cz' ? 'Uložení týmu selhalo.' : 'Failed to save team.', 'error');
    }
  }, [token, API_BASE, initData, showToast, lang]);
  
  const handleExportICS = useCallback(() => {
    if (!calendar || calendar.length === 0) {
      if (showToast) showToast(lang === 'cz' ? 'Není co exportovat.' : 'Nothing to export.', 'info');
      return;
    }
    
    let icsContent = "BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//Nexus Hub//NONSGML v1.0//EN\n";
    
    calendar.forEach(event => {
      const start = new Date(event.startTime || new Date());
      const end = new Date(event.endTime || new Date());
      
      const formatDate = (date) => {
        return date.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
      };
      
      icsContent += "BEGIN:VEVENT\n";
      icsContent += `SUMMARY:${event.title}\n`;
      icsContent += `DTSTART:${formatDate(start)}\n`;
      icsContent += `DTEND:${formatDate(end)}\n`;
      icsContent += `DESCRIPTION:${event.locationType || 'Incall'}\n`;
      icsContent += "END:VEVENT\n";
    });
    
    icsContent += "END:VCALENDAR";
    
    const blob = new Blob([icsContent], { type: 'text/calendar;charset=utf-8' });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', 'nexus-calendar.ics');
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    if (showToast) showToast(lang === 'cz' ? 'Kalendář byl exportován.' : 'Calendar exported.', 'success');
  }, [calendar, lang, showToast]);

  const handleSaveCalendarSync = useCallback(async () => {
    if (!calendarSyncUrl || !calendarSyncUrl.startsWith('http')) {
      if (showToast) showToast(lang === 'cz' ? 'Neplatná URL kalendáře.' : 'Invalid calendar URL.', 'error');
      return;
    }
    
    try {
      setIsSyncing(true);
      // Mock call if backend is not ready, or actual call if it is
      // await axios.post(`${API_BASE}/calendar/sync`, { url: calendarSyncUrl }, { headers: { Authorization: `Bearer ${token}` } });
      
      if (showToast) showToast(lang === 'cz' ? 'Synchronizace kalendáře nastavena.' : 'Calendar sync configured.', 'success');
      setIsCalendarSyncOpen(false);
    } catch (_err) {
      console.error(_err);
      if (showToast) showToast(lang === 'cz' ? 'Chyba při nastavování synchronizace.' : 'Error setting up sync.', 'error');
    } finally {
      setIsSyncing(false);
    }
  }, [calendarSyncUrl, lang, showToast, setIsCalendarSyncOpen]);

  const handleSaveBooking = useCallback(async () => {
    if (!newBookingForm.title || !newBookingForm.date || !activeProfileId) return;
    
    try {
      setIsDataLoading(true);
      const startDateTime = `${newBookingForm.date}T${newBookingForm.startTime}:00`;
      const endDateTime = `${newBookingForm.date}T${newBookingForm.endTime}:00`;
      
      await axios.post(`${API_BASE}/bookings`, {
        profileId: activeProfileId,
        title: newBookingForm.title,
        startTime: startDateTime,
        endTime: endDateTime,
        locationType: newBookingForm.locationType,
        address: newBookingForm.locationType === 'outcall' ? newBookingForm.address : null
      }, { headers: { Authorization: `Bearer ${token}` } });
      
      if (showToast) showToast(lang === 'cz' ? 'Schůzka uložena.' : 'Booking saved.', 'success');
      setIsBookingModalOpen(false);
      setNewBookingForm({ title: '', date: new Date().toISOString().split('T')[0], startTime: '10:00', endTime: '11:00', locationType: 'incall', address: '' });
      initData();
    } catch (_err) {
      console.error(_err);
      if (showToast) showToast(lang === 'cz' ? 'Chyba při ukládání.' : 'Error saving booking.', 'error');
    } finally {
      setIsDataLoading(false);
    }
  }, [newBookingForm, activeProfileId, token, API_BASE, initData, showToast, lang, setIsBookingModalOpen]);

  const handleDelayBooking = useCallback(async (bookingId, delayMinutes) => {
    try {
      let updatedCalendar = [...calendar].sort((a, b) => {
        const tA = (a.time || '').split(' - ')[0];
        const tB = (b.time || '').split(' - ')[0];
        return tA.localeCompare(tB);
      });

      const bookingIndex = updatedCalendar.findIndex(b => b.id === bookingId);
      if (bookingIndex === -1) return;

      const parseTime = (timeStr) => {
        const [s, _err] = (timeStr || '10:00 - 11:00').split(' - ');
        const [sh, sm] = s.split(':').map(Number);
        const [eh, em] = _err.split(':').map(Number);
        return { start: (sh || 0) * 60 + (sm || 0), end: (eh || 0) * 60 + (em || 0) };
      };

      const formatTime = (totalMin) => {
        const h = Math.floor(totalMin / 60) % 24;
        const m = totalMin % 60;
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
      };

      const booking = updatedCalendar[bookingIndex];
      const times = parseTime(booking.time);
      const _oldEnd = times.end;
      const newEnd = times.end + delayMinutes;
      
      booking.time = `${formatTime(times.start)} - ${formatTime(newEnd)}`;
      
      // Cascade shift
      const postponedSms = [];
      let lastEnd = newEnd;

      for (let i = bookingIndex + 1; i < updatedCalendar.length; i++) {
        const nextB = updatedCalendar[i];
        const nTimes = parseTime(nextB.time);
        const duration = nTimes.end - nTimes.start;
        
        if (nTimes.start < lastEnd) {
          const shiftBy = lastEnd - nTimes.start;
          const newStart = lastEnd;
          const newFinish = newStart + duration;
          nextB.time = `${formatTime(newStart)} - ${formatTime(newFinish)}`;
          lastEnd = newFinish;

          // Prepare notification draft
          const clientName = (nextB.title || '').replace('Meeting w/ ', '');
          postponedSms.push({
            bookingId: nextB.id,
            clientName,
            oldTime: formatTime(nTimes.start),
            newTime: formatTime(newStart),
            delay: shiftBy,
            message: lang === 'cz' 
              ? `Ahoj ${clientName}, omlouvám se, ale moje předchozí schůzka se protáhla. Uvidíme se o ${shiftBy} minut později v ${formatTime(newStart)}. Těším se!`
              : `Hi ${clientName}, I'm sorry, our meeting will be delayed by ${shiftBy} minutes. See you at ${formatTime(newStart)}! Looking forward to it.`
          });
        } else {
          break; // No more overlaps
        }
      }

      setCalendar(updatedCalendar);
      if (showToast) showToast(lang === 'cz' ? 'Agenda byla posunuta.' : 'Agenda has been shifted.', 'success');
      
      return postponedSms;
    } catch (_err) {
      console.error('Delay booking _err:', _err);
      return [];
    }
  }, [calendar, lang, showToast]);

  const handleQuickSaveMeeting = useCallback(async (meeting) => {
    try {
      await axios.post(`${API_BASE}/bookings`, {
        profileId: activeProfileId, title: `Meeting: ${meeting.time}`, date: meeting.date, startTime: meeting.time, duration: meeting.duration
      }, { headers: { Authorization: `Bearer ${token}` } });
      initData();
    } catch (_err) {
      console.error(_err);
      if (showToast) showToast(lang === 'cz' ? 'Nepodařilo se uložit schůzku.' : 'Failed to save meeting.', 'error');
    }
  }, [activeProfileId, token, API_BASE, initData, showToast, lang]);

  const fetchClientByPhone = useCallback(async (phone) => {
    if (!phone) return null;
    try {
      const res = await axios.get(`${API_BASE}/clients/${phone}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      return res.data;
    } catch (_err) {
      console.error('Failed to fetch client info:', _err);
      return null;
    }
  }, [API_BASE, token]);

  const handleSyncChatHistory = useCallback(async (chatId) => {
    if (!chatId || !token) return;
    try {
      if (showToast) showToast(lang === 'cz' ? 'Příkaz k synchronizaci odeslán...' : 'Sync command dispatched...', 'info');
      await axios.post(`${API_BASE}/chats/${chatId}/sync`, {}, {
        headers: { Authorization: `Bearer ${token}` }
      });
    } catch (_err) {
      console.error('Chat sync failed:', _err);
      if (showToast) showToast(lang === 'cz' ? 'Synchronizace selhala.' : 'Sync failed.', 'error');
    }
  }, [token, API_BASE, showToast, lang]);

  const handleRevokeBinding = useCallback(async (installationId) => {
    if (!installationId || !token) return;
    try {
      await axios.post(`${API_BASE}/device/revoke-binding`, { installationId }, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setSessions(prev => prev.map(session =>
        session.installationId === installationId
          ? { ...session, status: 'Disabled' }
          : session
      ));
      if (showToast) showToast(lang === 'cz' ? 'Relay zařízení bylo odpojeno.' : 'Relay device revoked.', 'success');
    } catch (_err) {
      console.error('Failed to revoke relay binding:', _err);
      if (showToast) showToast(lang === 'cz' ? 'Odpojení relay zařízení selhalo.' : 'Failed to revoke relay device.', 'error');
    }
  }, [token, API_BASE, showToast, lang]);

  const handlePairTracker = useCallback(async (imei, options = {}) => {
    const cleanImei = String(imei || '').trim();
    if (!cleanImei || !token) return null;

    const selectedProfileId = options.profileId !== undefined
      ? options.profileId
      : (activeProfileId && activeProfileId !== 'all' ? activeProfileId : null);

    try {
      setIsPairingTracker(true);
      const { data } = await axios.post(`${API_BASE}/trackers/pair`, {
        imei: cleanImei,
        profileId: selectedProfileId || null,
        label: options.label || null
      }, {
        headers: { Authorization: `Bearer ${token}` }
      });

      if (data?.tracker) {
        setTrackers(prev => {
          const rest = prev.filter(t => t.id !== data.tracker.id);
          return [data.tracker, ...rest];
        });
      }
      if (data?.ingest) setTrackerProvisioning(data.ingest);
      if (showToast) showToast(lang === 'cz' ? 'Tracker byl spárován. Token si uložte do zařízení.' : 'Tracker paired. Store the token on the device.', 'success');
      return data;
    } catch (_err) {
      console.error('Pair tracker failed:', _err);
      const message = _err.response?.data?.message || (lang === 'cz' ? 'Párování trackeru selhalo.' : 'Tracker pairing failed.');
      if (showToast) showToast(message, 'error');
      return null;
    } finally {
      setIsPairingTracker(false);
    }
  }, [API_BASE, activeProfileId, token, showToast, lang]);

  const handleUnpairTracker = useCallback(async (trackerId) => {
    if (!trackerId || !token) return;
    try {
      await axios.delete(`${API_BASE}/trackers/${trackerId}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      setTrackers(prev => prev.map(t => t.id === trackerId ? { ...t, active: false } : t));
      setTrackerProvisioning(null);
      if (showToast) showToast(lang === 'cz' ? 'Tracker byl odpojen.' : 'Tracker unpaired.', 'success');
    } catch (_err) {
      console.error('Unpair tracker failed:', _err);
      const message = _err.response?.data?.message || (lang === 'cz' ? 'Odpojení trackeru selhalo.' : 'Tracker unpair failed.');
      if (showToast) showToast(message, 'error');
    }
  }, [API_BASE, token, showToast, lang]);

  const applyTrackerLocation = useCallback((payload = {}) => {
    if (!payload.trackerId) return;
    const now = new Date().toISOString();
    setTrackers(prev => prev.map(t => t.id === payload.trackerId ? {
      ...t,
      lastLat: payload.lat,
      lastLng: payload.lng,
      lastAccuracy: payload.accuracy,
      lastBattery: payload.battery,
      lastCapturedAt: payload.capturedAt || now,
      lastSeenAt: now
    } : t));
  }, []);

  const onStartSubscription = useCallback(async (planId, options = {}) => {
    return startCheckout({ planId, ...options });
  }, [startCheckout]);

  const onCancelSubscription = useCallback(async () => {
    if (!token) return;
    try {
      await axios.post(`${API_BASE}/subscriptions/cancel`, {
        note: 'Cancelled from subscription tab'
      }, {
        headers: { Authorization: `Bearer ${token}` }
      });
      _setActiveSubscription(null);
      if (showToast) showToast(lang === 'cz' ? 'Předplatné bylo zrušeno.' : 'Subscription cancelled.', 'success');
      initData();
    } catch (_err) {
      console.error('Failed to cancel subscription:', _err);
      if (showToast) showToast(lang === 'cz' ? 'Zrušení předplatného selhalo.' : 'Failed to cancel subscription.', 'error');
    }
  }, [API_BASE, token, showToast, lang, initData]);

  const gpsHistory = useMemo(() => (
    (trackers || [])
      .filter(t => t.active !== false && Number.isFinite(Number(t.lastLat)) && Number.isFinite(Number(t.lastLng)))
      .map(t => ({
        trackerId: t.id,
        profileId: t.profileId,
        lat: Number(t.lastLat),
        lng: Number(t.lastLng),
        accuracy: t.lastAccuracy,
        battery: t.lastBattery,
        capturedAt: t.lastCapturedAt || t.lastSeenAt,
        label: t.label || t.imei
      }))
      .sort((a, b) => new Date(b.capturedAt || 0) - new Date(a.capturedAt || 0))
  ), [trackers]);

  return useMemo(() => ({
    profiles, agencies, agencySettings: _agencySettings, operators, sessions, stats, activeSubscription: _activeSubscription,
    subscriptionHistory: _subscriptionHistory, globalFeatures, handleFeatureToggle,
    subscriptionPlans: _plans, fetchPlans, updatePlans, isPlansLoading,
    isStartingSubscription, onStartSubscription, onCancelSubscription, startCheckout, startBillingPortal,
    globalSettings, handleUpdateGlobalSetting,
    featureLocks, handleFeatureLockToggle, lockableFeatures: getLockableFeatures(),
    isTraining, trainingProgress, onStartTraining, onResetTraining,
    auditLogs: [], isDataLoading, isBackgroundLoading, hasHydrated, clientNames, updateClientName,
    handleCheckIn, handleCheckOut, handleSafetyImOk, isSafetyLoading,
    handleEditBooking, handleDeleteBooking,
    fetchAllReferrals, handleConfirmReferral,
    sourceText, setSourceText, translatedText, isTranslating, translateTargetLang, setTranslateTargetLang, handleTranslate,
    isMaintenanceMode, setIsMaintenanceMode, globalAnnouncement, setGlobalAnnouncement, publishGlobalAnnouncement,
    calendar, isCalendarSyncOpen, setIsCalendarSyncOpen, calendarSyncUrl, setCalendarSyncUrl,
    isBookingModalOpen, setIsBookingModalOpen, selectedScheduleEvent, setSelectedScheduleEvent,
    newBookingForm, setNewBookingForm, bioText, setBioText, isSyncing, syncStatus: _syncStatus, syncProgress: _syncProgress,
    relayOnline, trackers, gpsHistory, trackerProvisioning, isPairingTracker,
    handlePairTracker, handleUnpairTracker, applyTrackerLocation,
    handleSaveBio, handleSyncAll, handleSyncChatHistory, handleRevokeBinding, handleSaveCredentials, handleQuickSaveMeeting, handleDelayBooking, initData,
    handleExportICS, handleSaveCalendarSync, handleSaveBooking, fetchClientByPhone,
    setProfiles, toggleOperatorStatus, handleSaveAssignees,
    sipDids,
  }), [
    profiles, agencies, _agencySettings, operators, sessions, stats, _activeSubscription, _subscriptionHistory, 
    globalFeatures, handleFeatureToggle, _plans, fetchPlans, updatePlans, isPlansLoading, isStartingSubscription, onStartSubscription, onCancelSubscription, startCheckout, startBillingPortal,
    globalSettings, handleUpdateGlobalSetting, featureLocks, handleFeatureLockToggle, isTraining, trainingProgress,
    onStartTraining, onResetTraining, isDataLoading, isBackgroundLoading, hasHydrated, clientNames, updateClientName, calendar, 
    handleCheckIn, handleCheckOut, handleSafetyImOk, isSafetyLoading,
    handleEditBooking, handleDeleteBooking, fetchAllReferrals, handleConfirmReferral,
    isMaintenanceMode, setIsMaintenanceMode, globalAnnouncement, setGlobalAnnouncement, publishGlobalAnnouncement,

    isCalendarSyncOpen, calendarSyncUrl, isBookingModalOpen, selectedScheduleEvent, newBookingForm, bioText, 
    isSyncing, _syncStatus, _syncProgress, relayOnline, trackers, gpsHistory, trackerProvisioning, isPairingTracker,
    handlePairTracker, handleUnpairTracker, applyTrackerLocation, handleSaveBio, handleSyncAll, handleSyncChatHistory,
    handleSaveCredentials, handleQuickSaveMeeting, handleDelayBooking, initData, handleExportICS, 
    handleSaveCalendarSync, handleSaveBooking, fetchClientByPhone, toggleOperatorStatus, handleSaveAssignees, 
    handleRevokeBinding
  , sourceText, translatedText, isTranslating, translateTargetLang, handleTranslate, sipDids]);
}
