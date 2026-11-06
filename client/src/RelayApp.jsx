/**
 * RelayApp – the entire UI for the Nexus Relay variant.
 * Intentionally minimal: login screen → relay dashboard.
 * No Sidebar, no ViewRouter, no calendar, no inbox, no analytics.
 */
import React, { useState, Suspense, lazy, useCallback } from 'react';
import { Loader2, Lock, Mail, Eye, EyeOff, Smartphone, Battery, Server, ShieldCheck, Pause, Play, Settings } from 'lucide-react';
import { useRelay } from './context/RelayContext';
import * as tokenStore from './services/tokenStore';
import { initPushNotifications } from './services/pushService';
import GlobalAppStyles from './styles/GlobalAppStyles';
import { useSipCall } from './plugins/NexusSip';
import { useInCallService, isInCallAvailable } from './plugins/NexusInCall';
import { useSocket } from './hooks/useSocket';
import { useSmsRelay } from './plugins/NexusSms';
import { App as CapacitorApp } from '@capacitor/app';
import axios from 'axios';

const IncomingCallScreen = lazy(() => import('./components/sip/IncomingCallScreen'));
const ActiveCallScreen = lazy(() => import('./components/sip/ActiveCallScreen'));
const IncomingCallModal = lazy(() => import('./components/IncomingCallModal'));
const IncomingSmsModal = lazy(() => import('./components/IncomingSmsModal'));
const IncomingSmsToast = lazy(() => import('./components/IncomingSmsToast'));

const RelayDialerModal = lazy(() => import('./components/RelayDialerModal'));
const RelaySmsModal = lazy(() => import('./components/RelaySmsModal'));

