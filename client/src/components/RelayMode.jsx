import React, { useState, useEffect, useRef, useCallback } from 'react';
import * as tokenStore from '../services/tokenStore';
import {
  Signal, 
  Wifi, 
  Battery, 
  Activity, 
  History, 
  ShieldCheck, 
  Server, 
  ServerCrash,
  AlertCircle,
  Play,
  Pause,
  Settings,
  RefreshCw,
  Phone,
  MessageSquare,
  Smartphone,
  ArrowUpRight,
  ArrowDownLeft,
  X
} from 'lucide-react';
import { useSipCall } from '../plugins/NexusSip';
import { useInCallService, isInCallAvailable } from '../plugins/NexusInCall';
import { useSmsRelay } from '../plugins/NexusSms';
import IncomingCallScreen from './sip/IncomingCallScreen';
import ActiveCallScreen from './sip/ActiveCallScreen';
import IncomingCallModal from './IncomingCallModal';
import IncomingSmsModal from './IncomingSmsModal';
import IncomingSmsToast from './IncomingSmsToast';
import axios from 'axios';


import { useNexus } from '../context/ContextHook';
import { useSocketBridge } from '../services/socketBridge';
import { useFeatureLock } from '../config/featureLocks';

import { SERVER_ORIGIN } from '../constants/config';
function relayDebug(...args) {
  console.info('[Relay]', ...args);
}

