import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import FeatureLock from '../FeatureLock';
import TrackingSetupGuide from './TrackingSetupGuide';
import { getTrackingReadiness, isReadinessBlocking } from '../../services/trackingReadiness';
import { Shield, Clock, CheckCircle, LogOut, Zap, Mic, MicOff, Battery, Phone, PhoneOff, UserCheck, XCircle, Bluetooth, Activity, Settings, ChevronDown, Volume2 } from 'lucide-react';
import { useNexus } from '../../context/ContextHook';

const SafetyControlCard = () => {
  const { 
    t, lang, isMobile, sosActive, linkedSessionId, checkinMinutes, setCheckinMinutes,
    checkinTimerEnd, checkinRemaining, triggerSOS, cancelSOS, 
    startCheckinTimer, resetCheckinTimer, confirmDeparture,
    SAFETY_SUGGESTIONS, onDelayBooking,
    linkedTrackerId, lastTrackerUpdate, voiceGuardianActive, handleToggleVoiceGuardian,
    batteryLevel, incomingGhostCall, setIncomingGhostCall, ghostCallScheduledAt, triggerGhostCall, verifyIdentity,
    heartRate, hrThreshold, setHrThreshold, isBluetoothConnected, setIsBluetoothConnected,
    audioSentinelActive, setAudioSentinelActive, showToast,
    manualTrackingOn, setManualTracking, phoneTrackingActive, phoneTrackingError
  } = useNexus();

  const isCz = lang === 'cz' || lang === 'cs';
  const suggestions = SAFETY_SUGGESTIONS || ['15m', '30m', '45m', '60m', '1.5h', '2h'];

  // Průvodce nastavením sledování polohy. Zapnout tracking bez potřebných oprávnění
  // by znamenalo, že se tiše zastaví — u bezpečnostní funkce nepřípustné, takže
  // uživatele nejdřív provedeme nastavením a teprve pak přepneme.
  const [showTrackingSetup, setShowTrackingSetup] = useState(false);

  const handleTrackingToggle = async () => {
    if (!setManualTracking) return;
    if (manualTrackingOn) { setManualTracking(false); return; }   // vypnout jde vždy
    const readiness = await getTrackingReadiness();
    if (isReadinessBlocking(readiness)) { setShowTrackingSetup(true); return; }
    setManualTracking(true);
  };

  const handleSuggestionClick = (s) => {
    let mins = 60;
    if (s.includes('m')) mins = parseInt(s);
    if (s.includes('h')) mins = parseFloat(s) * 60;
    setCheckinMinutes(mins);
  };

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  const formatRemaining = (ms) => {
    const totalSeconds = Math.floor(ms / 1000);
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  };

  return (
    <div className="glass-card" style={{ 
      padding: isMobile ? '1.25rem' : '1.5rem', 
      borderRadius: '24px', 
      background: sosActive ? 'rgba(239,68,68,0.08)' : 'rgba(255,255,255,0.02)', 
      border: `1px solid ${sosActive ? 'rgba(239,68,68,0.3)' : 'var(--card-border)'}`,
      display: 'flex',
      flexDirection: 'column',
      gap: '1rem',
      transition: 'all 0.3s ease'
    }}>
      {/* Battery & Signal Overview */}
      <div style={{ display: 'flex', gap: '0.75rem', marginBottom: '0.75rem' }}>
        <div style={{ flex: 1, background: 'rgba(255,255,255,0.03)', padding: '0.75rem', borderRadius: '12px', display: 'flex', alignItems: 'center', gap: '0.5rem', border: '1px solid rgba(255,255,255,0.05)' }}>
          <Battery size={14} color={batteryLevel <= 15 ? '#ef4444' : '#22c55e'} />
          <div style={{ fontSize: '0.7rem', fontWeight: 600 }}>{batteryLevel || 100}% {isCz ? 'Baterie' : 'Battery'}</div>
        </div>
        <div style={{ flex: 1, background: 'rgba(255,255,255,0.03)', padding: '0.75rem', borderRadius: '12px', display: 'flex', alignItems: 'center', gap: '0.5rem', border: '1px solid rgba(255,255,255,0.05)' }}>
          <Zap size={14} color="#3b82f6" />
          <div style={{ fontSize: '0.7rem', fontWeight: 600 }}>{isCz ? 'Systém' : 'System'} {t('secure')}</div>
        </div>
      </div>

      {/* Tracker Status Line if Linked */}
      {linkedTrackerId && (
        <div style={{ 
          fontSize: '0.75rem', 
          background: 'rgba(34, 197, 94, 0.05)', 
          padding: '0.6rem 0.8rem', 
          borderRadius: '12px', 
          display: 'flex', 
          alignItems: 'center', 
          justifyContent: 'space-between',
          border: '1px solid rgba(34, 197, 94, 0.1)'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#22c55e', fontWeight: 700 }}>
             <div style={{ 
               width: '8px', height: '8px', borderRadius: '50%', background: '#22c55e',
               animation: (lastTrackerUpdate && (now - lastTrackerUpdate < 45000)) ? 'pulse-signal 1.5s infinite' : 'none'
             }} />
             {isCz ? 'Zdroj: Tracker' : 'Source: Tracker'}
          </div>
          <div style={{ color: 'var(--text-secondary)', fontSize: '0.65rem' }}>
            {lastTrackerUpdate 
              ? (isCz ? `Aktivní před ${Math.floor((now - lastTrackerUpdate)/1000)}s` : `Active ${Math.floor((now - lastTrackerUpdate)/1000)}s ago`)
              : (isCz ? 'Čekání na signál...' : 'Waiting for signal...')}
          </div>
        </div>
      )}

      <style>{`
        @keyframes pulse-signal {
          0% { transform: scale(1); opacity: 1; box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.7); }
          70% { transform: scale(1.1); opacity: 0.8; box-shadow: 0 0 0 6px rgba(34, 197, 94, 0); }
          100% { transform: scale(1); opacity: 1; box-shadow: 0 0 0 0 rgba(34, 197, 94, 0); }
        }
      `}</style>

      {linkedSessionId && !sosActive && (
        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '-0.5rem', marginBottom: '0.5rem' }}>
          <button 
            onClick={() => onDelayBooking(linkedSessionId, 15)}
            style={{ flex: 1, padding: '0.5rem', borderRadius: '10px', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--card-border)', color: 'var(--text-secondary)', fontSize: '0.7rem', fontWeight: '800', cursor: 'pointer' }}
          >
            {isCz ? '+15m Odložit' : '+15m Delay'}
          </button>
          <button 
            onClick={() => onDelayBooking(linkedSessionId, 30)}
            style={{ flex: 1, padding: '0.5rem', borderRadius: '10px', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--card-border)', color: 'var(--text-secondary)', fontSize: '0.7rem', fontWeight: '800', cursor: 'pointer' }}
          >
            {isCz ? '+30m Odložit' : '+30m Delay'}
          </button>
        </div>
      )}

      {/* SOS Button */}
      <button
        onClick={async () => {
          if (sosActive) {
            const ok = await verifyIdentity();
            if (ok) cancelSOS();
          } else {
            triggerSOS('manual');
          }
        }}
        style={{
          width: '100%', 
          // Android parametry ze zadání: primární akce 52–104 px. Dřív se výška
          // odvíjela jen z paddingu, takže při menším písmu spadla pod 52.
          minHeight: '76px',
          padding: '1rem 1.25rem', 
          borderRadius: '18px',
          // Bez gradientu. Zadání ho pro Android zakazuje a má pravdu: plná barva
          // je čitelnější na levném displeji v přímém slunci, kde se tenhle
          // telefon nejspíš používá.
          background: sosActive ? 'rgba(239, 68, 68, 0.1)' : '#ef4444',
          border: sosActive ? '1px solid #ef4444' : 'none', 
          color: sosActive ? '#ef4444' : 'white', 
          fontWeight: 900,
          cursor: 'pointer',
          boxShadow: 'none',
          transition: 'all 0.2s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '0.75rem'
        }}
        className={sosActive ? '' : 'pulse-subtle'}
      >
        <Shield size={26} fill={sosActive ? 'none' : 'white'} fillOpacity={0.2} style={{ flex: 'none' }} />
        {/* Česky i anglicky naráz, ne jedno nebo druhé podle nastavení telefonu.
            Modelka může být cizinka s česky nastaveným mobilem — a naopak. Ve
            chvíli, kdy tohle tlačítko mačká, není čas luštit jazyk. */}
        <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', lineHeight: 1.15 }}>
          <span style={{ fontSize: '1.2rem' }}>
            {sosActive ? 'ZRUŠIT SOS' : 'NOUZOVÉ SOS'}
          </span>
          <span style={{ fontSize: '0.7rem', fontWeight: 600, opacity: 0.85, fontFamily: 'ui-monospace, monospace', letterSpacing: '0.06em' }}>
            {sosActive ? 'CANCEL SOS' : 'EMERGENCY SOS'}
          </span>
        </span>
      </button>

      {/* Voice Guardian & Audio Sentinel.
          Voice SOS je uzamčené: přepínač zatím jen požádá o mikrofon, žádné
          rozpoznávání bezpečnostního slova neexistuje — modelka by spoléhala
          na hlídání, které neprobíhá. */}
      <div style={{ display: 'flex', gap: '0.75rem' }}>
        <div style={{ flex: 1 }}>
        <FeatureLock featureKey="voice-sos" compact>
        <div
          onClick={handleToggleVoiceGuardian}
          style={{ 
            flex: 1,
            fontSize: '0.75rem', 
            background: voiceGuardianActive ? 'rgba(59, 130, 246, 0.1)' : 'rgba(255, 255, 255, 0.03)', 
            padding: '1rem', 
            borderRadius: '20px', 
            display: 'flex', 
            flexDirection: 'column',
            gap: '0.5rem',
            border: voiceGuardianActive ? '1px solid rgba(59, 130, 246, 0.3)' : '1px solid rgba(255, 255, 255, 0.05)',
            cursor: 'pointer',
            transition: 'all 0.3s ease'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ 
              width: '32px', height: '32px', borderRadius: '10px', 
              background: voiceGuardianActive ? '#3b82f6' : 'rgba(255,255,255,0.05)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: voiceGuardianActive ? 'white' : 'var(--text-secondary)'
            }}>
              {voiceGuardianActive ? <Mic size={16} /> : <MicOff size={16} />}
            </div>
            <div style={{ 
              width: '32px', height: '18px', borderRadius: '20px', 
              background: voiceGuardianActive ? '#3b82f6' : 'rgba(255,255,255,0.1)',
              position: 'relative'
            }}>
              <div style={{ 
                width: '12px', height: '12px', borderRadius: '50%', background: 'white',
                position: 'absolute', top: '3px', left: voiceGuardianActive ? '17px' : '3px',
                transition: 'all 0.3s ease'
              }} />
            </div>
          </div>
          <div>
            <div style={{ fontWeight: 800, color: voiceGuardianActive ? 'white' : 'var(--text-secondary)' }}>{t('voiceGuardian')}</div>
            <div style={{ fontSize: '0.6rem', opacity: 0.6 }}>{voiceGuardianActive ? (isCz ? 'Aktivně naslouchá' : 'Listening...') : (isCz ? 'Hlasové SOS' : 'Voice activation')}</div>
          </div>
        </div>
        </FeatureLock>
        </div>

        <div
          onClick={() => setAudioSentinelActive(!audioSentinelActive)}
          style={{ 
            flex: 1,
            fontSize: '0.75rem', 
            background: audioSentinelActive ? 'rgba(16, 185, 129, 0.1)' : 'rgba(255, 255, 255, 0.03)', 
            padding: '1rem', 
            borderRadius: '20px', 
            display: 'flex', 
            flexDirection: 'column',
            gap: '0.5rem',
            border: audioSentinelActive ? '1px solid rgba(16, 185, 129, 0.3)' : '1px solid rgba(255, 255, 255, 0.05)',
            cursor: 'pointer',
            transition: 'all 0.3s ease'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ 
              width: '32px', height: '32px', borderRadius: '10px', 
              background: audioSentinelActive ? '#10b981' : 'rgba(255,255,255,0.05)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: audioSentinelActive ? 'white' : 'var(--text-secondary)'
            }}>
              <Volume2 size={16} />
            </div>
            <div style={{ 
              width: '32px', height: '18px', borderRadius: '20px', 
              background: audioSentinelActive ? '#10b981' : 'rgba(255,255,255,0.1)',
              position: 'relative'
            }}>
              <div style={{ 
                width: '12px', height: '12px', borderRadius: '50%', background: 'white',
                position: 'absolute', top: '3px', left: audioSentinelActive ? '17px' : '3px',
                transition: 'all 0.3s ease'
              }} />
            </div>
          </div>
          <div>
            <div style={{ fontWeight: 800, color: audioSentinelActive ? 'white' : 'var(--text-secondary)' }}>Sentinel</div>
            <div style={{ fontSize: '0.6rem', opacity: 0.6 }}>{audioSentinelActive ? (isCz ? 'Audio dohled zapnut' : 'Audio pulse on') : (isCz ? 'Tichý dohled' : 'Silent monitor')}</div>
          </div>
        </div>
      </div>

      {voiceGuardianActive && (
        <div style={{ 
          background: 'rgba(59, 130, 246, 0.05)', 
          padding: '0.75rem', 
          borderRadius: '12px', 
          fontSize: '0.65rem',
          border: '1px solid rgba(59, 130, 246, 0.1)'
        }}>
          <div style={{ fontWeight: 800, color: '#3b82f6', marginBottom: '0.4rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            {isCz ? 'Aktivní klíčová slova' : 'Active Keywords'}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
            {['HELP', 'POMOC', 'SOS', 'STOP', 'POLICIE'].map(k => (
              <span key={k} style={{ background: 'rgba(59, 130, 246, 0.1)', padding: '2px 6px', borderRadius: '4px', color: 'white', fontWeight: 600 }}>{k}</span>
            ))}
          </div>
        </div>
      )}

      {!sosActive && (
        <FeatureLock featureKey="ghost-call" compact>
        <div
          onClick={() => {
            const scenarios = [
              { name: isCz ? 'Agency HQ' : 'Agency HQ', icon: Shield },
              { name: isCz ? 'Máma' : 'Mom', icon: UserCheck },
              { name: isCz ? 'Taxi Dispečink' : 'Taxi Dispatch', icon: Phone }
            ];
            const sc = scenarios[Math.floor(Math.random() * scenarios.length)];
            triggerGhostCall(10);
            showToast(isCz ? `Simulace hovoru: ${sc.name}` : `Simulating call from: ${sc.name}`, 'info');
          }}
          style={{ 
            marginTop: '1rem',
            background: ghostCallScheduledAt ? 'rgba(245, 158, 11, 0.1)' : 'rgba(255,255,255,0.03)', 
            padding: '1rem', 
            borderRadius: '16px', 
            border: ghostCallScheduledAt ? '1px solid rgba(245, 158, 11, 0.3)' : '1px solid rgba(255,255,255,0.05)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            cursor: ghostCallScheduledAt ? 'default' : 'pointer'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.8rem' }}>
            <div style={{ width: '36px', height: '36px', borderRadius: '50%', background: 'rgba(245, 158, 11, 0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#f59e0b' }}>
              <Phone size={18} />
            </div>
            <div>
              <div style={{ fontSize: '0.85rem', fontWeight: 700, color: 'white' }}>{t('ghostCall')}</div>
              <div style={{ fontSize: '0.65rem', color: 'var(--text-secondary)' }}>
                {ghostCallScheduledAt 
                  ? (isCz ? `Vyzvánění začne za ${Math.ceil((ghostCallScheduledAt - now)/1000)}s` : `Calling in ${Math.ceil((ghostCallScheduledAt - now)/1000)}s`)
                  : t('ghostCallDesc')}
              </div>
            </div>
          </div>
          {!ghostCallScheduledAt && <ChevronDown size={16} color="var(--text-secondary)" style={{ transform: 'rotate(-90deg)' }} />}
        </div>
        </FeatureLock>
      )}

      {/* Ghost Call Fullscreen Overlay */}
      {/* Přes PORTÁL do <body>: obrazovka hovoru je vnořená v kartě s `backdrop-filter`
          (.glass-card), a ta pro position:fixed vytváří kotvicí blok — „celoobrazovkový"
          hovor se pak vykreslil jen uvnitř kartičky. U fantomového hovoru je věrohodnost
          celý smysl funkce: musí vypadat jako skutečný příchozí hovor, ne jako okénko. */}
      {incomingGhostCall && createPortal((
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'linear-gradient(to bottom, #1a1a2e, #16213e)',
          zIndex: 999999, display: 'flex', flexDirection: 'column', alignItems: 'center',
          justifyContent: 'space-between', padding: '4rem 2rem'
        }}>
          <div style={{ textAlign: 'center' }}>
             <div style={{ width: '80px', height: '80px', borderRadius: '50%', background: 'rgba(255,255,255,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 1.5rem', border: '1px solid rgba(255,255,255,0.2)' }}>
                <UserCheck size={40} color="white" />
             </div>
             <div style={{ fontSize: '1.5rem', fontWeight: 800, color: 'white', marginBottom: '0.5rem' }}>AGENCY RELAY</div>
             <div style={{ fontSize: '0.9rem', color: 'rgba(255,255,255,0.6)', letterSpacing: '2px' }}>INCOMING CALL...</div>
          </div>

          <div style={{ display: 'flex', gap: '4rem' }}>
             <div onClick={() => setIncomingGhostCall(false)} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem' }}>
                <div style={{ width: '64px', height: '64px', borderRadius: '50%', background: '#ef4444', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', cursor: 'pointer', boxShadow: '0 0 20px rgba(239, 68, 68, 0.4)' }}>
                   <PhoneOff size={28} />
                </div>
                <div style={{ fontSize: '0.75rem', color: 'white', fontWeight: 600 }}>Decline</div>
             </div>
             <div onClick={() => setIncomingGhostCall(false)} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '0.5rem' }}>
                <div style={{ width: '64px', height: '64px', borderRadius: '50%', background: '#22c55e', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', cursor: 'pointer', boxShadow: '0 0 20px rgba(34, 197, 94, 0.4)' }}>
                   <Phone size={28} />
                </div>
                <div style={{ fontSize: '0.75rem', color: 'white', fontWeight: 600 }}>Accept</div>
             </div>
          </div>
        </div>
      ), document.body)}

      {/* Sledování polohy — manuální přepínač (B). Automaticky se navíc zapne během
          check-inu (A) i při SOS (C). Uzamčeno přes FeatureLock, dokud není
          background tracking ověřený na zařízení (bezpečnostní funkce). */}
      <FeatureLock featureKey="phone-tracking" compact>
      <button
        onClick={handleTrackingToggle}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          width: '100%', padding: '0.7rem 0.9rem', marginBottom: '0.75rem',
          borderRadius: '12px', cursor: 'pointer',
          background: manualTrackingOn ? 'rgba(34, 197, 94, 0.1)' : 'rgba(255,255,255,0.04)',
          border: `1px solid ${manualTrackingOn ? 'rgba(34, 197, 94, 0.3)' : 'rgba(255,255,255,0.1)'}`,
          color: 'white', textAlign: 'left'
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
          <span style={{ fontWeight: 700, fontSize: '0.85rem' }}>
            {lang === 'cz' ? 'Sledovat moji polohu' : 'Track my location'}
          </span>
          {/*
            Hlásí STAV, ne přání. Dokud se chyba spárování polykala, stálo tu
            „Poloha se odesílá" i ve chvíli, kdy server o telefonu nevěděl.
          */}
          <span style={{
            fontSize: '0.65rem',
            color: phoneTrackingActive && phoneTrackingError ? 'var(--error-color)' : 'var(--text-secondary)'
          }}>
            {phoneTrackingActive && phoneTrackingError
              ? (isCz ? '▲ Poloha se NEodesílá — nahlas to agentuře' : '▲ Location NOT sending — tell the agency')
              : phoneTrackingActive
                ? (isCz ? '● Poloha se odesílá' : '● Sending location')
                : (isCz ? 'Zapíná se i při check-inu a SOS' : 'Also on during check-in & SOS')}
          </span>
        </div>
        <div style={{
          width: 40, height: 22, borderRadius: 11, flexShrink: 0, position: 'relative',
          background: manualTrackingOn ? 'var(--success-color)' : 'rgba(255,255,255,0.15)',
          transition: 'background 0.2s'
        }}>
          <div style={{
            position: 'absolute', top: 2, left: manualTrackingOn ? 20 : 2,
            width: 18, height: 18, borderRadius: '50%', background: '#fff', transition: 'left 0.2s'
          }} />
        </div>
      </button>
      </FeatureLock>

      {showTrackingSetup && (
        <TrackingSetupGuide
          isCz={isCz}
          onClose={() => setShowTrackingSetup(false)}
          onReady={() => { setShowTrackingSetup(false); setManualTracking && setManualTracking(true); }}
        />
      )}

      {/* Check-in Timer Controls */}
      <div style={{ background: 'rgba(255,255,255,0.02)', padding: '1rem', borderRadius: '16px', border: '1px solid rgba(255,255,255,0.05)' }}>
        {!checkinTimerEnd ? (
          <>
            <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', marginBottom: '0.75rem' }}>
              <div style={{ position: 'relative', flex: 1 }}>
                <input
                  type="number" min="5" max="480" value={checkinMinutes}
                  onChange={_err => setCheckinMinutes(Math.max(5, Math.min(480, Number(_err.target.value))))}
                  style={{ 
                    width: '100%', 
                    padding: '0.8rem 1rem', 
                    borderRadius: '12px', 
                    background: 'rgba(0,0,0,0.2)', 
                    border: '1px solid rgba(255,255,255,0.1)', 
                    color: 'white', 
                    fontSize: '1rem', 
                    fontWeight: '700',
                    outline: 'none'
                  }}
                />
                <span style={{ position: 'absolute', right: '1rem', top: '50%', transform: 'translateY(-50%)', fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: '800' }}>min</span>
              </div>
              <button 
                onClick={() => startCheckinTimer()} 
                style={{
                  padding: '0.8rem 1.5rem', 
                  borderRadius: '12px',
                  background: 'var(--accent-color)', 
                  border: 'none',
                  color: 'white', 
                  fontWeight: '800', 
                  fontSize: '0.9rem', 
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem'
                }}
              >
                <Clock size={18} />
                {isCz ? 'Start' : 'Start'}
              </button>
            </div>
            
            <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
              {suggestions.map(s => (
                <button
                  key={s}
                  onClick={() => handleSuggestionClick(s)}
                  style={{
                    padding: '0.35rem 0.65rem',
                    borderRadius: '8px',
                    background: 'rgba(255,255,255,0.05)',
                    border: '1px solid rgba(255,255,255,0.1)',
                    color: 'var(--text-secondary)',
                    fontSize: '0.7rem',
                    fontWeight: '700',
                    cursor: 'pointer'
                  }}
                >
                  {s}
                </button>
              ))}
            </div>
          </>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '1rem' }}>
              <div style={{ 
                fontSize: '2.5rem', 
                fontWeight: '900', 
                color: checkinRemaining && checkinRemaining < 120000 ? '#ef4444' : 'var(--accent-color)', 
                fontFamily: 'monospace',
                letterSpacing: '0.05em'
              }}>
                {checkinRemaining ? formatRemaining(checkinRemaining) : '--:--'}
              </div>
            </div>
            
            <div style={{ display: 'grid', gridTemplateColumns: linkedSessionId ? '1fr 1fr' : '1fr', gap: '0.75rem' }}>
              <button 
                onClick={resetCheckinTimer} 
                style={{
                  padding: '0.9rem', 
                  borderRadius: '12px',
                  background: 'rgba(34, 197, 94, 0.15)', 
                  border: '1px solid rgba(34, 197, 94, 0.3)',
                  color: '#22c55e', 
                  fontWeight: '900', 
                  fontSize: '0.9rem', 
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '0.5rem'
                }}
              >
                <CheckCircle size={18} />
                {isCz ? 'JSEM OK' : 'I\'M OK'}
              </button>
              
              {linkedSessionId && (
                <button 
                  onClick={confirmDeparture} 
                  style={{
                    padding: '0.9rem', 
                    borderRadius: '12px',
                    background: 'rgba(59, 130, 246, 0.15)', 
                    border: '1px solid rgba(59, 130, 246, 0.3)',
                    color: '#3b82f6', 
                    fontWeight: '900', 
                    fontSize: '0.9rem', 
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: '0.5rem'
                  }}
                >
                  <LogOut size={18} />
                  {isCz ? 'KLIENT ODEŠEL' : 'CLIENT LEFT'}
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      <div style={{ padding: '1rem', background: 'rgba(59, 130, 246, 0.03)', borderRadius: '16px', border: '1px solid rgba(59, 130, 246, 0.1)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '1rem' }}>
          <Bluetooth size={16} color="#3b82f6" />
          <div style={{ fontSize: '0.85rem', fontWeight: '800', color: 'white' }}>GUARDIAN IoT</div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {/* Heart Rate Tracking */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
               <div style={{ position: 'relative' }}>
                 <Activity size={18} color={heartRate > 0 ? '#10b981' : 'rgba(255,255,255,0.2)'} className={heartRate > 0 ? 'pulse' : ''} />
               </div>
               <span style={{ fontSize: '0.75rem', fontWeight: '600', color: 'var(--text-secondary)' }}>
                 {isCz ? 'Srdeční tep' : 'Heart Rate'}
               </span>
            </div>
            <div style={{ fontSize: '0.9rem', fontWeight: '900', color: heartRate > hrThreshold ? '#ef4444' : 'white' }}>
              {heartRate > 0 ? `${heartRate} BPM` : (isCz ? 'Nepřipojeno' : 'Disconnected')}
            </div>
          </div>

          {/* Threshold Setting */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', marginTop: '0.25rem' }}>
             <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.65rem', fontWeight: '700', color: 'rgba(255,255,255,0.3)' }}>
                <span>{isCz ? 'LIMIT PRO TICHÝ ALARM' : 'SILENT SOS THRESHOLD'}</span>
                <span style={{ color: 'var(--accent-color)' }}>{hrThreshold} BPM</span>
             </div>
             <input 
               type="range" min="100" max="180" value={hrThreshold}
               onChange={(_err) => setHrThreshold(Number(_err.target.value))}
               style={{ width: '100%', accentColor: 'var(--accent-color)', height: '4px', cursor: 'pointer' }}
             />
          </div>

          {/* Action Buttons */}
          <button 
             onClick={() => {
               // Mocking the BLE pairing trigger
               if (typeof navigator.bluetooth !== 'undefined') {
                 navigator.bluetooth.requestDevice({ filters: [{ services: ['heart_rate'] }] })
                   .then(() => setIsBluetoothConnected(true))
                   .catch(() => {});
               } else {
                 setIsBluetoothConnected(!isBluetoothConnected); // Toggle simulation
               }
             }}
             style={{ 
               marginTop: '0.5rem',
               padding: '0.6rem', 
               borderRadius: '10px', 
               background: isBluetoothConnected ? 'rgba(34, 197, 94, 0.1)' : 'rgba(255,255,255,0.05)', 
               border: `1px solid ${isBluetoothConnected ? 'rgba(34, 197, 94, 0.3)' : 'rgba(255,255,255,0.1)'}`,
               color: isBluetoothConnected ? '#22c55e' : 'white',
               fontSize: '0.75rem', fontWeight: '800', cursor: 'pointer'
             }}
          >
             {isBluetoothConnected ? (isCz ? 'Zařízení aktivní ✓' : 'Device Active ✓') : (isCz ? 'Párovat Smart Band' : 'Pair Smart Band')}
          </button>
        </div>
      </div>

      <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', textAlign: 'center', opacity: 0.7, lineHeight: 1.4 }}>
        {linkedSessionId
          ? (isCz ? 'Časovač je napojen na vaši rezervaci. Po uplynutí se automaticky odešle SOS.' : 'Timer is linked to your booking. SOS will auto-trigger when time expires.')
          : (isCz ? 'Pokud nepotvrdíte stav včas, systém automaticky rozešle SOS s vaší polohou.' : 'If you don\'t check in on time, SOS with your location will be sent automatically.')
        }
      </div>
    </div>
  );
};

export default SafetyControlCard;