// ── Login screen ─────────────────────────────────────────────────────────────
const RelayLoginScreen = () => {
  const { onLogin } = useRelay();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [insets, setInsets] = useState({ top: 0, bottom: 0 });

  React.useEffect(() => {
    const measure = () => {
      const navBar = Math.max(0, window.screen.height - window.innerHeight);
      // Horní status bar: screen.height - availHeight - navBar
      const statusBar = Math.max(0, window.screen.availHeight - window.innerHeight);
      setInsets({
        top: statusBar > 0 && statusBar < 120 ? statusBar : 0,
        bottom: navBar > 0 && navBar < 200 ? navBar : 0,
      });
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

  React.useEffect(() => {
    let listener;
    CapacitorApp.addListener('backButton', () => {
      CapacitorApp.exitApp();
    }).then(l => listener = l);
    return () => {
      if (listener) listener.remove();
    };
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!email || !password) return;
    setLoading(true);
    setLoginError('');
    try {
      const res = await onLogin(email, password);
      if (res && !res.success) {
        setLoginError(res.error || 'Přihlášení selhalo. Zkontrolujte e-mail a heslo.');
      }
    } catch {
      setLoginError('Chyba připojení. Zkuste to znovu.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      minHeight: '100dvh', background: '#000000', display: 'flex',
      flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      paddingLeft: '2rem', paddingRight: '2rem',
      paddingTop: `max(2rem, ${insets.top}px)`,
      paddingBottom: `max(2rem, ${insets.bottom}px)`,
      boxSizing: 'border-box', color: 'white'
    }}>
      <div style={{ width: '72px', height: '72px', borderRadius: '20px', background: 'rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: '1.5rem' }}>
        <img src="/nexus_relay_icon.png" style={{ width: '56px', height: '56px', borderRadius: '14px' }} alt="Nexus Relay" onError={e => { e.target.style.display = 'none'; }} />
      </div>
      <h2 style={{ fontSize: '1.8rem', fontWeight: '900', letterSpacing: '0.05em', marginBottom: '0.5rem', color: '#60a5fa' }}>NEXUS RELAY</h2>
      <p style={{ fontSize: '0.9rem', color: 'rgba(255,255,255,0.5)', marginBottom: '2.5rem', textAlign: 'center' }}>
        Systémové relé pro Nexus Hub<br/>Zadejte své přihlašovací údaje
      </p>

      <form onSubmit={handleSubmit} style={{ width: '100%', maxWidth: '320px', display: 'flex', flexDirection: 'column', gap: '1.2rem' }}>
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
          <Mail size={20} style={{ position: 'absolute', left: '1.2rem', color: '#60a5fa', zIndex: 10, pointerEvents: 'none' }} />
          <input
            type="email" value={email} onChange={e => setEmail(e.target.value)}
            placeholder="E-mail" autoComplete="username"
            style={{ width: '100%', padding: '1.2rem 1.2rem 1.2rem 3.5rem', boxSizing: 'border-box', background: 'rgba(255,255,255,0.08)', border: 'none', borderRadius: '16px', color: 'white', fontSize: '1.05rem', outline: 'none', zIndex: 1 }}
          />
        </div>
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
          <Lock size={20} style={{ position: 'absolute', left: '1.2rem', color: '#60a5fa', zIndex: 10, pointerEvents: 'none' }} />
          <input
            type={showPw ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)}
            placeholder="Heslo" autoComplete="current-password"
            style={{ width: '100%', padding: '1.2rem 3.5rem 1.2rem 3.5rem', boxSizing: 'border-box', background: 'rgba(255,255,255,0.08)', border: 'none', borderRadius: '16px', color: 'white', fontSize: '1.05rem', outline: 'none', zIndex: 1 }}
          />
          <button type="button" onClick={() => setShowPw(v => !v)} style={{ position: 'absolute', right: '1rem', background: 'none', border: 'none', color: 'rgba(255,255,255,0.5)', cursor: 'pointer', padding: '0.5rem', zIndex: 10, display: 'flex' }}>
            {showPw ? <EyeOff size={20} /> : <Eye size={20} />}
          </button>
        </div>
        {loginError && (
          <div style={{
            background: 'rgba(239, 68, 68, 0.15)',
            border: '1px solid rgba(239, 68, 68, 0.4)',
            borderRadius: '12px',
            padding: '0.9rem 1.2rem',
            color: '#f87171',
            fontSize: '0.95rem',
            textAlign: 'center',
            lineHeight: '1.4'
          }}>
            {loginError}
          </div>
        )}
        <button
          type="submit" disabled={loading || !email || !password}
          style={{ marginTop: '0.5rem', padding: '1.2rem', borderRadius: '16px', border: 'none', background: (loading || !email || !password) ? 'rgba(96, 165, 250, 0.4)' : '#3b82f6', color: 'white', fontWeight: '800', fontSize: '1.05rem', cursor: (loading || !email || !password) ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.6rem', transition: 'all 0.2s' }}
        >
          {loading ? <Loader2 size={22} className="animate-spin" /> : <Lock size={20} />}
          {loading ? 'Ověřování...' : 'Spustit Relay'}
        </button>
      </form>
    </div>
  );
};

// ── Main relay dashboard (minimal) ───────────────────────────────────────────
const RelayDashboard = () => {
  const { operator, onLogout, lang, isNativeApp, API_BASE } = useRelay();
  const relayProfileId = operator?.profileId || operator?.activeProfileId || null;
  const [isActive, setIsActive] = useState(true);
  const [batteryLevel, setBatteryLevel] = useState(100);
  const [isCharging, setIsCharging] = useState(false);
  const [permSms, setPermSms] = useState(false);
  const [permDefaultSms, setPermDefaultSms] = useState(false);
  const [permDialer, setPermDialer] = useState(false);
  const [isBatOpt, setIsBatOpt] = useState(false);
  const [setupRunning, setSetupRunning] = useState(false);
  const [setupFailedCount, setSetupFailedCount] = useState(0);
  const [showDialer, setShowDialer] = useState(false);
  const [showSms, setShowSms] = useState(false);
  // Zpráva, na kterou se právě odpovídá — teprve ta otevře celé okno.
  const [odpovidamNa, setOdpovidamNa] = useState(null);

  // Battery info via native API
  React.useEffect(() => {
    if (typeof navigator?.getBattery === 'function') {
      navigator.getBattery().then(bat => {
        setBatteryLevel(Math.round(bat.level * 100));
        setIsCharging(bat.charging);
        bat.addEventListener('levelchange', () => setBatteryLevel(Math.round(bat.level * 100)));
        bat.addEventListener('chargingchange', () => setIsCharging(bat.charging));
      }).catch(() => {});
    }
  }, []);

  const checkAllStatus = useCallback(async () => {
    const relay = window.Capacitor?.Plugins?.NexusRelay;
    const incall = window.Capacitor?.Plugins?.NexusInCall;
    
    let smsOk = false;
    let dialerOk = false;
    let batOk = false;

    if (relay) {
      const s = await relay.checkStatus?.().catch(() => null);
      // `smsMonitoring` je nativně jen runtime oprávnění
      // (`smsState == PermissionState.GRANTED`), ne role výchozí SMS
      // aplikace. Samo o sobě tedy nestačí: 5. 11. 2026 měl telefon
      // všechna oprávnění udělená, roli držely Google Zprávy — a obrazovka
      // přesto hlásila „Oprávnění OK".
      const def = await relay.isDefaultSmsApp?.().catch(() => null);
      const jeVychozi = Boolean(def?.isDefault);
      setPermDefaultSms(jeVychozi);
      if (s) {
        smsOk = Boolean(s.smsMonitoring) && jeVychozi;
        setPermSms(smsOk);
      }
      const bat = await relay.checkBatteryOptimization?.().catch(() => null);
      if (bat) {
        batOk = Boolean(!bat.optimized);
        setIsBatOpt(batOk);
      }
    }
    
    if (incall) {
      const d = await incall.isDefaultDialer?.().catch(() => null);
      if (d) {
        // Když je GSM most vypnutý (výchozí stav — hovory vedeme přes SIP),
        // role výchozího vytáčeče se nevyžaduje. Bez tohohle by zůstala
        // navždy nesplněná a průvodce by nikdy neohlásil hotovo.
        dialerOk = d.featureEnabled === false ? true : Boolean(d.isDefault);
        setPermDialer(dialerOk);
      }
    }
    
    return { smsOk, dialerOk, batOk };
  }, []);

  const runSetupWizard = useCallback(async () => {
    if (setupRunning) return;
    setSetupRunning(true);
    try {
      const relay = window.Capacitor?.Plugins?.NexusRelay;
      const incall = window.Capacitor?.Plugins?.NexusInCall;
      if (!relay) return;

      // 1. Standard Permissions (SMS, Location, Phone)
      await relay.ensureReady?.().catch(() => null);
      
      // 2. Default SMS App
      // Podmínka tu dřív zněla `if (s && !s.smsMonitoring)`, tedy o roli
      // se žádalo JEN když chybělo runtime oprávnění. Jakmile ho uživatel
      // udělil, přestalo se na roli ptát úplně a telefon zůstal natrvalo
      // bez ní. Ptáme se vždycky, když ji nemáme.
      const defRes = await relay.isDefaultSmsApp?.().catch(() => null);
      if (defRes && !defRes.isDefault) {
        await relay.requestDefaultSmsApp?.().catch(() => null);
        await new Promise(r => setTimeout(r, 1000));
      }

      // 3. Výchozí vytáčeč — jen když je GSM most zapnutý.
      //
      // Hovory jdou přes SIP, takže o tuhle roli standardně nežádáme.
      // Dřív se dialog otevřel vždycky: uživatelka odklikávala nápadné
      // oprávnění pro funkci, která se nepoužije a která by hovor navíc
      // dodala jednosměrný (do WebRTC jde jen mikrofon telefonu).
      if (incall) {
        const d = await incall.isDefaultDialer?.().catch(() => null);
        if (d && d.featureEnabled !== false && !d.isDefault) {
          await incall.requestDefaultDialer?.().catch(() => null);
          await new Promise(r => setTimeout(r, 1000));
        }
      }

      // 4. Battery Optimization
      const bat = await relay.checkBatteryOptimization?.().catch(() => null);
      if (bat && bat.optimized) {
        await relay.requestIgnoreBatteryOptimization?.().catch(() => null);
        await new Promise(r => setTimeout(r, 1000));
      }

      const status = await checkAllStatus();
      if (!status.smsOk || !status.dialerOk || !status.batOk) {
        setSetupFailedCount(prev => prev + 1);
      } else {
        setSetupFailedCount(0);
      }
    } finally {
      setSetupRunning(false);
    }
  }, [checkAllStatus, setupRunning]);

  // Initial check and auto-prompt on mount
  React.useEffect(() => {
    checkAllStatus().then((status) => {
      // If any of the essential setup is missing, wait 1.5s then prompt
      if (!status.smsOk || !status.dialerOk || !status.batOk) {
        setTimeout(() => {
           runSetupWizard();
        }, 1500);
      }
    });
  }, [checkAllStatus, runSetupWizard]);

  // SIP calls
  const { sipState, sipIncomingCall, answer: sipAnswer, reject: sipReject, hangup: sipHangup } = useSipCall({
    operator, isActive, API_BASE, isNativeApp,
  });

  // Relay auth token + Socket.IO — needed to bridge GSM call audio to the web operator
  const relayAuthToken = operator?.token || tokenStore.getToken() || '';
  // Secret zařízení musí být reaktivní: přichází až z /device/verify, tedy po
  // prvním vykreslení. Kdyby se jen přečetl, configureRelay by ho nikdy
  // nedostal a služba na pozadí by zůstala u tokenu, co za hodinu vyprší.
  const relaySecret = tokenStore.useRelaySecret() || '';
  const relaySocket = useSocket(relayAuthToken);

  // GSM calls via InCallService — with WebRTC bridge config so an incoming GSM call
  // is streamed to the operator over WebRTC (offer/answer/ICE relayed via the server).
  const {
    callState: gsmCallState, incomingCall: gsmIncomingCall, callDuration: gsmCallDuration,
    answer: gsmAnswer, reject: gsmReject, hangup: gsmHangup,
    setMuted: gsmSetMuted, setSpeaker: gsmSetSpeaker,
    isFeatureEnabled: gsmBridgeEnabled,
  } = useInCallService({
    apiUrl: `${(API_BASE || '').replace(/\/api$/, '')}/api/device`,
    installationId: localStorage.getItem('nexus_installation_id') || operator?.installationId || '',
    secret: tokenStore.getRelaySecret() || operator?.token || '',
    socket: relaySocket,
    isActive,
  });

  // SMS relay
  const { incomingSms, clearIncomingSms, sendSms, configureRelay } = useSmsRelay({ operator, isActive, isNativeApp, API_BASE });

  React.useEffect(() => {
    if (isNativeApp && API_BASE && configureRelay) {
      configureRelay({
        baseUrl: `${API_BASE.replace(/\/api$/, '')}/api/device/relay`,
        deviceId: operator?.id || 'RELAY-DEVICE',
        installationId: localStorage.getItem('nexus_installation_id') || '',
        isActive: isActive,
        profileId: relayProfileId || '',
        authToken: relayAuthToken,
        // Viz RelayMode: authToken vyprší za hodinu, secret zařízení ne.
        deviceSecret: relaySecret || tokenStore.getRelaySecret() || ''
      }).catch(console.error);
    }
  }, [isNativeApp, API_BASE, isActive, operator, relayProfileId, relayAuthToken, relaySecret, configureRelay]);

  // Registrace FCM tokenu. Bez ní je pushová záloha pro odchozí SMS mrtvá:
  // server hledá pushDevice podle uživatele vazby, žádný nenajde a vrátí
  // { ok: false }. Nativní strana přitom `send_sms` přes FCM umí odbavit
  // i se zavřenou aplikací (NexusFcmService) — chyběl jen ten token.
  //
  // initPushNotifications se VOLÁ ZNOVU při každé změně tokenu. Registrace
  // se serverem chodí s přístupovým tokenem; když ten mezitím vypršel,
  // dotáhne se až tímhle opakovaným voláním.
  React.useEffect(() => {
    if (!isNativeApp || !API_BASE || !relayAuthToken) return;
    // Bez posluchače v JS: relay příkazy odbavuje nativní služba, aby to
    // fungovalo i tehdy, když aplikace vůbec neběží.
    initPushNotifications(API_BASE, relayAuthToken, () => {});
  }, [isNativeApp, API_BASE, relayAuthToken]);

  // Bind device with backend so SMS endpoints authorize this installationId
  React.useEffect(() => {
    const verifyDevice = async () => {
      try {
        if (!relayAuthToken) return;
        const url = API_BASE ? `${API_BASE.replace(/\/api$/, '')}/api/device/verify` : '/api/device/verify';
        const vr = await axios.post(url, {
          installationId: localStorage.getItem('nexus_installation_id'),
          profileId: relayProfileId,
          platform: isNativeApp ? 'android' : 'web',
          model: 'RelayApp',
          deviceName: 'Nexus Relay'
        }, {
          headers: { Authorization: `Bearer ${relayAuthToken}` }
        });
        // Ulož per-device relay secret (odvozený serverem) pro WebRTC signaling
        // a pro nativní službu, která ho používá místo vypršitelného tokenu.
        if (vr?.data?.deviceSecret) {
          tokenStore.setRelaySecret(vr.data.deviceSecret);
        }
      } catch (err) {
        console.error('Device binding failed:', err);
      }
    };
    if (isActive) verifyDevice();
  }, [API_BASE, relayAuthToken, relayProfileId, isActive, isNativeApp]);

  React.useEffect(() => {
    let listener;
    CapacitorApp.addListener('backButton', () => {
      if (showSms) {
        // RelaySmsModal has its own back handler that manages chat→list→close
        return;
      }
      if (showDialer) {
        setShowDialer(false);
      } else {
        CapacitorApp.exitApp();
      }
    }).then(l => listener = l);
    return () => {
      if (listener) listener.remove();
    };
  }, [showDialer, showSms]);

  const allSetupOk = permSms && permDialer && isBatOpt;

  return (
    <>
      {/* Incoming call modals */}
      <Suspense fallback={null}>
        {isInCallAvailable() && gsmBridgeEnabled && (gsmCallState === 'ringing' || gsmCallState === 'active') && (
          <IncomingCallModal
            incomingCall={gsmIncomingCall} callState={gsmCallState} callDuration={gsmCallDuration}
            onAnswer={gsmAnswer} onReject={gsmReject} onHangup={gsmHangup}
            onMute={gsmSetMuted} onSpeaker={gsmSetSpeaker} lang={lang}
          />
        )}
        {/* Relay nikdo neobsluhuje, takže se u každé zprávy neotvírá celé okno —
            jen oznámení, které samo zmizí. Odpovědět jde po klepnutí. */}
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
            onReply={text => sendSms(odpovidamNa.from, text)}
            lang={lang}
          />
        )}
        {sipState === 'ringing' && sipIncomingCall && (
          <IncomingCallScreen caller={sipIncomingCall.caller || sipIncomingCall.callerId} profileName={sipIncomingCall.callerName} onAnswer={sipAnswer} onReject={sipReject} />
        )}
        {sipState === 'in_call' && (
          <ActiveCallScreen caller={sipIncomingCall?.caller || 'SIP'} profileName={sipIncomingCall?.callerName} onEnd={sipHangup} />
        )}
      </Suspense>

      {/* Main UI */}
      <style>{`
        @keyframes pulseIndicator {
          0% { box-shadow: 0 0 0 0 rgba(74, 222, 128, 0.4); }
          70% { box-shadow: 0 0 0 15px rgba(74, 222, 128, 0); }
          100% { box-shadow: 0 0 0 0 rgba(74, 222, 128, 0); }
        }
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(10px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
      <div style={{
        minHeight: '100dvh',
        background: 'linear-gradient(180deg, #0f172a 0%, #020617 100%)',
        color: 'white',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '3.5rem 1.5rem',
        boxSizing: 'border-box'
      }}>
        
        {/* Header/Identity */}
        <div style={{ textAlign: 'center', marginBottom: '3rem', animation: 'fadeIn 0.6s ease-out' }}>
          <div style={{
             width: '88px', height: '88px', borderRadius: '50%',
             background: 'linear-gradient(135deg, rgba(59,130,246,0.15) 0%, rgba(37,99,235,0.05) 100%)',
             border: '1px solid rgba(59,130,246,0.3)',
             boxShadow: '0 8px 32px rgba(59,130,246,0.15)',
             display: 'flex', alignItems: 'center', justifyContent: 'center',
             margin: '0 auto 1.5rem', color: '#60a5fa'
          }}>
            <Smartphone size={40} strokeWidth={1.5} />
          </div>
          <h2 style={{ fontSize: '1.75rem', fontWeight: '800', letterSpacing: '-0.02em', margin: '0 0 0.5rem 0' }}>Nexus Relay</h2>
          <div style={{ fontSize: '0.95rem', color: '#94a3b8', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }}>
            {lang === 'cz' ? 'Přihlášen:' : 'Signed in:'}
            <span style={{ color: '#f8fafc', fontWeight: '600', padding: '0.25rem 0.75rem', background: 'rgba(255,255,255,0.08)', borderRadius: '20px', letterSpacing: '0.02em' }}>
              {operator?.name || operator?.email || 'Modelka'}
            </span>
          </div>
          {/* Bez prirazeneho profilu relay nestahne frontu odchozich zprav:
              posle `?profileId=` a server odpovi HTTP 400. Driv to obrazovka
              nijak nerekla a hlasila „AKTIVNÍ" dal, takze telefon mohl takhle
              stat tydny. 5. 11. 2026 to stalo cely vecer hledani. */}
          {!operator?.profileId && (
            <div style={{ marginTop: '0.75rem', padding: '0.6rem 0.9rem', borderRadius: '12px',
              background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.35)',
              color: '#fca5a5', fontSize: '0.8rem', fontWeight: '600', maxWidth: '320px' }}>
              {lang === 'cz'
                ? 'Tomuto účtu není přiřazený profil. Odchozí zprávy nebudou chodit.'
                : 'No profile assigned to this account. Outgoing messages will not arrive.'}
            </div>
          )}
        </div>

        {/* Main Status Card */}
        <div style={{
          width: '100%', maxWidth: '340px',
          padding: '2rem 1.5rem', borderRadius: '24px',
          background: isActive ? 'linear-gradient(145deg, rgba(34,197,94,0.1) 0%, rgba(21,128,61,0.02) 100%)' : 'linear-gradient(145deg, rgba(239,68,68,0.1) 0%, rgba(185,28,28,0.02) 100%)',
          border: `1px solid ${isActive ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.2)'}`,
          boxShadow: `0 8px 32px ${isActive ? 'rgba(34,197,94,0.05)' : 'rgba(239,68,68,0.05)'}`,
          backdropFilter: 'blur(10px)',
          textAlign: 'center',
          marginBottom: '2rem',
          transition: 'all 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
          animation: 'fadeIn 0.7s ease-out'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.75rem', marginBottom: '1rem' }}>
            <div style={{
              width: '12px', height: '12px', borderRadius: '50%',
              background: isActive ? '#4ade80' : '#f87171',
              animation: isActive ? 'pulseIndicator 2s infinite' : 'none'
            }} />
            <span style={{ fontWeight: '700', fontSize: '1.15rem', color: isActive ? '#4ade80' : '#f87171', letterSpacing: '0.05em' }}>
              {isActive ? (lang === 'cz' ? 'AKTIVNÍ' : 'ACTIVE') : (lang === 'cz' ? 'POZASTAVENO' : 'PAUSED')}
            </span>
          </div>
          <p style={{ fontSize: '0.9rem', color: '#cbd5e1', margin: 0, lineHeight: 1.6 }}>
            {lang === 'cz'
              ? 'Telefon automaticky přeposílá SMS zprávy a hovory do systému Nexus.'
              : 'This phone is automatically forwarding SMS and calls to the Nexus system.'}
          </p>
        </div>

        {/* System Indicators */}
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '1rem',
          width: '100%', maxWidth: '340px',
          animation: 'fadeIn 0.8s ease-out'
        }}>
          {/* Battery */}
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.6rem',
            padding: '1.25rem 1rem', borderRadius: '20px', background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.05)'
          }}>
            <Battery size={26} color={batteryLevel > 20 ? '#4ade80' : '#f87171'} strokeWidth={1.5} />
            <span style={{ fontSize: '0.85rem', color: '#cbd5e1', fontWeight: '500' }}>{batteryLevel}% {isCharging && '⚡'}</span>
          </div>

          {/* Setup / Config */}
          <div
            onClick={runSetupWizard}
            style={{
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.6rem',
              padding: '1.25rem 1rem', borderRadius: '20px',
              background: allSetupOk ? 'rgba(34,197,94,0.05)' : 'rgba(239,68,68,0.08)',
              border: `1px solid ${allSetupOk ? 'rgba(34,197,94,0.2)' : 'rgba(239,68,68,0.3)'}`,
              cursor: 'pointer', transition: 'all 0.2s'
            }}
          >
            <ShieldCheck size={26} color={allSetupOk ? '#4ade80' : '#f87171'} strokeWidth={1.5} />
            <span style={{ fontSize: '0.85rem', color: allSetupOk ? '#4ade80' : '#f87171', fontWeight: '600', textAlign: 'center' }}>
              {allSetupOk
                ? 'Oprávnění OK'
                : setupRunning
                  ? 'Nastavuji...'
                  : !permDefaultSms
                    ? 'Nejsem výchozí SMS aplikace'
                    : 'Chyba v nastavení'}
            </span>
          </div>
        </div>

        {/* Permission Fix Button */}
        {!allSetupOk && setupFailedCount > 0 && (
          <div style={{ width: '100%', maxWidth: '340px', marginTop: '1rem', animation: 'fadeIn 0.5s ease-out' }}>
            <button
              onClick={() => {
                const relay = window.Capacitor?.Plugins?.NexusRelay;
                if (relay?.openAppSettings) relay.openAppSettings();
              }}
              style={{
                width: '100%', padding: '1rem', borderRadius: '16px',
                background: 'rgba(245, 158, 11, 0.1)', border: '1px solid rgba(245, 158, 11, 0.3)',
                color: '#f59e0b', fontWeight: '600', fontSize: '0.9rem',
                display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.4rem',
                cursor: 'pointer', transition: 'all 0.2s'
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <Settings size={18} />
                <span>{lang === 'cz' ? 'Otevřít nastavení aplikace' : 'Open App Settings'}</span>
              </div>
              <span style={{ fontSize: '0.75rem', opacity: 0.8, textAlign: 'center', fontWeight: 'normal', marginTop: '0.2rem' }}>
                {lang === 'cz' 
                  ? 'Pokud systém blokuje oprávnění, otevřete nastavení, klikněte na tři tečky nahoře a zvolte "Povolit omezená nastavení".' 
                  : 'If permissions are blocked, open settings, tap the three dots menu and choose "Allow restricted settings".'}
              </span>
            </button>
          </div>
        )}

        {/* Action Buttons */}
        <div style={{ width: '100%', maxWidth: '340px', display: 'flex', flexDirection: 'column', gap: '1rem', marginTop: '1.5rem', animation: 'fadeIn 0.9s ease-out' }}>
          <button
            onClick={() => setIsActive(v => !v)}
            style={{
              padding: '1.15rem', borderRadius: '18px',
              background: isActive ? 'rgba(255,255,255,0.05)' : '#3b82f6',
              border: isActive ? '1px solid rgba(255,255,255,0.1)' : 'none',
              color: 'white', fontWeight: '600', fontSize: '1rem',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.6rem',
              cursor: 'pointer', transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
              boxShadow: isActive ? 'none' : '0 8px 25px rgba(59,130,246,0.4)'
            }}
          >
            {isActive ? <Pause size={20} strokeWidth={2.5} /> : <Play size={20} strokeWidth={2.5} />}
            {isActive ? (lang === 'cz' ? 'Pozastavit Relay' : 'Pause Relay') : (lang === 'cz' ? 'Spustit Relay' : 'Start Relay')}
          </button>

          <button
            onClick={onLogout}
            style={{
              padding: '1.15rem', borderRadius: '18px',
              background: 'transparent',
              border: '1px solid rgba(239,68,68,0.3)',
              color: '#f87171', fontWeight: '600', fontSize: '1rem',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer', transition: 'all 0.2s',
              opacity: 0.8
            }}
          >
            {lang === 'cz' ? 'Odhlásit zařízení' : 'Logout device'}
          </button>
        </div>

        {/* Dummy features for Google Play compliance */}
        <div style={{ width: '100%', maxWidth: '340px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginTop: '1.5rem', animation: 'fadeIn 1s ease-out' }}>
          <button
            onClick={() => setShowDialer(true)}
            style={{
              padding: '1rem', borderRadius: '16px',
              background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)',
              color: '#94a3b8', fontSize: '0.85rem', fontWeight: '500',
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem',
              cursor: 'pointer'
            }}
          >
            <Smartphone size={20} />
            {lang === 'cz' ? 'Číselník' : 'Dialer'}
          </button>
          
          <button
            onClick={() => setShowSms(true)}
            style={{
              padding: '1rem', borderRadius: '16px',
              background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)',
              color: '#94a3b8', fontSize: '0.85rem', fontWeight: '500',
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem',
              cursor: 'pointer'
            }}
          >
            <Mail size={20} />
            {lang === 'cz' ? 'Zprávy' : 'Messages'}
          </button>
        </div>
      </div>
      
      <Suspense fallback={null}>
        <RelayDialerModal isOpen={showDialer} onClose={() => setShowDialer(false)} />
        <RelaySmsModal isOpen={showSms} onClose={() => setShowSms(false)} />
      </Suspense>
    </>
  );
}
// ── Toast renderer ────────────────────────────────────────────────────────────
const RelayToasts = () => {
  const { toasts } = useRelay();
  if (!toasts || toasts.length === 0) return null;
  return (
    <div style={{
      position: 'fixed', top: 'calc(1rem + env(safe-area-inset-top, 0px))',
      left: '50%', transform: 'translateX(-50%)',
      zIndex: 999999, display: 'flex', flexDirection: 'column', gap: '0.5rem',
      width: 'calc(100% - 2rem)', maxWidth: '360px', pointerEvents: 'none'
    }}>
      {toasts.map(t => (
        <div key={t.id} style={{
          padding: '0.9rem 1.2rem',
          borderRadius: '14px',
          background: t.type === 'error' ? 'rgba(239,68,68,0.92)'
            : t.type === 'success' ? 'rgba(34,197,94,0.92)'
            : 'rgba(30,41,59,0.95)',
          color: 'white',
          fontSize: '0.95rem',
          fontWeight: '600',
          boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
          backdropFilter: 'blur(10px)',
          textAlign: 'center',
          animation: 'fadeIn 0.2s ease-out'
        }}>
          {t.message}
        </div>
      ))}
    </div>
  );
};

// ── Root ─────────────────────────────────────────────────────────────────────
const RelayApp = () => {
  const { isLoggedIn } = useRelay();

  return (
    <>
      <GlobalAppStyles />
      <RelayToasts />
      {isLoggedIn ? <RelayDashboard /> : <RelayLoginScreen />}
    </>
  );
};

export default RelayApp;