const RelayMode = ({ operator, t, onHide: _onHide, onExit, syncPushToken, isSyncingPush: _isSyncingPush, requestRelayPermissions, processRelayOutbox, syncSmsHistory }) => {
  const nexus = useNexus();
  const socket = useSocketBridge();
  const {
    isRelayActive: isActive,
    setIsRelayActive: setIsActive, 
    relaySimSlot: selectedSimSlot, 
    relayLogs: logs,
    setRelayLogs: setLogs,
    addRelayLog: addLocalLog,
    API_BASE,
    token: nexusToken,
    activeProfileId,
    lang,
    setLang
  } = nexus || {};

  const RELAY_API_BASE = SERVER_ORIGIN;

  // Reaktivně, ne jednorázovým čtením: secret přichází až z /device/verify.
  const relaySecret = tokenStore.useRelaySecret() || '';

  // Přímý GSM audio most je zamykatelná funkce (reaktivní; App Owner může odemknout).
  const gsmCallBridgeLocked = useFeatureLock('gsm-call-bridge');


  const updateLogStatus = useCallback((idOrPhone, newStatus) => {
    relayDebug('updateLogStatus', { idOrPhone, newStatus });
    setLogs(prev => {
      const updated = prev.map(l => (l.id === idOrPhone || l.from === idOrPhone) ? { ...l, status: newStatus } : l);
      localStorage.setItem('nexus_relay_logs', JSON.stringify(updated));
      return updated;
    });
  }, [setLogs]);

  const [connectionStatus, setConnectionStatus] = useState('connecting');
  const [_signalStrength, setSignalStrength] = useState(85);
  const [batteryLevel, setBatteryLevel] = useState(100);
  const [isCharging, setIsCharging] = useState(false);


  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isRefreshingLogs, setIsRefreshingLogs] = useState(false);
  const [permissionsStatus, setPermissionsStatus] = useState({
    smsMonitoring: false,
    callMonitoring: false,
    locationMonitoring: false,
    rcsMonitoring: false
  });
  const [relayNotice, setRelayNotice] = useState(null);
  const [showTestSmsConfirm, setShowTestSmsConfirm] = useState(false);
  // Zpráva, na kterou se právě odpovídá — teprve ta otevře celé okno.
  const [odpovidamNa, setOdpovidamNa] = useState(null);
  const [_noProfileWarning] = useState(false);
  const latestHealthCheckRef = useRef(0);
  const consecutiveHealthFailuresRef = useRef(0);
  const POLL_FAILURES_FOR_DISCONNECT = 5;

  const showRelayNotice = useCallback((type, message) => {
    relayDebug('showRelayNotice', { type, message });
    setRelayNotice({ type, message });
  }, []);

  // ── SIP VoIP integration ────────────────────────────────────────────────────


  // Fake call handler
  useEffect(() => {
    const handleFakeCall = (data) => {
      const myInstallationId = operator?.installationId;
      if (data.targetInstallationId && data.targetInstallationId !== myInstallationId) return;
      const delay = (data.delay || 0) * 1000;
      setTimeout(() => {
        if (navigator.vibrate) navigator.vibrate([1000, 500, 1000, 500, 1000]);
        addLocalLog('call', 'System', 'Fake call received', 'inbound', 'forwarded');
      }, delay);
    };
    if (socket) {
      socket.on('fake_call_request', handleFakeCall);
      return () => socket.off('fake_call_request', handleFakeCall);
    }
  }, [socket, operator?.installationId, addLocalLog]);

  // ── Automatic Refresh on New Message ──
  // NOTE: refreshLogs is defined later in this component. We use a ref so this
  // useEffect can safely reference it without a temporal dead zone crash.
  const refreshLogsRef = useRef(null);
  useEffect(() => {
    const handleNewMessage = (data) => {
      if (operator?.profileId && data.profileId === operator.profileId) {
        refreshLogsRef.current?.();
      } else if (!operator?.profileId) {
        refreshLogsRef.current?.();
      }
    };
    if (socket) {
      socket.on('new_message', handleNewMessage);
      return () => socket.off('new_message', handleNewMessage);
    }
  }, [socket, operator?.profileId]);

  // ── Pull to Refresh logic ──
  const [pullDistance, setPullDistance] = useState(0);
  const pullStartRef = useRef(0);
  const isPullingRef = useRef(false);

  const _handleTouchStart = (_err) => {
    const scrollEl = document.querySelector('.relay-logs-scroll');
    if (scrollEl && scrollEl.scrollTop === 0) {
      pullStartRef.current = _err.touches[0].clientY;
      isPullingRef.current = true;
    }
  };

  const _handleTouchMove = (_err) => {
    if (!isPullingRef.current) return;
    const currentY = _err.touches[0].clientY;
    const distance = currentY - pullStartRef.current;
    if (distance > 0) {
      setPullDistance(Math.min(distance * 0.4, 80));
      if (distance > 10) _err.preventDefault();
    }
  };

  const _handleTouchEnd = () => {
    if (isPullingRef.current) {
      if (pullDistance > 60) {
        void refreshLogs();
      }
      setPullDistance(0);
      isPullingRef.current = false;
    }
  };

  // ── SIP VoIP integration ────────────────────────────────────────────────────
  const [sipConfig, setSipConfig] = useState(null);
  const sipFetchedRef = useRef(false);

  // Fetch SIP credentials when relay activates
  useEffect(() => {
    if (!isActive || !operator?.token || sipFetchedRef.current) return;
    sipFetchedRef.current = true;
    (async () => {
      try {
        const url = `${API_BASE || RELAY_API_BASE}/sip/config`;
        const res = await axios.get(url, {
          headers: {
            Authorization: `Bearer ${operator.token}`,
            'x-installation-id': operator.installationId || '',
          },
        });
        if (res.data?.ok && res.data.sipConfig) {
          setSipConfig(res.data.sipConfig);
        }
      } catch (_err) {
        console.warn('[Relay/SIP] Could not fetch SIP config:', _err.message);
      }
    })();
  }, [isActive, operator?.token, operator?.installationId, API_BASE, RELAY_API_BASE]);

  // Reset SIP on deactivation
  useEffect(() => {
    if (!isActive) {
      setSipConfig(null);
      sipFetchedRef.current = false;
    }
  }, [isActive]);

  const handleSipCallAnswered = useCallback(() => {
    addLocalLog('call', 'SIP', 'SIP call answered', 'inbound', 'forwarded');
  }, [addLocalLog]);

  const handleSipCallEnded = useCallback(() => {
    addLocalLog('call', 'SIP', 'SIP call ended', 'inbound', 'forwarded');
  }, [addLocalLog]);

  const {
    sipState,
    incomingCall: sipIncomingCall,
    answer: sipAnswer,
    reject: sipReject,
    hangup: sipHangup,
  } = useSipCall(sipConfig, {
    onIncoming: (data) => {
      addLocalLog('call', data.caller || data.callerId || 'SIP', 'Incoming SIP call', 'inbound', 'pending');
    },
    onAnswered: handleSipCallAnswered,
    onEnded: handleSipCallEnded,
  });

  // ── InCallService (GSM hovory bez SIP Trunk) ──────────────────────────────
  // Funguje pouze pokud je Nexus nastaven jako výchozí telefonní aplikace.
  const {
    incomingCall: gsmIncomingCall,
    callState:    gsmCallState,
    callDuration: gsmCallDuration,
    isDefaultDialer: _isDefaultDialer,
    answer:       gsmAnswer,
    reject:       gsmReject,
    hangup:       gsmHangup,
    setMuted:     gsmSetMuted,
    setSpeaker:   gsmSetSpeaker,
    requestDefaultDialer: _requestDefaultDialer,
  } = useInCallService({
    apiUrl: `${RELAY_API_BASE}/api/device`,
    installationId: operator?.installationId || '',
    secret: tokenStore.getRelaySecret() || operator?.token || '', // Per-device relay secret (odvozený serverem, uložený při bindingu) — #5
    socket: nexus.socket
  }, {
    onIncoming: (call) => addLocalLog('call', call.callerId, 'GSM hovor (příchozí)', 'inbound', 'ringing'),
    onAnswered: ()     => addLocalLog('call', 'GSM', 'Hovor přijat operátorem', 'inbound', 'answered'),
    onEnded:    ()     => addLocalLog('call', 'GSM', 'Hovor ukončen', 'inbound', 'completed'),
  });

  const { isDefaultSmsApp: _isDefaultSmsApp, requestDefaultSmsApp: _requestDefaultSmsApp, incomingSms, clearIncomingSms, sendSms, configureRelay } = useSmsRelay({
    onIncoming: (sms) => addLocalLog('sms', sms.from, 'Příchozí SMS (GSM)', 'inbound', 'completed'),
  });

  useEffect(() => {
    const relayAuthToken = operator?.token || nexusToken || tokenStore.getToken() || '';
    const relayProfileId = operator?.profileId || (activeProfileId && activeProfileId !== 'all' ? activeProfileId : '');

    configureRelay({
      baseUrl: `${RELAY_API_BASE}/api/device/relay`,
      deviceId: operator?.id || 'RELAY-DEVICE',
      installationId: localStorage.getItem('nexus_installation_id') || operator?.installationId || '',
      isActive,
      profileId: relayProfileId || '',
      authToken: relayAuthToken,
      // Pověření zařízení. authToken žije hodinu a jakmile systém uspí WebView,
      // nemá ho kdo obnovit — nativní služba pak mlčky dostávala 401 a odchozí
      // SMS zůstávaly ve frontě. Secret z /device/verify nevyprší.
      deviceSecret: relaySecret
    }).catch((err) => console.warn('[Relay] Failed to configure native relay', err));
  }, [activeProfileId, configureRelay, isActive, nexusToken, operator?.id, operator?.installationId, operator?.profileId, operator?.token, relaySecret, RELAY_API_BASE]);

  // Persist logs to localStorage whenever they change

  useEffect(() => {
    try { localStorage.setItem('nexus_relay_logs', JSON.stringify(logs.slice(0, 20))); } catch { /* ignore */ }
  }, [logs]);

  // Sync lang from localStorage in case user changes language while relay is running
  useEffect(() => {
    const interval = setInterval(() => {
      const current = localStorage.getItem('nexus_lang') || 'cz';
      setLang(prev => prev !== current ? current : prev);
    }, 2000);
    return () => clearInterval(interval);
  }, [setLang]);

  // Persist SIM slot preference
  useEffect(() => {
    localStorage.setItem('nexus_relay_sim_slot', selectedSimSlot);
  }, [selectedSimSlot]);

  const HEALTH_CHECK_TIMEOUT_MS = 8000;
  const MANUAL_RETRY_ATTEMPTS = 3;

  const connectionUi = {
    connected: {
      label: t('relayConnected') || 'CONNECTED',
      color: 'var(--success-color)',
      icon: Server
    },
    connecting: {
      label: t('relayConnecting') || 'CONNECTING',
      color: 'var(--accent-color)',
      icon: RefreshCw
    },
    disconnected: {
      label: t('relayDisconnected') || 'DISCONNECTED',
      color: 'var(--error-color)',
      icon: AlertCircle
    }
  };

  const _currentConnectionUi = connectionUi[connectionStatus] || connectionUi.disconnected;
  const isServerConnected = connectionStatus === 'connected';

  const toggleRelayActive = () => {
    setIsActive(prev => {
      const nextIsActive = !prev;

      if (!nextIsActive) {
        // Invalidate any in-flight health check so paused mode stays visually disconnected.
        latestHealthCheckRef.current += 1;
        consecutiveHealthFailuresRef.current = 0;
        setConnectionStatus('disconnected');
      }

      return nextIsActive;
    });
  };

  const updateBatteryDiagnostics = async () => {
    try {
      const devicePlugin = window.Capacitor?.Plugins?.Device;
      if (devicePlugin?.getBatteryInfo) {
        const info = await devicePlugin.getBatteryInfo();
        if (typeof info?.batteryLevel === 'number') {
          setBatteryLevel(Math.max(0, Math.min(100, Math.round(info.batteryLevel * 100))));
        }
        if (typeof info?.isCharging === 'boolean') {
          setIsCharging(info.isCharging);
        }
        return;
      }

      if (typeof navigator !== 'undefined' && navigator.getBattery) {
        const battery = await navigator.getBattery();
        setBatteryLevel(Math.max(0, Math.min(100, Math.round((battery.level || 0) * 100))));
        setIsCharging(Boolean(battery.charging));
      }
    } catch (_err) {
      console.warn('[Relay] Failed to read battery level', _err);
    }
  };

  const _refreshDiagnostics = () => {
    setIsRefreshing(true);
    void updateBatteryDiagnostics();
    setTimeout(() => {
      setSignalStrength(prev => Math.max(70, Math.min(100, prev + (Math.random() * 6 - 3))));
      setIsRefreshing(false);
    }, 800);
  };

  useEffect(() => {
    void updateBatteryDiagnostics();
    const interval = setInterval(() => {
      void updateBatteryDiagnostics();
    }, 30000);
    return () => clearInterval(interval);
  }, []);

  const checkServerConnection = useCallback(async ({ showConnectingState = true, source = 'manual', attempts = 1 } = {}) => {
    const checkId = Math.random().toString(36).substring(7);
    relayDebug('checkServerConnection:start', { source, attempts, showConnectingState, checkId, isActive });
    
    if (!isActive) return false;
    if (showConnectingState) setConnectionStatus('connecting');

    // 1. Try local status if available (Nexus Bridge / Capacitor)
    const relayStatus = await nexus?.checkRelayStatus?.();
    relayDebug('checkServerConnection:deviceStatus', relayStatus);
    
    if (relayStatus?.connected && relayStatus?.bridgeActive) {
      setConnectionStatus('connected');
      latestHealthCheckRef.current = Date.now();
      consecutiveHealthFailuresRef.current = 0;
      relayDebug('checkServerConnection:connected-via-device-status');
      return true;
    }

    // 2. Try profile health via nexus context
    const profileStatus = await nexus?.checkProfileHealth?.(operator?.profileId);
    relayDebug('checkServerConnection:profileStatus', profileStatus);
    if (profileStatus?.isHealthy) {
      setConnectionStatus('connected');
      latestHealthCheckRef.current = Date.now();
      consecutiveHealthFailuresRef.current = 0;
      relayDebug('checkServerConnection:connected-via-profiles');
      return true;
    }

    // 3. Last resort: Direct health check to relay server
    let lastError = null;
    const failureThreshold = source === 'poll' ? POLL_FAILURES_FOR_DISCONNECT : 1;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 6000);

        const response = await fetch(`${RELAY_API_BASE}/health`, { 
          cache: 'no-cache',
          signal: controller.signal
        });
        
        clearTimeout(timeoutId);

        if (!response.ok && response.status !== 503) {
           throw new Error(`HTTP Error: ${response.status}`);
        }
        
        // Success
        setConnectionStatus('connected');
        latestHealthCheckRef.current = Date.now();
        consecutiveHealthFailuresRef.current = 0;
        relayDebug('checkServerConnection:connected-via-health', { attempt, status: response.status });
        return true;
      } catch (_err) {
        lastError = _err;
        relayDebug('checkServerConnection:health-attempt-failed', { attempt, _err: String(lastError) });
        
        if (attempt < attempts) {
          await new Promise(resolve => setTimeout(resolve, 650));
        }
      }
    }

    // Final failure logic
    consecutiveHealthFailuresRef.current += 1;
    if (consecutiveHealthFailuresRef.current >= failureThreshold) {
      console.warn('[Relay] Server is unreachable', lastError);
      setConnectionStatus('disconnected');
    } else {
      console.warn(`[Relay] Transient health check failure (${consecutiveHealthFailuresRef.current}/${failureThreshold})`);
    }

    relayDebug('checkServerConnection:failed', {
      source,
      attempts,
      consecutiveFailures: consecutiveHealthFailuresRef.current,
      _err: String(lastError || 'unknown')
    });
    return false;
  }, [isActive, nexus, operator?.profileId, RELAY_API_BASE]);

  const _reconnectServer = async () => {
    relayDebug('reconnectServer:clicked');
    setIsRefreshing(true);
    let connected = await checkServerConnection({ source: 'manual', attempts: MANUAL_RETRY_ATTEMPTS });
    let pushSyncReachedServer = false;

    if (typeof syncPushToken === 'function') {
      try {
        pushSyncReachedServer = await syncPushToken();
      } catch (_err) {
        console.warn('[Relay] Push token sync failed during reconnect', _err);
      }
    }

    if (!connected && pushSyncReachedServer) {
      connected = true;
      consecutiveHealthFailuresRef.current = 0;
      setConnectionStatus('connected');
      showRelayNotice(t('relayConnectedViaApi') || 'Server API responded successfully. Relay stays connected.', 'success');
    }

    if (connected && typeof processRelayOutbox === 'function' && operator?.profileId) {
      void processRelayOutbox(operator.profileId);
    }

    if (connected && typeof syncSmsHistory === 'function' && operator?.profileId) {
      void syncSmsHistory(operator.profileId);
    }

    setIsRefreshing(false);
    if (!connected) {
      showRelayNotice(t('relayServerUnreachable') || 'Server is unreachable. Check internet connection and try again.', 'error');
    }
    relayDebug('reconnectServer:result', { connected, pushSyncReachedServer });
  };

  useEffect(() => {
    if (!isActive) {
      consecutiveHealthFailuresRef.current = 0;
      setConnectionStatus('disconnected');
      return;
    }

    void checkServerConnection({ source: 'manual' });

    const interval = setInterval(() => {
      void checkServerConnection({ showConnectingState: false, source: 'poll' });
    }, 30000);

    return () => clearInterval(interval);
  }, [isActive, checkServerConnection]);

  const _testSms = () => {
    // Open in-app confirm dialog instead of window.confirm (crashes Android WebView)
    setShowTestSmsConfirm(true);
  };

  const executeSendTestSms = async () => {
    setShowTestSmsConfirm(false);
    const testNum = operator?.phoneNumber || "+420777777777";
    const testMsg = "Nexus Relay Diagnostic - " + new Date().toLocaleTimeString();
    addLocalLog("sms", testNum, "TEST: " + testMsg, "outbound", "pending");
    try {
      const plugin = window.Capacitor?.Plugins?.NexusRelay;
      if (!plugin) throw new Error("Relay plugin not available");
      await plugin.sendSms({ to: testNum, text: testMsg });
      updateLogStatus(testNum, "sent");
    } catch {
      setBatteryLevel(100);
      setIsCharging(false);
    }
  };

  useEffect(() => {
    // 1. Listen for background events from native plugin
    const plugin = window.Capacitor?.Plugins?.NexusRelay;
    let listener = null;
    
    if (plugin?.addListener) {
      listener = plugin.addListener('relay_event', (event) => {
        try {
          const st = (event.status || '').toLowerCase();
          if (st === 'sent' || st === 'forwarded' || st === 'relayed' || st === 'ok' || st === 'success' || st === 'delivered') {
            updateLogStatus(event.from, 'forwarded');
            showRelayNotice(t('smsRelayed') || 'SMS byla odeslána!', 'success');
          } else if (event.status === 'failed' || event.status === '_err') {
            updateLogStatus(event.from, 'failed');
            showRelayNotice(t('relayFailed') || 'Přeposlání selhalo!', 'error');
          } else {
            addLocalLog(event.type || 'sms', event.from, event.content, event.direction || 'inbound', 'pending');
          }
        } catch (_err) {
          console.error('[Relay] relay_event handler _err:', _err);
        }
      });
    }

    return () => {
      if (listener) listener.remove();
    };
  }, [isActive, updateLogStatus, addLocalLog, showRelayNotice, t]);

  const syncRelayToServer = useCallback(async () => {
    if (!operator?.token || !isActive) return;
    const installationId = localStorage.getItem('nexus_installation_id');
    if (!installationId) return;

    try {
      let model = 'Web/Unknown';
      let platform = 'android';
      let deviceName = '';

      if (window.Capacitor?.isNativePlatform()) {
        const info = await window.Capacitor.Plugins.Device.getInfo();
        model = info.model;
        platform = info.platform;
        deviceName = info.name;
      }

      await axios.post(`${RELAY_API_BASE}/api/device/verify`, {
        installationId,
        profileId: operator?.profileId,
        platform,
        model,
        deviceName
      }, {
        headers: { Authorization: `Bearer ${operator?.token}` }
      });
      console.log('[Relay] Server binding verified successfully');
      setConnectionStatus('connected');
    } catch (_err) {
      console.warn('[Relay] Failed to verify server binding', _err);
      setConnectionStatus('_err');
    }
  }, [operator, isActive, RELAY_API_BASE]);


  useEffect(() => {
    // Also wake up the server so it knows this device is active today.
    if (isActive) {
      void syncRelayToServer();
      
      // Automaticky vyžádat vypnutí optimalizace baterie, aby Android neuspával službu
      if (window.Capacitor?.Plugins?.NexusRelay) {
        window.Capacitor.Plugins.NexusRelay.checkBatteryOptimization().then(res => {
          if (res?.optimized) {
            console.log('[Relay] Requesting to ignore battery optimizations...');
            window.Capacitor.Plugins.NexusRelay.requestIgnoreBatteryOptimization().catch(console.error);
          }
        }).catch(console.error);
      }
    }
  }, [isActive, syncRelayToServer]);

  const handleExitMode = async () => {
    setConnectionStatus('disconnected');
    // We NO LONGER disable the relay on exit, it stays active in background!
    if (typeof onExit === 'function') {
      onExit();
    }
  };

  useEffect(() => {
    if (window.Capacitor?.Plugins?.NexusRelay) {
      const checkBlacklist = async (phone) => {
        try {
          const url = `${API_BASE || RELAY_API_BASE}/blacklist/check`;
          const res = await axios.get(url, {
            params: { phone },
            headers: { Authorization: `Bearer ${operator?.token}` }
          });
          if (res.data?.found) {
            const entry = res.data.entry;
            const severity = entry.severity === 'danger' ? '🔴' : '⚠️';
            const name = entry.name ? ` (${entry.name})` : '';
            addLocalLog('warning', phone, `${severity} BLACKLIST: ${phone}${name} — ${entry.description || ''}`, 'inbound', 'forwarded');
          }
        } catch (_err) { console.error(_err); }
      };

      const smsListener = window.Capacitor.Plugins.NexusRelay.addListener('onSmsReceived', async (data) => {
        try {
          addLocalLog('sms', data.from, data.body, 'inbound', 'pending');
          checkBlacklist(data.from);
          // Also forward to server (in case native plugin doesn't do it automatically)
          const installationId = localStorage.getItem('nexus_installation_id');
          const token = tokenStore.getToken();
          if (installationId && token) {
            try {
              const res = await fetch(`${RELAY_API_BASE}/api/device/relay`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify({
                  installationId,
                  from: data.from,
                  content: data.body,
                  type: 'SMS_RECEIVED',
                  transport: 'sms',
                  direction: 'inbound'
                })
              });
              if (!res.ok) throw new Error(`Server returned ${res.status}`);
              updateLogStatus(data.from, 'forwarded');
              showRelayNotice(lang === 'cz' ? 'SMS přeposlána na server' : 'SMS forwarded to server', 'success');
            } catch (_err) {
              console.warn('[Relay] Failed to forward SMS to server', _err);
              updateLogStatus(data.from, 'failed');
              showRelayNotice((lang === 'cz' ? 'Chyba přeposílání: ' : 'Forward _err: ') + _err.message, '_err');
            }
          }
        } catch (_err) { console.error('[Relay] onSmsReceived _err:', _err); }
      });
      const rcsListener = window.Capacitor.Plugins.NexusRelay.addListener('onRcsReceived', (data) => {
        try {
          addLocalLog('rcs', data.from, data.body, 'inbound', 'pending');
          checkBlacklist(data.from);
        } catch (_err) { console.error('[Relay] onRcsReceived _err:', _err); }
      });
      const callListener = window.Capacitor.Plugins.NexusRelay.addListener('onCallStateChanged', (data) => {
        try {
          if (data.state && data.state !== 'IDLE') {
            addLocalLog('call', data.from, `State: ${data.state}`);
            if (data.from) checkBlacklist(data.from);
          }
        } catch (_err) { console.error('[Relay] onCallStateChanged _err:', _err); }
      });
      return () => {
        smsListener.remove();
        rcsListener.remove();
        callListener.remove();
      };
    }
  }, [isActive, operator, addLocalLog, API_BASE, RELAY_API_BASE, lang, updateLogStatus, showRelayNotice]);

  useEffect(() => {
    if (!isActive || window.Capacitor?.Plugins?.NexusRelay) return;
    const interval = setInterval(() => {
      setSignalStrength(prev => Math.max(70, Math.min(100, prev + (Math.random() * 10 - 5))));
      void updateBatteryDiagnostics();
    }, 10000);
    return () => clearInterval(interval);
  }, [isActive]);



  const refreshPermissionsStatus = useCallback(async () => {
    try {
      const plugin = window.Capacitor?.Plugins?.NexusRelay;
      if (!plugin?.checkStatus) return;
      
      const status = await plugin.checkStatus();
      if (status) {
        setPermissionsStatus({
          smsMonitoring: Boolean(status.smsMonitoring),
          callMonitoring: Boolean(status.callMonitoring),
          locationMonitoring: Boolean(status.locationMonitoring),
          rcsMonitoring: Boolean(status.rcsMonitoring)
        });
      }
    } catch (_err) {
      console.warn('[Relay] Failed to refresh permissions status', _err);
    }
  }, []);

  const refreshLogs = useCallback(async () => {
    // Keep ref up to date so early-registered socket handlers can call us
    refreshLogsRef.current = refreshLogs;
    if (isRefreshingLogs) return;
    setIsRefreshingLogs(true);
    try {
      const installationId = localStorage.getItem('nexus_installation_id');
      const token = tokenStore.getToken();
      if (!installationId || !token) {
        setIsRefreshingLogs(false);
        return;
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 6000);
      
      const response = await fetch(`${RELAY_API_BASE}/api/device/logs?installationId=${encodeURIComponent(installationId)}&limit=50`, {
        method: 'GET',
        cache: 'no-store',
        headers: {
          'Authorization': `Bearer ${token}`
        },
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      if (response.ok) {
        const data = await response.json();
        if (Array.isArray(data?.logs)) {
          const serverLogs = data.logs.map(l => ({
            id: l.id || l.timestamp || Date.now() + Math.random(),
            transport: l.transport || 'sms',
            type: l.transport || 'sms',
            from: l.from || '?',
            content: l.content || '',
            fullData: l.content || '',
            direction: l.direction || 'inbound',
            time: l.time || new Date(l.timestamp || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            status: l.status || 'forwarded',
            senderName: l.sender?.name || null
          }));
          // Merge: keep local-only logs (prefixed with 'local_') + server logs
          setLogs(prev => {
            const localOnly = prev.filter(l => String(l.id).startsWith('local_'));
            const merged = [...serverLogs];
            localOnly.forEach(local => {
              if (!merged.find(s => s.content === local.content && s.from === local.from)) {
                merged.unshift(local);
              }
            });
            return merged.slice(0, 30);
          });
        }
      }
    } catch (_err) {
      console.warn('[Relay] Failed to refresh logs', _err);
    } finally {
      setIsRefreshingLogs(false);
    }
  }, [RELAY_API_BASE, isRefreshingLogs, setLogs]);

  // Load initial permissions status and start polling
  useEffect(() => {
    const initPermissions = async () => {
      await refreshPermissionsStatus();
      if (requestRelayPermissions) {
        const plugin = window.Capacitor?.Plugins?.NexusRelay;
        if (plugin?.checkStatus) {
           const st = await plugin.checkStatus();
           if (!st.smsMonitoring || !st.callMonitoring) {
             await requestRelayPermissions();
             await refreshPermissionsStatus();
           }
        }
      }
    };
    void initPermissions();
    
    // Also load logs immediately on mount/activation
    if (isActive) {
      void refreshLogs();
    }

    const interval = setInterval(() => {
      if (isActive) {
        void refreshPermissionsStatus();
        void refreshLogs(); // Auto-refresh logs every 10s along with permissions
      }
    }, 10000); 

    return () => clearInterval(interval);
  }, [isActive, refreshPermissionsStatus, refreshLogs, requestRelayPermissions]);

  useEffect(() => {
    if (!relayNotice) return;
    const timer = setTimeout(() => setRelayNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [relayNotice]);

  return (
    <>
      {/* IncomingCallModal: GSM hovor zachycený přes InCallService (bez SIP Trunk).
          Uzamčeno — přímý GSM audio most je neověřený; produkčně jede přes VoIP. */}
      {isInCallAvailable() && !gsmCallBridgeLocked && (gsmCallState === 'ringing' || gsmCallState === 'active') && (
        <IncomingCallModal
          incomingCall={gsmIncomingCall}
          callState={gsmCallState}
          callDuration={gsmCallDuration}
          onAnswer={gsmAnswer}
          onReject={gsmReject}
          onHangup={gsmHangup}
          onMute={gsmSetMuted}
          onSpeaker={gsmSetSpeaker}
          lang={lang}
        />
      )}

      {/* Příchozí SMS: oznámení, které se samo zavře.
          Celé okno u každé zprávy tu nedává smysl — relay nikdo neobsluhuje.
          Odpovědět jde po klepnutí na oznámení. */}
      {!odpovidamNa && (
        <IncomingSmsToast
          sms={incomingSms}
          onOpen={() => setOdpovidamNa(incomingSms)}
          onClose={clearIncomingSms}
          lang={lang}
        />
      )}
      {odpovidamNa && (
        <IncomingSmsModal
          sms={odpovidamNa}
          onClose={() => { setOdpovidamNa(null); clearIncomingSms(); }}
          onReply={(text) => sendSms(odpovidamNa.from, text)}
          lang={lang}
        />
      )}

      {/* ERROR OVERLAY IF DISCONNECTED */}
      {connectionStatus === 'disconnected' && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 9999,
          background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(10px)',
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '2rem', textAlign: 'center'
        }}>
          <div style={{ width: '80px', height: '80px', borderRadius: '24px', background: 'rgba(239, 68, 68, 0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#ef4444', marginBottom: '1.5rem' }}>
            <ServerCrash size={40} />
          </div>
          <h2 style={{ fontSize: '1.5rem', fontWeight: '900', color: 'white', marginBottom: '0.75rem' }}>
            {lang === 'cz' ? 'Chyba připojení' : 'Connection Error'}
          </h2>
          <p style={{ color: 'rgba(255,255,255,0.6)', fontSize: '0.95rem', lineHeight: 1.5, maxWidth: '300px', marginBottom: '2rem' }}>
            {lang === 'cz' 
              ? 'Zkontrolujte prosím internet nebo stav serveru.' 
              : 'Please check your internet connection or server status.'}
          </p>
          <button 
            onClick={() => checkServerConnection({ source: 'manual' })}
            style={{
              padding: '1rem 2rem', borderRadius: '14px',
              background: 'var(--accent-color)', border: 'none',
              color: 'white', fontWeight: '900', fontSize: '0.95rem',
              display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer'
            }}
          >
            <RefreshCw size={18} className={isRefreshing ? 'rotate' : ''} />
            {lang === 'cz' ? 'Zkusit znovu' : 'Try Again'}
          </button>
        </div>
      )}

      {/* In-app Test SMS confirm dialog (window.confirm crashes Android WebView) */}

      {showTestSmsConfirm && (
        <div
          onClick={() => setShowTestSmsConfirm(false)}
          style={{
            position: 'fixed', inset: 0, zIndex: 9999,
            background: 'rgba(0,0,0,0.75)', backdropFilter: 'blur(6px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2rem'
          }}
        >
          <div
            onClick={_err => _err.stopPropagation()}
            style={{
              background: '#12141a', border: '1px solid rgba(59,130,246,0.3)',
              borderRadius: '20px', padding: '2rem', width: '100%', maxWidth: '320px',
              display: 'flex', flexDirection: 'column', gap: '1.5rem'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <MessageSquare size={22} color="var(--accent-color)" />
              <span style={{ fontWeight: '900', fontSize: '1rem' }}>
                {lang === 'cz' ? 'Testovací SMS' : 'Test SMS'}
              </span>
            </div>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5 }}>
              {lang === 'cz'
                ? 'Odeslat diagnostickou SMS pro ověření funkčnosti Relay pluginu?'
                : 'Send a diagnostic SMS to verify Relay plugin functionality?'}
            </p>
            <div style={{ display: 'flex', gap: '0.75rem' }}>
              <button
                onClick={() => setShowTestSmsConfirm(false)}
                style={{
                  flex: 1, padding: '0.85rem', borderRadius: '12px',
                  background: 'rgba(255,255,255,0.05)', border: '1px solid var(--card-border)',
                  color: 'var(--text-secondary)', fontWeight: '800', fontSize: '0.8rem', cursor: 'pointer'
                }}
              >
                {lang === 'cz' ? 'ZRUŠIT' : 'CANCEL'}
              </button>
              <button
                onClick={executeSendTestSms}
                style={{
                  flex: 1, padding: '0.85rem', borderRadius: '12px',
                  background: 'rgba(59,130,246,0.15)', border: '1px solid rgba(59,130,246,0.4)',
                  color: 'var(--accent-color)', fontWeight: '900', fontSize: '0.8rem', cursor: 'pointer'
                }}
              >
                {lang === 'cz' ? 'ODESLAT' : 'SEND'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* SIP incoming call fullscreen overlay */}
      {sipState === 'ringing' && sipIncomingCall && (
        <IncomingCallScreen
          caller={sipIncomingCall.caller || sipIncomingCall.callerId}
          profileName={sipIncomingCall.callerName}
          onAnswer={() => sipAnswer()}
          onReject={() => sipReject()}
        />
      )}

      {/* SIP active call fullscreen overlay */}
      {sipState === 'in_call' && (
        <ActiveCallScreen
          caller={sipIncomingCall?.caller || 'SIP'}
          profileName={sipIncomingCall?.callerName}
          onEnd={() => sipHangup()}
        />
      )}

    <div className="relay-container fade-in" style={{ 
      minHeight: '100dvh',
      background: '#07080a',
      color: 'white', 
      paddingTop: '3rem',
      paddingLeft: '1.5rem',
      paddingRight: '1.5rem',
      paddingBottom: '3rem',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '2rem',
      width: '100%',
      boxSizing: 'border-box'
    }}>
       <div style={{ textAlign: 'center' }}>
          <div style={{ width: '80px', height: '80px', borderRadius: '40px', background: 'rgba(59, 130, 246, 0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 1.5rem', color: 'var(--accent-color)' }}>
             <Smartphone size={40} />
          </div>
          <h2 style={{ fontSize: '1.5rem', fontWeight: '900', letterSpacing: '0.05em', marginBottom: '0.5rem' }}>
            NEXUS RELAY
          </h2>
          <div style={{ fontSize: '1rem', color: 'var(--text-secondary)' }}>
            {lang === 'cz' ? 'Připojeno jako:' : 'Connected as:'} <span style={{ color: 'white', fontWeight: '800' }}>{operator?.displayName || operator?.name || operator?.username || operator?.id || 'Modelka'}</span>
          </div>
       </div>

       <div style={{ padding: '1.5rem', borderRadius: '20px', background: isActive ? 'rgba(34, 197, 94, 0.05)' : 'rgba(239, 68, 68, 0.05)', border: `1px solid ${isActive ? 'rgba(34, 197, 94, 0.2)' : 'rgba(239, 68, 68, 0.2)'}`, width: '100%', maxWidth: '320px', textAlign: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
            <div style={{ width: '12px', height: '12px', borderRadius: '50%', background: isActive ? 'var(--success-color)' : 'var(--error-color)', boxShadow: `0 0 10px ${isActive ? 'var(--success-color)' : 'var(--error-color)'}` }} />
            <span style={{ fontWeight: '800', fontSize: '1.1rem', color: isActive ? 'var(--success-color)' : 'var(--error-color)' }}>
              {isActive ? (lang === 'cz' ? 'RELAY AKTIVNÍ' : 'RELAY ACTIVE') : (lang === 'cz' ? 'RELAY POZASTAVEN' : 'RELAY PAUSED')}
            </span>
          </div>
          <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', margin: 0, lineHeight: 1.5 }}>
            {lang === 'cz' 
              ? 'Tento telefon nyní slouží pouze k automatickému přeposílání zpráv a hovorů do systému Nexus.' 
              : 'This phone is now solely used for automatically forwarding messages and calls to the Nexus system.'}
          </p>
       </div>

       {/* Status Badges */}
       <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', justifyContent: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.5rem 1rem', borderRadius: '12px', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--card-border)' }}>
             <Server size={16} color={isServerConnected ? 'var(--success-color)' : 'var(--error-color)'} />
             <span style={{ fontSize: '0.8rem', fontWeight: '800' }}>{isServerConnected ? 'API OK' : 'Offline'}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.5rem 1rem', borderRadius: '12px', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--card-border)' }}>
             <Battery size={16} color={batteryLevel > 20 ? 'var(--success-color)' : 'var(--error-color)'} />
             <span style={{ fontSize: '0.8rem', fontWeight: '800' }}>{Math.round(batteryLevel)}% {isCharging && '⚡'}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.5rem 1rem', borderRadius: '12px', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--card-border)' }}>
             <ShieldCheck size={16} color={permissionsStatus.smsMonitoring ? 'var(--success-color)' : 'var(--text-secondary)'} />
             <span style={{ fontSize: '0.8rem', fontWeight: '800' }}>{permissionsStatus.smsMonitoring ? 'SMS OK' : 'No SMS'}</span>
          </div>
       </div>

       <div style={{ width: '100%', maxWidth: '320px', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <button 
            onClick={toggleRelayActive}
            style={{ padding: '1rem', borderRadius: '14px', background: 'rgba(255,255,255,0.05)', border: '1px solid var(--card-border)', color: 'white', fontWeight: '900', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', cursor: 'pointer' }}>
            {isActive ? <Pause size={18} /> : <Play size={18} />}
            {isActive ? (lang === 'cz' ? 'Pozastavit' : 'Pause Relay') : (lang === 'cz' ? 'Spustit Relay' : 'Start Relay')}
          </button>
          
          <button
            onClick={handleExitMode}
            style={{ padding: '1rem', borderRadius: '14px', background: 'rgba(239, 68, 68, 0.05)', border: '1px solid rgba(239, 68, 68, 0.2)', color: 'var(--error-color)', fontWeight: '900', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}>
            {lang === 'cz' ? 'Odhlásit (Ukončit)' : 'Logout (Exit)'}
          </button>
       </div>
    </div>
    </>
  );
};

export default RelayMode;
