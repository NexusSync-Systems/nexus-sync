import React from 'react';
import { Smartphone, Info, Globe, ShieldCheck, MapPin, X, Radio, Server, Lock } from 'lucide-react';

import { useNexus } from '../context/ContextHook';
import TrunkManager from './sip/TrunkManager';


// Operátorkám se tu zobrazoval zapsaný `nexus-api.myvnc.com` — server, který
// 3. 11. 2026 zanikl, a Asterisk zatím neběží nikde (viz
// docs/relay-hovory-a-sms.md). Zobrazit mrtvé jméno je horší než přiznat, že
// hodnota není nastavená: podle toho prvního by se dala nastavit cizí ústředna.
const SIP_HOST = (() => {
  const url = (import.meta.env.VITE_SIP_WS_URL || '').trim();
  if (!url) return '';
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
})();
const RelayControlCenter = () => {
  const nexus = useNexus();
  const { 
    sessions, profiles, activeRole, activeOperator, 
    handleRevokeBinding, showToast, t, lang, isMobile 
  } = nexus;
  const isManager = activeRole === 'app_owner' || activeRole === 'agency_admin' || activeRole === 'agency_manager' || activeOperator?.isManager || activeOperator?.isSeniorOperator;

  // Icons used for status badges
  const getStatusColor = (status) => {
    switch (status) {
      case 'Active': return 'var(--success-color)';
      case 'Pending': return '#f59e0b';
      case 'Error': return 'var(--error-color)';
      default: return 'var(--text-secondary)';
    }
  };

  return (
    <div style={{ padding: isMobile ? '1.5rem 1rem' : '2rem', flex: 1, overflowY: 'auto', maxHeight: '100%' }} className="fade-in custom-scrollbar">
      <div style={{ marginBottom: '2.5rem' }}>
        <h2 style={{ fontSize: isMobile ? '2rem' : '2.5rem', fontWeight: '900', marginBottom: '0.5rem', background: 'linear-gradient(to right, #6366f1, #a855f7)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
          {t('relayCenterTitle') || 'Relay Control Center'}
        </h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '1rem' }}>
          {t('relayCenterSubtitle') || 'Global state of your hardware relay nodes and VoIP routing.'}
        </p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(3, 1fr)', gap: '1.5rem', marginBottom: '3rem' }}>
        <div className="glass-card" style={{ padding: '1.5rem', borderLeft: '4px solid var(--accent-color)' }}>
          <div style={{ fontSize: '0.7rem', fontWeight: '800', color: 'var(--text-secondary)', letterSpacing: '0.1em', marginBottom: '0.5rem' }}>SIP SERVER</div>
          <code style={{ fontSize: '1.1rem', fontWeight: '900', color: 'white' }}>{SIP_HOST || 'nenastaveno'}</code>
        </div>
        <div className="glass-card" style={{ padding: '1.5rem', borderLeft: '4px solid var(--success-color)' }}>
          <div style={{ fontSize: '0.7rem', fontWeight: '800', color: 'var(--text-secondary)', letterSpacing: '0.1em', marginBottom: '0.5rem' }}>VOIP NODES</div>
          <div style={{ fontSize: '1.5rem', fontWeight: '900' }}>{(sessions || []).filter(s => s.status === 'Active').length} <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>ONLINE</span></div>
        </div>
        <div className="glass-card" style={{ padding: '1.5rem', borderLeft: '4px solid #f59e0b' }}>
          <div style={{ fontSize: '0.7rem', fontWeight: '800', color: 'var(--text-secondary)', letterSpacing: '0.1em', marginBottom: '0.5rem' }}>VOIP ROUTING</div>
          <div style={{ fontSize: '1.1rem', fontWeight: '900', color: '#f59e0b' }}>BYON ENABLED</div>
        </div>
      </div>

      <div className="settings-section" style={{ marginBottom: '3rem' }}>
        <h3 style={{ marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <Smartphone size={24} color="var(--accent-color)" /> {t('connectedDevices') || 'Connected Relay Devices'}
        </h3>
        <div className="glass-card" style={{ padding: 0 }}>
          {(() => {
            const visibleSessions = (sessions || []).filter(s => {
              if (isManager) return true;
              const sessionProfile = (profiles || []).find(p => p.id === s.profileId);
              return sessionProfile?.agencyId === activeOperator?.agencyId;
            });

            if (visibleSessions.length === 0) return (
              <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
                <Info size={48} style={{ opacity: 0.2, marginBottom: '1rem' }} />
                <div>{t('noDevicesConnected') || 'No active device bindings found.'}</div>
              </div>
            );

            return visibleSessions.map((s, i) => (
              <div key={i} style={{ padding: '1.5rem', borderBottom: i < visibleSessions.length - 1 ? '1px solid var(--card-border)' : 'none', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
                <div style={{ display: 'flex', gap: '1.5rem', alignItems: 'center' }}>
                  <div style={{ 
                    background: !s.profileId ? 'rgba(245,158,11,0.1)' : (s.current || s.status === 'Active') ? 'rgba(59,130,246,0.1)' : 'rgba(255,255,255,0.05)', 
                    padding: '1rem', 
                    borderRadius: '16px',
                    position: 'relative'
                  }}>
                    <Smartphone size={24} color={!s.profileId ? '#f59e0b' : (s.current || s.status === 'Active') ? 'var(--accent-color)' : 'var(--text-secondary)'} />
                    <div style={{ 
                      position: 'absolute', bottom: '-2px', right: '-2px', width: '12px', height: '12px', 
                      borderRadius: '50%', background: getStatusColor(s.status), border: '2px solid #0f1117' 
                    }}></div>
                  </div>
                  <div>
                    <div style={{ fontWeight: '800', fontSize: '1.1rem' }}>
                      {s.device} {s.current && <span style={{ color: 'var(--success-color)', fontSize: '0.75rem', marginLeft: '0.5rem' }}>✓ {t('thisDevice')}</span>}
                    </div>
                    <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', display: 'flex', gap: '0.75rem' }}>
                      <span>{s.location}</span>
                      <span>•</span>
                      <span>{(profiles || []).find(p => p.id === s.profileId)?.name || 'UNASSIGNED'}</span>
                    </div>
                  </div>
                </div>

                <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
                  {isManager && (
                    <div style={{ 
                      background: 'rgba(255,255,255,0.03)', 
                      padding: '0.5rem 1rem', 
                      borderRadius: '10px', 
                      border: '1px solid var(--card-border)',
                      fontSize: '0.8rem'
                    }}>
                      <div style={{ fontSize: '0.6rem', color: 'var(--text-secondary)', fontWeight: '800' }}>SIP USER</div>
                      <div style={{ fontWeight: '700', fontFamily: 'monospace' }}>{s.sipUser || 'auto-gen'}</div>
                    </div>
                  )}

                  <button
                    title={lang === 'cz' ? 'Zobrazit polohu zařízení' : 'Show device location'}
                    onClick={() => {
                      if (s.lat && s.lng) {
                        window.open(`https://www.google.com/maps?q=${s.lat},${s.lng}`, '_blank');
                      } else {
                        showToast(lang === 'cz' ? 'Poloha momentálně není k dispozici' : 'Location not available', 'info');
                      }
                    }}
                    className="status-badge"
                    style={{ padding: '0.6rem 1rem', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.5rem', background: 'rgba(139,92,246,0.1)', color: '#a78bfa', borderColor: 'rgba(139,92,246,0.3)' }}
                  >
                    <MapPin size={16} /> {lang === 'cz' ? 'MAPA' : 'MAP'}
                  </button>

                  {(isManager || s.profileId === activeOperator?.profileId) && (
                    <button
                      className="status-badge"
                      style={{ 
                        cursor: s.status === 'Active' ? 'pointer' : 'default', 
                        opacity: s.status === 'Active' ? 1 : 0.5,
                        borderColor: 'var(--error-color)',
                        color: 'var(--error-color)',
                        background: 'rgba(239, 68, 68, 0.05)'
                      }}
                      onClick={() => s.status === 'Active' && handleRevokeBinding(s.installationId)}
                    >
                      {s.status === 'Active' ? t('revoke') : t('revoked') || 'REVOKED'}
                    </button>
                  )}
                </div>
              </div>
            ));
          })()}
        </div>
      </div>

      <div style={{ background: 'rgba(59, 130, 246, 0.05)', border: '1px solid rgba(59, 130, 246, 0.2)', borderRadius: '24px', padding: '2rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1.5rem' }}>
          <div style={{ background: 'var(--accent-color)', padding: '0.75rem', borderRadius: '12px' }}><Lock size={20} color="white" /></div>
          <div>
            <h4 style={{ fontWeight: '900', fontSize: '1.25rem' }}>{lang === 'cz' ? 'Technické nastavení brány' : 'Technical Gateway Setup'}</h4>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>{lang === 'cz' ? 'Tyto údaje slouží pro ruční nastavení SIP klientů, pokud automatické párování selže.' : 'Use these credentials for manual SIP client configuration if auto-pairing fails.'}</p>
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(2, 1fr)', gap: '1.5rem' }}>
          <div className="glass-card" style={{ padding: '1.5rem' }}>
            <div style={{ fontSize: '0.75rem', fontWeight: '800', color: 'var(--text-secondary)', marginBottom: '0.75rem' }}>ASTERISK HOST</div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <code style={{ fontSize: '1rem', color: 'white' }}>{SIP_HOST || 'nenastaveno'}</code>
              <code style={{ fontSize: '0.8rem', color: 'var(--accent-color)' }}>PORT: 5060</code>
            </div>
          </div>
          <div className="glass-card" style={{ padding: '1.5rem' }}>
            <div style={{ fontSize: '0.75rem', fontWeight: '800', color: 'var(--text-secondary)', marginBottom: '0.75rem' }}>REGION ROUTING</div>
            <div style={{ fontWeight: '700' }}>EUROPE-CENTRAL-1 (PRAGUE)</div>
          </div>
        </div>
      </div>
      
      <TrunkManager />

      <style>{`
        .glass-card { background: rgba(255,255,255,0.03); backdrop-filter: blur(10px); border: 1px solid var(--card-border); border-radius: 20px; transition: all 0.3s; }
        .glass-card:hover { border-color: rgba(255,255,255,0.1); background: rgba(255,255,255,0.05); }
        .status-badge { padding: 0.4rem 1rem; border-radius: 10px; border: 1px solid var(--card-border); font-size: 0.75rem; fontWeight: 800; }
        .fade-in { animation: fadeIn 0.4s ease-out; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
      `}</style>
    </div>
  );
};

export default RelayControlCenter;
