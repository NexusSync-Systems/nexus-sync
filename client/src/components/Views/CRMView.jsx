import React, { useState, useEffect, useCallback } from 'react';
import { 
  Search, Filter, UserCheck, TrendingUp, Calendar, 
  MessageSquare, Star, Clock, AlertTriangle, ChevronRight,
  MoreVertical, Tag as TagIcon
} from 'lucide-react';
import { useNexus } from '../../context/ContextHook';


import { API_BASE } from '../../constants/config';
const CRMView = () => {
  const nexus = useNexus();
  const { 
    t = (k) => k, 
    token = '' 
  } = nexus || {};

  const [clients, setClients] = useState([]);
  const [stats, setStats] = useState({ totalClients: 0, vipClients: 0, totalRevenue: 0 });
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [filter, setFilter] = useState('all'); // all, vip, inactive

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const headers = { 'Authorization': `Bearer ${token}` };
      const [clientsRes, statsRes] = await Promise.all([
        fetch(`${API_BASE}/clients`, { headers }),
        fetch(`${API_BASE}/clients/stats`, { headers })
      ]);
      
      if (clientsRes.ok && statsRes.ok) {
        const clientsData = await clientsRes.json();
        const statsData = await statsRes.json();
        setClients(clientsData);
        setStats(statsData);
      }
    } catch {
      console.error('Failed to fetch CRM data');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const filteredClients = clients.filter(c => {
    const matchesSearch = (c.phone || '').includes(searchTerm) || (c.name || '').toLowerCase().includes(searchTerm.toLowerCase());
    if (filter === 'vip') return matchesSearch && (c.tags || '').includes('VIP');
    if (filter === 'inactive') {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      return matchesSearch && (!c.lastVisit || new Date(c.lastVisit) < thirtyDaysAgo);
    }
    return matchesSearch;
  });

  const StatCard = ({ icon: Icon, label, value, color }) => (
    <div style={{ background: 'var(--card-bg)', border: '1px solid var(--card-border)', borderRadius: '16px', padding: '1.5rem', display: 'flex', alignItems: 'center', gap: '1.5rem', flex: 1 }}>
      <div style={{ background: `${color}15`, color, padding: '0.75rem', borderRadius: '12px' }}>
        <Icon size={24} />
      </div>
      <div>
        <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: '600', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
        <div style={{ fontSize: '1.5rem', fontWeight: '900', color: 'white', marginTop: '0.2rem' }}>{value}</div>
      </div>
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem', animation: 'fadeIn 0.5s ease-out' }}>
      <style>{`
        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        .client-row { transition: all 0.2s ease; cursor: pointer; border-bottom: 1px solid rgba(255,255,255,0.03); }
        .client-row:hover { background: rgba(255,255,255,0.02); }
        .tag { font-size: 0.65rem; font-weight: 800; padding: 2px 8px; border-radius: 6px; }
      `}</style>

      {/* Header & Stats */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
        <div>
          <h1 style={{ fontSize: '2rem', fontWeight: '900', color: 'white', margin: 0 }}>{t('crmTitle')}</h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginTop: '0.4rem' }}>{t('crmSubtitle')}</p>
        </div>
        <div style={{ display: 'flex', gap: '1rem' }}>
          <button onClick={fetchData} style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid var(--card-border)', color: 'white', padding: '0.75rem 1.25rem', borderRadius: '12px', fontWeight: '700', cursor: 'pointer' }}>
            {t('refresh')}
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap' }}>
        <StatCard icon={UserCheck} label={t('totalClients')} value={stats.totalClients} color="var(--accent-color)" />
        <StatCard icon={Star} label={t('vipClients')} value={stats.vipClients} color="#fbbf24" />
        <StatCard icon={TrendingUp} label={t('totalRevenue')} value={`${(Number(stats.totalRevenue) || 0).toLocaleString()} CZK`} color="var(--success-color)" />
      </div>

      {/* Main Content */}
      <div style={{ background: 'var(--card-bg)', border: '1px solid var(--card-border)', borderRadius: '20px', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '1.5rem', borderBottom: '1px solid var(--card-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
          <div style={{ position: 'relative', flex: 1, minWidth: '300px' }}>
            <Search size={18} style={{ position: 'absolute', left: '1rem', top: '50%', transform: 'translateY(-50%)', color: 'rgba(255,255,255,0.3)' }} />
            <input 
              type="text" 
              placeholder={t('searchClients')}
              value={searchTerm}
              onChange={_err => setSearchTerm(_err.target.value)}
              style={{ width: '100%', background: 'rgba(0,0,0,0.2)', border: '1px solid var(--card-border)', borderRadius: '12px', padding: '0.8rem 1rem 0.8rem 2.8rem', color: 'white', fontSize: '0.9rem' }}
            />
          </div>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            {['all', 'vip', 'inactive'].map(f => (
              <button 
                key={f}
                onClick={() => setFilter(f)}
                style={{ 
                  background: filter === f ? 'rgba(59, 130, 246, 0.15)' : 'transparent',
                  border: '1px solid',
                  borderColor: filter === f ? 'var(--accent-color)' : 'transparent',
                  color: filter === f ? 'white' : 'var(--text-secondary)',
                  padding: '0.5rem 1rem', borderRadius: '10px', fontSize: '0.8rem', fontWeight: '700', cursor: 'pointer'
                }}
              >
                {f === 'all' ? t('all') : (f === 'vip' ? t('vip') : t('inactive'))}
              </button>
            ))}
          </div>
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left' }}>
            <thead>
              <tr style={{ background: 'rgba(255,255,255,0.02)', color: 'var(--text-secondary)', fontSize: '0.7rem', fontWeight: '800', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                <th style={{ padding: '1rem 1.5rem' }}>{t('client')}</th>
                <th style={{ padding: '1rem 1.5rem' }}>{t('tags')}</th>
                <th style={{ padding: '1rem 1.5rem' }}>{t('totalSpent')}</th>
                <th style={{ padding: '1rem 1.5rem' }}>{t('lastVisit')}</th>
                <th style={{ padding: '1rem 1.5rem' }}>{t('status')}</th>
                <th style={{ padding: '1rem 1.5rem' }}></th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan="6" style={{ padding: '4rem', textAlign: 'center', color: 'var(--text-secondary)' }}>{t('loadingCrm')}</td></tr>
              ) : filteredClients.length === 0 ? (
                <tr><td colSpan="6" style={{ padding: '4rem', textAlign: 'center', color: 'var(--text-secondary)' }}>{t('noClientsFound')}</td></tr>
              ) : filteredClients.map(client => {
                const lastDate = client.lastVisit ? new Date(client.lastVisit) : null;
                const isInactive = lastDate && (new Date() - lastDate > 30 * 24 * 60 * 60 * 1000);
                
                return (
                  <tr key={client.id} className="client-row">
                    <td style={{ padding: '1.2rem 1.5rem' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                        <div style={{ width: '36px', height: '36px', background: 'rgba(59, 130, 246, 0.1)', color: 'var(--accent-color)', borderRadius: '10px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: '800', fontSize: '0.75rem' }}>
                          {client.phone?.slice(-4)}
                        </div>
                        <div>
                          <div style={{ color: 'white', fontWeight: '700', fontSize: '0.9rem' }}>{client.name || 'Anonymous'}</div>
                          <div style={{ color: 'var(--text-secondary)', fontSize: '0.75rem' }}>{client.phone}</div>
                        </div>
                      </div>
                    </td>
                    <td style={{ padding: '1.2rem 1.5rem' }}>
                      <div style={{ display: 'flex', gap: '0.4rem' }}>
                        {(() => {
                          let parsedTags;
                          try { parsedTags = JSON.parse(client.tags || '[]'); } catch { parsedTags = []; }
                          if (!Array.isArray(parsedTags)) parsedTags = [];
                          
                          if (parsedTags.length === 0) return <span style={{ color: 'rgba(255,255,255,0.1)', fontSize: '0.7rem' }}>—</span>;
                          
                          return parsedTags.map((t, idx) => (
                            <span key={idx} className="tag" style={{ background: t === 'VIP' ? 'rgba(251, 191, 36, 0.15)' : 'rgba(255,255,255,0.05)', color: t === 'VIP' ? '#fbbf24' : 'var(--text-secondary)' }}>{t}</span>
                          ));
                        })()}
                      </div>
                    </td>
                    <td style={{ padding: '1.2rem 1.5rem' }}>
                      <div style={{ color: 'white', fontWeight: '800' }}>{(Number(client.totalSpent) || 0).toLocaleString()} CZK</div>
                      <div style={{ fontSize: '0.7rem', color: 'rgba(34, 197, 94, 0.8)' }}>
                        {client._count?.bookings || 0} visits
                      </div>
                    </td>
                    <td style={{ padding: '1.2rem 1.5rem' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                        <Calendar size={14} />
                        {client.lastVisit ? lastDate.toLocaleDateString() : t('never')}
                      </div>
                    </td>
                    <td style={{ padding: '1.2rem 1.5rem' }}>
                      {isInactive ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: '#f87171', fontSize: '0.75rem', fontWeight: '700' }}>
                          <AlertTriangle size={14} /> {t('inactive')}
                        </div>
                      ) : (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: '#34d399', fontSize: '0.75rem', fontWeight: '700' }}>
                          <Clock size={14} /> {t('active')}
                        </div>
                      )}
                    </td>
                    <td style={{ padding: '1.2rem 1.5rem', textAlign: 'right' }}>
                      <ChevronRight size={18} color="rgba(255,255,255,0.2)" />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

export default CRMView;
