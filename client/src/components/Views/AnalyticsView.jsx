import React, { useState } from 'react';
import { safeRedirect } from '../../utils/safeRedirect';
import { DollarSign, Calendar, MessageSquare, TrendingUp, Users, Activity, Lock } from 'lucide-react';
import { useNexus } from '../../context/ContextHook';
import PinModal from '../Modals/PinModal';

import { API_BASE } from '../../constants/config';
const AnalyticsView = () => {
  const nexus = useNexus();
  const { 
    isMobile, 
    t, 
    lang,
    agencies, 
    profiles: allAgencyProfiles, 
    operators: availableOperators,
    activeOperator
  } = nexus;

  const [pinVerified, setPinVerified] = useState(!activeOperator?.hasPin);
  const [isUpgrading, setIsUpgrading] = useState(false);

  const agency = agencies?.[0] || {};
  const hasAnalyticsAccess = agency.plan === 'Professional' || agency.plan === 'Agency' || agency.extraFeatures?.analytics === true;

  const handleUpgrade = async () => {
    setIsUpgrading(true);
    try {
      const response = await fetch(`${API_BASE}/billing/checkout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${nexus.token}`
        },
        body: JSON.stringify({ 
          planId: 'pro_monthly',
          successUrl: window.location.href,
          cancelUrl: window.location.href
        })
      });
      const data = await response.json();
      if (data.url) safeRedirect(data.url);
    } catch (err) {
      console.error("Upgrade failed:", err);
    } finally {
      setIsUpgrading(false);
    }
  };

  // 1. Subscription Check (Higher Priority than PIN)
  if (!hasAnalyticsAccess) {
    return (
      <div style={{ display: 'flex', flex: 1, alignItems: 'center', justifyContent: 'center', height: '100%', background: 'var(--bg-color)' }}>
        <div style={{ textAlign: 'center', maxWidth: '500px', padding: '3rem', background: 'rgba(255,255,255,0.02)', border: '1px solid var(--card-border)', borderRadius: '32px', backdropFilter: 'blur(10px)' }}>
          <div style={{ 
            width: '100px', height: '100px', 
            background: 'linear-gradient(135deg, #3b82f6 0%, #a855f7 100%)', 
            borderRadius: '30px', display: 'flex', alignItems: 'center', justifyContent: 'center', 
            margin: '0 auto 2.5rem', 
            boxShadow: '0 20px 40px rgba(59, 130, 246, 0.3)',
            position: 'relative'
          }}>
            <TrendingUp size={48} color="white" />
            <div style={{ position: 'absolute', bottom: '-10px', right: '-10px', background: '#0f172a', borderRadius: '50%', padding: '8px', border: '2px solid #3b82f6' }}>
              <Lock size={18} color="#3b82f6" />
            </div>
          </div>
          
          <h2 style={{ fontSize: '1.75rem', fontWeight: '950', marginBottom: '1.25rem', background: 'linear-gradient(to right, #fff, #94a3b8)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
            {lang === 'cz' ? 'Profesionální analytika' : 'Professional Analytics'}
          </h2>
          
          <p style={{ color: 'var(--text-secondary)', marginBottom: '3rem', fontSize: '1rem', lineHeight: '1.7', fontWeight: '500' }}>
            {lang === 'cz' 
              ? 'Detailní statistiky tržeb, konverzí a výkonu operátorů jsou dostupné pouze v tarifu Professional nebo jako samostatný modul.' 
              : 'Detailed revenue stats, conversion tracking, and operator performance are only available on the Professional plan or as a separate add-on.'}
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <button 
              onClick={handleUpgrade}
              disabled={isUpgrading}
              className="premium-btn"
              style={{ 
                width: '100%', padding: '1.25rem', 
                background: 'linear-gradient(to right, #3b82f6, #6366f1)', 
                border: 'none', borderRadius: '16px', 
                color: 'white', fontWeight: '900', fontSize: '0.95rem',
                cursor: 'pointer', boxShadow: '0 10px 20px rgba(59, 130, 246, 0.2)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.75rem'
              }}
            >
              {isUpgrading ? <Activity size={20} className="spin" /> : <DollarSign size={20} />}
              {lang === 'cz' ? 'UPGRADOVAT NA PROFESSIONAL' : 'UPGRADE TO PROFESSIONAL'}
            </button>
            
            <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.5rem' }}>
              {lang === 'cz' ? 'Okamžitá aktivace po zaplacení' : 'Instant activation after payment'}
            </p>
          </div>
        </div>
      </div>
    );
  }

  // 2. PIN Verification (Sensitive Data Access)
  if (!pinVerified) {
    return (
      <div style={{ display: 'flex', flex: 1, alignItems: 'center', justifyContent: 'center', height: '100%', background: 'var(--bg-color)' }}>
        <div style={{ textAlign: 'center', maxWidth: '400px', padding: '2rem' }}>
          <div style={{ width: '80px', height: '80px', background: 'rgba(167, 139, 250, 0.1)', borderRadius: '24px', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 2rem', border: '1px solid rgba(167, 139, 250, 0.2)' }}>
            <Lock size={40} color="#a78bfa" />
          </div>
          <h2 style={{ fontSize: '1.5rem', fontWeight: '900', marginBottom: '1rem' }}>{lang === 'cz' ? 'Analytika je uzamčena' : 'Analytics is Locked'}</h2>
          <p style={{ color: 'var(--text-secondary)', marginBottom: '2.5rem', fontSize: '0.95rem', lineHeight: '1.6' }}>
            {lang === 'cz' 
              ? 'Tento pohled obsahuje citlivá finanční data. Pro pokračování zadejte svůj bezpečnostní PIN.' 
              : 'This view contains sensitive financial data. Please enter your security PIN to continue.'}
          </p>
          <button 
            onClick={() => setPinVerified('prompt')}
            className="action-btn"
            style={{ width: '100%', padding: '1rem', background: '#a78bfa', borderRadius: '12px', fontWeight: '800' }}
          >
            {lang === 'cz' ? 'ODEMKNOUT PINEM' : 'UNLOCK WITH PIN'}
          </button>
        </div>
        
        {pinVerified === 'prompt' && (
          <PinModal 
            onSuccess={() => setPinVerified(true)}
            onCancel={() => setPinVerified(false)}
            title={lang === 'cz' ? 'Přístup k analytice' : 'Access Analytics'}
            description={lang === 'cz' ? 'Zadejte svůj 4-místný kód pro zobrazení tržeb.' : 'Enter your 4-digit code to view revenue.'}
          />
        )}
      </div>
    );
  }

  return (
    <div data-testid="page-analytics-container" style={{ padding: isMobile ? '1.5rem 1rem' : '2rem', flex: 1, overflowY: 'auto' }} className="fade-in custom-scrollbar">
      {!isMobile && (
        <h2 style={{ fontSize: '2rem', fontWeight: '800', marginBottom: '2.5rem' }}>{t('agencyOverview')}</h2>
      )}

      {/* Top Metric Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(4, 1fr)', gap: '1.5rem', marginBottom: '3rem' }}>
        <div className="glass-card" style={{ padding: '1.5rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem', color: 'var(--text-secondary)' }}>
            <DollarSign size={20} color="var(--success-color)" />
            <span style={{ fontSize: '0.8rem', fontWeight: '700', letterSpacing: '0.05em' }}>{t('totalRevenue').toUpperCase()}</span>
          </div>
          <div style={{ fontSize: '2rem', fontWeight: '900' }}>0.00</div>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '0.5rem', fontWeight: '700' }}>N/A</div>
        </div>

        <div className="glass-card" style={{ padding: '1.5rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem', color: 'var(--text-secondary)' }}>
            <Calendar size={20} color="var(--accent-color)" />
            <span style={{ fontSize: '0.8rem', fontWeight: '700', letterSpacing: '0.05em' }}>{t('activeBookings').toUpperCase()}</span>
          </div>
          <div style={{ fontSize: '2rem', fontWeight: '900' }}>0</div>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '0.5rem', fontWeight: '700' }}>N/A</div>
        </div>

        <div className="glass-card" style={{ padding: '1.5rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem', color: 'var(--text-secondary)' }}>
            <MessageSquare size={20} color="#a855f7" />
            <span style={{ fontSize: '0.8rem', fontWeight: '700', letterSpacing: '0.05em' }}>{t('totalMessages').toUpperCase()}</span>
          </div>
          <div style={{ fontSize: '2rem', fontWeight: '900' }}>0</div>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '0.5rem' }}>{t('acrossAllProfiles')}</div>
        </div>

        <div className="glass-card" style={{ padding: '1.5rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem', color: 'var(--text-secondary)' }}>
            <TrendingUp size={20} color="#f59e0b" />
            <span style={{ fontSize: '0.8rem', fontWeight: '700', letterSpacing: '0.05em' }}>{t('conversionRate').toUpperCase()}</span>
          </div>
          <div style={{ fontSize: '2rem', fontWeight: '900' }}>0%</div>
          <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginTop: '0.5rem', fontWeight: '700' }}>N/A</div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: '2rem', flexDirection: isMobile ? 'column' : 'row' }}>
        {/* Left Column: Profile Earnings */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3 style={{ fontSize: '1.25rem', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Users size={20} color="var(--accent-color)" /> {t('perfByProfile')}
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {isMobile ? (agencies || []).flatMap(a => a.profiles || []).slice(0, 10).map((p, i) => (
              <div key={p.id || i} className="glass-card" style={{ padding: '1.25rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                    <div style={{ width: '32px', height: '32px', background: 'var(--accent-color)', borderRadius: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: '900', fontSize: '0.8rem' }}>{p.name[0]}</div>
                    <span style={{ fontWeight: '800', color: 'white' }}>{p.name}</span>
                  </div>
                  <span style={{ fontSize: '0.7rem', padding: '0.2rem 0.6rem', background: 'rgba(59, 130, 246, 0.1)', color: 'var(--accent-color)', borderRadius: '6px', fontWeight: '800' }}>#{i+1}</span>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                  <div>
                    <div style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', fontWeight: '800' }}>BOOKINGS</div>
                    <div style={{ fontWeight: '700', fontSize: '1rem' }}>{p.activeBookings || 0}</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', fontWeight: '800' }}>EARNINGS</div>
                    <div style={{ fontWeight: '900', fontSize: '1rem', color: 'var(--success-color)' }}>{p.earnings || '0.00'}</div>
                  </div>
                </div>
              </div>
            )) : (
              <div className="glass-card custom-scrollbar" style={{ padding: 0, overflowX: 'auto' }}>
                <table style={{ width: '100%', textAlign: 'left', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: 'rgba(255,255,255,0.02)', borderBottom: '1px solid var(--card-border)' }}>
                      <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontSize: '0.8rem' }}>PROFILE</th>
                      <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontSize: '0.8rem' }}>{t('rank').toUpperCase()}</th>
                      <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontSize: '0.8rem' }}>{t('activeBookings').toUpperCase()}</th>
                      <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontSize: '0.8rem', textAlign: 'right' }}>{t('earnings').toUpperCase()}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...(allAgencyProfiles || [])].sort((a,b) => parseInt((b.earnings || '0').replace(/\D/g,'')) - parseInt((a.earnings || '0').replace(/\D/g,''))).map((p, idx) => (
                      <tr key={p.id} style={{ borderBottom: '1px solid var(--card-border)' }}>
                        <td style={{ padding: '1rem' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                            <div style={{ width: '32px', height: '32px', background: 'rgba(255,255,255,0.03)', borderRadius: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: '900', fontSize: '0.8rem', color: 'var(--accent-color)' }}>{p.name[0]}</div>
                            <span style={{ fontWeight: '700' }}>{p.name}</span>
                          </div>
                        </td>
                        <td style={{ padding: '1rem' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            <TrendingUp size={14} color="var(--success-color)" />
                            <span style={{ fontWeight: '700' }}>#{idx + 1}</span>
                          </div>
                        </td>
                        <td style={{ padding: '1rem', fontWeight: '700' }}>{p.activeBookings || 0}</td>
                        <td style={{ padding: '1rem', textAlign: 'right', fontWeight: '900', color: 'var(--success-color)' }}>{p.earnings || '0.00'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {/* Right Column: Operator Activity */}
        <div style={{ width: isMobile ? '100%' : '450px' }}>
          <h3 style={{ fontSize: '1.25rem', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Activity size={20} color="var(--accent-color)" /> {t('perfByOperator')}
          </h3>
          <div className="glass-card custom-scrollbar" style={{ padding: 0, overflowX: 'auto' }}>
            <table style={{ width: '100%', textAlign: 'left', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ background: 'rgba(255,255,255,0.02)', borderBottom: '1px solid var(--card-border)' }}>
                  <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontSize: '0.8rem' }}>OPERATOR</th>
                  <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontSize: '0.8rem', textAlign: 'right' }}>{t('totalMessages').toUpperCase()}</th>
                  <th style={{ padding: '1rem', color: 'var(--text-secondary)', fontSize: '0.8rem', textAlign: 'right' }}>{t('callsHandled').toUpperCase()}</th>
                </tr>
              </thead>
              <tbody>
                {(availableOperators || [])
                  .filter(op => {
                    const r = (op.role?.name || op.role || '').toUpperCase();
                    return r === 'OPERATOR' || r === 'SENIOR OPERATOR' || r === 'SENIOR_OPERATOR';
                  })
                  .sort((a,b) => (b.metrics?.messages || 0) - (a.metrics?.messages || 0))
                  .map((op, i, arr) => (
                    <tr key={op.id} style={{ borderBottom: i < arr.length - 1 ? '1px solid var(--card-border)' : 'none' }}>
                      <td style={{ padding: '1rem' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                          <div style={{ width: '28px', height: '28px', background: 'rgba(255,255,255,0.05)', borderRadius: '6px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.6rem', fontWeight: '900' }}>{op.avatar}</div>
                          <div style={{ fontWeight: '700', fontSize: '0.9rem' }}>{op.name}</div>
                        </div>
                      </td>
                      <td style={{ padding: '1rem', textAlign: 'right', fontWeight: '700' }}>{op.metrics?.messages ?? 0}</td>
                      <td style={{ padding: '1rem', textAlign: 'right', color: 'var(--text-secondary)' }}>{op.metrics?.calls ?? 0}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AnalyticsView;
