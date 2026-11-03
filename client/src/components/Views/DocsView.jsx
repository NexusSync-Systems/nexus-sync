import React, { useState } from 'react';
import { 
  FileText, Copy, Check, Download, ExternalLink, 
  Terminal, Shield, Smartphone, Zap, FileCode
} from 'lucide-react';
import { useNexus } from '../../context/ContextHook';

const CommandBlock = ({ title, command, description, t }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div style={{
      background: 'rgba(255,255,255,0.02)',
      border: '1px solid rgba(255,255,255,0.05)',
      borderRadius: '16px',
      padding: '1.25rem',
      marginBottom: '1rem'
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
        <h4 style={{ margin: 0, fontSize: '0.9rem', color: 'var(--accent-color)', fontWeight: '800' }}>{title}</h4>
        <button 
          onClick={handleCopy}
          style={{
            background: copied ? 'rgba(34, 197, 94, 0.1)' : 'rgba(255,255,255,0.05)',
            border: 'none',
            color: copied ? '#22c55e' : 'white',
            padding: '6px 12px',
            borderRadius: '8px',
            fontSize: '0.75rem',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            transition: 'all 0.2s'
          }}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
          {copied ? t('copied') : t('copy')}
        </button>
      </div>
      <div style={{
        background: '#040507',
        padding: '1rem',
        borderRadius: '10px',
        fontFamily: 'monospace',
        fontSize: '0.85rem',
        color: '#a5b4fc',
        overflowX: 'auto',
        marginBottom: '0.5rem',
        border: '1px solid rgba(255,255,255,0.03)'
      }}>
        {command}
      </div>
      {description && <p style={{ margin: 0, fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{description}</p>}
    </div>
  );
};

const DocsView = () => {
  const { activeOperator, t } = useNexus();

  // Check permission via hook directly
  if (!activeOperator?.isAppOwner) {
    return (
      <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
        <Shield size={48} style={{ marginBottom: '1rem', opacity: 0.2 }} />
        <p>{t('app_owner_only')}</p>
      </div>
    );
  }

  return (
    <div style={{ padding: '2rem', maxWidth: '900px', margin: '0 auto', animation: 'fadeIn 0.4s ease-out' }}>
      <header style={{ marginBottom: '2.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '0.5rem' }}>
          <div style={{ 
            width: '48px', height: '48px', borderRadius: '14px', 
            background: 'rgba(99, 102, 241, 0.1)', display: 'flex', 
            alignItems: 'center', justifyContent: 'center', color: 'var(--accent-color)' 
          }}>
            <FileText size={28} />
          </div>
          <h1 style={{ margin: 0, fontSize: '1.75rem', fontWeight: '900' }}>{t('docs_title')}</h1>
        </div>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.95rem' }}>
          {t('docs_subtitle')}
        </p>
      </header>

      <section style={{ marginBottom: '3rem' }}>
        <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', fontSize: '1.2rem', marginBottom: '1.5rem' }}>
          <Zap size={20} color="#fbbf24" /> {t('featuresTitle')}
        </h3>
        
        <CommandBlock 
          title={t('docs_deploy_ota')}
          command="cd client && npm run deploy:ota"
          description={t('docs_deploy_ota_desc')}
          t={t}
        />

        <CommandBlock 
          title={t('docs_deploy_firebase')}
          command="cd client && npm run build && firebase deploy --only hosting"
          description={t('docs_deploy_firebase_desc')}
          t={t}
        />
      </section>

      <section style={{ marginBottom: '3rem' }}>
        <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', fontSize: '1.2rem', marginBottom: '1.5rem' }}>
          <Smartphone size={20} color="#60a5fa" /> {t('docs_mobile_android')}
        </h3>

        <div style={{ 
          background: 'rgba(59, 130, 246, 0.05)', 
          borderLeft: '4px solid #3b82f6',
          padding: '1.25rem',
          borderRadius: '0 12px 12px 0',
          marginBottom: '1.5rem',
          fontSize: '0.9rem'
        }}>
          <strong>{t('docs_mobile_android')}:</strong> {t('docs_before_apk')}
        </div>
        
        <CommandBlock 
          title={t('docs_cap_sync')}
          command="npx cap sync android"
          description={t('docs_cap_sync_desc')}
          t={t}
        />

        <CommandBlock 
          title={t('docs_open_android')}
          command="npx cap open android"
          description={t('docs_open_android_desc')}
          t={t}
        />
      </section>

      <section style={{ marginBottom: '2rem' }}>
        <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', fontSize: '1.2rem', marginBottom: '1.5rem' }}>
          <Terminal size={20} color="#10b981" /> {t('docs_tools')}
        </h3>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: '1rem' }}>
          <a href="https://console.firebase.google.com/" target="_blank" rel="noreferrer" style={toolCardStyle}>
            <ExternalLink size={18} /> Firebase Console
          </a>
          {/* Odkaz na /api/docs tu býval se zapsaným zaniklým hostem. Swagger je
              navíc v produkci záměrně vypnutý (app.js: NODE_ENV !== 'production'),
              takže by nevedl nikam ani se správnou adresou. Popis veřejného API
              je od #148 přímo v aplikaci: Developer API → Dokumentace. */}
        </div>
      </section>
    </div>
  );
};

const toolCardStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.75rem',
  padding: '1rem 1.25rem',
  background: 'rgba(255,255,255,0.03)',
  border: '1px solid rgba(255,255,255,0.05)',
  borderRadius: '12px',
  color: 'white',
  textDecoration: 'none',
  fontSize: '0.9rem',
  fontWeight: '700',
  transition: 'all 0.2s'
};

export default DocsView;
