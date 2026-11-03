import React, { useState, useEffect, useCallback } from 'react';
import { 
  Users, Gift, Award, TrendingUp, Copy, 
  Check, Share2, ExternalLink, RefreshCw,
  Clock, AlertCircle
} from 'lucide-react';
import { useNexus } from '../../context/ContextHook';


import { API_BASE } from '../../constants/config';
const ReferralsView = () => {
  const { _t, lang, isMobile, token, showToast } = useNexus();
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  const fetchStats = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch(`${API_BASE}/referrals/stats`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setStats(data);
      }
    } catch (_err) {
      console.error('Failed to fetch referral stats:', _err);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  const handleGenerateCode = async () => {
    try {
      const res = await fetch(`${API_BASE}/referrals/generate-code`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        fetchStats();
        showToast(lang === 'cz' ? 'Referral kód vygenerován!' : 'Referral code generated!', 'success');
      }
    } catch {
      showToast('Error generating code', 'error');
    }
  };

  const copyToClipboard = () => {
    if (!stats?.referralCode) return;
    navigator.clipboard.writeText(stats.referralCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    showToast(lang === 'cz' ? 'Kód zkopírován!' : 'Code copied!', 'success');
  };

  if (loading && !stats) {
    return (
      <div style={{ display: 'flex', flex: 1, alignItems: 'center', justifyContent: 'center', height: '100%' }}>
        <RefreshCw size={32} className="animate-spin" color="var(--accent-color)" />
      </div>
    );
  }

  return (
    <div style={{ padding: isMobile ? '1.5rem 1rem' : '3rem', paddingBottom: '8rem', flex: 1, overflowY: 'auto' }} className="fade-in custom-scrollbar">
      {/* Header */}
      <div style={{ marginBottom: '3rem' }}>
        <h2 style={{ fontSize: isMobile ? '1.75rem' : '2.5rem', fontWeight: '900', marginBottom: '0.5rem', background: 'linear-gradient(to right, #f59e0b, #ef4444)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <Gift size={isMobile ? 24 : 32} color="#f59e0b" /> {lang === 'cz' ? 'Partnerský Program' : 'Referral Program'}
        </h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '1.1rem' }}>{lang === 'cz' ? 'Doporučte Nexus Hub dalším agenturám a získejte odměny.' : 'Refer Nexus Hub to other agencies and earn rewards.'}</p>
      </div>

      {/* Referral Code Card */}
      <div className="glass-card" style={{ padding: '2.5rem', marginBottom: '3rem', border: '1px solid rgba(245, 158, 11, 0.2)', background: 'linear-gradient(135deg, rgba(245, 158, 11, 0.05) 0%, rgba(0, 0, 0, 0) 100%)' }}>
        <div style={{ textAlign: 'center', maxWidth: '600px', margin: '0 auto' }}>
          <h3 style={{ fontSize: '1.25rem', fontWeight: '800', marginBottom: '1.5rem' }}>{lang === 'cz' ? 'Váš unikátní doporučující kód' : 'Your Unique Referral Code'}</h3>
          
          {stats?.referralCode ? (
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'center', alignItems: 'stretch' }}>
              <div style={{ background: 'rgba(255,255,255,0.05)', border: '2px dashed var(--accent-color)', padding: '1rem 2rem', borderRadius: '12px', fontSize: '1.75rem', fontWeight: '900', letterSpacing: '0.2em', color: 'white' }}>
                {stats.referralCode}
              </div>
              <button 
                onClick={copyToClipboard}
                style={{ background: 'var(--accent-color)', border: 'none', borderRadius: '12px', padding: '0 1.25rem', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              >
                {copied ? <Check size={24} /> : <Copy size={24} />}
              </button>
            </div>
          ) : (
            <button 
              onClick={handleGenerateCode}
              className="action-btn"
              style={{ width: 'auto', padding: '1rem 2rem', background: 'var(--accent-color)', borderRadius: '12px', fontWeight: '800' }}
            >
              VYGENEROVAT KÓD
            </button>
          )}
          
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginTop: '1.5rem' }}>
            {lang === 'cz' 
              ? 'Sdílejte tento kód. Nové agentury ho zadají při registraci.' 
              : 'Share this code. New agencies enter it during registration.'}
          </p>
        </div>
      </div>

      {/* Stats Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(4, 1fr)', gap: '1.5rem', marginBottom: '3rem' }}>
        <div className="glass-card" style={{ padding: '1.5rem' }}>
          <div style={{ color: 'var(--text-secondary)', fontSize: '0.7rem', fontWeight: '800', marginBottom: '0.5rem', textTransform: 'uppercase' }}>Celkem doporučení</div>
          <div style={{ fontSize: '1.75rem', fontWeight: '900', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Users size={20} color="var(--accent-color)" /> {stats?.totalSignups || 0}
          </div>
        </div>
        <div className="glass-card" style={{ padding: '1.5rem' }}>
          <div style={{ color: 'var(--text-secondary)', fontSize: '0.7rem', fontWeight: '800', marginBottom: '0.5rem', textTransform: 'uppercase' }}>Potvrzené registrace</div>
          <div style={{ fontSize: '1.75rem', fontWeight: '900', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Check size={20} color="#10b981" /> {stats?.confirmed || 0}
          </div>
        </div>
        <div className="glass-card" style={{ padding: '1.5rem' }}>
          <div style={{ color: 'var(--text-secondary)', fontSize: '0.7rem', fontWeight: '800', marginBottom: '0.5rem', textTransform: 'uppercase' }}>Čekající odměny</div>
          <div style={{ fontSize: '1.75rem', fontWeight: '900', color: '#f59e0b' }}>
            {stats?.pendingEarned || 0} <span style={{ fontSize: '1rem', fontWeight: '700' }}>CZK</span>
          </div>
        </div>
        <div className="glass-card" style={{ padding: '1.5rem' }}>
          <div style={{ color: 'var(--text-secondary)', fontSize: '0.7rem', fontWeight: '800', marginBottom: '0.5rem', textTransform: 'uppercase' }}>Získané odměny</div>
          <div style={{ fontSize: '1.75rem', fontWeight: '900', color: '#10b981' }}>
            {stats?.totalEarned || 0} <span style={{ fontSize: '1rem', fontWeight: '700' }}>CZK</span>
          </div>
        </div>
      </div>

      {/* Referral Table */}
      <div className="glass-card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '1.5rem', borderBottom: '1px solid var(--card-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ fontSize: '1.1rem', fontWeight: '800' }}>{lang === 'cz' ? 'Historie doporučení' : 'Referral History'}</h3>
          <button onClick={fetchStats} style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}><RefreshCw size={16} /></button>
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ background: 'rgba(255,255,255,0.02)', borderBottom: '1px solid var(--card-border)' }}>
              <th style={{ padding: '1rem 1.5rem', textAlign: 'left', color: 'var(--text-secondary)', fontSize: '0.7rem', fontWeight: '800' }}>AGENTURA</th>
              <th style={{ padding: '1rem 1.5rem', textAlign: 'left', color: 'var(--text-secondary)', fontSize: '0.7rem', fontWeight: '800' }}>DATUM</th>
              <th style={{ padding: '1rem 1.5rem', textAlign: 'left', color: 'var(--text-secondary)', fontSize: '0.7rem', fontWeight: '800' }}>STAV</th>
              <th style={{ padding: '1rem 1.5rem', textAlign: 'right', color: 'var(--text-secondary)', fontSize: '0.7rem', fontWeight: '800' }}>ODMĚNA</th>
            </tr>
          </thead>
          <tbody>
            {!stats?.referrals || stats.referrals.length === 0 ? (
              <tr><td colSpan="4" style={{ padding: '4rem', textAlign: 'center', color: 'var(--text-secondary)' }}>Zatím jste nikoho nedoporučili. Začněte sdílením kódu!</td></tr>
            ) : stats.referrals.map((ref) => (
              <tr key={ref.id} style={{ borderBottom: '1px solid var(--card-border)' }} className="table-row-hover">
                <td style={{ padding: '1.25rem 1.5rem' }}>
                  <div style={{ fontWeight: '700' }}>{ref.agencyName}</div>
                </td>
                <td style={{ padding: '1.25rem 1.5rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                  {new Date(ref.createdAt).toLocaleDateString()}
                </td>
                <td style={{ padding: '1.25rem 1.5rem' }}>
                   <div style={{ 
                     display: 'inline-flex', alignItems: 'center', gap: '0.4rem', padding: '0.3rem 0.75rem', borderRadius: '100px', fontSize: '0.7rem', fontWeight: '800',
                     background: ref.status === 'confirmed' ? 'rgba(16, 185, 129, 0.1)' : 'rgba(245, 158, 11, 0.1)',
                     color: ref.status === 'confirmed' ? '#10b981' : '#f59e0b',
                     border: `1px solid ${ref.status === 'confirmed' ? 'rgba(16, 185, 129, 0.2)' : 'rgba(245, 158, 11, 0.2)'}`
                   }}>
                     {ref.status === 'confirmed' ? <Check size={12} /> : <Clock size={12} />}
                     {ref.status.toUpperCase()}
                   </div>
                </td>
                <td style={{ padding: '1.25rem 1.5rem', textAlign: 'right', fontWeight: '900', color: ref.rewardAmount > 0 ? '#10b981' : 'var(--text-secondary)' }}>
                  {ref.rewardAmount || 0} CZK
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Info Box */}
      <div style={{ marginTop: '2rem', padding: '1.5rem', background: 'rgba(59, 130, 246, 0.05)', border: '1px solid rgba(59, 130, 246, 0.2)', borderRadius: '12px', display: 'flex', gap: '1rem', alignItems: 'flex-start' }}>
        <AlertCircle size={24} color="#3b82f6" style={{ marginTop: '0.2rem' }} />
        <div>
          <div style={{ fontWeight: '800', color: '#3b82f6', marginBottom: '0.25rem' }}>{lang === 'cz' ? 'Jak to funguje?' : 'How it works?'}</div>
          <p style={{ fontSize: '0.85rem', color: '#94a3b8', lineHeight: '1.5' }}>
            {lang === 'cz' 
              ? 'Odměna za doporučení se připisuje automaticky poté, co doporučená agentura uhradí své první předplatné. Výše odměny závisí na zvoleném tarifu nové agentury.' 
              : 'Referral rewards are credited automatically after the referred agency pays its first subscription. Reward amount depends on the new agency\'s chosen plan.'}
          </p>
        </div>
      </div>

      <style>{`
        .table-row-hover:hover { background: rgba(255,255,255,0.02) !important; }
        .animate-spin { animation: spin 1s linear infinite; }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
};

export default ReferralsView;
