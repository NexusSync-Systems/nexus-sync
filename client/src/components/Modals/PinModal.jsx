import React, { useState, useEffect, useRef } from 'react';
import { Shield, X, Check, AlertTriangle, Loader2 } from 'lucide-react';
import { useNexus } from '../../context/ContextHook';


import { API_BASE } from '../../constants/config';
const PinModal = ({ onSuccess, onCancel, title, description }) => {
  const { t, token } = useNexus();
  const [pin, setPin] = useState(['', '', '', '']);
  const [_err, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const inputRefs = useRef([]);
  
  useEffect(() => {
    // Auto-focus first input
    if (inputRefs.current[0]) inputRefs.current[0].focus();
  }, []);

  const handleChange = (index, value) => {
    if (!/^\d*$/.test(value)) return;
    
    const newPin = [...pin];
    newPin[index] = value.slice(-1);
    setPin(newPin);
    setError('');

    // Auto-advance
    if (value && index < 3 && inputRefs.current[index + 1]) {
      inputRefs.current[index + 1].focus();
    }
  };

  const handleKeyDown = (index, _err) => {
    if (_err.key === 'Backspace' && !pin[index] && index > 0 && inputRefs.current[index - 1]) {
      inputRefs.current[index - 1].focus();
    }
    if (_err.key === 'Enter' && pin.every(v => v)) {
      handleSubmit();
    }
  };

  const handleSubmit = async () => {
    const pinStr = pin.join('');
    if (pinStr.length < 4) return;

    try {
      setLoading(true);
      const res = await fetch(`${API_BASE}/auth/verify-pin`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ pin: pinStr })
      });

      if (res.ok) {
        onSuccess();
      } else {
        setError(t?.invalidPin || 'Nesprávný bezpečnostní PIN');
        setPin(['', '', '', '']);
        if (inputRefs.current[0]) inputRefs.current[0].focus();
      }
    } catch {
      setError('Chyba spojení se serverem');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.85)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem', backdropFilter: 'blur(10px)' }}>
      <div className="glass-card fade-in" style={{ width: '100%', maxWidth: '380px', padding: '2.5rem 2rem', textAlign: 'center', border: '1px solid var(--accent-color)40' }}>
        <div style={{ width: '60px', height: '60px', background: 'rgba(59, 130, 246, 0.1)', borderRadius: '18px', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 1.5rem' }}>
          <Shield size={32} color="var(--accent-color)" />
        </div>
        
        <h3 style={{ fontWeight: '900', fontSize: '1.25rem', marginBottom: '0.5rem' }}>{title || 'Zabezpečená operace'}</h3>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', marginBottom: '2rem' }}>{description || 'Zadejte svůj bezpečnostní PIN pro pokračování.'}</p>
        
        <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'center', marginBottom: '1.5rem' }}>
          {pin.map((digit, idx) => (
            <input
              key={idx}
              ref={el => inputRefs.current[idx] = el}
              type="password"
              inputMode="numeric"
              maxLength={1}
              value={digit}
              onChange={(_err) => handleChange(idx, _err.target.value)}
              onKeyDown={(_err) => handleKeyDown(idx, _err)}
              style={{
                width: '50px',
                height: '60px',
                background: 'rgba(255,255,255,0.05)',
                border: `2px solid ${_err ? 'var(--error-color)' : (digit ? 'var(--accent-color)' : 'var(--card-border)')}`,
                borderRadius: '12px',
                textAlign: 'center',
                fontSize: '1.5rem',
                fontWeight: '900',
                color: 'white',
                outline: 'none',
                transition: 'all 0.2s'
              }}
            />
          ))}
        </div>

        {_err && (
          <div style={{ color: 'var(--error-color)', fontSize: '0.85rem', fontWeight: '700', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.4rem', marginBottom: '1.5rem' }}>
            <AlertTriangle size={14} /> {_err}
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <button 
            onClick={handleSubmit} 
            disabled={loading || !pin.every(v => v)}
            style={{ width: '100%', padding: '1rem', borderRadius: '12px', background: 'var(--accent-color)', border: 'none', color: 'white', fontWeight: '800', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', opacity: pin.every(v => v) ? 1 : 0.5 }}
          >
            {loading ? <Loader2 className="animate-spin" size={20} /> : <Check size={20} />}
            POTVRDIT PIN
          </button>
          
          <button 
            onClick={onCancel}
            style={{ width: '100%', padding: '0.85rem', borderRadius: '12px', background: 'transparent', border: '1px solid var(--card-border)', color: 'var(--text-secondary)', fontWeight: '700', cursor: 'pointer' }}
          >
            ZRUŠIT
          </button>
        </div>
      </div>

      <style>{`
        .animate-spin { animation: spin 1s linear infinite; }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
};

export default PinModal;
