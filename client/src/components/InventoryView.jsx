import React, { useState, useMemo, useEffect, useCallback } from 'react';
import { useNexus } from '../context/ContextHook';
import { API_BASE } from '../constants/config';
import {
  Package as PackageIcon, MapPin, AlertTriangle, Plus, Search, Filter,
  ChevronDown, CheckCircle2, XCircle, RefreshCw, MoreVertical,
  Minus, Check, X, Trash2, Edit2
} from 'lucide-react';


const InventoryView = () => {
  const nexus = useNexus();
  const { 
    t = (k) => k, 
    token = '',
    lang: _lang = 'cz'
  } = nexus || {};

  const isMobile = typeof window !== 'undefined' ? window.innerWidth < 768 : false;

  // ── State ──────────────────────────────────────────────────────────────────
  const [locations, setLocations] = useState([]);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedLocation, setSelectedLocation] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [isAddingLocation, setIsAddingLocation] = useState(false);
  const [newLocationName, setNewLocationName] = useState('');

  // Add item modal
  const [addItemModal, setAddItemModal] = useState(false);
  const [newItem, setNewItem] = useState({ name: '', quantity: 0, threshold: 10, locationId: '', unit: 'pieces' });
  const [editingQty, setEditingQty] = useState(null);
  const [fetchError, setFetchError] = useState(false);

  // ── API helpers ─────────────────────────────────────────────────────────────
  const headers = useMemo(() => ({ 
    'Content-Type': 'application/json', 
    Authorization: `Bearer ${token || ''}` 
  }), [token]);

  const handleUpdateQuantity = async (id, quantity) => {
    try {
      const res = await fetch(`${API_BASE}/inventory/items/${id}`, {
        method: 'PATCH', headers, body: JSON.stringify({ quantity: Number(quantity) })
      });
      if (res.ok) { 
        const updated = await res.json(); 
        setItems(p => p.map(i => i.id === id ? updated : i)); 
      }
    } catch (_err) { console.error('[Inventory] update quantity _err:', _err); }
    setEditingQty(null);
  };

  const handleQuickConsume = async (item, amount) => {
    const newQty = Math.max(0, (item.quantity || 0) - amount);
    await handleUpdateQuantity(item.id, newQty);
  };

  const fetchAll = useCallback(async () => {
    if (!token) return;
    try {
      setLoading(true);
      const [locsRes, itemsRes] = await Promise.all([
        fetch(`${API_BASE}/inventory/locations`, { headers }),
        fetch(`${API_BASE}/inventory/items`, { headers })
      ]);
      if (locsRes.ok) setLocations(await locsRes.json());
      if (itemsRes.ok) setItems(await itemsRes.json());
    } catch (_err) {
      console.error('[Inventory] fetch failed:', _err);
      setFetchError(true);
    } finally {
      setLoading(false);
    }
  }, [headers, token]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // ── CRUD ─────────────────────────────────────────────────────────────────────
  const handleAddLocation = async () => {
    if (!newLocationName.trim()) return;
    try {
      const res = await fetch(`${API_BASE}/inventory/locations`, {
        method: 'POST', headers,
        body: JSON.stringify({ name: newLocationName.trim() })
      });
      if (res.ok) { const loc = await res.json(); setLocations(p => [...p, loc]); }
      else console.error('[Inventory] add location failed:', res.status);
    } catch (_err) { console.error('[Inventory] add location _err:', _err); }
    setNewLocationName(''); setIsAddingLocation(false);
  };

  const handleDeleteLocation = async (id) => {
    if (!window.confirm(t?.('confirmDeleteLocation') || 'Smazat lokaci a všechny její položky?')) return;
    try {
      const res = await fetch(`${API_BASE}/inventory/locations/${id}`, { method: 'DELETE', headers });
      if (res.ok) { setLocations(p => p.filter(l => l.id !== id)); setItems(p => p.filter(i => i.locationId !== id)); }
    } catch (_err) { console.error('[Inventory] delete location _err:', _err); }
  };

  const handleAddItem = async () => {
    if (!newItem.name.trim() || !newItem.locationId) return;
    try {
      const res = await fetch(`${API_BASE}/inventory/items`, {
        method: 'POST', headers, body: JSON.stringify(newItem)
      });
      if (res.ok) { const item = await res.json(); setItems(p => [...p, item]); setAddItemModal(false); setNewItem({ name: '', quantity: 0, threshold: 10, locationId: '', unit: 'pieces' }); }
    } catch (_err) { console.error('[Inventory] add item _err:', _err); }
  };

  const handleDeleteItem = async (id) => {
    if (!window.confirm(t?.('deleteItemConfirm') || 'Opravdu smazat?')) return;
    try {
      const res = await fetch(`${API_BASE}/inventory/items/${id}`, { method: 'DELETE', headers });
      if (res.ok) setItems(p => p.filter(i => i.id !== id));
    } catch (_err) { console.error('[Inventory] delete item _err:', _err); }
  };

  // ── Derived ───────────────────────────────────────────────────────────────
  const filteredItems = useMemo(() => items.filter(item => {
    const matchesLoc = selectedLocation === 'all' || item.locationId === selectedLocation;
    const matchesSearch = item.name.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesLoc && matchesSearch;
  }), [items, selectedLocation, searchQuery]);

  const stats = useMemo(() => {
    const active = selectedLocation === 'all' ? items : items.filter(i => i.locationId === selectedLocation);
    return {
      total: active.length,
      inStock: active.filter(i => i.quantity > i.threshold).length,
      lowStock: active.filter(i => i.quantity > 0 && i.quantity <= i.threshold).length,
      outOfStock: active.filter(i => i.quantity === 0).length
    };
  }, [items, selectedLocation]);

  const getColor = (q, t) => q === 0 ? 'var(--error-color)' : q <= t ? 'var(--warning-color)' : 'var(--success-color)';
  const getLabel = (q, thr) => q === 0 ? (t?.outOfStock || 'Out of Stock') : q <= thr ? (t?.lowStock || 'Low Stock') : (t?.inStock || 'In Stock');
  const locName = (id) => locations.find(l => l.id === id)?.name || id;

  const renderConsumeButtons = (item) => {
    const unit = item.unit || 'pieces';
    if (unit === 'pieces') {
      return (
        <div style={{ display: 'flex', gap: '0.4rem' }}>
          <button onClick={() => handleQuickConsume(item, 1)} className="consume-btn" style={{ padding: '4px 8px', background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.2)', color: '#ef4444', borderRadius: '6px', fontSize: '0.7rem', fontWeight: '800', cursor: 'pointer' }}>-1 ks</button>
        </div>
      );
    }
    if (unit === 'milliliters' || unit === 'ml') {
      return (
        <div style={{ display: 'flex', gap: '0.4rem' }}>
          <button onClick={() => handleQuickConsume(item, 100)} className="consume-btn" style={{ padding: '4px 8px', background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.2)', color: '#ef4444', borderRadius: '6px', fontSize: '0.7rem', fontWeight: '800', cursor: 'pointer' }}>-100ml</button>
          <button onClick={() => handleQuickConsume(item, 250)} className="consume-btn" style={{ padding: '4px 8px', background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.2)', color: '#ef4444', borderRadius: '6px', fontSize: '0.7rem', fontWeight: '800', cursor: 'pointer' }}>-250ml</button>
        </div>
      );
    }
    if (unit === 'liters' || unit === 'l') {
      return (
        <div style={{ display: 'flex', gap: '0.4rem' }}>
          <button onClick={() => handleQuickConsume(item, 0.5)} className="consume-btn" style={{ padding: '4px 8px', background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.2)', color: '#ef4444', borderRadius: '6px', fontSize: '0.7rem', fontWeight: '800', cursor: 'pointer' }}>-0.5l</button>
          <button onClick={() => handleQuickConsume(item, 1)} className="consume-btn" style={{ padding: '4px 8px', background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.2)', color: '#ef4444', borderRadius: '6px', fontSize: '0.7rem', fontWeight: '800', cursor: 'pointer' }}>-1l</button>
        </div>
      );
    }
    return null;
  };

  return (
    <div style={{ padding: isMobile ? '1.5rem 1rem' : '3rem', paddingBottom: '8rem', flex: 1, overflowY: 'auto', maxHeight: '100%' }} className="fade-in custom-scrollbar">
      {fetchError && (
        <div style={{ padding: '1rem 1.5rem', background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.3)', borderRadius: '12px', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.75rem', color: '#ef4444', fontWeight: '700', fontSize: '0.9rem' }}>
          <AlertTriangle size={18} />
          {t?.fetchError || 'Nepodařilo se načíst data. Zkuste to znovu.'}
          <button onClick={() => { setFetchError(false); fetchAll(); }} style={{ marginLeft: 'auto', background: 'rgba(239,68,68,0.2)', border: 'none', color: '#ef4444', padding: '0.5rem 1rem', borderRadius: '8px', fontWeight: '700', cursor: 'pointer' }}>
            <RefreshCw size={14} />
          </button>
        </div>
      )}
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: isMobile ? 'flex-start' : 'center', marginBottom: isMobile ? '1.5rem' : '3rem', flexDirection: isMobile ? 'column' : 'row', gap: isMobile ? '1rem' : 0 }}>
        <div>
          <h2 style={{ fontSize: isMobile ? '1.75rem' : '2.5rem', fontWeight: '900', marginBottom: '0.5rem', background: 'linear-gradient(to right, #60a5fa, #a78bfa)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <PackageIcon size={isMobile ? 24 : 32} color="var(--accent-color)" /> {t?.stockCard || 'Sklad'}
          </h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: isMobile ? '0.9rem' : '1.1rem' }}>Správa fyzického majetku a zásob agentury.</p>
        </div>
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
          {/* Location selector */}
          {!isAddingLocation ? (
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <div style={{ position: 'relative' }}>
                <MapPin size={14} color="var(--text-secondary)" style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)' }} />
                <select value={selectedLocation} onChange={e => setSelectedLocation(e.target.value)} style={{ padding: '0.6rem 1.5rem 0.6rem 2rem', background: 'rgba(255,255,255,0.05)', border: '1px solid var(--card-border)', borderRadius: '10px', color: 'white', fontSize: '0.85rem', cursor: 'pointer', minWidth: '140px' }}>
                  <option value="all">Vše</option>
                  {(locations || []).map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              </div>
              <button onClick={() => setIsAddingLocation(true)} title="Přidat lokaci" style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid var(--card-border)', padding: '0.55rem', borderRadius: '10px', color: 'white', cursor: 'pointer', display: 'flex' }}>
                <Plus size={16} />
              </button>
              {selectedLocation !== 'all' && (
                <button onClick={() => handleDeleteLocation(selectedLocation)} title="Smazat lokaci" style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', padding: '0.55rem', borderRadius: '10px', color: 'var(--error-color)', cursor: 'pointer', display: 'flex' }}>
                  <Trash2 size={16} />
                </button>
              )}
            </div>
          ) : (
            <div className="glass-card" style={{ padding: '0.5rem 0.75rem', display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <input autoFocus value={newLocationName} onChange={e => setNewLocationName(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleAddLocation()} placeholder="Název lokace..." style={{ background: 'transparent', border: 'none', color: 'white', fontSize: '0.85rem', outline: 'none', width: '140px' }} />
              <button onClick={handleAddLocation} style={{ background: 'var(--success-color)', border: 'none', borderRadius: '4px', color: 'white', padding: '3px', cursor: 'pointer' }}><Check size={14} /></button>
              <button onClick={() => setIsAddingLocation(false)} style={{ background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: '4px', color: 'white', padding: '3px', cursor: 'pointer' }}><X size={14} /></button>
            </div>
          )}
          <button onClick={() => { setNewItem(p => ({ ...p, locationId: selectedLocation !== 'all' ? selectedLocation : (locations[0]?.id || '') })); setAddItemModal(true); }} className="action-btn" style={{ marginTop: 0, padding: '0.65rem 1.25rem', display: 'flex', gap: '0.5rem', alignItems: 'center', background: 'var(--accent-color)', fontWeight: '700' }}>
            <Plus size={18} /> Přidat položku
          </button>
        </div>
      </div>

      {/* Stats */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2,1fr)' : 'repeat(4,1fr)', gap: isMobile ? '0.75rem' : '1.5rem', marginBottom: '2rem' }}>
        {[
          { label: t?.itemsInStock || 'Skladem', val: stats.inStock, color: 'var(--accent-color)', Icon: PackageIcon },
          { label: t?.lowStockItems || 'Nízké zásoby', val: stats.lowStock, color: 'var(--warning-color)', Icon: AlertTriangle },
          { label: t?.outOfStockItems || 'Vyprodáno', val: stats.outOfStock, color: 'var(--error-color)', Icon: XCircle },
          { label: 'Celkem položek', val: stats.total, color: 'var(--success-color)', Icon: CheckCircle2 },
        ].map(({ label, val, color, Icon: _Icon }) => (
          <div key={label} className="glass-card" style={{ padding: isMobile ? '1rem' : '1.5rem' }}>
            <div style={{ background: `${color}15`, padding: '0.5rem', borderRadius: '10px', width: 'fit-content', marginBottom: '0.75rem' }}><_Icon size={20} color={color} /></div>
            <div style={{ color: 'var(--text-secondary)', fontSize: '0.65rem', fontWeight: '800', letterSpacing: '0.05em' }}>{label.toUpperCase()}</div>
            <div style={{ fontSize: '1.5rem', fontWeight: '900' }}>{val}</div>
          </div>
        ))}
      </div>

      {/* Table */}
      <div className="glass-card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ padding: '1.25rem 1.5rem', borderBottom: '1px solid var(--card-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
          <div style={{ position: 'relative', flex: 1, minWidth: '200px', maxWidth: '400px' }}>
            <Search size={16} color="var(--text-secondary)" style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)' }} />
            <input type="text" placeholder="Hledat položku..." value={searchQuery} onChange={e => setSearchQuery(e.target.value)} style={{ width: '100%', background: 'rgba(255,255,255,0.05)', border: '1px solid var(--card-border)', padding: '0.75rem 0.75rem 0.75rem 2.5rem', borderRadius: '12px', color: 'white' }} />
          </div>
          <button onClick={fetchAll} style={{ background: 'none', border: '1px solid var(--card-border)', padding: '0.7rem', borderRadius: '10px', color: 'white', cursor: 'pointer', display: 'flex' }}><RefreshCw size={16} /></button>
        </div>

        {loading ? (
          <div style={{ padding: '4rem', textAlign: 'center', color: 'var(--text-secondary)' }}><RefreshCw size={24} style={{ opacity: 0.4 }} /></div>
        ) : isMobile ? (
          <div>
            {filteredItems.map((item, idx) => (
              <div key={item.id} style={{ padding: '1.25rem', borderBottom: idx < filteredItems.length - 1 ? '1px solid var(--card-border)' : 'none' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
                  <div>
                    <div style={{ fontWeight: '800' }}>{item.name}</div>
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '0.3rem' }}><MapPin size={10} /> {locName(item.locationId)}</div>
                  </div>
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', padding: '0.3rem 0.6rem', borderRadius: '6px', fontSize: '0.65rem', fontWeight: '900', background: `${getColor(item.quantity, item.threshold)}15`, color: getColor(item.quantity, item.threshold) }}>
                    {getLabel(item.quantity, item.threshold).toUpperCase()}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
                  {editingQty?.id === item.id ? (
                    <input type="number" value={editingQty.value} onChange={e => setEditingQty(p => ({ ...p, value: e.target.value }))} onBlur={() => handleUpdateQuantity(item.id, editingQty.value)} onKeyDown={e => e.key === 'Enter' && handleUpdateQuantity(item.id, editingQty.value)} style={{ width: '70px', background: 'rgba(255,255,255,0.1)', border: '1px solid var(--accent-color)', borderRadius: '8px', color: 'white', padding: '0.4rem', fontSize: '0.9rem', fontWeight: '800' }} />
                  ) : (
                    <button onClick={() => setEditingQty({ id: item.id, value: item.quantity })} style={{ fontWeight: '800', fontSize: '1.1rem', background: 'rgba(255,255,255,0.05)', border: '1px solid var(--card-border)', borderRadius: '8px', color: item.quantity <= item.threshold ? 'var(--warning-color)' : 'white', padding: '0.3rem 0.75rem', cursor: 'pointer' }}>{item.quantity} <span style={{ fontSize: '0.7rem', opacity: 0.5 }}>{item.unit || 'ks'}</span></button>
                  )}
                  {renderConsumeButtons(item)}
                  <button onClick={() => handleDeleteItem(item.id)} style={{ background: 'none', border: 'none', color: 'var(--error-color)', cursor: 'pointer', marginLeft: 'auto', display: 'flex' }}><Trash2 size={16} /></button>
                </div>
              </div>
            ))}
            {!filteredItems.length && <div style={{ padding: '3rem', textAlign: 'center', color: 'var(--text-secondary)' }}><PackageIcon size={40} style={{ opacity: 0.1 }} /><div>Žádné položky</div></div>}
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--card-border)', background: 'rgba(255,255,255,0.02)' }}>
                {['Název', 'Lokace', 'Množství', 'Rychlá spotřeba', 'Limit', 'Stav', ''].map(h => (
                  <th key={h} style={{ padding: '1rem 1.25rem', color: 'var(--text-secondary)', fontSize: '0.72rem', fontWeight: '800', textTransform: 'uppercase', textAlign: h === 'Množství' || h === 'Limit' ? 'center' : 'left' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredItems.map(item => (
                <tr key={item.id} style={{ borderBottom: '1px solid var(--card-border)' }} className="table-row-hover">
                  <td style={{ padding: '1rem 1.25rem' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                      <div style={{ width: '36px', height: '36px', background: 'rgba(255,255,255,0.04)', borderRadius: '9px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}><PackageIcon size={18} color="var(--text-secondary)" /></div>
                      <div style={{ fontWeight: '700' }}>{item.name}</div>
                    </div>
                  </td>
                  <td style={{ padding: '1rem 1.25rem' }}><div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', color: 'var(--text-secondary)', fontSize: '0.85rem' }}><MapPin size={13} />{locName(item.locationId)}</div></td>
                  <td style={{ padding: '1rem 1.25rem', textAlign: 'center' }}>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                      {editingQty?.id === item.id ? (
                        <input type="number" value={editingQty.value} onChange={e => setEditingQty(p => ({ ...p, value: e.target.value }))} onBlur={() => handleUpdateQuantity(item.id, editingQty.value)} onKeyDown={e => e.key === 'Enter' && handleUpdateQuantity(item.id, editingQty.value)} autoFocus style={{ width: '70px', background: 'rgba(255,255,255,0.1)', border: '1px solid var(--accent-color)', borderRadius: '8px', color: 'white', padding: '0.3rem', textAlign: 'center', fontSize: '1rem', fontWeight: '800' }} />
                      ) : (
                        <button onClick={() => setEditingQty({ id: item.id, value: item.quantity })} title="Klikni pro úpravu" style={{ fontWeight: '800', fontSize: '1rem', color: item.quantity <= item.threshold ? 'var(--warning-color)' : 'white', background: 'rgba(255,255,255,0.04)', border: '1px solid var(--card-border)', borderRadius: '8px', padding: '0.2rem 0.75rem', cursor: 'pointer' }}>{item.quantity} <span style={{ fontSize: '0.7rem', opacity: 0.5 }}>{item.unit || 'ks'}</span></button>
                      )}
                    </div>
                  </td>
                  <td style={{ padding: '1rem 1.25rem' }}>
                    {renderConsumeButtons(item)}
                  </td>
                  <td style={{ padding: '1rem 1.25rem', textAlign: 'center', color: 'var(--text-secondary)', fontSize: '0.9rem' }}>{item.threshold}</td>
                  <td style={{ padding: '1rem 1.25rem' }}>
                    <div style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', padding: '0.3rem 0.75rem', borderRadius: '7px', fontSize: '0.72rem', fontWeight: '800', background: `${getColor(item.quantity, item.threshold)}15`, color: getColor(item.quantity, item.threshold), border: `1px solid ${getColor(item.quantity, item.threshold)}30` }}>
                      <div style={{ width: '5px', height: '5px', borderRadius: '50%', background: getColor(item.quantity, item.threshold) }} />{getLabel(item.quantity, item.threshold).toUpperCase()}
                    </div>
                  </td>
                  <td style={{ padding: '1rem 1.25rem', textAlign: 'right' }}>
                    <button onClick={() => handleDeleteItem(item.id)} style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: '0.3rem' }}><Trash2 size={16} /></button>
                  </td>
                </tr>
              ))}
              {!filteredItems.length && (
                <tr><td colSpan="7" style={{ padding: '4rem', textAlign: 'center', color: 'var(--text-secondary)' }}><PackageIcon size={40} style={{ opacity: 0.1, marginBottom: '0.75rem' }} /><div>Žádné položky</div></td></tr>
              )}
            </tbody>
          </table>
        )}
      </div>

      {/* Add Item Modal */}
      {addItemModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 3000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem' }}>
          <div className="glass-card fade-in" style={{ width: '100%', maxWidth: '440px', padding: '2rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '1.5rem' }}>
              <h3 style={{ fontWeight: '800', fontSize: '1.1rem' }}>Nová skladová položka</h3>
              <button onClick={() => setAddItemModal(false)} style={{ background: 'transparent', border: 'none', color: 'white', cursor: 'pointer' }}><X size={20} /></button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <input placeholder="Název položky *" value={newItem.name} onChange={e => setNewItem(p => ({ ...p, name: e.target.value }))} style={{ padding: '0.75rem 1rem', background: 'rgba(255,255,255,0.05)', border: '1px solid var(--card-border)', borderRadius: '10px', color: 'white', fontSize: '0.95rem' }} />
              
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                <select value={newItem.locationId} onChange={e => setNewItem(p => ({ ...p, locationId: e.target.value }))} style={{ padding: '0.75rem 1rem', background: 'rgba(255,255,255,0.05)', border: '1px solid var(--card-border)', borderRadius: '10px', color: 'white', fontSize: '0.9rem' }}>
                  <option value="">Lokace *</option>
                  {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
                <select value={newItem.unit} onChange={e => setNewItem(p => ({ ...p, unit: e.target.value }))} style={{ padding: '0.75rem 1rem', background: 'rgba(255,255,255,0.05)', border: '1px solid var(--card-border)', borderRadius: '10px', color: 'white', fontSize: '0.9rem' }}>
                  <option value="pieces">{t?.pieces || 'ks'}</option>
                  <option value="milliliters">{t?.milliliters || 'ml'}</option>
                  <option value="liters">{t?.liters || 'l'}</option>
                </select>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                <div>
                  <label style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', fontWeight: '700' }}>MNOŽSTVÍ</label>
                  <input type="number" min="0" value={newItem.quantity} onChange={e => setNewItem(p => ({ ...p, quantity: Number(e.target.value) }))} style={{ width: '100%', marginTop: '0.4rem', padding: '0.65rem 0.75rem', background: 'rgba(255,255,255,0.05)', border: '1px solid var(--card-border)', borderRadius: '10px', color: 'white' }} />
                </div>
                <div>
                  <label style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', fontWeight: '700' }}>MIN. LIMIT</label>
                  <input type="number" min="0" value={newItem.threshold} onChange={e => setNewItem(p => ({ ...p, threshold: Number(e.target.value) }))} style={{ width: '100%', marginTop: '0.4rem', padding: '0.65rem 0.75rem', background: 'rgba(255,255,255,0.05)', border: '1px solid var(--card-border)', borderRadius: '10px', color: 'white' }} />
                </div>
              </div>
              <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.5rem' }}>
                <button onClick={() => setAddItemModal(false)} style={{ flex: 1, padding: '0.75rem', borderRadius: '10px', border: '1px solid var(--card-border)', background: 'transparent', color: 'white', fontWeight: '700', cursor: 'pointer' }}>Zrušit</button>
                <button onClick={handleAddItem} disabled={!newItem.name.trim() || !newItem.locationId} style={{ flex: 1, padding: '0.75rem', borderRadius: '10px', border: 'none', background: 'var(--accent-color)', color: 'white', fontWeight: '800', cursor: 'pointer', opacity: !newItem.name.trim() || !newItem.locationId ? 0.5 : 1 }}>Přidat položku</button>
              </div>
            </div>
          </div>
        </div>
      )}

      <style>{`
        .table-row-hover:hover { background: rgba(255,255,255,0.03) !important; }
        .consume-btn:active { transform: scale(0.95); }
      `}</style>
    </div>
  );
};

export default InventoryView;
