import React from 'react';
import BankTransferInstructions from '../BankTransferInstructions';
import { 
  Activity, Building2, Smartphone, ShieldCheck, Lock, 
  DollarSign, Sparkles, TrendingUp, Terminal, CheckCircle2, CalendarClock, AlertTriangle
} from 'lucide-react';

import { useNexus } from '../../context/ContextHook';
import StripeEmbeddedCheckoutModal from '../Billing/StripeEmbeddedCheckoutModal';

import { API_BASE } from '../../constants/config';
const SettingsView = () => {
  const nexus = useNexus();
  const {
    isMobile = false,
    t = (k) => k,
    lang = 'cz',
    activeRole = '',
    activeOperator = null,
    agencies = [],
    operators: availableOperators = [],
    sessions = [],
    profiles = [],
    handleRevokeBinding = () => {},
    agencySettings = {},
    updateAgencySettings = () => {},
    departureIntervalMin = 15,
    setDepartureIntervalMin = () => {},
    isMaintenanceMode = false,
    setIsMaintenanceMode = () => {},
    globalAnnouncement = '',
    setGlobalAnnouncement = () => {},
    publishGlobalAnnouncement = () => {},
    isAllowed = () => false,
    showToast = () => {},
    setLang = () => {},
    activeSubscription = null,
    activeMarket = 'cz',
    startCheckout = null,
    startBillingPortal = null,
    isStartingSubscription = false,
    _daysLeft = 0
  } = nexus || {};

  const activeClient = (agencies || [])[0] || null;
  const seatsLimit = (() => {
    const planClean = String(activeClient?.plan || 'Enterprise').toLowerCase();
    if (planClean === 'enterprise') return lang === 'cz' ? 'Neomezeně' : 'Unlimited';
    if (planClean === 'agency') return '20';
    if (planClean === 'professional' || planClean === 'pro') return '10';
    if (planClean === 'starter') return '5';
    return lang === 'cz' ? 'Neomezeně' : 'Unlimited';
  })();
  const [timezoneLabel] = React.useState(() => {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    const offsetMinutes = -new Date().getTimezoneOffset();
    const sign = offsetMinutes >= 0 ? '+' : '-';
    const absolute = Math.abs(offsetMinutes);
    const hours = Math.floor(absolute / 60);
    const minutes = absolute % 60;
    return `${timeZone} (UTC${sign}${hours}${minutes ? `:${String(minutes).padStart(2, '0')}` : ''})`;
  });
  const loadingText = lang === 'cz' ? 'NAČÍTÁM...' : 'LOADING...';
  const activationButtonText = (label) => isStartingSubscription ? loadingText : label;
  const activationButtonBaseStyle = {
    transition: 'opacity 0.2s',
    opacity: isStartingSubscription ? 0.65 : 1,
    cursor: isStartingSubscription ? 'wait' : 'pointer'
  };
  const [embeddedCheckout, setEmbeddedCheckout] = React.useState(null);

  // Způsob platby a pokyny k převodu.
  //
  // `dostupneMetody` se ptá serveru schválně: převod je za přepínačem
  // ALLOW_BANK_TRANSFER_BILLING a nabízet ho tam, kde není zapnutý, znamená
  // poslat uživatele do chyby.
  const [zpusobPlatby, setZpusobPlatby] = React.useState('card');
  const [pokynyPrevodem, setPokynyPrevodem] = React.useState(null);
  const [dostupneMetody, setDostupneMetody] = React.useState({ card: true, transfer: false });

  React.useEffect(() => {
    if (!nexus?.token) return undefined;
    let zruseno = false;
    (async () => {
      try {
        const zaklad = API_BASE;
        const r = await fetch(`${zaklad}/billing/methods`, { headers: { Authorization: `Bearer ${nexus.token}` } });
        if (!r.ok) return;
        const d = await r.json();
        if (!zruseno) setDostupneMetody({ card: d.card !== false, transfer: d.transfer === true });
      } catch { /* zůstane výchozí: jen karta */ }
    })();
    return () => { zruseno = true; };
  }, [nexus?.token]);

  const handleUpgrade = async (planId, method = zpusobPlatby) => {
    if (isStartingSubscription) return;
    if (!nexus?.token) {
      showToast(lang === 'cz' ? 'Nejste přihlášený. Přihlaste se prosím znovu.' : 'You are not signed in. Please sign in again.', 'error');
      return;
    }

    try {
      if (typeof startCheckout === 'function') {
        const checkout = await startCheckout({
          planId,
          paymentMethod: method,
          checkoutMode: 'embedded',
          market: activeMarket,
          successUrl: window.location.href,
          cancelUrl: window.location.href
        });
        // Převod nikam nepřesměrovává — vrací platební pokyny, které se
        // musí ukázat. Kdyby se sem propadl, uživatel by klikl a nestalo
        // by se navenek vůbec nic.
        if (checkout?.paymentMethod === 'transfer' && checkout?.pokyny) {
          setPokynyPrevodem(checkout.pokyny);
        } else if (checkout?.clientSecret && checkout?.publishableKey) {
          setEmbeddedCheckout(checkout);
        } else if (checkout?.url) {
          window.location.assign(checkout.url);
        }
        return;
      }

      const response = await fetch(`${API_BASE}/billing/checkout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${nexus.token}`
        },
        body: JSON.stringify({ 
          planId,
          paymentMethod: method,
          checkoutMode: 'embedded',
          market: activeMarket,
          successUrl: window.location.href,
          cancelUrl: window.location.href
        })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.message || (lang === 'cz' ? 'Platební brána není dostupná.' : 'Payment gateway is not available.'));
      }
      
      if (method === 'card' && data.clientSecret && data.publishableKey) {
        setEmbeddedCheckout(data);
      } else if (method === 'card' && data.url) {
        window.location.assign(data.url);
      } else if (method === 'card') {
        throw new Error(data.message || (lang === 'cz' ? 'Platební brána nevrátila adresu pro přesměrování.' : 'Payment gateway did not return a redirect URL.'));
      }
    } catch (err) {
      console.error("Upgrade failed:", err);
      showToast(err.message || (lang === 'cz' ? 'Chyba při inicializaci platby.' : 'Error initializing payment.'), 'error');
    }
  };

  const handleBillingPortal = async () => {
    if (isStartingSubscription) return;
    if (typeof startBillingPortal === 'function') {
      await startBillingPortal({ returnUrl: window.location.href });
      return;
    }
    showToast(lang === 'cz' ? 'Správa plateb není dostupná.' : 'Billing management is not available.', 'error');
  };

  return (
    <div data-testid="page-settings-container" style={{ padding: isMobile ? '1.5rem 1rem' : '2rem', flex: 1, overflowY: isMobile ? 'visible' : 'auto' }} className="fade-in custom-scrollbar">

      <StripeEmbeddedCheckoutModal
        checkout={embeddedCheckout}
        lang={lang}
        isMobile={isMobile}
        onClose={() => setEmbeddedCheckout(null)}
        onError={(message) => showToast(message, 'error')}
      />
      <h2 style={{ fontSize: '2rem', fontWeight: '800' }}>
        {activeRole === 'app_owner' ? t('controlCenter') : t('agencyControlCenter')}
      </h2>
      <p style={{ color: 'var(--text-secondary)', marginBottom: '3rem' }}>
        {activeRole === 'app_owner' ? t('configSubtitle') : t('agencyConfigSubtitle')}
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '3rem' }}>
        {activeRole === 'app_owner' && (
          <div className="settings-section">
            <h3 style={{ marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Activity size={20} color="var(--success-color)" /> Platform Health Snapshot
            </h3>
            <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(3, 1fr)', gap: '1rem' }}>
              <div className="glass-card" style={{ padding: '1.25rem', textAlign: 'center' }}>
                <div style={{ fontSize: '0.65rem', fontWeight: '800', color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>ACTIVE SESSIONS</div>
                <div style={{ fontSize: '1.5rem', fontWeight: '900' }}>32</div>
              </div>
              <div className="glass-card" style={{ padding: '1.25rem', textAlign: 'center' }}>
                <div style={{ fontSize: '0.65rem', fontWeight: '800', color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>DB LATENCY</div>
                <div style={{ fontSize: '1.5rem', fontWeight: '900', color: 'var(--success-color)' }}>12ms</div>
              </div>
              <div className="glass-card" style={{ padding: '1.25rem', textAlign: 'center' }}>
                <div style={{ fontSize: '0.65rem', fontWeight: '800', color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>OUTGOING NODES</div>
                <div style={{ fontSize: '1.5rem', fontWeight: '900' }}>4</div>
              </div>
            </div>
          </div>
        )}

        {/* --- SUBSCRIPTIONS & MODULES SECTION --- */}
        <div className="settings-section">
          <h3 style={{ marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <DollarSign size={20} color="#fbbf24" /> {lang === 'cz' ? 'Předplatné a moduly' : 'Subscriptions & Modules'}
          </h3>
          
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {/* Current Plan Overview - two column layout */}
            <div className="glass-card" style={{
              padding: isMobile ? '1.5rem' : '2rem',
              background: 'linear-gradient(135deg, rgba(251,191,36,0.06) 0%, rgba(255,255,255,0.02) 100%)',
              border: '1px solid rgba(251,191,36,0.2)'
            }}>
              <div style={{
                display: 'grid',
                gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr',
                gap: isMobile ? '2rem' : '3rem',
                alignItems: 'start'
              }}>

                {/* LEFT: Plan info + validity */}
                <div>
                  {/* Plan header */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.5rem' }}>
                    <div>
                      <div style={{ fontSize: '0.65rem', fontWeight: '800', color: '#fbbf24', textTransform: 'uppercase', letterSpacing: '0.12em', marginBottom: '0.4rem' }}>
                        {lang === 'cz' ? 'AKTUÁLNÍ TARIF' : 'CURRENT PLAN'}
                      </div>
                      <div style={{ fontSize: '2.25rem', fontWeight: '950', lineHeight: 1.1 }}>
                        {activeClient?.plan || 'Enterprise'}
                      </div>
                    </div>
                    <div style={{ padding: '0.5rem 1rem', background: 'rgba(16,185,129,0.1)', color: '#10b981', borderRadius: '12px', fontSize: '0.75rem', fontWeight: '900', display: 'flex', alignItems: 'center', gap: '0.5rem', flexShrink: 0, border: '1px solid rgba(16,185,129,0.2)' }}>
                      <CheckCircle2 size={15} /> {lang === 'cz' ? 'AKTIVNÍ' : 'ACTIVE'}
                    </div>
                  </div>

                  {/* Validity bar */}
                  {(() => {
                    let expiry = activeSubscription?.expiresAt
                      ? new Date(activeSubscription.expiresAt)
                      : activeClient?.planExpiresAt
                        ? new Date(activeClient.planExpiresAt)
                        : null;
                    if (!expiry) {
                      expiry = new Date();
                      expiry.setDate(expiry.getDate() + 30);
                    }
                    const now = new Date();
                    const totalDays = 365;
                    const remaining = Math.max(0, Math.ceil((expiry - now) / 86400000));
                    const usedFraction = Math.min(1, Math.max(0, 1 - remaining / totalDays));
                    const barColor = remaining <= 7 ? '#ef4444' : remaining <= 30 ? '#f59e0b' : '#10b981';
                    const barPct = Math.max(2, Math.round((1 - usedFraction) * 100));

                    return (
                      <div>
                        {remaining <= 7 && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.6rem 0.85rem', background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.35)', borderRadius: '10px', marginBottom: '1rem', fontSize: '0.8rem', color: '#f87171', fontWeight: '700' }}>
                            <AlertTriangle size={15} />
                            {lang === 'cz'
                              ? `Tarif vyprší za ${remaining} ${remaining === 1 ? 'den' : remaining < 5 ? 'dny' : 'dní'}! Obnovte předplatné.`
                              : `Subscription expires in ${remaining} day${remaining !== 1 ? 's' : ''}! Please renew.`}
                          </div>
                        )}

                        {/* Days remaining big display */}
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem', marginBottom: '0.75rem' }}>
                          <span style={{ fontSize: '3rem', fontWeight: '900', color: barColor, lineHeight: 1 }}>{remaining}</span>
                          <span style={{ fontSize: '1rem', fontWeight: '700', color: 'var(--text-secondary)' }}>
                            {lang === 'cz' ? (remaining === 1 ? 'den' : remaining < 5 ? 'dny' : 'dní') : `day${remaining !== 1 ? 's' : ''}`} {lang === 'cz' ? 'zbývá' : 'remaining'}
                          </span>
                        </div>

                        {/* Expiry date */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: 'var(--text-secondary)', fontSize: '0.8rem', fontWeight: '600', marginBottom: '0.85rem' }}>
                          <CalendarClock size={14} color="#fbbf24" />
                          {lang === 'cz' ? 'Platnost do:' : 'Valid until:'}
                          <span style={{ color: 'white', fontWeight: '800' }}>
                            {expiry.toLocaleDateString(lang === 'cz' ? 'cs-CZ' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}
                          </span>
                        </div>

                        {/* Progress bar */}
                        <div style={{ height: '8px', background: 'rgba(255,255,255,0.07)', borderRadius: '99px', overflow: 'hidden' }}>
                          <div style={{
                            height: '100%',
                            width: `${barPct}%`,
                            background: `linear-gradient(90deg, ${barColor}88, ${barColor})`,
                            borderRadius: '99px',
                            transition: 'width 0.5s ease'
                          }} />
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.65rem', color: 'var(--text-secondary)', marginTop: '0.4rem' }}>
                          <span>{lang === 'cz' ? 'Začátek' : 'Start'}</span>
                          <span>{lang === 'cz' ? 'Konec' : 'End'}</span>
                        </div>
                        <button
                          onClick={handleBillingPortal}
                          disabled={isStartingSubscription}
                          style={{
                            marginTop: '1rem',
                            padding: '0.75rem 1rem',
                            borderRadius: '10px',
                            border: '1px solid rgba(251,191,36,0.35)',
                            background: 'rgba(251,191,36,0.1)',
                            color: '#fbbf24',
                            fontSize: '0.78rem',
                            fontWeight: '900',
                            cursor: isStartingSubscription ? 'wait' : 'pointer',
                            width: isMobile ? '100%' : 'auto'
                          }}
                        >
                          {activationButtonText(lang === 'cz' ? 'SPRAVOVAT PLATBY' : 'MANAGE BILLING')}
                        </button>
                      </div>
                    );
                  })()}
                </div>

                {/* RIGHT: Module cards */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                  <div style={{ fontSize: '0.65rem', fontWeight: '800', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '0.25rem' }}>
                    {lang === 'cz' ? 'DOSTUPNÉ MODULY' : 'AVAILABLE MODULES'}
                  </div>

                  {/* Analytics Module */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '1rem 1.25rem', background: 'rgba(59,130,246,0.05)', borderRadius: '14px', border: '1px solid rgba(59,130,246,0.15)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                      <TrendingUp size={18} color="#3b82f6" />
                      <span style={{ fontWeight: '800', fontSize: '0.9rem' }}>Analytics</span>
                    </div>
                    {(activeClient?.plan === 'Professional' || activeClient?.plan === 'Agency' || activeClient?.plan === 'Enterprise' || activeClient?.extraFeatures?.analytics) ? (
                      <div style={{ fontSize: '0.7rem', color: 'var(--success-color)', fontWeight: '900', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                        <CheckCircle2 size={14} /> {lang === 'cz' ? 'AKTIVOVÁNO' : 'ACTIVE'}
                      </div>
                    ) : (
                      <button disabled={isStartingSubscription} onClick={() => handleUpgrade('pro_monthly')} style={{ padding: '0.4rem 1rem', background: '#3b82f6', color: 'white', border: 'none', borderRadius: '8px', fontSize: '0.7rem', fontWeight: '900', ...activationButtonBaseStyle }}>
                        {activationButtonText(lang === 'cz' ? 'AKTIVOVAT' : 'ACTIVATE')}
                      </button>
                    )}
                  </div>

                  {/* AI Module */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '1rem 1.25rem', background: 'rgba(167,139,250,0.05)', borderRadius: '14px', border: '1px solid rgba(167,139,250,0.15)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                      <Sparkles size={18} color="#a78bfa" />
                      <span style={{ fontWeight: '800', fontSize: '0.9rem' }}>AI Features</span>
                    </div>
                    {(activeClient?.plan === 'Professional' || activeClient?.plan === 'Agency' || activeClient?.plan === 'Enterprise' || activeClient?.extraFeatures?.ai_features) ? (
                      <div style={{ fontSize: '0.7rem', color: 'var(--success-color)', fontWeight: '900', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                        <CheckCircle2 size={14} /> {lang === 'cz' ? 'AKTIVOVÁNO' : 'ACTIVE'}
                      </div>
                    ) : (
                      <button disabled={isStartingSubscription} onClick={() => handleUpgrade('ai_module', 'card')} style={{ padding: '0.4rem 0.9rem', background: '#a78bfa', color: 'black', border: 'none', borderRadius: '8px', fontSize: '0.65rem', fontWeight: '900', ...activationButtonBaseStyle }}>
                        {activationButtonText(lang === 'cz' ? 'AKTIVOVAT' : 'ACTIVATE')}
                      </button>
                    )}
                  </div>

                  {/* API Module */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '1rem 1.25rem', background: 'rgba(16,185,129,0.05)', borderRadius: '14px', border: '1px solid rgba(16,185,129,0.15)' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                      <Terminal size={18} color="#10b981" />
                      <span style={{ fontWeight: '800', fontSize: '0.9rem' }}>API Access</span>
                    </div>
                    {(activeClient?.plan === 'Agency' || activeClient?.plan === 'Enterprise' || activeClient?.extraFeatures?.api_access) ? (
                      <div style={{ fontSize: '0.7rem', color: 'var(--success-color)', fontWeight: '900', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                        <CheckCircle2 size={14} /> {lang === 'cz' ? 'AKTIVOVÁNO' : 'ACTIVE'}
                      </div>
                    ) : (
                      <button disabled={isStartingSubscription} onClick={() => handleUpgrade('api_access')} style={{ padding: '0.4rem 1rem', background: '#10b981', color: 'black', border: 'none', borderRadius: '8px', fontSize: '0.7rem', fontWeight: '900', ...activationButtonBaseStyle }}>
                        {activationButtonText(lang === 'cz' ? 'AKTIVOVAT' : 'ACTIVATE')}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>
            
            {/* Tariff Comparison Grid */}
            <div style={{ marginTop: '2rem' }}>
              <div style={{ fontSize: '0.8rem', fontWeight: '800', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: '1.25rem' }}>
                {lang === 'cz' ? 'SROVNÁNÍ A ZMĚNA TARIFŮ' : 'PLAN COMPARISON & UPGRADES'}
              </div>
              {/* Volba způsobu platby. Zobrazí se, jen když server převod
                  opravdu umí — jinak by tlačítko vedlo do chyby. */}
              {dostupneMetody.transfer && (
                <div data-testid="volba-zpusobu-platby" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 700, marginRight: '0.3rem' }}>
                    {lang === 'cz' ? 'PLATBA:' : 'PAYMENT:'}
                  </span>
                  {[
                    { id: 'card', popisek: lang === 'cz' ? 'Kartou' : 'Card' },
                    { id: 'transfer', popisek: lang === 'cz' ? 'Převodem' : 'Bank transfer' },
                  ].map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      data-testid={`zpusob-platby-${m.id}`}
                      onClick={() => { setZpusobPlatby(m.id); setPokynyPrevodem(null); }}
                      style={{
                        padding: '0.4rem 0.9rem', borderRadius: 8, cursor: 'pointer', fontWeight: 800, fontSize: '0.75rem',
                        border: zpusobPlatby === m.id ? '1px solid var(--accent-color)' : '1px solid var(--card-border)',
                        background: zpusobPlatby === m.id ? 'rgba(59,130,246,0.14)' : 'transparent',
                        color: zpusobPlatby === m.id ? 'var(--accent-color)' : 'var(--text-secondary)',
                      }}
                    >
                      {m.popisek}
                    </button>
                  ))}
                </div>
              )}

              {pokynyPrevodem && (
                <BankTransferInstructions pokyny={pokynyPrevodem} lang={lang} onClose={() => setPokynyPrevodem(null)} />
              )}

              <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(3, 1fr)', gap: '1.25rem', marginTop: pokynyPrevodem ? '1.25rem' : 0 }}>
                
                {/* Starter Plan Card */}
                <div className="glass-card" style={{ 
                  padding: '1.5rem', 
                  display: 'flex', 
                  flexDirection: 'column', 
                  gap: '1rem',
                  border: activeClient?.plan === 'Starter' ? '1px solid var(--accent-color)' : '1px solid var(--card-border)',
                  background: activeClient?.plan === 'Starter' ? 'rgba(59,130,246,0.02)' : 'transparent'
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ fontWeight: '900', fontSize: '1.25rem' }}>Starter</div>
                    {activeClient?.plan === 'Starter' && (
                      <span style={{ fontSize: '0.65rem', padding: '3px 8px', background: 'rgba(59,130,246,0.15)', color: 'var(--accent-color)', borderRadius: '20px', fontWeight: '800' }}>
                        {lang === 'cz' ? 'AKTUÁLNÍ' : 'CURRENT'}
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: '1.75rem', fontWeight: '950', color: 'white' }}>
                    {lang === 'cz' ? '290 Kč' : '12 EUR'} <span style={{ fontSize: '0.8rem', fontWeight: '600', color: 'var(--text-secondary)' }}>/ {lang === 'cz' ? 'měsíc' : 'mo'}</span>
                  </div>
                  <div style={{ fontSize: '0.72rem', fontWeight: '800', color: '#fbbf24' }}>
                    {lang === 'cz' ? 'První měsíc ZDARMA (Trial)' : 'First month FREE (Trial)'}
                  </div>
                  <div style={{ fontSize: '0.8rem', fontWeight: '700', color: 'var(--accent-color)' }}>
                    {lang === 'cz' ? 'Limit: až 5 profilů' : 'Limit: up to 5 profiles'}
                  </div>
                  <ul style={{ paddingLeft: '1.25rem', margin: 0, fontSize: '0.78rem', color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: '0.4rem', flex: 1 }}>
                    <li>{lang === 'cz' ? 'Základní správa profilů' : 'Basic profile management'}</li>
                    <li>{lang === 'cz' ? 'SOS Emergency alerty' : 'Emergency SOS alerts'}</li>
                    <li>{lang === 'cz' ? 'Manuální směrování SMS' : 'Manual SMS routing'}</li>
                  </ul>
                  {activeClient?.plan === 'Starter' ? (
                    <button disabled style={{ padding: '0.75rem', borderRadius: '10px', border: 'none', background: 'rgba(16,185,129,0.1)', color: '#10b981', fontSize: '0.8rem', fontWeight: '800', cursor: 'default', width: '100%' }}>
                      {lang === 'cz' ? 'AKTIVNÍ TARIF' : 'ACTIVE PLAN'}
                    </button>
                  ) : (
                    <button 
                      data-testid="plan-activate-starter"
                      disabled={isStartingSubscription}
                      onClick={() => handleUpgrade('starter_monthly')} 
                      style={{ padding: '0.75rem', borderRadius: '10px', border: 'none', background: 'var(--accent-color)', color: 'white', fontSize: '0.8rem', fontWeight: '800', width: '100%', ...activationButtonBaseStyle }}
                      onMouseOver={(e) => { if (!isStartingSubscription) e.currentTarget.style.opacity = 0.85; }}
                      onMouseOut={(e) => { if (!isStartingSubscription) e.currentTarget.style.opacity = 1; }}
                    >
                      {activationButtonText(lang === 'cz' ? 'AKTIVOVAT STARTER' : 'ACTIVATE STARTER')}
                    </button>
                  )}
                </div>

                {/* Professional Plan Card */}
                <div className="glass-card" style={{ 
                  padding: '1.5rem', 
                  display: 'flex', 
                  flexDirection: 'column', 
                  gap: '1rem',
                  border: (activeClient?.plan === 'Professional' || activeClient?.plan === 'Pro') ? '1px solid var(--accent-color)' : '1px solid var(--card-border)',
                  background: (activeClient?.plan === 'Professional' || activeClient?.plan === 'Pro') ? 'rgba(59,130,246,0.02)' : 'transparent',
                  position: 'relative'
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.75rem' }}>
                    <div style={{ fontWeight: '900', fontSize: '1.25rem' }}>Professional</div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '0.4rem', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: '0.62rem', padding: '4px 10px', background: 'linear-gradient(135deg, #3b82f6, #2563eb)', color: 'white', borderRadius: '20px', fontWeight: '900', textTransform: 'uppercase', letterSpacing: '0.04em', boxShadow: '0 6px 18px rgba(37,99,235,0.35)', border: '1px solid rgba(255,255,255,0.18)', lineHeight: 1 }}>
                        {lang === 'cz' ? 'POPULÁRNÍ' : 'POPULAR'}
                      </span>
                      {(activeClient?.plan === 'Professional' || activeClient?.plan === 'Pro') && (
                        <span style={{ fontSize: '0.65rem', padding: '3px 8px', background: 'rgba(59,130,246,0.15)', color: 'var(--accent-color)', borderRadius: '20px', fontWeight: '800' }}>
                          {lang === 'cz' ? 'AKTUÁLNÍ' : 'CURRENT'}
                        </span>
                      )}
                    </div>
                  </div>
                  <div style={{ fontSize: '1.75rem', fontWeight: '950', color: 'white' }}>
                    990 Kč <span style={{ fontSize: '0.8rem', fontWeight: '600', color: 'var(--text-secondary)' }}>/ {lang === 'cz' ? 'měsíc' : 'mo'}</span>
                  </div>
                  <div style={{ fontSize: '0.8rem', fontWeight: '700', color: 'var(--accent-color)' }}>
                    {lang === 'cz' ? 'Limit: až 10 profilů' : 'Limit: up to 10 profiles'}
                  </div>
                  <ul style={{ paddingLeft: '1.25rem', margin: 0, fontSize: '0.78rem', color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: '0.4rem', flex: 1 }}>
                    <li><strong>{lang === 'cz' ? 'Vše v Starter' : 'Everything in Starter'}</strong></li>
                    <li>{lang === 'cz' ? 'Analytics modul v ceně' : 'Analytics module included'}</li>
                    <li>{lang === 'cz' ? 'AI chatové návrhy a překladač' : 'AI suggestions & translator'}</li>
                    <li>{lang === 'cz' ? 'Automatické topování (Organic Boost)' : 'Organic boost automation'}</li>
                  </ul>
                  {(activeClient?.plan === 'Professional' || activeClient?.plan === 'Pro') ? (
                    <button disabled style={{ padding: '0.75rem', borderRadius: '10px', border: 'none', background: 'rgba(16,185,129,0.1)', color: '#10b981', fontSize: '0.8rem', fontWeight: '800', cursor: 'default', width: '100%' }}>
                      {lang === 'cz' ? 'AKTIVNÍ TARIF' : 'ACTIVE PLAN'}
                    </button>
                  ) : (
                    <button 
                      data-testid="plan-activate-professional"
                      disabled={isStartingSubscription}
                      onClick={() => handleUpgrade('pro_monthly')} 
                      style={{ padding: '0.75rem', borderRadius: '10px', border: 'none', background: 'var(--accent-color)', color: 'white', fontSize: '0.8rem', fontWeight: '800', width: '100%', ...activationButtonBaseStyle }}
                      onMouseOver={(e) => { if (!isStartingSubscription) e.currentTarget.style.opacity = 0.85; }}
                      onMouseOut={(e) => { if (!isStartingSubscription) e.currentTarget.style.opacity = 1; }}
                    >
                      {activationButtonText(lang === 'cz' ? 'AKTIVOVAT PROFESSIONAL' : 'ACTIVATE PROFESSIONAL')}
                    </button>
                  )}
                </div>

                {/* Agency Plan Card */}
                <div className="glass-card" style={{ 
                  padding: '1.5rem', 
                  display: 'flex', 
                  flexDirection: 'column', 
                  gap: '1rem',
                  border: (activeClient?.plan === 'Agency' || activeClient?.plan === 'Enterprise') ? '1px solid var(--accent-color)' : '1px solid var(--card-border)',
                  background: (activeClient?.plan === 'Agency' || activeClient?.plan === 'Enterprise') ? 'rgba(59,130,246,0.02)' : 'transparent'
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ fontWeight: '900', fontSize: '1.25rem' }}>Agency / Enterprise</div>
                    {(activeClient?.plan === 'Agency' || activeClient?.plan === 'Enterprise') && (
                      <span style={{ fontSize: '0.65rem', padding: '3px 8px', background: 'rgba(59,130,246,0.15)', color: 'var(--accent-color)', borderRadius: '20px', fontWeight: '800' }}>
                        {lang === 'cz' ? 'AKTUÁLNÍ' : 'CURRENT'}
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: '1.75rem', fontWeight: '950', color: 'white' }}>
                    2 490 Kč <span style={{ fontSize: '0.8rem', fontWeight: '600', color: 'var(--text-secondary)' }}>/ {lang === 'cz' ? 'měsíc' : 'mo'}</span>
                  </div>
                  <div style={{ fontSize: '0.8rem', fontWeight: '700', color: 'var(--accent-color)' }}>
                    {lang === 'cz' ? 'Limit: až 20 profilů' : 'Limit: up to 20 profiles'}
                  </div>
                  <ul style={{ paddingLeft: '1.25rem', margin: 0, fontSize: '0.78rem', color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: '0.4rem', flex: 1 }}>
                    <li><strong>{lang === 'cz' ? 'Vše v Professional' : 'Everything in Professional'}</strong></li>
                    <li>{lang === 'cz' ? 'Developer API přístup' : 'Developer API access'}</li>
                    <li>{lang === 'cz' ? 'PM2 auditní logy a historie' : 'Audit logs & tracking'}</li>
                    <li>{lang === 'cz' ? 'Nejvyšší priorita podpory' : 'Priority support'}</li>
                  </ul>
                  {(activeClient?.plan === 'Agency' || activeClient?.plan === 'Enterprise') ? (
                    <button disabled style={{ padding: '0.75rem', borderRadius: '10px', border: 'none', background: 'rgba(16,185,129,0.1)', color: '#10b981', fontSize: '0.8rem', fontWeight: '800', cursor: 'default', width: '100%' }}>
                      {lang === 'cz' ? 'AKTIVNÍ TARIF' : 'ACTIVE PLAN'}
                    </button>
                  ) : (
                    <button 
                      data-testid="plan-activate-agency"
                      disabled={isStartingSubscription}
                      onClick={() => handleUpgrade('agency_monthly')} 
                      style={{ padding: '0.75rem', borderRadius: '10px', border: 'none', background: 'var(--accent-color)', color: 'white', fontSize: '0.8rem', fontWeight: '800', width: '100%', ...activationButtonBaseStyle }}
                      onMouseOver={(e) => { if (!isStartingSubscription) e.currentTarget.style.opacity = 0.85; }}
                      onMouseOut={(e) => { if (!isStartingSubscription) e.currentTarget.style.opacity = 1; }}
                    >
                      {activationButtonText(lang === 'cz' ? 'AKTIVOVAT AGENCY' : 'ACTIVATE AGENCY')}
                    </button>
                  )}
                </div>

              </div>
            </div>

          </div>
          
        </div>

        <div className="settings-section">
          <h3 style={{ marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Activity size={20} color="var(--accent-color)" /> {lang === 'cz' ? 'Osobní předvolby' : 'Personal Preferences'}
          </h3>
          <div className="glass-card" style={{ padding: isMobile ? '1.5rem' : '2rem' }}>
            <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: '1.5rem' }}>
              {/* Language */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '1.25rem', background: 'rgba(255,255,255,0.03)', borderRadius: '14px', border: '1px solid var(--card-border)' }}>
                <div>
                  <div style={{ fontWeight: '700', marginBottom: '0.25rem' }}>{lang === 'cz' ? 'Jazyk aplikace' : 'Application Language'}</div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{lang === 'cz' ? 'Jazyk uživatelského rozhraní' : 'UI display language'}</div>
                </div>
                <div style={{ display: 'flex', background: 'rgba(0,0,0,0.3)', padding: '3px', borderRadius: '12px', border: '1px solid var(--card-border)', flexShrink: 0 }}>
                  <button onClick={() => setLang('cz')} style={{ padding: '8px 18px', border: 'none', background: lang === 'cz' ? 'var(--accent-color)' : 'transparent', color: 'white', borderRadius: '9px', fontSize: '0.75rem', fontWeight: '900', cursor: 'pointer', transition: 'all 0.2s' }}>CZ</button>
                  <button onClick={() => setLang('en')} style={{ padding: '8px 18px', border: 'none', background: lang === 'en' ? 'var(--accent-color)' : 'transparent', color: 'white', borderRadius: '9px', fontSize: '0.75rem', fontWeight: '900', cursor: 'pointer', transition: 'all 0.2s' }}>EN</button>
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '1.25rem', background: 'rgba(255,255,255,0.03)', borderRadius: '14px', border: '1px solid var(--card-border)' }}>
                <div>
                  <div style={{ fontWeight: '700', marginBottom: '0.25rem' }}>{lang === 'cz' ? 'Časové pásmo' : 'Timezone'}</div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{timezoneLabel}</div>
                </div>
                <div style={{ fontSize: '0.75rem', fontWeight: '800', color: 'var(--text-secondary)', padding: '0.4rem 0.85rem', background: 'rgba(255,255,255,0.04)', borderRadius: '10px', border: '1px solid var(--card-border)' }}>AUTO</div>
              </div>
            </div>
          </div>
        </div>

        <div className="settings-section">
          <h3 style={{ marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Lock size={20} color="#a78bfa" /> {lang === 'cz' ? 'Bezpečnostní PIN' : 'Security PIN'}
          </h3>
          <div className="glass-card" style={{ padding: isMobile ? '1.5rem' : '2rem' }}>
            <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: '2rem', alignItems: 'start' }}>
              <div>
                <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', margin: '0 0 1.5rem' }}>
                  {lang === 'cz'
                    ? 'Nastavte 4-místný PIN pro ochranu citlivých operací — mazání, finanční reporty, export dat.'
                    : 'Set a 4-digit PIN to protect sensitive operations: deletions, financial reports, data exports.'}
                </p>
                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                  {['🔒', '🗑️', '💰', '📤'].map((icon, i) => (
                    <div key={i} style={{ padding: '0.4rem 0.75rem', background: 'rgba(167,139,250,0.08)', border: '1px solid rgba(167,139,250,0.2)', borderRadius: '8px', fontSize: '0.75rem', color: '#a78bfa', fontWeight: '700' }}>
                      {icon} {[lang === 'cz' ? 'Ochrana' : 'PIN lock', lang === 'cz' ? 'Mazání' : 'Deletion', lang === 'cz' ? 'Finance' : 'Finance', lang === 'cz' ? 'Export' : 'Export'][i]}
                    </div>
                  ))}
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '0.7rem', fontWeight: '800', color: 'var(--text-secondary)', marginBottom: '0.5rem', letterSpacing: '0.08em' }}>{lang === 'cz' ? 'NOVÝ PIN (4 ČÍSLICE)' : 'NEW PIN (4 DIGITS)'}</label>
                  <input type="password" maxLength={4} placeholder="••••" id="new-security-pin"
                    style={{ width: '100%', background: 'rgba(255,255,255,0.05)', border: '1px solid var(--card-border)', padding: '0.85rem', borderRadius: '12px', color: 'white', letterSpacing: '0.5em', textAlign: 'center', fontSize: '1.5rem', fontWeight: '900', boxSizing: 'border-box' }} />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '0.7rem', fontWeight: '800', color: 'var(--text-secondary)', marginBottom: '0.5rem', letterSpacing: '0.08em' }}>{lang === 'cz' ? 'POTVRZENÍ HESLEM' : 'CONFIRM WITH PASSWORD'}</label>
                  <input type="password" placeholder={lang === 'cz' ? 'Vaše heslo k účtu' : 'Your account password'} id="pin-auth-password"
                    style={{ width: '100%', background: 'rgba(255,255,255,0.05)', border: '1px solid var(--card-border)', padding: '0.85rem', borderRadius: '12px', color: 'white', boxSizing: 'border-box' }} />
                </div>
                <button onClick={async () => {
                    const pin = document.getElementById('new-security-pin').value;
                    const password = document.getElementById('pin-auth-password').value;
                    if (!pin || pin.length < 4 || !password) return showToast(lang === 'cz' ? 'Vyplněte 4-místný PIN a heslo.' : 'Enter 4-digit PIN and password.', 'error');
                    try {
                      const res = await fetch(`${API_BASE}/auth/security-pin`, {
                        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${nexus.token}` },
                        body: JSON.stringify({ pin, password })
                      });
                      if (res.ok) { showToast(lang === 'cz' ? 'PIN úspěšně nastaven.' : 'PIN set successfully.', 'success'); document.getElementById('new-security-pin').value = ''; document.getElementById('pin-auth-password').value = ''; }
                      else { const data = await res.json(); showToast(data.message || 'Error', 'error'); }
                    } catch { showToast('Network error', 'error'); }
                  }}
                  style={{ padding: '0.85rem', background: 'linear-gradient(135deg, #a78bfa, #7c3aed)', color: 'white', border: 'none', borderRadius: '12px', fontWeight: '900', fontSize: '0.85rem', cursor: 'pointer', letterSpacing: '0.05em' }}>
                  {lang === 'cz' ? 'ULOŽIT PIN' : 'SAVE PIN'}
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="settings-section">
          <h3 style={{ marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Building2 size={20} color="var(--accent-color)" />
            {activeRole === 'app_owner' ? 'Agency Information' : t('agencyInsight')}: <span style={{ color: 'var(--accent-color)' }}>{activeClient?.name || t('global')}</span>
          </h3>
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr 1fr' : 'repeat(4, 1fr)', gap: '1rem' }}>
            <div className="glass-card" style={{ padding: '1.5rem', textAlign: 'center' }}>
              <div style={{ color: 'var(--text-secondary)', fontSize: '0.65rem', fontWeight: '800', marginBottom: '0.75rem', letterSpacing: '0.08em' }}>{t('teamSeats') || 'TÝM'}</div>
              <div style={{ fontSize: '2rem', fontWeight: '900', color: 'var(--accent-color)' }}>{(availableOperators || []).length}</div>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>
                / {seatsLimit} {['Neomezeně', 'Unlimited'].includes(seatsLimit) ? '' : (lang === 'cz' ? 'míst' : 'seats')}
              </div>
            </div>
            <div className="glass-card" style={{ padding: '1.5rem', textAlign: 'center' }}>
              <div style={{ color: 'var(--text-secondary)', fontSize: '0.65rem', fontWeight: '800', marginBottom: '0.75rem', letterSpacing: '0.08em' }}>{lang === 'cz' ? 'PROFILY' : 'PROFILES'}</div>
              <div style={{ fontSize: '2rem', fontWeight: '900', color: '#10b981' }}>{(profiles || []).length}</div>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>{lang === 'cz' ? 'aktivních' : 'active'}</div>
            </div>
            <div className="glass-card" style={{ padding: '1.5rem', textAlign: 'center' }}>
              <div style={{ color: 'var(--text-secondary)', fontSize: '0.65rem', fontWeight: '800', marginBottom: '0.75rem', letterSpacing: '0.08em' }}>{t('regionalReach') || 'REGION'}</div>
              <div style={{ fontSize: '1.25rem', fontWeight: '900' }}>{activeClient?.region || 'UK'}</div>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>{lang === 'cz' ? 'trh' : 'market'}</div>
            </div>
            <div className="glass-card" style={{ padding: '1.5rem', textAlign: 'center' }}>
              <div style={{ color: 'var(--text-secondary)', fontSize: '0.65rem', fontWeight: '800', marginBottom: '0.75rem', letterSpacing: '0.08em' }}>{lang === 'cz' ? 'AGENTURY' : 'AGENCIES'}</div>
              <div style={{ fontSize: '2rem', fontWeight: '900', color: '#f59e0b' }}>{(agencies || []).length}</div>
              <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>{lang === 'cz' ? 'celkem' : 'total'}</div>
            </div>
          </div>
        </div>

        <div className="settings-section">
          <h3 style={{ marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Smartphone size={20} color="var(--accent-color)" /> {t('sessionTopology')}
          </h3>
          <div className="glass-card" style={{ padding: 0 }}>
            {(() => {
              const isManager = activeRole === 'app_owner' || activeRole === 'agency_admin' || activeRole === 'agency_manager' || activeOperator?.isManager || activeOperator?.isSeniorOperator;
              const visibleSessions = (sessions || []).filter(s => {
                if (isManager) return true;
                const sessionProfile = (profiles || []).find(p => p.id === s.profileId);
                return sessionProfile?.agencyId === activeOperator?.agencyId;
              });
              if (visibleSessions.length === 0) return (
                <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>{t('noDevicesConnected') || 'No active device bindings found.'}</div>
              );
              return visibleSessions.map((s, i) => (
                <div key={i} style={{ padding: '1.5rem', borderBottom: i < visibleSessions.length - 1 ? '1px solid var(--card-border)' : 'none', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
                  {!s.profileId && (
                    <div style={{ width: '100%', background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.3)', borderRadius: '8px', padding: '0.5rem 0.75rem', fontSize: '0.75rem', color: '#f59e0b', fontWeight: '700', marginBottom: '0.5rem' }}>
                      ⚠️ {lang === 'cz' ? 'Žádný profil přiřazen — SMS relay nefunguje. Přiřaďte profil a spárujte znovu.' : 'No profile assigned — SMS relay disabled. Assign a profile then re-pair.'}
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: '1.25rem', alignItems: 'center' }}>
                    <div style={{ background: !s.profileId ? 'rgba(245,158,11,0.1)' : (s.current || s.status === 'Active') ? 'rgba(59,130,246,0.1)' : 'rgba(255,255,255,0.05)', padding: '0.75rem', borderRadius: '12px' }}>
                      <Smartphone size={20} color={!s.profileId ? '#f59e0b' : (s.current || s.status === 'Active') ? 'var(--accent-color)' : 'var(--text-secondary)'} />
                    </div>
                    <div>
                      <div style={{ fontWeight: '700' }}>{s.device} {s.current && <span style={{ color: 'var(--success-color)', fontSize: '0.7rem' }}>({t('thisDevice')})</span>}</div>
                      {/* `s.location` se nikdy nevyplňovalo, takže tu byl prázdný
                          text s oddělovačem. Místo něj poslední kontakt — u relaye
                          je to jediné, z čeho se pozná, jestli ještě žije. */}
                      <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                        {s.status === 'Disabled'
                          ? (lang === 'cz' ? 'Odpojeno' : 'Disabled')
                          : s.jeOnline
                            ? (lang === 'cz' ? 'Odpovídá' : 'Responding')
                            : (
                              <span style={{ color: 'var(--warning-color)', fontWeight: 700 }}>
                                {lang === 'cz' ? 'Neodpovídá' : 'Not responding'}
                                {s.lastSeenAt && ` — ${lang === 'cz' ? 'naposledy' : 'last seen'} ${new Date(s.lastSeenAt).toLocaleString(lang === 'cz' ? 'cs-CZ' : 'en-GB')}`}
                              </span>
                            )}
                      </div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                    <button
                      title={lang === 'cz' ? 'Zobrazit polohu zařízení' : 'Show device location'}
                      onClick={() => {
                        if (s.lat && s.lng) {
                          window.open(`https://www.google.com/maps?q=${s.lat},${s.lng}`, '_blank');
                        } else {
                          showToast(lang === 'cz' ? 'Poloha momentálně není k dispozici' : 'Location not available', 'info');
                        }
                      }}
                      style={{ padding: '0.4rem 0.75rem', background: 'rgba(139,92,246,0.1)', border: '1px solid rgba(139,92,246,0.3)', color: '#a78bfa', borderRadius: '8px', fontSize: '0.7rem', fontWeight: '700', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.3rem' }}
                    >
                      📍 {lang === 'cz' ? 'Poloha' : 'Location'}
                    </button>
                    {(isManager || s.profileId === activeOperator?.profileId) && (
                      <div
                        className="status-badge"
                        style={{ cursor: s.status === 'Active' ? 'pointer' : 'default', opacity: s.status === 'Active' ? 1 : 0.5 }}
                        onClick={() => s.status === 'Active' && handleRevokeBinding(s.installationId)}
                      >
                        {s.status === 'Active' ? t('revoke') : t('revoked') || 'REVOKED'}
                      </div>
                    )}
                  </div>
                </div>
              ));
            })()}
          </div>
        </div>

        <div className="settings-section">
          <h3 style={{ marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <ShieldCheck size={20} color="var(--accent-color)" /> {t('safetyGuardHeading') || 'Safety Guard Configuration'}
          </h3>
          <div className="glass-card" style={{ padding: '1.5rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: isMobile ? 'flex-start' : 'center', marginBottom: '1rem', flexDirection: isMobile ? 'column' : 'row', gap: isMobile ? '1rem' : '0' }}>
              <div>
                <div style={{ fontWeight: '700' }}>{t('safetyAlertMode') || 'Emergency Alert Routing'}</div>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{t('safetyAlertModeDesc') || 'Choose who receives push notifications during a panic alert.'}</div>
              </div>
              <select 
                value={agencySettings?.safetyAlertMode || 'MANAGERS_AND_ASSIGNED'}
                onChange={(_err) => updateAgencySettings({ safetyAlertMode: _err.target.value })}
                className="glass-input"
                style={{ width: isMobile ? '100%' : 'auto', padding: '0.5rem 1rem', background: 'rgba(59, 130, 246, 0.1)', border: '1px solid var(--accent-color)', color: 'white', fontWeight: '700' }}
              >
                <option value="MANAGERS_AND_ASSIGNED">{t('modeManagersAndAssigned') || 'Managers + Assigned Operators'}</option>
                <option value="ASSIGNED_ONLY">{t('modeAssignedOnly') || 'Strictly Assigned Operators Only'}</option>
              </select>
            </div>
            {/* Departure Interval Setting */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: isMobile ? 'flex-start' : 'center', marginTop: '1rem', paddingTop: '1rem', borderTop: '1px solid var(--card-border)', flexDirection: isMobile ? 'column' : 'row', gap: isMobile ? '0.75rem' : '0' }}>
              <div>
                <div style={{ fontWeight: '700' }}>Interval odchodu klienta</div>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Modelka musí potvrdit odchod klienta do X minut po check-outu, jinak jde bezpečnostní alert.</div>
              </div>
              <select
                value={departureIntervalMin}
                onChange={(_err) => {
                  const v = parseInt(_err.target.value, 10);
                  setDepartureIntervalMin(v);
                  localStorage.setItem('nexus_departure_interval', String(v));
                }}
                className="glass-input"
                style={{ width: isMobile ? '100%' : 'auto', padding: '0.5rem 1rem', background: 'rgba(59,130,246,0.1)', border: '1px solid var(--accent-color)', color: 'white', fontWeight: '700' }}
              >
                {[5, 10, 15, 20, 30].map(m => <option key={m} value={m}>{m} minut</option>)}
              </select>
            </div>
          </div>
        </div>

        {activeRole === 'app_owner' && (
          <div className="settings-section">
            <h3 style={{ marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Lock size={20} color="var(--accent-color)" /> Platform Management (App Owner Only)
            </h3>
            <div className="glass-card" style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ fontWeight: '700' }}>Maintenance Mode</div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Restrict access to all non-admin users for scheduled maintenance.</div>
                </div>
                <div 
                  className={`status-badge ${isMaintenanceMode ? 'active' : ''}`} 
                  style={{ cursor: 'pointer', background: isMaintenanceMode ? 'var(--error-color)' : 'rgba(255,255,255,0.06)' }}
                  onClick={() => setIsMaintenanceMode(!isMaintenanceMode)}
                >
                  {isMaintenanceMode ? 'ACTIVE' : 'INACTIVE'}
                </div>
              </div>
              <div style={{ borderTop: '1px solid var(--card-border)', paddingTop: '1.5rem' }}>
                <div style={{ fontWeight: '700', marginBottom: '0.75rem' }}>Global Announcement Banner</div>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <input 
                    className="glass-input" 
                    placeholder="Type an announcement to show to all users..." 
                    style={{ flex: 1, padding: '0.75rem' }}
                    value={globalAnnouncement}
                    onChange={(_err) => setGlobalAnnouncement(_err.target.value)}
                  />
                  <button className="action-btn" style={{ width: 'auto', padding: '0 1.5rem' }} onClick={() => publishGlobalAnnouncement()}>PUBLISH</button>
                </div>
              </div>
            </div>
          </div>
        )}
        
        {isAllowed('global_features') && (
          <div className="settings-section">
            <h3 style={{ marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
               Advanced Features
            </h3>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
              Additional configuration for this agency.
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

export default SettingsView;
