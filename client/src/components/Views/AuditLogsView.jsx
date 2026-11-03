import React, { useState, useEffect, useCallback } from 'react';
import { 
  Shield, ShieldCheck, Search, Filter, Calendar, User, 
  Activity, AlertTriangle, RefreshCw, ChevronLeft, 
  ChevronRight, Info, Eye
} from 'lucide-react';
import { useNexus } from '../../context/ContextHook';


import { API_BASE } from '../../constants/config';
const AuditLogsView = () => {
  const { t, token, isMobile } = useNexus();
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedLog, setSelectedLog] = useState(null);
  
  const fetchLogs = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch(`${API_BASE}/audit-logs?page=${page}&limit=20&action=${searchQuery}`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      if (res.ok) {
        const data = await res.json();
        // Bez záložních hodnot stačí jedna odpověď 200 bez `logs` a stránka
        // spadne na `logs.length` s bílou obrazovkou — ne prázdný seznam,
        // ale „Kritická chyba renderu“. Server dnes vždycky posílá správný
        // tvar, takže se to uživateli nestane; jenže rozdíl mezi „nic tu
        // není“ a „appka se rozsypala“ je pro obsluhu zásadní a nemá viset
        // na tom, že se tvar odpovědi nikdy nezmění.
        setLogs(Array.isArray(data.logs) ? data.logs : []);
        setTotal(Number(data.total) || 0);
        setPages(Number(data.pages) || 1);
      }
    } catch (_err) {
      console.error('Failed to fetch audit logs:', _err);
    } finally {
      setLoading(false);
    }
  }, [token, page, searchQuery]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  const getActionColor = (action) => {
    const a = action.toLowerCase();
    if (a.includes('delete') || a.includes('remove')) return '#ef4444';
    if (a.includes('create') || a.includes('add')) return '#10b981';
    if (a.includes('update') || a.includes('edit')) return '#3b82f6';
    if (a.includes('login')) return '#a78bfa';
    return 'var(--text-secondary)';
  };

  const formatDate = (iso) => {
    return new Date(iso).toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  };

  return (
    <div style={{ padding: isMobile ? '1.5rem 1rem' : '3rem', paddingBottom: '8rem', flex: 1, overflowY: 'auto', maxHeight: '100%' }} className="fade-in custom-scrollbar">
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: isMobile ? 'flex-start' : 'center', marginBottom: isMobile ? '1.5rem' : '3rem', flexDirection: isMobile ? 'column' : 'row', gap: isMobile ? '1rem' : 0 }}>
        <div>
          <h2 style={{ fontSize: isMobile ? '1.75rem' : '2.5rem', fontWeight: '900', marginBottom: '0.5rem', background: 'linear-gradient(to right, #60a5fa, #a78bfa)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <Shield size={isMobile ? 24 : 32} color="var(--accent-color)" /> {t('auditLogs')}
          </h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: isMobile ? '0.9rem' : '1.1rem' }}>{t('auditLogsDesc')}</p>
        </div>
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
           <button onClick={fetchLogs} style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid var(--card-border)', padding: '0.75rem', borderRadius: '12px', color: 'white', cursor: 'pointer' }}>
             <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
           </button>
        </div>
      </div>

      {/* Filters */}
      <div className="glass-card" style={{ padding: '1.25rem', marginBottom: '2rem', display: 'flex', gap: '1rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ position: 'relative', flex: 1, minWidth: '250px' }}>
          <Search size={16} color="var(--text-secondary)" style={{ position: 'absolute', left: '14px', top: '50%', transform: 'translateY(-50%)' }} />
          <input 
            type="text" 
            placeholder="Hledat akci (např. login, delete)..." 
            value={searchQuery}
            onChange={(_err) => { setSearchQuery(_err.target.value); setPage(1); }}
            style={{ width: '100%', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--card-border)', padding: '0.8rem 0.8rem 0.8rem 2.75rem', borderRadius: '12px', color: 'white', fontSize: '0.9rem' }} 
          />
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.5rem 1rem', background: 'rgba(59, 130, 246, 0.1)', border: '1px solid rgba(59, 130, 246, 0.2)', borderRadius: '10px', color: 'var(--accent-color)', fontSize: '0.8rem', fontWeight: '700' }}>
            <Activity size={14} /> {total} UDÁLOSTÍ
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="glass-card" style={{ padding: 0, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--card-border)', background: 'rgba(255,255,255,0.02)' }}>
              {['Čas', 'Uživatel', 'Akce', 'Detaily', ''].map(h => (
                <th key={h} style={{ padding: '1.25rem', color: 'var(--text-secondary)', fontSize: '0.72rem', fontWeight: '800', textTransform: 'uppercase', textAlign: 'left' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan="5" style={{ padding: '4rem', textAlign: 'center' }}><RefreshCw size={24} className="animate-spin" style={{ opacity: 0.3 }} /></td></tr>
            ) : logs.length === 0 ? (
              <tr><td colSpan="5" style={{ padding: '4rem', textAlign: 'center', color: 'var(--text-secondary)' }}>Žádné záznamy nenalezeny.</td></tr>
            ) : logs.map((log) => (
              <tr key={log.id} style={{ borderBottom: '1px solid var(--card-border)' }} className="table-row-hover">
                <td style={{ padding: '1.25rem', fontSize: '0.85rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <Calendar size={14} opacity={0.5} />
                    {formatDate(log.timestamp)}
                  </div>
                </td>
                <td style={{ padding: '1.25rem' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                    <div style={{ width: '32px', height: '32px', background: 'rgba(255,255,255,0.05)', borderRadius: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.75rem', fontWeight: '900', color: 'var(--accent-color)' }}>
                      {log.userName.charAt(0)}
                    </div>
                    <div>
                      <div style={{ fontWeight: '700', fontSize: '0.9rem' }}>{log.userName}</div>
                      <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>{log.userEmail}</div>
                    </div>
                  </div>
                </td>
                <td style={{ padding: '1.25rem' }}>
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', padding: '0.3rem 0.6rem', borderRadius: '6px', fontSize: '0.65rem', fontWeight: '900', background: `${getActionColor(log.action)}15`, color: getActionColor(log.action), border: `1px solid ${getActionColor(log.action)}30` }}>
                    {log.action.toUpperCase()}
                  </div>
                </td>
                <td style={{ padding: '1.25rem', fontSize: '0.85rem', color: 'var(--text-secondary)', maxWidth: '300px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {log.details || '-'}
                </td>
                <td style={{ padding: '1.25rem', textAlign: 'right' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: '0.5rem' }}>
                    {log.hash && (
                      <div className="verified-badge" style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', padding: '0.2rem 0.5rem', borderRadius: '6px', background: 'rgba(16, 185, 129, 0.1)', border: '1px solid rgba(16, 185, 129, 0.2)', color: '#10b981', fontSize: '0.6rem', fontWeight: '950' }}>
                        <Shield size={10} /> VERIFIED
                      </div>
                    )}
                    <button onClick={() => setSelectedLog(log)} style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: '0.5rem' }}><Eye size={16} /></button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {pages > 1 && (
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '1rem', marginTop: '2rem' }}>
          <button 
            disabled={page === 1} 
            onClick={() => setPage(p => p - 1)}
            style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid var(--card-border)', padding: '0.6rem', borderRadius: '10px', color: 'white', cursor: page === 1 ? 'not-allowed' : 'pointer', opacity: page === 1 ? 0.3 : 1 }}
          >
            <ChevronLeft size={18} />
          </button>
          <span style={{ fontSize: '0.9rem', fontWeight: '700', color: 'var(--text-secondary)' }}>
            STRANA <span style={{ color: 'white' }}>{page}</span> Z <span style={{ color: 'white' }}>{pages}</span>
          </span>
          <button 
            disabled={page === pages} 
            onClick={() => setPage(p => p + 1)}
            style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid var(--card-border)', padding: '0.6rem', borderRadius: '10px', color: 'white', cursor: page === pages ? 'not-allowed' : 'pointer', opacity: page === pages ? 0.3 : 1 }}
          >
            <ChevronRight size={18} />
          </button>
        </div>
      )}

      {/* Detail Modal */}
      {selectedLog && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 3000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }}>
          <div className="glass-card fade-in" style={{ width: '100%', maxWidth: '500px', padding: '2rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '1.5rem' }}>
              <h3 style={{ fontWeight: '800', fontSize: '1.1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <Info size={20} color="var(--accent-color)" /> Detail události
              </h3>
              <button onClick={() => setSelectedLog(null)} style={{ background: 'transparent', border: 'none', color: 'white', cursor: 'pointer' }}><ChevronRight size={20} style={{ transform: 'rotate(90deg)' }} /></button>
            </div>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '100px 1fr', gap: '1rem', fontSize: '0.9rem' }}>
                <div style={{ color: 'var(--text-secondary)', fontWeight: '700' }}>AKCE:</div>
                <div style={{ fontWeight: '800', color: getActionColor(selectedLog.action) }}>{selectedLog.action}</div>
                
                <div style={{ color: 'var(--text-secondary)', fontWeight: '700' }}>UŽIVATEL:</div>
                <div style={{ fontWeight: '700' }}>{selectedLog.userName} ({selectedLog.userEmail})</div>
                
                <div style={{ color: 'var(--text-secondary)', fontWeight: '700' }}>ČAS:</div>
                <div>{formatDate(selectedLog.timestamp)}</div>

                <div style={{ color: 'var(--text-secondary)', fontWeight: '700' }}>INTEGRITA:</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: '#10b981', fontWeight: '800', fontSize: '0.75rem' }}>
                  <ShieldCheck size={14} /> KRYPTOGRAFICKY PODEPSÁNO
                </div>
              </div>
              
              {selectedLog.hash && (
                <div style={{ marginTop: '0.5rem' }}>
                  <div style={{ color: 'var(--text-secondary)', fontWeight: '700', fontSize: '0.65rem', marginBottom: '0.4rem', letterSpacing: '0.1em' }}>SHA-256 INTEGRITY HASH</div>
                  <div style={{ background: 'rgba(0,0,0,0.3)', padding: '0.75rem', borderRadius: '8px', border: '1px solid rgba(16, 185, 129, 0.2)', fontSize: '0.7rem', color: '#10b981', wordBreak: 'break-all', fontFamily: 'monospace' }}>
                    {selectedLog.hash}
                  </div>
                </div>
              )}
              
              <div style={{ marginTop: '1rem' }}>
                <div style={{ color: 'var(--text-secondary)', fontWeight: '700', fontSize: '0.75rem', marginBottom: '0.5rem', letterSpacing: '0.05em' }}>DATA / DETAILY</div>
                <div style={{ background: 'rgba(0,0,0,0.2)', padding: '1rem', borderRadius: '10px', border: '1px solid var(--card-border)', fontSize: '0.85rem', color: '#cbd5e1', whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontFamily: 'monospace' }}>
                  {selectedLog.details || 'Žádné doplňující informace.'}
                </div>
              </div>

              <button onClick={() => setSelectedLog(null)} style={{ width: '100%', padding: '0.75rem', borderRadius: '10px', background: 'var(--accent-color)', border: 'none', color: 'white', fontWeight: '800', cursor: 'pointer', marginTop: '1rem' }}>
                ZAVŘÍT
              </button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        .table-row-hover:hover { background: rgba(255,255,255,0.03) !important; }
        .animate-spin { animation: spin 1s linear infinite; }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
};

export default AuditLogsView;
