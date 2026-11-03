import React, { useState, useEffect } from 'react';
import { DollarSign, Building2, Zap, Activity, TrendingUp, Users, Server, ShieldCheck, AlertTriangle, Calendar, Loader2, MessageSquare, Copy, X, Clock, HardDrive, Banknote, ChevronLeft, ChevronRight } from 'lucide-react';
import axios from 'axios';
import { RevenueLineChart, ConversionDonutChart, MiniSparkline } from './AnalyticsCharts';
import { useVultr } from '../hooks/useVultr';
import { useHetzner } from '../hooks/useHetzner';
import { useNexus } from '../context/ContextHook';
import Skeleton from './UI/Skeleton';
import SafetyControlCard from './Safety/SafetyControlCard';
import AIInsightCard from './AIInsightCard';
// Varianta APK je konstanta dosazená při buildu, ne stav aplikace — brát ji
// z kontextu znamenalo `undefined`, takže se relay větev dashboardu nikdy
// nevykreslila. Kontext ji nevystavuje a vystavovat nemá.
import { isRelayVariant } from '../plugins/NexusSms';
import { VOLITELNE as DUVODY_BLACKLIST, popisDuvodu } from '../config/blacklistReasons';

const DashboardHome = () => {
  const nexus = useNexus();
  const { 
    activeOperator: user, t, lang, agencies, profiles: _profiles, 
    calendar, stats, activeSubscription, activeRole,
    isMobile, isBackgroundLoading,
    setLinkedSessionId, linkedSessionId,
    onDelayBooking,
    isLoggedIn, showToast, API_BASE, token, totalUnread, setActiveTab
  } = nexus;
  
  // Stav serverů je věc app ownera. Pro ostatní role tyhle endpointy vracejí 403,
  // takže se dřív z dashboardu každých 30 vteřin doptávaly na chybu donekonečna.
  const infraEnabled = !!nexus.isAppOwner;
  const vultr = useVultr({ enabled: infraEnabled });
  const hetzner = useHetzner({ enabled: infraEnabled });
  const isMainHub = nexus.selectedServerId === 'main-hub';
  const isAiNode = nexus.selectedServerId === 'ai-node';
  const server = isMainHub ? vultr : (isAiNode ? hetzner : vultr);
  const { status: currentServerStatus } = server;

  const [systemHealth, setSystemHealth] = useState(null);

  const isAppOwner = user?.isAppOwner;

  useEffect(() => {
    if (isAppOwner && isLoggedIn && API_BASE && token) {
      const fetchHealth = async () => {
        try {
          const r = await axios.get(`${API_BASE}/admin/health`, {
            headers: { Authorization: `Bearer ${token}` }
          });
          setSystemHealth(r.data);
        } catch (_err) {
          console.error('Failed to fetch health on dashboard:', _err);
        }
      };
      fetchHealth();
      const interval = setInterval(fetchHealth, 60000); // 1 min refresh
      return () => clearInterval(interval);
    }
  }, [isAppOwner, isLoggedIn, API_BASE, token]);

  const currentAgency = (agencies || [])[0] || {};
  const regions = currentAgency.regions || ['uk'];
  const isMultiregion = currentAgency.isInternational || regions.length > 1;
  const defaultCurrency = isMultiregion ? 'EUR' : (regions[0] === 'cz' ? 'CZK' : (regions[0] === 'us' ? 'USD' : 'GBP'));
  const [dashboardCurrency, setDashboardCurrency] = useState(defaultCurrency);
  const [calViewDate, setCalViewDate] = useState(new Date());
  
  // Auto-detect active booking and link it to safety session (for Models)
  useEffect(() => {
    if (!isLoggedIn || activeRole !== 'model' || linkedSessionId) return;
    
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    
    const activeEvent = (calendar || []).find(event => {
      try {
        const [start, end] = (event.time || '').split(' - ');
        if (!start || !end) return false;
        const [sh, sm] = start.split(':').map(Number);
        const [eh, em] = end.split(':').map(Number);
        const startMin = sh * 60 + sm;
        const endMin = eh * 60 + em;
        // Check if current time is within booking window (plus 5 min grace before)
        return nowMin >= (startMin - 5) && nowMin < endMin;
      } catch { return false; }
    });

    if (activeEvent && activeEvent.id && activeEvent.id !== linkedSessionId) {
      setLinkedSessionId(activeEvent.id);
    }
  }, [calendar, isLoggedIn, activeRole, linkedSessionId, setLinkedSessionId]);

  const formatMoney = (val, cur) => {
    const sym = { GBP: '£', EUR: '€', USD: '$', CZK: 'Kč' }[cur] || '£';
    const numStr = String(val).replace(/[^0-9.]/g, '') || "0.00";
    return cur === 'CZK' ? `${parseInt(numStr)} ${sym}` : `${sym}${numStr}`;
  };

  const _isCz = lang === 'cz' || lang === 'cs';
  const isManager = activeRole === 'agency_admin' || activeRole === 'manager';
  const isModel = activeRole === 'model';



  if (isRelayVariant) {
    return (
      <div style={{ 
        padding: '1.5rem 1rem',
        maxWidth: '100%',
        margin: '0 auto',
        width: '100%',
        display: 'flex',
        flexDirection: 'column',
        gap: '2rem'
      }}>
        <div className="fade-in">
          <WelcomeSection user={user} t={t} lang={lang} />
          <AlertsSection activeSubscription={activeSubscription} agencies={agencies} stats={stats} profiles={_profiles} activeRole={activeRole} t={t} />

          <div style={{ marginBottom: '1.5rem' }}>
            <h2 style={{ fontSize: '1.75rem', fontWeight: '900', letterSpacing: '0.05em' }}>{t('dailyAgenda').toUpperCase()}</h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>{t('dailyAgendaDesc')}</p>
          </div>

          {isBackgroundLoading ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '300px', width: '100%', background: 'rgba(255,255,255,0.01)', borderRadius: '24px', border: '1px solid var(--card-border)' }}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1rem' }}>
                <Loader2 className="animate-spin" size={32} color="var(--accent-color)" />
                <div className="premium-loading-text" style={{ fontSize: '0.6rem', letterSpacing: '0.2em', opacity: 0.5 }}>SYNCHRONIZACE_JÁDRA...</div>
              </div>
            </div>
          ) : (
          <>
          <div className="glass-card" style={{ padding: '1.5rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
              <h3 style={{ fontSize: '1.1rem', fontWeight: '800' }}>{t('todaysBookings')}</h3>
              <span style={{ fontSize: '0.75rem', color: 'var(--accent-color)', fontWeight: '800' }}>{(calendar || []).length} {t('total').toUpperCase()}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              {(calendar || []).length > 0 ? (calendar || []).map((event, i) => (
                <div key={i} style={{ padding: '1.25rem', background: 'rgba(255,255,255,0.03)', borderRadius: '15px', borderLeft: `4px solid ${event.status === 'confirmed' ? 'var(--success-color)' : 'var(--accent-color)'}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div style={{ fontWeight: '800', fontSize: '1rem' }}>{event.time}</div>
                    <div style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>{(event.title || '').replace('Meeting w/ ', '')}</div>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.5rem' }}>
                    <div style={{ fontSize: '0.75rem', fontWeight: '900', color: 'var(--text-secondary)' }}>{event.duration}</div>
                    <div style={{ display: 'flex', gap: '0.35rem' }}>
                      <button 
                        onClick={(_err) => { _err.stopPropagation(); onDelayBooking(event.id, 15); }}
                        style={{ fontSize: '0.65rem', border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.05)', color: 'var(--text-secondary)', padding: '0.25rem 0.5rem', borderRadius: '6px', fontWeight: '800', cursor: 'pointer' }}
                      >
                        +15m
                      </button>
                      <button 
                        onClick={(_err) => { _err.stopPropagation(); onDelayBooking(event.id, 30); }}
                        style={{ fontSize: '0.65rem', border: '1px solid rgba(255,255,255,0.1)', background: 'rgba(255,255,255,0.05)', color: 'var(--text-secondary)', padding: '0.25rem 0.5rem', borderRadius: '6px', fontWeight: '800', cursor: 'pointer' }}
                      >
                        +30m
                      </button>
                    </div>
                  </div>
                </div>
              )) : <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '2rem 1rem', gap: '0.75rem', border: '1px dashed var(--card-border)', borderRadius: '12px' }}>
                  <Calendar size={32} color="#374151" />
                  <div style={{ fontSize: '1rem', fontWeight: '700', color: '#64748b' }}>{t('noBookingsToday')}</div>
                  <div style={{ fontSize: '0.8rem', color: '#475569' }}>
                    {t('newBookingsAppear')}
                  </div>
                </div>}
            </div>
          </div>

          <div className="glass-card" style={{ padding: '1.5rem', marginTop: '1.5rem' }}>
            <h3 style={{ fontSize: '1.1rem', fontWeight: '800', marginBottom: '1rem' }}>{t('quickStats')}</h3>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
              <div 
                data-testid="dashboard-messages-card"
                onClick={() => setActiveTab('inbox')}
                style={{ padding: '1rem', background: 'rgba(255,255,255,0.02)', borderRadius: '12px', textAlign: 'center', cursor: 'pointer', position: 'relative' }}
              >
                <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>{t('totalMessages', 'TOTAL MESSAGES').toUpperCase()}</div>
                <div style={{ fontSize: '1.5rem', fontWeight: '900' }}>{(stats || {}).totalMessages || 0}</div>
                {totalUnread > 0 && (
                  <div style={{ position: 'absolute', top: '10px', right: '10px', background: 'var(--error-color)', color: 'white', borderRadius: '10px', padding: '0 6px', fontSize: '0.65rem', fontWeight: 'bold' }}>
                    {totalUnread}
                  </div>
                )}
              </div>
              <div style={{ padding: '1rem', background: 'rgba(255,255,255,0.02)', borderRadius: '12px', textAlign: 'center' }}>
                <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>{t('calls').toUpperCase()}</div>
                <div style={{ fontSize: '1.5rem', fontWeight: '900' }}>{(stats || {}).totalCalls || 0}</div>
              </div>
            </div>
          </div>
          </>
          )}
        </div>
      </div>
    );
  }

  const renderSubscriptionBanner = () => {
    if (!activeSubscription) return null;
    const now = new Date();
    const expiresAt = new Date(activeSubscription.expiresAt);
    const daysLeft = Math.max(0, Math.ceil((expiresAt - now) / 86400000));
    const status = activeSubscription.status;
    
    let statusColor = '#6b7280';
    if (status === 'ACTIVE') statusColor = '#10b981';
    else if (status === 'TRIAL') statusColor = '#f59e0b';
    else if (status === 'EXPIRED') statusColor = '#ef4444';

    return (
      <div className="glass-card" style={{ 
        padding: '1rem 1.5rem', 
        marginBottom: '1.5rem', 
        borderLeft: `4px solid ${statusColor}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: '0.75rem'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <ShieldCheck size={20} color={statusColor} />
          <div>
            <div style={{ fontSize: '0.7rem', fontWeight: '800', color: 'var(--text-secondary)' }}>
              {t('subscription').toUpperCase()}
            </div>
            <div style={{ fontWeight: '800', fontSize: '1.1rem' }}>
              {activeSubscription.plan}
            </div>
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: '0.75rem', fontWeight: '800', color: daysLeft <= 7 ? '#ef4444' : 'var(--text-secondary)' }}>
            {t('trialExpiresIn').replace('{days}', daysLeft)}
          </div>
          <div style={{ fontSize: '0.65rem', color: 'var(--text-secondary)' }}>
            {expiresAt.toLocaleDateString(lang === 'cz' ? 'cs-CZ' : 'en-GB')}
          </div>
        </div>
      </div>
    );
  };

  const renderSuperAdmin = () => {
    const statusColor = {
      running: "var(--success-color)",
      active: "var(--success-color)",
      stopped: "var(--error-color)",
      off: "var(--error-color)",
    }[currentServerStatus?.power_status?.toLowerCase()] ?? "var(--text-secondary)";

    return (
    <div className="fade-in">
      <WelcomeSection user={user} t={t} lang={lang} />
      <div style={{ marginBottom: '2rem' }}>
        <AIInsightCard stats={stats} agencies={agencies} systemHealth={systemHealth} />
      </div>
      <AlertsSection activeSubscription={activeSubscription} agencies={agencies} stats={stats} profiles={_profiles} activeRole={activeRole} t={t} />

      <div style={{ marginBottom: isMobile ? '1.5rem' : '2.5rem', display: 'flex', justifyContent: 'space-between', alignItems: isMobile ? 'flex-start' : 'flex-end', flexDirection: isMobile ? 'column' : 'row', gap: isMobile ? '1rem' : 0 }}>
        <div>
          <h2 style={{ fontSize: isMobile ? '1.75rem' : '2rem', fontWeight: '900', letterSpacing: '0.05em' }}>{t('globalOverview').toUpperCase()}</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: isMobile ? '0.9rem' : '1rem' }}>{t('globalHealthDesc')}</p>
        </div>
        
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
          {/* Server Selector for Super Admin */}
          <div style={{ position: 'relative' }}>
            <select 
              value={nexus.selectedServerId}
              onChange={(e) => nexus.setSelectedServerId(e.target.value)}
              style={{
                appearance: 'none',
                background: 'rgba(255,255,255,0.05)',
                border: '1px solid var(--card-border)',
                borderRadius: '12px',
                padding: '0.6rem 2.5rem 0.6rem 1rem',
                color: 'white',
                fontSize: '0.8rem',
                fontWeight: '700',
                cursor: 'pointer',
                outline: 'none',
                minWidth: '200px'
              }}
            >
              {(nexus.availableServers || []).map(server => (
                <option key={server.id} value={server.id} style={{ background: '#111', color: 'white' }}>
                  {server.name} ({server.id === 'main-hub' ? 'Primary' : 'Relay'})
                </option>
              ))}
            </select>
            <Server size={14} color="var(--accent-color)" style={{ position: 'absolute', right: '1rem', top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }} />
          </div>

          <div style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid var(--card-border)', borderRadius: '12px', padding: '0.5rem', display: 'flex', gap: '0.25rem' }}>
            {['cz', 'eu', 'uk', 'us'].map(market => (
              <button
                key={market}
                data-testid={`market-selector-${market}`}
                onClick={() => nexus.setActiveMarket(market)}
                style={{ padding: '0.4rem 0.8rem', borderRadius: '10px', background: nexus.activeMarket === market ? 'rgba(59, 130, 246, 0.2)' : 'transparent', color: nexus.activeMarket === market ? '#60a5fa' : 'var(--text-secondary)', border: 'none', fontSize: '0.75rem', fontWeight: '800', cursor: 'pointer' }}
              >
                {market.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
      </div>

      {isBackgroundLoading ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '400px', width: '100%', background: 'rgba(255,255,255,0.01)', borderRadius: '24px', border: '1px solid var(--card-border)' }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1rem' }}>
            <Loader2 className="animate-spin" size={32} color="var(--accent-color)" />
            <div className="premium-loading-text" style={{ fontSize: '0.6rem', letterSpacing: '0.2em', opacity: 0.5 }}>NAČÍTÁNÍ_GLOBÁLNÍCH_DAT...</div>
          </div>
        </div>
      ) : (
      <>

      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fit, minmax(240px, 1fr))', gap: isMobile ? '1rem' : '1.5rem', marginBottom: isMobile ? '1.5rem' : '3rem' }}>
        {[
          { label: t('totalRevenue'), value: stats?.revenue || '£0.00', icon: <Banknote color="#10b981" />, growth: stats?.commissionGrowth || 'STABLE', chart: stats?.sparklineData || stats?.chartData || [0,0,0,0,0,0,0] },
          { label: t('agencies').toUpperCase(), value: stats?.totalAgencies || (agencies || []).length, icon: <Building2 color="#3b82f6" />, growth: 'PROD', chart: [0,0,0,0,0,0,0] },
          { label: 'SERVER LOAD', value: systemHealth ? `${systemHealth.cpu.loadAvg[0]}` : (currentServerStatus?.power_status || 'CHECKING...').toUpperCase(), icon: <Server color={statusColor} />, growth: systemHealth ? `${systemHealth.memory.percent}% RAM` : (currentServerStatus?.main_ip || 'PENDING'), chart: [0,0,0,0,0,0,0], isStatus: true },
          { label: 'DISK SPACE', value: systemHealth ? `${systemHealth.disk.percent}` : stats?.totalProfiles || '0', icon: systemHealth ? <HardDrive color="#f59e0b" /> : <Zap color="#f59e0b" />, growth: systemHealth ? systemHealth.disk.used : 'STABLE', chart: [0,0,0,0,0,0,0], isStatus: !!systemHealth },
          { label: 'SYSTEM UPTIME', value: systemHealth ? `${systemHealth.uptime.days}d ${systemHealth.uptime.hours}h` : stats?.totalMessages || '0', icon: systemHealth ? <Clock color="#ec4899" /> : <Activity color="#8b5cf6" />, growth: systemHealth ? `${systemHealth.uptime.minutes}m` : (stats?.uptime || '100% UP'), chart: stats?.sparklineData || stats?.chartData || [0,0,0,0,0,0,0], isStatus: !!systemHealth }
        ].map((stat, i) => (
          <div key={i} data-testid={`stat-card-${stat.label.toLowerCase().replace(/\s+/g, '-')}`} className="glass-card" style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', border: stat.isStatus ? `1px solid ${statusColor}40` : '1px solid var(--card-border)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '1rem' }}>
              <div style={{ width: '40px', height: '40px', borderRadius: '10px', background: 'rgba(255,255,255,0.03)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {stat.icon}
              </div>
              <div style={{ textAlign: 'right' }}>
                <span style={{ fontSize: '0.75rem', fontWeight: '800', color: stat.isStatus ? statusColor : ((stat.growth || '').startsWith('+') ? 'var(--success-color)' : 'var(--text-secondary)') }}>{stat.growth}</span>
                {!stat.isStatus && (
                  <div style={{ marginTop: '0.25rem' }}>
                    <MiniSparkline data={stat.chart} color={stat.icon.props.color} />
                  </div>
                )}
                {stat.isStatus && currentServerStatus && (
                   <div style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', fontWeight: '700', marginTop: '0.25rem' }}>
                     {currentServerStatus.region}
                   </div>
                )}
              </div>
            </div>
            <div style={{ fontSize: '0.7rem', fontWeight: '800', color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>{stat.label}</div>
            <div style={{ fontSize: '1.75rem', fontWeight: '900', color: stat.isStatus ? statusColor : 'inherit' }}>{stat.value}</div>
          </div>
        ))}
      </div>

      <div style={{ marginBottom: '3rem' }}>
        <QuickBlacklistSection API_BASE={API_BASE} token={token} showToast={showToast} t={t} lang={lang} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '2fr 1fr', gap: '2rem', marginBottom: '3rem' }}>
        <div className="glass-card" style={{ padding: '2rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
            <h3 style={{ fontSize: '1.25rem', fontWeight: '800', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <TrendingUp size={20} color="var(--accent-color)" /> {t('revenueTrend')}
            </h3>
          </div>
          <div style={{ height: '300px' }}>
            <RevenueLineChart data={stats?.revenueData || stats?.chartData || [0,0,0,0,0,0,0]} />
          </div>
        </div>

        <div className="glass-card" style={{ padding: '2rem' }}>
          <h3 style={{ fontSize: '1.25rem', fontWeight: '800', marginBottom: '2rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <Activity size={20} color="#a855f7" /> {t('systemLoad')}
          </h3>
          <div style={{ display: 'flex', justifyContent: 'center', height: '100%', alignItems: 'center' }}>
            <ConversionDonutChart data={[
              { label: 'Active', value: stats?.totalProfiles ? 100 : 0 },
              { label: 'Idle', value: stats?.totalProfiles ? 0 : 100 }
            ]} />
          </div>
        </div>
      </div>
      </>
      )}
    </div>
    );
  };

  const renderManager = () => (
    <div className="fade-in">
      <WelcomeSection user={user} t={t} lang={lang} />
      <AlertsSection activeSubscription={activeSubscription} agencies={agencies} stats={stats} profiles={_profiles} activeRole={activeRole} t={t} />

      {!isMobile && (
        <div style={{ marginBottom: '2.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem' }}>
          <div>
            <h2 style={{ fontSize: '2rem', fontWeight: '900' }}>{t('agencyOverview').toUpperCase()}</h2>
            <p style={{ color: 'var(--text-secondary)', fontSize: '1rem' }}>{t('agencyOverviewDesc')}</p>
          </div>
          {isMultiregion && (
             <div style={{ display: 'flex', gap: '0.25rem', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--card-border)', padding: '0.25rem', borderRadius: '10px' }}>
                {['GBP', 'EUR', 'USD', 'CZK'].map(cur => (
                  <button
                    key={cur}
                    data-testid={`currency-selector-${cur}`}
                    onClick={() => setDashboardCurrency(cur)}
                    style={{
                      padding: '0.4rem 0.8rem',
                      borderRadius: '8px',
                      background: dashboardCurrency === cur ? 'rgba(59, 130, 246, 0.2)' : 'transparent',
                      color: dashboardCurrency === cur ? '#60a5fa' : 'var(--text-secondary)',
                      border: 'none',
                      fontSize: '0.75rem',
                      fontWeight: '800',
                      cursor: 'pointer',
                      transition: 'all 0.2s'
                    }}
                  >
                    {cur}
                  </button>
                ))}
             </div>
          )}
        </div>
      )}
      
      {isMobile && isMultiregion && (
        <div style={{ marginBottom: '1.5rem', overflowX: 'auto', display: 'flex', paddingBottom: '0.5rem' }}>
           <div style={{ display: 'flex', gap: '0.25rem', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--card-border)', padding: '0.25rem', borderRadius: '10px' }}>
              {['GBP', 'EUR', 'USD', 'CZK'].map(cur => (
                <button
                  key={cur}
                  onClick={() => setDashboardCurrency(cur)}
                  style={{
                    padding: '0.4rem 0.8rem',
                    borderRadius: '8px',
                    background: dashboardCurrency === cur ? 'rgba(59, 130, 246, 0.2)' : 'transparent',
                    color: dashboardCurrency === cur ? '#60a5fa' : 'var(--text-secondary)',
                    border: 'none',
                    fontSize: '0.7rem',
                    fontWeight: '800'
                  }}
                >
                  {cur}
                </button>
              ))}
           </div>
        </div>
      )}

      {renderSubscriptionBanner()}

      {isBackgroundLoading ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '350px', width: '100%', background: 'rgba(255,255,255,0.01)', borderRadius: '24px', border: '1px solid var(--card-border)' }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1rem' }}>
            <Loader2 className="animate-spin" size={32} color="var(--accent-color)" />
            <div className="premium-loading-text" style={{ fontSize: '0.6rem', letterSpacing: '0.2em', opacity: 0.5 }}>ZÍSKÁVÁNÍ_AGENTURNÍCH_DAT...</div>
          </div>
        </div>
      ) : (
      <>
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(3, 1fr)', gap: '1.5rem', marginBottom: '3rem' }}>
        <div className="glass-card" style={{ padding: '1.5rem', background: 'linear-gradient(135deg, rgba(59, 130, 246, 0.1), transparent)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <div style={{ fontSize: '0.7rem', fontWeight: '800', color: 'var(--accent-color)', marginBottom: '0.5rem' }}>{t('revenueMtd')}</div>
              <div style={{ fontSize: '2.5rem', fontWeight: '900' }}>{formatMoney(stats?.revenue, dashboardCurrency)}</div>
            </div>
            <MiniSparkline data={stats?.sparklineData || stats?.chartData || [0,0,0,0,0,0,0]} color="var(--accent-color)" />
          </div>
        </div>
        <div className="glass-card" style={{ padding: '1.5rem' }}>
           <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <div style={{ fontSize: '0.7rem', fontWeight: '800', color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>{t('activeOps')}</div>
              <div style={{ fontSize: '2.5rem', fontWeight: '900' }}>{stats?.totalUsers || '0'}</div>
            </div>
          </div>
        </div>
        <div className="glass-card" style={{ padding: '1.5rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <div style={{ fontSize: '0.7rem', fontWeight: '800', color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>{t('avgConversion')}</div>
              <div style={{ fontSize: '2.5rem', fontWeight: '900' }}>{stats?.commissionGrowth || '0%'}</div>
            </div>
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: '2rem', marginBottom: '3rem' }}>
        <div className="glass-card" style={{ padding: '2rem' }}>
          <h3 style={{ fontSize: '1.25rem', fontWeight: '800', marginBottom: '1.5rem' }}>{t('revenueTrend')}</h3>
          <div style={{ height: '250px' }}>
            <RevenueLineChart data={stats?.revenueData || stats?.chartData || [0,0,0,0,0,0,0]} height={250} />
          </div>
        </div>
        <div className="glass-card" style={{ padding: '2rem' }}>
          <h3 style={{ fontSize: '1.1rem', fontWeight: '800', marginBottom: '1.5rem' }}>{t('todaysBookings')}</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {(calendar || []).length > 0 ? (calendar || []).map((event, i) => (
              <div key={i} style={{ padding: '1.25rem', background: 'rgba(255,255,255,0.03)', borderRadius: '15px', borderLeft: `4px solid ${event.status === 'confirmed' ? 'var(--success-color)' : 'var(--accent-color)'}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ fontWeight: '800', fontSize: '1rem' }}>{event.time}</div>
                  <div style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>{(event.title || '').replace('Meeting w/ ', '')}</div>
                </div>
                <div style={{ fontSize: '0.75rem', fontWeight: '900', color: 'var(--text-secondary)' }}>{event.duration}</div>
              </div>
            )) : <div style={{ color: 'var(--text-secondary)' }}>{t('noBookingsToday')}</div>}
          </div>
        </div>
      </div>
      <div style={{ marginBottom: '3rem' }}>
        <QuickBlacklistSection API_BASE={API_BASE} token={token} showToast={showToast} t={t} lang={lang} />
      </div>
      </>
      )}
    </div>
  );

  const renderOperator = () => (
    <div className="fade-in">
      <WelcomeSection user={user} t={t} lang={lang} />
      <AlertsSection activeSubscription={activeSubscription} agencies={agencies} stats={stats} profiles={_profiles} activeRole={activeRole} t={t} />

      <div style={{ marginBottom: isMobile ? '1.5rem' : '2.5rem', display: 'flex', justifyContent: 'space-between', alignItems: isMobile ? 'center' : 'flex-end', flexDirection: isMobile ? 'column' : 'row', gap: isMobile ? '1rem' : 0 }}>
        <div style={{ textAlign: isMobile ? 'center' : 'left' }}>
          <h2 style={{ fontSize: isMobile ? '1.5rem' : '2rem', fontWeight: '900' }}>{t('personalWorkspace')}</h2>
        </div>
      </div>

      {isBackgroundLoading ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '300px', width: '100%', background: 'rgba(255,255,255,0.01)', borderRadius: '24px', border: '1px solid var(--card-border)' }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1rem' }}>
            <Loader2 className="animate-spin" size={32} color="var(--accent-color)" />
            <div className="premium-loading-text" style={{ fontSize: '0.6rem', letterSpacing: '0.2em', opacity: 0.5 }}>PŘÍPRAVA_PRACOVNÍHO_PROSTORU...</div>
          </div>
        </div>
      ) : (
      <>
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'minmax(0, 2fr) 380px', gap: isMobile ? '1rem' : '2rem' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: isMobile ? '1rem' : '1.5rem', minWidth: 0 }}>
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(3, 1fr)', gap: isMobile ? '1rem' : '1.5rem' }}>
            <div 
              className="glass-card" 
              id="dashboard-stats-messages" 
              data-testid="dashboard-messages-card"
              onClick={() => setActiveTab('inbox')}
              style={{ padding: isMobile ? '1rem' : '1.5rem', textAlign: 'center', background: 'rgba(255,255,255,0.02)', cursor: 'pointer', position: 'relative' }}
            >
               <div style={{ color: 'var(--text-secondary)', fontSize: '0.7rem', fontWeight: '800', marginBottom: '0.5rem', letterSpacing: '0.05em' }}>{t('totalMessages', 'TOTAL MESSAGES').toUpperCase()}</div>
               <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.75rem' }}>
                 <div style={{ fontSize: isMobile ? '1.5rem' : '2.2rem', fontWeight: '900' }}>{stats?.totalMessages || 0}</div>
                 <MessageSquare size={18} color="var(--text-secondary)" style={{ opacity: 0.3 }} />
               </div>
               {totalUnread > 0 && (
                 <div style={{ position: 'absolute', top: '15px', right: '15px', background: 'var(--error-color)', color: 'white', borderRadius: '12px', padding: '2px 8px', fontSize: '0.75rem', fontWeight: 'bold' }}>
                   {totalUnread}
                 </div>
               )}
            </div>
            <div 
              className="glass-card" 
              onClick={() => setActiveTab('calendar')}
              style={{ padding: isMobile ? '1rem' : '1.5rem', textAlign: 'center', border: '1px solid rgba(59, 130, 246, 0.2)', background: 'rgba(59, 130, 246, 0.03)', cursor: 'pointer' }}
            >
               <div style={{ color: 'var(--accent-color)', fontSize: '0.7rem', fontWeight: '800', marginBottom: '0.5rem', letterSpacing: '0.05em' }}>{t('totalBookings').toUpperCase()}</div>
               <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.75rem' }}>
                 <div style={{ fontSize: isMobile ? '1.5rem' : '2.2rem', fontWeight: '900', color: 'var(--accent-color)' }}>{stats?.totalBookings || 0}</div>
                 <Calendar size={18} color="var(--accent-color)" style={{ opacity: 0.4 }} />
               </div>
            </div>
            <div className="glass-card" style={{ padding: isMobile ? '1rem' : '1.5rem', textAlign: 'center', background: 'rgba(255,255,255,0.02)' }}>
               <div style={{ color: 'var(--success-color)', fontSize: '0.7rem', fontWeight: '800', marginBottom: '0.5rem', letterSpacing: '0.05em' }}>{t('commissionGrowth').toUpperCase()}</div>
               <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.75rem' }}>
                 <div style={{ fontSize: isMobile ? '1.5rem' : '2.2rem', fontWeight: '900', color: 'var(--success-color)' }}>{stats?.commissionGrowth || '0%'}</div>
                 <TrendingUp size={18} color="var(--success-color)" style={{ opacity: 0.3 }} />
               </div>
            </div>
          </div>

          <div className="glass-card" style={{ padding: isMobile ? '1.5rem' : '2rem', height: '280px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
               <h3 style={{ fontSize: '1.1rem', fontWeight: '800', letterSpacing: '0.02em' }}>{t('revenueTrend')}</h3>
               <Activity size={18} color="var(--accent-color)" style={{ opacity: 0.5 }} />
            </div>
            <div style={{ height: '180px' }}>
              <RevenueLineChart data={stats?.revenueData || stats?.chartData || [0, 0, 0, 0, 0, 0, 0]} height={180} />
            </div>
          </div>

          {/* Quick Blacklist Section */}
          <div style={{ marginTop: '1.5rem' }}>
            <QuickBlacklistSection API_BASE={API_BASE} token={token} showToast={showToast} t={t} lang={lang} />
          </div>
        </div>

        {/* Agenda Column with Day Navigation */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          <div className="glass-card" style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', height: '100%', minHeight: '500px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
              <h3 style={{ fontSize: '1.1rem', fontWeight: '800' }}>
                {(() => {
                  const d = calViewDate || new Date();
                  const isToday = d.toDateString() === new Date().toDateString();
                  return isToday ? (t('todaysBookings')) : (t('bookingsForDate').replace('{date}', d.toLocaleDateString(lang === 'cz' ? 'cs-CZ' : 'en-GB', { day: 'numeric', month: 'numeric' })));
                })()}
              </h3>
              <div style={{ display: 'flex', gap: '0.35rem', alignItems: 'center' }}>
                <button 
                  onClick={() => { const d = new Date(calViewDate || new Date()); d.setDate(d.getDate()-1); setCalViewDate(d); }} 
                  style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid var(--card-border)', color: 'white', padding: '0.45rem', borderRadius: '10px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.2s' }}
                  onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.1)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'rgba(255,255,255,0.05)'}
                >
                  <ChevronLeft size={16} />
                </button>
                <div style={{ background: 'rgba(59, 130, 246, 0.1)', border: '1px solid rgba(59, 130, 246, 0.2)', borderRadius: '10px', padding: '0.4rem 0.75rem', textAlign: 'center', minWidth: '85px' }}>
                  <div style={{ fontSize: '0.85rem', fontWeight: '900', color: 'var(--accent-color)' }}>
                    {(calViewDate || new Date()).toLocaleDateString(lang === 'cz' ? 'cs-CZ' : 'en-GB', { day: 'numeric', month: 'short' })}
                  </div>
                </div>
                <button 
                  onClick={() => { const d = new Date(calViewDate || new Date()); d.setDate(d.getDate()+1); setCalViewDate(d); }} 
                  style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid var(--card-border)', color: 'white', padding: '0.45rem', borderRadius: '10px', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'all 0.2s' }}
                  onMouseEnter={e => e.currentTarget.style.background = 'rgba(255,255,255,0.1)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'rgba(255,255,255,0.05)'}
                >
                  <ChevronRight size={16} />
                </button>
              </div>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem', overflowY: 'auto', flex: 1, paddingRight: '0.25rem' }}>
              {(() => {
                const d = calViewDate || new Date();
                const dStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
                const filtered = (calendar || []).filter(e => {
                  return (e.startTime && e.startTime.startsWith(dStr)) || (e.date && e.date.startsWith(dStr));
                });

                if (filtered.length > 0) {
                  return filtered.map((event, i) => (
                    <div key={i} className="fade-in" style={{ padding: '1.25rem', background: 'rgba(255,255,255,0.03)', borderRadius: '16px', border: '1px solid rgba(255,255,255,0.05)', borderLeft: `4px solid ${event.status === 'confirmed' ? 'var(--success-color)' : 'var(--accent-color)'}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: '900', fontSize: '1rem', color: 'white', marginBottom: '0.2rem' }}>{event.time}</div>
                        <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: '600' }}>{(event.title || '').replace('Meeting w/ ', '')}</div>
                      </div>
                      <div style={{ textAlign: 'right', flexShrink: 0 }}>
                        <div style={{ fontSize: '0.7rem', fontWeight: '900', color: 'var(--text-secondary)', opacity: 0.8 }}>{event.duration}</div>
                        {event.profileName && <div style={{ fontSize: '0.65rem', color: 'var(--accent-color)', marginTop: '0.3rem', fontWeight: '800', background: 'rgba(59, 130, 246, 0.1)', padding: '2px 6px', borderRadius: '4px' }}>{event.profileName}</div>}
                      </div>
                    </div>
                  ));
                }
                
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, gap: '1.5rem', opacity: 0.3, padding: '2rem 0' }}>
                    <div style={{ width: '64px', height: '64px', borderRadius: '50%', background: 'rgba(255,255,255,0.03)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <Calendar size={32} />
                    </div>
                    <div style={{ textAlign: 'center' }}>
                      <div style={{ fontSize: '1rem', fontWeight: '800', marginBottom: '0.25rem' }}>{t('noBookingsToday')}</div>
                      <div style={{ fontSize: '0.8rem' }}>{t('tryAnotherDay')}</div>
                    </div>
                  </div>
                );
              })()}
            </div>
          </div>
        </div>
      </div>
      </>
      )}
    </div>
  );

  const renderModel = () => {

    return (
      <div className="fade-in">
        <WelcomeSection user={user} t={t} lang={lang} />
        <AlertsSection activeSubscription={activeSubscription} agencies={agencies} stats={stats} profiles={_profiles} activeRole={activeRole} t={t} />

        <div style={{ marginBottom: isMobile ? '1.5rem' : '2rem' }}>
          <SafetyControlCard />
        </div>


        <div style={{ marginBottom: isMobile ? '1.1rem' : '2.5rem' }}>
          <h2 style={{ fontSize: isMobile ? '1.35rem' : '2rem', fontWeight: '900', lineHeight: 1.15 }}>{t('dailyAgenda')}</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: isMobile ? '0.9rem' : '1rem', marginTop: isMobile ? '0.35rem' : '0.5rem' }}>{t('dailyAgendaDesc')}</p>
        </div>

      {isBackgroundLoading ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '200px', width: '100%', background: 'rgba(255,255,255,0.02)', borderRadius: '24px', border: '1px solid var(--card-border)' }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1rem' }}>
            <Loader2 className="animate-spin" size={24} color="var(--accent-color)" />
            <div className="premium-loading-text" style={{ fontSize: '0.6rem', letterSpacing: '0.15em', opacity: 0.5 }}>NAČÍTÁNÍ_AGENDY...</div>
          </div>
        </div>
      ) : (
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1.5fr 1fr', gap: '2rem' }}>
        <div className="glass-card" style={{ padding: isMobile ? '1.15rem' : '2rem' }}>
          <h3 style={{ fontSize: isMobile ? '0.95rem' : '1.1rem', fontWeight: '800', marginBottom: isMobile ? '0.9rem' : '1.5rem' }}>{t('todaysBookings')}</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {(calendar || []).length > 0 ? (calendar || []).map((event, i) => (
              <div key={i} style={{ padding: '1.25rem', background: 'rgba(255,255,255,0.03)', borderRadius: '15px', borderLeft: `4px solid ${event.status === 'confirmed' ? 'var(--success-color)' : 'var(--accent-color)'}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ fontWeight: '800', fontSize: '1rem' }}>{event.time}</div>
                  <div style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>{(event.title || '').replace('Meeting w/ ', '')}</div>
                </div>
                <div style={{ fontSize: '0.75rem', fontWeight: '900', color: 'var(--text-secondary)' }}>{event.duration}</div>
              </div>
            )) : <div style={{ color: 'var(--text-secondary)' }}>{t('noBookingsToday')}</div>}
          </div>
        </div>
      </div>
      )}
    </div>
    );
  };

  return (
    <div style={{ 
      padding: isMobile ? '0.75rem 0.9rem 2rem' : '3rem 3rem 6rem',
      maxWidth: '1400px',
      margin: '0 auto',
      width: '100%',
      minHeight: '100%',
      display: 'flex',
      flexDirection: 'column'
    }}>
      {isAppOwner ? renderSuperAdmin() : (isManager ? renderManager() : (isModel ? renderModel() : renderOperator()))}
    </div>
  );
};

const QuickBlacklistSection = ({ API_BASE, token, showToast, t, lang }) => {
  const [phone, setPhone] = useState('');
  // Důvod je kategorie z číselníku, ne volný text — viz config/blacklistReasons.js.
  // Server neznámý kód odmítne, takže výchozí hodnota musí být platný kód.
  const [duvod, setDuvod] = useState(DUVODY_BLACKLIST[0]);
  const [isLoading, setIsLoading] = useState(false);

  return (
    <div className="glass-card" style={{ padding: '1.5rem', border: '1px solid rgba(239, 68, 68, 0.2)', background: 'rgba(239, 68, 68, 0.02)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem' }}>
        <div style={{ width: '36px', height: '36px', borderRadius: '10px', background: 'rgba(239, 68, 68, 0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <ShieldCheck size={20} color="#ef4444" />
        </div>
        <h3 style={{ fontSize: '1.1rem', fontWeight: '800' }}>{t('quickBlacklist').toUpperCase()}</h3>
      </div>
      <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '1.25rem' }}>
        {t('blacklistDesc')}
      </p>
      <select
        value={duvod}
        onChange={e => setDuvod(e.target.value)}
        disabled={isLoading}
        aria-label={t('reason')}
        data-testid="blacklist-reason"
        style={{ width: '100%', marginBottom: '0.75rem', background: 'rgba(255,255,255,0.05)', border: '1px solid var(--card-border)', padding: '0.75rem 1rem', borderRadius: '10px', color: 'white' }}
      >
        {DUVODY_BLACKLIST.map(kod => (
          <option key={kod} value={kod} style={{ background: '#1a1a1a' }}>{popisDuvodu(kod, lang)}</option>
        ))}
      </select>
      <div style={{ display: 'flex', gap: '0.75rem' }}>
        <input 
          type="text" 
          placeholder="+420..." 
          value={phone}
          onChange={e => setPhone(e.target.value)}
          disabled={isLoading}
          style={{ flex: 1, background: 'rgba(255,255,255,0.05)', border: '1px solid var(--card-border)', padding: '0.75rem 1rem', borderRadius: '10px', color: 'white' }}
        />
        <button 
          onClick={async () => {
            if (!phone.trim()) return;
            setIsLoading(true);
            try {
              const res = await fetch(`${API_BASE}/blacklist`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({ phone: phone, reason: duvod })
              });
              if (res.ok) {
                setPhone('');
                showToast(t('blacklistedSuccess'), 'success');
              } else {
                showToast(t('blacklistedError'), 'error');
              }
            } catch (_err) {
              showToast(t('networkError'), 'error');
            } finally {
              setIsLoading(false);
            }
          }}
          disabled={isLoading}
          style={{ background: '#ef4444', color: 'white', border: 'none', padding: '0 1.25rem', borderRadius: '10px', fontWeight: '800', fontSize: '0.8rem', cursor: 'pointer', opacity: isLoading ? 0.6 : 1 }}
        >
          {isLoading ? '...' : t('blacklist').toUpperCase()}
        </button>
      </div>
    </div>
  );
};

export default DashboardHome;

const WelcomeSection = ({ user, t, lang }) => (
  <div style={{ marginBottom: '1.5rem' }}>
    <h2 id="dashboard-welcome-title" style={{ fontSize: '1.5rem', fontWeight: '900', margin: 0 }}>👋 {t('welcomeBack')}, {user?.name || 'Uživateli'}!</h2>
    <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', margin: '0.25rem 0 0' }}>{new Date().toLocaleDateString(lang === 'cz' ? 'cs-CZ' : 'en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</p>
  </div>
);

const AlertsSection = ({ activeSubscription, agencies, stats, profiles, activeRole, t }) => {
  const alerts = [];
  if (activeSubscription) {
    const now = new Date();
    const expiresAt = new Date(activeSubscription?.expiresAt || now);
    const daysLeft = Math.max(0, Math.ceil((expiresAt - now) / 86400000));
    const status = activeSubscription?.status;
    if (status === 'EXPIRED') {
      alerts.push({ message: t('subscriptionExpired'), color: '#ef4444' });
    } else if (status === 'TRIAL' && daysLeft < 7) {
      alerts.push({ message: t('trialExpiresIn').replace('{days}', daysLeft), color: '#f59e0b' });
    }
  }
  const myAgency = (agencies || [])?.[0];
  const hasProfilesInAgency = (stats?.totalProfiles || 0) > 0 || (stats?.activeProfiles || 0) > 0 || (myAgency?.totalProfiles || 0) > 0;
  
  if (!hasProfilesInAgency && (profiles || []).length === 0 && (activeRole === 'app_owner' || activeRole === 'agency_admin' || activeRole === 'manager')) {
    alerts.push({ message: t('createFirstProfile'), color: '#3b82f6' });
  }
  if (alerts.length === 0) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginBottom: '1.5rem' }}>
      {alerts.map((a, i) => (
        <div key={i} className="glass-card" style={{ padding: '0.85rem 1.25rem', borderLeft: `4px solid ${a.color}`, display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <AlertTriangle size={18} color={a.color} style={{ flexShrink: 0 }} />
          <span style={{ fontSize: '0.85rem', fontWeight: '600', color: a.color }}>{a.message}</span>
        </div>
      ))}
    </div>
  );
};

const SkeletonStatsGrid = ({ columns = 3, isMobile }) => (
  <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : `repeat(${columns}, 1fr)`, gap: '1.5rem', marginBottom: '1.5rem' }}>
    {Array.from({ length: columns }).map((_, i) => (
      <div key={i} className="glass-card" style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        <Skeleton width="40px" height="40px" borderRadius="10px" />
        <Skeleton width="60%" height="12px" />
        <Skeleton width="40%" height="24px" />
        <div className="premium-loading-text" style={{ fontSize: '0.6rem', marginTop: 'auto' }}>HYDRATING...</div>
      </div>
    ))}
  </div>
);

