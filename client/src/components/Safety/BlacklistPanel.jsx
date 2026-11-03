import React, { useState, useCallback, useEffect } from 'react';
import { Shield, Plus, X, Phone, Search, Trash2, Filter } from 'lucide-react';
import { useNexus } from '../../context/ContextHook';
import { VOLITELNE as DUVODY, popisDuvodu } from '../../config/blacklistReasons';

const BlacklistPanel = () => {
  const nexus = useNexus() || {};
  const { 
    t = (k) => k, 
    lang = 'en', 
    API_BASE = '', 
    token = '', 
    showToast = () => {} 
  } = nexus;

  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newPhone, setNewPhone] = useState('');
  // Kategorie z číselníku, ne volný text (config/blacklistReasons.js).
  // Výchozí hodnota je platný kód — prázdný řetězec by server odmítl.
  const [newReason, setNewReason] = useState(DUVODY[0]);
  const [searchTerm, setSearchTerm] = useState('');

  const fetchEntries = useCallback(async () => {
    if (!token || !API_BASE) return;
    try {
      setLoading(true);
      const res = await fetch(`${API_BASE}/blacklist`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setEntries(data.entries || []);
      }
    } catch {
      showToast(lang === 'cz' ? 'Chyba při načítání blacklistu' : 'Failed to load blacklist', 'error');
    } finally {
      setLoading(false);
    }
  }, [API_BASE, token, lang, showToast]);

  useEffect(() => { fetchEntries(); }, [fetchEntries]);

  const handleAdd = async () => {
    if (!newPhone.trim()) return;
    try {
      const res = await fetch(`${API_BASE}/blacklist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ phone: newPhone, reason: newReason })
      });
      if (res.ok) {
        setNewPhone('');
        setNewReason(DUVODY[0]);
        fetchEntries();
        showToast(lang === 'cz' ? 'Číslo zablokováno' : 'Number blacklisted', 'success');
      }
    } catch {
      showToast(lang === 'cz' ? 'Chyba při přidávání' : 'Error adding to blacklist', 'error');
    }
  };

  const handleRemove = async (id) => {
    try {
      const res = await fetch(`${API_BASE}/blacklist/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        fetchEntries();
        showToast(lang === 'cz' ? 'Blokování zrušeno' : 'Number unblocked', 'success');
      }
    } catch {
      showToast(lang === 'cz' ? 'Chyba při mazání' : 'Error removing from blacklist', 'error');
    }
  };

  // Hledá se i v POPISKU kategorie, ne jen v jejím kódu. Uživatel vidí
  // „Nezaplatil", ale v datech je 'unpaid' — bez toho by hledání podle toho,
  // co má před očima, schovalo právě ty záznamy, které hledá.
  const filteredEntries = entries.filter(_err => {
    const hledane = searchTerm.toLowerCase();
    return _err.phone.includes(searchTerm)
      || (_err.reason || '').toLowerCase().includes(hledane)
      || popisDuvodu(_err.reason, lang).toLowerCase().includes(hledane);
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem', height: '100%' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ fontSize: '1.5rem', fontWeight: '900', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <Shield size={28} color="var(--accent-color)" /> {t('blacklistManager')}
        </h2>
      </div>

      <div className="glass-card" style={{ padding: '1.5rem' }}>
        <div style={{ fontSize: '0.85rem', fontWeight: '800', color: 'white', marginBottom: '1rem', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{t('addManualBlock')}</div>
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: '200px', position: 'relative' }}>
            <Phone size={16} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'rgba(255,255,255,0.3)' }} />
            <input 
              type="text" 
              placeholder={t('phonePlaceholder')}
              value={newPhone}
              onChange={_err => setNewPhone(_err.target.value)}
              style={{ width: '100%', background: 'rgba(0,0,0,0.3)', border: '1px solid var(--card-border)', padding: '0.75rem 1rem 0.75rem 2.5rem', borderRadius: '10px', color: 'white' }}
            />
          </div>
          <select
            value={newReason}
            onChange={_err => setNewReason(_err.target.value)}
            aria-label={t('reason')}
            data-testid="blacklist-reason"
            style={{ flex: 2, minWidth: '200px', background: 'rgba(0,0,0,0.3)', border: '1px solid var(--card-border)', padding: '0.75rem 1rem', borderRadius: '10px', color: 'white' }}
          >
            {DUVODY.map(kod => (
              <option key={kod} value={kod} style={{ background: '#1a1a1a' }}>{popisDuvodu(kod, lang)}</option>
            ))}
          </select>
          <button 
            onClick={handleAdd}
            style={{ background: 'var(--accent-color)', color: 'white', border: 'none', padding: '0 1.5rem', borderRadius: '10px', fontWeight: '800', cursor: 'pointer' }}
          >
            <Plus size={20} />
          </button>
        </div>
      </div>

      <div style={{ background: 'rgba(0,0,0,0.2)', border: '1px solid var(--card-border)', borderRadius: '16px', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <div style={{ padding: '1rem', borderBottom: '1px solid var(--card-border)', position: 'relative' }}>
          <Search size={16} style={{ position: 'absolute', left: '1.75rem', top: '50%', transform: 'translateY(-50%)', color: 'rgba(255,255,255,0.3)' }} />
          <input 
            type="text" 
            placeholder={t('searchBlacklist')}
            value={searchTerm}
            onChange={_err => setSearchTerm(_err.target.value)}
            style={{ width: '100%', background: 'transparent', border: 'none', padding: '0.5rem 1rem 0.5rem 2.5rem', color: 'white', fontSize: '0.9rem' }}
          />
        </div>

        <div style={{ flex: 1, overflowY: 'auto', maxHeight: '400px' }} className="custom-scrollbar">
          {loading && entries.length === 0 ? (
            <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
              <div className="loader-dots" style={{ marginBottom: '1rem' }}><span></span><span></span><span></span></div>
              {t('loading')}...
            </div>
          ) : filteredEntries.length === 0 ? (
            <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
              <Filter size={32} style={{ opacity: 0.1, marginBottom: '0.5rem' }} />
              <div>{t('noBlacklistEntries')}</div>
            </div>
          ) : (
            filteredEntries.map(entry => (
              <div key={entry.id || entry.phone} style={{ padding: '1rem 1.5rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                  <div style={{ width: '36px', height: '36px', background: 'rgba(239, 68, 68, 0.1)', color: '#ef4444', borderRadius: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <Shield size={18} />
                  </div>
                  <div>
                    <div style={{ fontWeight: '700', color: 'white' }}>{entry.phone || entry.name || entry.licensePlate || 'Unknown'}</div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{entry.reason ? popisDuvodu(entry.reason, lang) : t('noReason')}</div>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem' }}>
                  <div style={{ textAlign: 'right', fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
                    <div>{entry.createdAt ? new Date(entry.createdAt).toLocaleDateString() : '-'}</div>
                  </div>
                  <button 
                    onClick={() => handleRemove(entry.id || entry.phone)}
                    style={{ background: 'transparent', border: 'none', color: 'rgba(255,255,255,0.2)', cursor: 'pointer', transition: 'color 0.2s' }}
                    onMouseOver={_err => _err.currentTarget.style.color = '#ef4444'}
                    onMouseOut={_err => _err.currentTarget.style.color = 'rgba(255,255,255,0.2)'}
                  >
                    <Trash2 size={18} />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};

export default BlacklistPanel;
