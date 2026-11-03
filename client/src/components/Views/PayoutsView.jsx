import React, { useState, useEffect, useCallback } from 'react';
import { 
  DollarSign, Download, Calendar, Filter, 
  ArrowRight, FileText, User, RefreshCw,
  TrendingUp, Wallet
} from 'lucide-react';
import { useNexus } from '../../context/ContextHook';


import { API_BASE } from '../../constants/config';
const PayoutsView = () => {
  const { _t, token, isMobile, lang } = useNexus();
  const [summary, setSummary] = useState([]);
  const [loading, setLoading] = useState(true);
  const [dateRange, setDateRange] = useState({
    start: new Date(new Date().setDate(new Date().getDate() - 30)).toISOString().split('T')[0],
    end: new Date().toISOString().split('T')[0]
  });

  const fetchSummary = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch(`${API_BASE}/payouts/summary?startDate=${dateRange.start}&endDate=${dateRange.end}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        // Endpoint vrací Object.values(...), tedy pole. Kdyby se tvar někdy
        // změnil, `summary.reduce` níž shodí celou stránku na bílou obrazovku
        // místo prázdné tabulky.
        setSummary(Array.isArray(data) ? data : []);
      }
    } catch (_err) {
      console.error('Failed to fetch payout summary:', _err);
    } finally {
      setLoading(false);
    }
  }, [token, dateRange]);

  useEffect(() => {
    fetchSummary();
  }, [fetchSummary]);

  const handleExport = async () => {
    // Auth via Authorization header + blob download — never put the JWT in the URL
    // (query strings leak into browser history, proxy logs, and Referer headers).
    try {
      const res = await fetch(`${API_BASE}/payouts/export?startDate=${dateRange.start}&endDate=${dateRange.end}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `payouts_${dateRange.start}_${dateRange.end}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('[Payouts] export failed', err);
    }
  };

  const totalAgencyRevenue = summary.reduce((acc, curr) => acc + curr.totalRevenue, 0);

  return (
    <div style={{ padding: isMobile ? '1.5rem 1rem' : '3rem', paddingBottom: '8rem', flex: 1, overflowY: 'auto' }} className="fade-in custom-scrollbar">
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: isMobile ? 'flex-start' : 'center', marginBottom: '3rem', flexDirection: isMobile ? 'column' : 'row', gap: '1.5rem' }}>
        <div>
          <h2 style={{ fontSize: isMobile ? '1.75rem' : '2.5rem', fontWeight: '900', marginBottom: '0.5rem', background: 'linear-gradient(to right, #10b981, #3b82f6)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <Wallet size={isMobile ? 24 : 32} color="#10b981" /> {lang === 'cz' ? 'Výplaty Modelek' : 'Model Payouts'}
          </h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '1.1rem' }}>{lang === 'cz' ? 'Přehled tržeb a exporty pro výplatní termíny.' : 'Revenue overview and exports for payout periods.'}</p>
        </div>
        <button 
          onClick={handleExport}
          className="action-btn" 
          style={{ width: isMobile ? '100%' : 'auto', padding: '0.8rem 1.5rem', background: '#10b981', display: 'flex', alignItems: 'center', gap: '0.5rem', borderRadius: '12px' }}
        >
          <Download size={18} /> {lang === 'cz' ? 'EXPORT CSV' : 'EXPORT CSV'}
        </button>
      </div>

      {/* Stats Overview */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(3, 1fr)', gap: '1.5rem', marginBottom: '3rem' }}>
        <div className="glass-card" style={{ padding: '1.5rem', borderLeft: '4px solid #10b981' }}>
          <div style={{ fontSize: '0.7rem', fontWeight: '800', color: 'var(--text-secondary)', marginBottom: '0.5rem', letterSpacing: '0.05em' }}>CELKOVÁ TRŽBA</div>
          <div style={{ fontSize: '2rem', fontWeight: '900' }}>{totalAgencyRevenue.toLocaleString()} CZK</div>
        </div>
        <div className="glass-card" style={{ padding: '1.5rem', borderLeft: '4px solid #3b82f6' }}>
          <div style={{ fontSize: '0.7rem', fontWeight: '800', color: 'var(--text-secondary)', marginBottom: '0.5rem', letterSpacing: '0.05em' }}>AKTIVNÍ MODELKY</div>
          <div style={{ fontSize: '2rem', fontWeight: '900' }}>{summary.length}</div>
        </div>
        <div className="glass-card" style={{ padding: '1.5rem', borderLeft: '4px solid #a855f7' }}>
          <div style={{ fontSize: '0.7rem', fontWeight: '800', color: 'var(--text-secondary)', marginBottom: '0.5rem', letterSpacing: '0.05em' }}>OBDOBÍ</div>
          <div style={{ fontSize: '1.1rem', fontWeight: '800', marginTop: '0.5rem' }}>{new Date(dateRange.start).toLocaleDateString()} — {new Date(dateRange.end).toLocaleDateString()}</div>
        </div>
      </div>

      {/* Filters */}
      <div className="glass-card" style={{ padding: '1.25rem', marginBottom: '2rem', display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div style={{ flex: 1, minWidth: '200px' }}>
          <label style={{ display: 'block', fontSize: '0.7rem', fontWeight: '800', color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>OD</label>
          <input 
            type="date" 
            value={dateRange.start}
            onChange={(_err) => setDateRange({...dateRange, start: _err.target.value})}
            style={{ width: '100%', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--card-border)', padding: '0.75rem', borderRadius: '10px', color: 'white' }} 
          />
        </div>
        <div style={{ flex: 1, minWidth: '200px' }}>
          <label style={{ display: 'block', fontSize: '0.7rem', fontWeight: '800', color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>DO</label>
          <input 
            type="date" 
            value={dateRange.end}
            onChange={(_err) => setDateRange({...dateRange, end: _err.target.value})}
            style={{ width: '100%', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--card-border)', padding: '0.75rem', borderRadius: '10px', color: 'white' }} 
          />
        </div>
        <button 
          onClick={fetchSummary}
          style={{ padding: '0.75rem 1.5rem', borderRadius: '10px', background: 'rgba(255,255,255,0.05)', border: '1px solid var(--card-border)', color: 'white', fontWeight: '700', cursor: 'pointer' }}
        >
          {loading ? <RefreshCw size={18} className="animate-spin" /> : 'AKTUALIZOVAT'}
        </button>
      </div>

      {/* Payout Table */}
      <div className="glass-card" style={{ padding: 0, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--card-border)', background: 'rgba(255,255,255,0.02)' }}>
              <th style={{ padding: '1.25rem', color: 'var(--text-secondary)', fontSize: '0.75rem', fontWeight: '800', textAlign: 'left' }}>MODELKA</th>
              <th style={{ padding: '1.25rem', color: 'var(--text-secondary)', fontSize: '0.75rem', fontWeight: '800', textAlign: 'center' }}>POČET ZAKÁZEK</th>
              <th style={{ padding: '1.25rem', color: 'var(--text-secondary)', fontSize: '0.75rem', fontWeight: '800', textAlign: 'right' }}>TRŽBA CELKEM</th>
              <th style={{ padding: '1.25rem', color: 'var(--text-secondary)', fontSize: '0.75rem', fontWeight: '800', textAlign: 'right' }}>VÝPLATA</th>
            </tr>
          </thead>
          <tbody>
            {loading && summary.length === 0 ? (
              <tr><td colSpan="4" style={{ padding: '4rem', textAlign: 'center' }}><RefreshCw size={24} className="animate-spin" style={{ opacity: 0.3 }} /></td></tr>
            ) : summary.length === 0 ? (
              <tr><td colSpan="4" style={{ padding: '4rem', textAlign: 'center', color: 'var(--text-secondary)' }}>Žádná data pro vybrané období.</td></tr>
            ) : summary.map((row) => (
              <tr key={row.profileId} style={{ borderBottom: '1px solid var(--card-border)' }} className="table-row-hover">
                <td style={{ padding: '1.25rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                    <div style={{ width: '36px', height: '36px', background: 'rgba(16, 185, 129, 0.1)', borderRadius: '10px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: '900', color: '#10b981' }}>
                      {row.profileName.charAt(0)}
                    </div>
                    <div style={{ fontWeight: '700' }}>{row.profileName}</div>
                  </div>
                </td>
                <td style={{ padding: '1.25rem', textAlign: 'center', fontWeight: '700' }}>
                  {row.totalBookings}
                </td>
                <td style={{ padding: '1.25rem', textAlign: 'right', fontWeight: '800' }}>
                  {row.totalRevenue.toLocaleString()} CZK
                </td>
                <td style={{ padding: '1.25rem', textAlign: 'right', fontWeight: '900', color: '#10b981' }}>
                  {((row.totalRevenue * (row.commission || 50)) / 100).toLocaleString()} CZK
                  <div style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', opacity: 0.7 }}>({row.commission || 50}%)</div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <style>{`
        .table-row-hover:hover { background: rgba(255,255,255,0.02) !important; }
        .animate-spin { animation: spin 1s linear infinite; }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
};

export default PayoutsView;
