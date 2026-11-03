import React, { useState, useEffect, useCallback } from 'react';
import { safeRedirect } from '../../utils/safeRedirect';
import { 
  Key, Plus, Trash2, Copy, CheckCircle2, AlertTriangle, 
  ShieldCheck, Globe, Loader2, Terminal, ExternalLink, Info, Zap, Crown
} from 'lucide-react';
import axios from 'axios';
import { useNexus } from '../../context/ContextHook';

const ApiSettingsView = () => {
  const { lang, showToast, API_BASE, token } = useNexus();
  const [keys, setKeys] = useState([]);
  const [agency, setAgency] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isUpgrading, setIsUpgrading] = useState(false);
  const [newKey, setNewKey] = useState(null);
  const [showConfirmDelete, setShowConfirmDelete] = useState(null);
  const [copiedKey, setCopiedKey] = useState(false);
  const [showDocs, setShowDocs] = useState(false);

  // Zaklad verejneho API se odvozuje z API_BASE, ne ze zapecene adresy — jinak by
  // kazde prestehovani backendu znamenalo novy build (viz #146).
  // API_BASE konci bud na /api (web, mobil), nebo je bez nej (lokalni vyvoj).
  const publicApiBase = `${String(API_BASE || '').replace(/\/api\/?$/, '')}/api/v1/public`;

  const fetchData = useCallback(async () => {
    try {
      setIsLoading(true);
      const [keysRes, agencyRes] = await Promise.all([
        axios.get(`${API_BASE}/developer/keys`, { headers: { Authorization: `Bearer ${token}` } }),
        axios.get(`${API_BASE}/agency/settings`, { headers: { Authorization: `Bearer ${token}` } })
      ]);
      setKeys(keysRes.data);
      setAgency(agencyRes.data);
    } catch (error) {
      console.error('Failed to fetch data:', error);
      showToast('Nepodařilo se načíst data', 'error');
    } finally {
      setIsLoading(false);
    }
  }, [showToast, API_BASE, token]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleCreateKey = async (e) => {
    e.preventDefault();
    const name = e.target.keyName.value;
    const scopes = Array.from(e.target.scopes)
      .filter(i => i.checked)
      .map(i => i.value)
      .join(',');

    try {
      setIsGenerating(true);
      const response = await axios.post(`${API_BASE}/developer/keys`, { name, scopes }, { headers: { Authorization: `Bearer ${token}` } });
      setNewKey(response.data.apiKey);
      fetchData();
      showToast('API klíč byl vygenerován', 'success');
    } catch (error) {
      showToast(error.response?.data?.message || 'Chyba při generování klíče', 'error');
    } finally {
      setIsGenerating(false);
    }
  };

  const handleRevokeKey = async (id) => {
    try {
      await axios.delete(`${API_BASE}/developer/keys/${id}`, { headers: { Authorization: `Bearer ${token}` } });
      setKeys(keys.filter(k => k.id !== id));
      setShowConfirmDelete(null);
      showToast('API klíč byl zneplatněn', 'success');
    } catch (_error) {
      showToast('Nepodařilo se smazat klíč', 'error');
    }
  };

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text);
    setCopiedKey(true);
    setTimeout(() => setCopiedKey(false), 2000);
    showToast('Zkopírováno do schránky', 'info');
  };

  const handleUpgrade = async () => {
    try {
      setIsUpgrading(true);
      const { data } = await axios.post(`${API_BASE}/billing/checkout`, {
        planId: 'api_access',
        successUrl: window.location.href,
        cancelUrl: window.location.href
      }, { headers: { Authorization: `Bearer ${token}` } });

      if (data.url) {
        showToast(lang === 'cz' ? 'Přesměrování na platební bránu...' : 'Redirecting to payment gateway...', 'info');
        safeRedirect(data.url);
      }
    } catch (_error) {
      showToast(lang === 'cz' ? 'Chyba při inicializaci platby.' : 'Error initializing payment.', 'error');
      setIsUpgrading(false);
    }
  };
  const extraFeatures = JSON.parse(agency?.extraFeatures || '{}');
  const hasApiAccess = ['Agency', 'Enterprise'].includes(agency?.plan || agency?.tier) || extraFeatures.api_access;

  return (
    <div className="view-container" style={{ padding: '2rem', maxWidth: '1200px', margin: '0 auto' }}>
      {/* Header */}
      <header style={{ marginBottom: '3rem', display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.5rem' }}>
            <Terminal size={24} color="var(--accent-color)" />
            <h1 style={{ fontSize: '2rem', fontWeight: '900', margin: 0, letterSpacing: '-0.02em' }}>Developer API</h1>
          </div>
          <p style={{ color: 'var(--text-secondary)', margin: 0, fontSize: '0.95rem' }}>
            Spravujte přístup k vašim datům přes externí aplikace a skripty.
          </p>
        </div>
        <div style={{ display: 'flex', gap: '1rem' }}>
          <button
            type="button"
            onClick={() => setShowDocs(v => !v)}
            style={{ 
              display: 'flex', alignItems: 'center', gap: '0.5rem', 
              padding: '0.75rem 1.25rem', borderRadius: '12px',
              background: showDocs ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.03)',
              border: '1px solid rgba(255,255,255,0.1)',
              color: 'white', fontSize: '0.85rem', fontWeight: '600', cursor: 'pointer'
            }}
          >
            <Globe size={16} /> {showDocs ? 'Skrýt dokumentaci' : 'Dokumentace'}
          </button>
        </div>
      </header>

      {/* Dokumentace verejneho API. Driv tu byl odkaz na /api/docs — relativni,
          takze na webu vedl na Firebase hosting (SPA index), a swagger je navic
          v produkci zamerne vypnuty. Obsah proto zije rovnou tady. */}
      {showDocs && (
        <section className="glass-panel" style={{ padding: '1.75rem', borderRadius: '20px', marginBottom: '2rem' }}>
          <h3 style={{ margin: '0 0 0.35rem', fontSize: '1.15rem', fontWeight: 800 }}>Veřejné API</h3>
          <p style={{ margin: '0 0 1.5rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            Jen pro čtení. Klíč vždy vidí data pouze vaší agentury.
          </p>

          <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '0.6rem 1.25rem', margin: '0 0 1.5rem', fontSize: '0.85rem' }}>
            <dt style={{ color: 'var(--text-secondary)' }}>Základ</dt>
            <dd style={{ margin: 0 }}><code>{publicApiBase}</code></dd>
            <dt style={{ color: 'var(--text-secondary)' }}>Hlavička</dt>
            <dd style={{ margin: 0 }}><code>X-API-KEY: nx_live_&lt;ID&gt;.&lt;SECRET&gt;</code></dd>
            <dt style={{ color: 'var(--text-secondary)' }}>Limit</dt>
            <dd style={{ margin: 0 }}>60 požadavků za minutu na klíč</dd>
            <dt style={{ color: 'var(--text-secondary)' }}>Tarif</dt>
            <dd style={{ margin: 0 }}>Agency, nebo dokoupený modul API</dd>
          </dl>

          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem', marginBottom: '1.5rem' }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--text-secondary)' }}>
                <th style={{ padding: '0.5rem 0.75rem 0.5rem 0', fontWeight: 600 }}>Endpoint</th>
                <th style={{ padding: '0.5rem 0.75rem', fontWeight: 600 }}>Oprávnění</th>
                <th style={{ padding: '0.5rem 0', fontWeight: 600 }}>Vrací</th>
              </tr>
            </thead>
            <tbody>
              {[
                { ep: 'GET /stats', scope: 'read:stats', ret: 'počty zpráv, rezervací a profilů' },
                { ep: 'GET /profiles', scope: 'read:profiles', ret: 'aktivní profily, max 1000' },
                { ep: 'GET /messages', scope: 'read:messages', ret: 'zprávy; ?limit= (max 100) a ?offset=' }
              ].map(r => (
                <tr key={r.ep} style={{ borderTop: '1px solid rgba(255,255,255,0.07)' }}>
                  <td style={{ padding: '0.6rem 0.75rem 0.6rem 0' }}><code>{r.ep}</code></td>
                  <td style={{ padding: '0.6rem 0.75rem' }}><code>{r.scope}</code></td>
                  <td style={{ padding: '0.6rem 0', color: 'var(--text-secondary)' }}>{r.ret}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', margin: '0 0 1.25rem' }}>
            Oprávnění <code>relay:bridge</code> není HTTP endpoint — slouží pro připojení
            automatizace přes Socket.IO.
          </p>

          <div style={{ marginBottom: '1.25rem' }}>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>Příklad</div>
            <pre style={{ margin: 0, padding: '0.9rem 1rem', borderRadius: '12px', background: 'rgba(0,0,0,0.3)', fontSize: '0.78rem', overflowX: 'auto' }}>
{`curl -H "X-API-KEY: $NEXUS_API_KEY" \\
  ${publicApiBase}/stats`}
            </pre>
          </div>

          <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '1.25rem' }}>
            <strong style={{ color: 'var(--text-primary)' }}>Chyby:</strong>{' '}
            <code>401</code> chybějící nebo neplatný klíč ·{' '}
            <code>403</code> chybějící oprávnění, vypršelý klíč, nebo tarif bez API ·{' '}
            <code>429</code> překročený limit
          </div>

          <div style={{ display: 'flex', gap: '0.75rem', padding: '0.9rem 1rem', borderRadius: '12px', background: 'rgba(245, 158, 11, 0.07)', border: '1px solid rgba(245, 158, 11, 0.2)', fontSize: '0.8rem', color: '#fbbf24' }}>
            <AlertTriangle size={16} style={{ flexShrink: 0 }} />
            <span>
              Pole <code>metrics.revenue</code> u <code>/stats</code> není implementované
              a vrací vždy <code>"0.00"</code>. Nepočítejte s ním.
            </span>
          </div>
        </section>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 350px', gap: '2rem' }}>
        
        {/* Main List */}
        <section>
          {/* Plan Status Banner */}
          {!hasApiAccess && (
            <div className="glass-panel" style={{ 
              padding: '1.5rem', borderRadius: '20px', marginBottom: '1.5rem',
              background: 'linear-gradient(135deg, rgba(255, 215, 0, 0.1) 0%, rgba(255, 165, 0, 0.05) 100%)',
              border: '1px solid rgba(255, 215, 0, 0.2)',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between'
            }}>
              <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
                <div style={{ width: '48px', height: '48px', borderRadius: '12px', background: 'rgba(255,215,0,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#ffd700' }}>
                  <Crown size={24} />
                </div>
                <div>
                  <h4 style={{ margin: 0, fontSize: '1rem', fontWeight: '800' }}>Vyžadován prémiový přístup</h4>
                  <p style={{ margin: 0, fontSize: '0.85rem', color: 'rgba(255,255,255,0.7)' }}>
                    Pro generování API klíčů potřebujete tarif Agency nebo dokoupený modul.
                  </p>
                </div>
              </div>
              <button 
                onClick={handleUpgrade}
                disabled={isUpgrading}
                style={{ 
                  padding: '0.75rem 1.5rem', borderRadius: '12px', background: '#ffd700', color: 'black',
                  border: 'none', fontWeight: '800', cursor: 'pointer', fontSize: '0.85rem',
                  display: 'flex', alignItems: 'center', gap: '0.5rem'
                }}
              >
                {isUpgrading ? <Loader2 className="animate-spin" size={16} /> : <Zap size={16} fill="currentColor" />}
                Aktivovat API za 990 Kč
              </button>
            </div>
          )}

          <div className="glass-panel" style={{ 
            padding: '1.5rem', borderRadius: '20px', minHeight: '400px',
            opacity: hasApiAccess ? 1 : 0.6, pointerEvents: hasApiAccess ? 'all' : 'none',
            position: 'relative'
          }}>
            {!hasApiAccess && (
              <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.1)', backdropFilter: 'blur(2px)', borderRadius: '20px', zIndex: 5 }}></div>
            )}
            <h3 style={{ fontSize: '1.1rem', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Key size={18} /> Aktivní klíče
            </h3>

            {isLoading ? (
              <div style={{ display: 'flex', justifyContent: 'center', padding: '4rem' }}>
                <Loader2 className="animate-spin" size={32} color="var(--accent-color)" />
              </div>
            ) : keys.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '4rem 2rem', opacity: 0.5 }}>
                <Key size={48} style={{ marginBottom: '1rem' }} />
                <p>Zatím nemáte žádné aktivní API klíče.</p>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                {keys.map(key => (
                  <div key={key.id} className="api-key-card" style={{ 
                    padding: '1.25rem', borderRadius: '16px',
                    background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.05)',
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center'
                  }}>
                    <div>
                      <div style={{ fontWeight: '700', marginBottom: '0.25rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        {key.name}
                        <span style={{ fontSize: '0.7rem', padding: '2px 8px', borderRadius: '100px', background: 'rgba(59, 130, 246, 0.1)', color: '#3b82f6', border: '1px solid rgba(59, 130, 246, 0.2)' }}>
                          {key.keyId}
                        </span>
                      </div>
                      <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', display: 'flex', gap: '1rem' }}>
                        <span>Vytvořeno: {new Date(key.createdAt).toLocaleDateString()}</span>
                        <span>Poslední užití: {key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString() : 'Nikdy'}</span>
                      </div>
                    </div>
                    
                    <button 
                      onClick={() => setShowConfirmDelete(key.id)}
                      className="revoke-btn"
                      style={{ 
                        padding: '0.6rem', borderRadius: '10px', 
                        background: 'rgba(239, 68, 68, 0.05)', border: '1px solid rgba(239, 68, 68, 0.1)',
                        color: '#ef4444', cursor: 'pointer'
                      }}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        {/* Generate Sidebar */}
        <aside>
          <div className="glass-panel" style={{ 
            padding: '1.5rem', borderRadius: '20px', position: 'sticky', top: '2rem',
            opacity: hasApiAccess ? 1 : 0.6, pointerEvents: hasApiAccess ? 'all' : 'none'
          }}>
            <h3 style={{ fontSize: '1.1rem', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Plus size={18} /> Nový klíč
            </h3>
            
            <form onSubmit={handleCreateKey}>
              <div style={{ marginBottom: '1.25rem' }}>
                <label style={{ display: 'block', fontSize: '0.8rem', marginBottom: '0.5rem', color: 'var(--text-secondary)' }}>Název klíče</label>
                <input 
                  name="keyName"
                  placeholder="Např. Google Sheets Export" 
                  required
                  style={{ 
                    width: '100%', padding: '0.8rem', borderRadius: '12px',
                    background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)',
                    color: 'white', outline: 'none'
                  }}
                />
              </div>

              <div style={{ marginBottom: '1.5rem' }}>
                <label style={{ display: 'block', fontSize: '0.8rem', marginBottom: '0.75rem', color: 'var(--text-secondary)' }}>Oprávnění (Scopes)</label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                  {[
                    { val: 'read:stats', label: 'Statistiky agentury' },
                    { val: 'read:profiles', label: 'Seznam profilů' },
                    { val: 'read:messages', label: 'Historie zpráv' },
                    { val: 'relay:bridge', label: 'Automatizace / local-agent (bridge)' }
                  ].map(scope => (
                    <label key={scope.val} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', cursor: 'pointer', fontSize: '0.9rem' }}>
                      <input type="checkbox" name="scopes" value={scope.val} defaultChecked={scope.val === 'read:stats'} />
                      {scope.label}
                    </label>
                  ))}
                </div>
              </div>

              <button 
                type="submit"
                disabled={isGenerating}
                style={{ 
                  width: '100%', padding: '1rem', borderRadius: '14px',
                  background: 'var(--accent-color)', color: 'white',
                  border: 'none', fontWeight: '800', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem'
                }}
              >
                {isGenerating ? <Loader2 className="animate-spin" size={18} /> : <ShieldCheck size={18} />}
                Vygenerovat klíč
              </button>
            </form>

            <div style={{ marginTop: '1.5rem', padding: '1rem', borderRadius: '12px', background: 'rgba(59, 130, 246, 0.05)', border: '1px solid rgba(59, 130, 246, 0.1)', fontSize: '0.8rem', color: '#60a5fa', display: 'flex', gap: '0.75rem' }}>
              <Info size={16} style={{ flexShrink: 0 }} />
              <span>Klíč uvidíte pouze jednou. Ihned si ho uložte na bezpečné místo.</span>
            </div>
          </div>
        </aside>
      </div>

      {/* New Key Modal (Success) */}
      {newKey && (
        <div style={{ 
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)', 
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999,
          padding: '1rem'
        }}>
          <div className="glass-panel" style={{ padding: '2.5rem', borderRadius: '32px', maxWidth: '500px', width: '100%', textAlign: 'center' }}>
            <div style={{ width: '64px', height: '64px', borderRadius: '100px', background: 'rgba(34, 197, 94, 0.1)', color: '#22c55e', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 1.5rem' }}>
              <CheckCircle2 size={32} />
            </div>
            <h2 style={{ fontSize: '1.5rem', fontWeight: '900', marginBottom: '1rem' }}>Klíč byl vygenerován!</h2>
            <p style={{ color: 'var(--text-secondary)', marginBottom: '2rem' }}>
              Toto je jediný moment, kdy klíč uvidíte. Po zavření tohoto okna už ho nebude možné zobrazit.
            </p>

            <div style={{ 
              padding: '1rem', borderRadius: '16px', background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.1)',
              display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '2rem', cursor: 'pointer'
            }} onClick={() => copyToClipboard(newKey)}>
              <code style={{ flex: 1, fontSize: '0.9rem', overflow: 'hidden', textOverflow: 'ellipsis', color: 'var(--accent-color)', fontWeight: '700' }}>
                {newKey}
              </code>
              {copiedKey ? <CheckCircle2 size={20} color="#22c55e" /> : <Copy size={20} opacity={0.5} />}
            </div>

            <button 
              onClick={() => setNewKey(null)}
              style={{ 
                width: '100%', padding: '1rem', borderRadius: '16px',
                background: 'white', color: 'black', border: 'none', fontWeight: '800', cursor: 'pointer'
              }}
            >
              Uložil jsem si klíč
            </button>
          </div>
        </div>
      )}

      {/* Delete Confirmation */}
      {showConfirmDelete && (
        <div style={{ 
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.8)', 
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999
        }}>
          <div className="glass-panel" style={{ padding: '2rem', borderRadius: '24px', maxWidth: '400px', width: '90%', textAlign: 'center' }}>
            <AlertTriangle size={48} color="#ef4444" style={{ marginBottom: '1rem' }} />
            <h3 style={{ fontSize: '1.2rem', marginBottom: '1rem' }}>Zneplatnit API klíč?</h3>
            <p style={{ color: 'var(--text-secondary)', marginBottom: '2rem', fontSize: '0.9rem' }}>
              Všechny aplikace a skripty používající tento klíč okamžitě přestanou fungovat. Tato akce je nevratná.
            </p>
            <div style={{ display: 'flex', gap: '1rem' }}>
              <button 
                onClick={() => setShowConfirmDelete(null)}
                style={{ flex: 1, padding: '0.8rem', borderRadius: '12px', background: 'rgba(255,255,255,0.05)', border: 'none', color: 'white' }}
              >
                Zrušit
              </button>
              <button 
                onClick={() => handleRevokeKey(showConfirmDelete)}
                style={{ flex: 1, padding: '0.8rem', borderRadius: '12px', background: '#ef4444', border: 'none', color: 'white', fontWeight: '700' }}
              >
                Ano, smazat
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ApiSettingsView;
