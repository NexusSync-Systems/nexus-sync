import React, { useState, useEffect } from 'react';
import { Sparkles, Brain, ArrowRight, RefreshCw, AlertCircle, Quote, Zap, X, Activity, HardDrive } from 'lucide-react';
import { useAI } from '../hooks/useAI';
import { useNexus } from '../context/ContextHook';

/**
 * AI Insight Card - Displays smart analysis from Llama 3.1
 */
const AIInsightCard = ({ stats, _agencies, systemHealth }) => {
  const { lang, _t, setActiveTab, activeRole, isMobile } = useNexus();
  const { askAi, isAiLoading, aiError } = useAI();
  const [insight, setInsight] = useState(null);
  const [showDetailedAudit, setShowDetailedAudit] = useState(false);
  const [detailedReport, setDetailedReport] = useState(null);
  const [isReportLoading, setIsReportLoading] = useState(false);

  // Helper to render basic markdown-like syntax
  const renderFormattedContent = (text) => {
    if (!text) return null;
    
    return text.split('\n').map((line, idx) => {
      const trimmed = line.trim();
      if (!trimmed) return <div key={idx} style={{ height: '0.75rem' }} />;

      // Header detection (starts and ends with **)
      if (trimmed.startsWith('**') && trimmed.endsWith('**') && !trimmed.includes(':')) {
        return (
          <h4 key={idx} style={{ 
            fontSize: '0.85rem', 
            fontWeight: '900', 
            color: 'var(--accent-color)', 
            marginTop: '1.5rem', 
            marginBottom: '0.75rem',
            letterSpacing: '0.05em',
            textTransform: 'uppercase'
          }}>
            {trimmed.replace(/\*\*/g, '')}
          </h4>
        );
      }

      // Bullet detection
      if (trimmed.startsWith('* ') || trimmed.startsWith('- ')) {
        const content = trimmed.substring(2);
        const parts = content.split('**');
        
        return (
          <div key={idx} style={{ 
            display: 'flex', 
            gap: '0.75rem', 
            marginBottom: '0.85rem', 
            padding: '0.75rem 1rem',
            background: 'rgba(255,255,255,0.02)',
            borderRadius: '10px',
            borderLeft: '2px solid var(--accent-color)',
            alignItems: 'flex-start'
          }}>
            <div style={{ marginTop: '0.2rem' }}>
              <Zap size={14} color="var(--accent-color)" />
            </div>
            <div style={{ fontSize: '0.85rem', lineHeight: '1.5', color: 'rgba(255,255,255,0.9)' }}>
              {parts.map((part, i) => (
                i % 2 === 1 ? <strong key={i} style={{ color: 'white', fontWeight: '800' }}>{part}</strong> : part
              ))}
            </div>
          </div>
        );
      }

      // Regular line with inline bold
      const parts = trimmed.split('**');
      return (
        <p key={idx} style={{ marginBottom: '0.75rem', fontSize: '0.9rem', lineHeight: '1.6' }}>
          {parts.map((part, i) => (
            i % 2 === 1 ? <strong key={i} style={{ color: 'white', fontWeight: '800' }}>{part}</strong> : part
          ))}
        </p>
      );
    });
  };

  const generateInsight = async () => {
    const isCz = lang === 'cz' || lang === 'cs';
    const isAppOwner = activeRole === 'app_owner';
    
    // Bez inicializace: obě větve níž (app_owner / ostatní) všechny tři
    // proměnné přiřazují, takže `= ""` byl mrtvý zápis.
    let context;
    let systemPrompt;
    let userPrompt;

    if (isAppOwner && systemHealth) {
      // Technical Perspective for App Owner
      context = `
        Technický stav platformy:
        - CPU Load: ${systemHealth.cpu.loadAvg[0]}
        - Memory: ${systemHealth.memory.percent}% (${systemHealth.memory.used} / ${systemHealth.memory.total})
        - Disk: ${systemHealth.disk.percent} (${systemHealth.disk.used})
        - Uptime: ${systemHealth.uptime.days}d ${systemHealth.uptime.hours}h
        - Aktivita: ${stats?.totalMessages || 0} zpráv dnes, ${stats?.totalAgencies || 0} aktivních agentur.
      `;

      systemPrompt = isCz
        ? "Jsi Nexus AI, technologický ředitel (CTO) a systémový architekt. Tvým úkolem je monitorovat zdraví platformy a upozorňovat na technické anomálie nebo úzká hrdla. Používej odrážky ve formátu '* **Nadpis**: Popis'. Na začátek dej krátký úvod."
        : "You are Nexus AI, a CTO and System Architect. Your job is to monitor platform health and flag technical anomalies or bottlenecks. Use bullets in format '* **Title**: Description'. Start with a short intro.";

      userPrompt = isCz
        ? `Analyzuj tento stav infrastruktury a napiš 3 technické postřehy o stabilitě a výkonu systému. Zde jsou data: ${context}`
        : `Analyze this infrastructure state and write 3 technical insights about system stability and performance. Here is the data: ${context}`;
    } else {
      // Business Perspective for Managers/Operators
      context = `
        Data pro analytiku:
        - Obrat: ${stats?.revenue || '0'}
        - Aktivita zpráv: ${stats?.totalMessages || 0}
        - Počet spravovaných účtů: ${stats?.totalProfiles || 0}
        - Růst: ${stats?.commissionGrowth || 'STABLE'}
      `;

      systemPrompt = isCz 
        ? "Jsi Nexus AI, elitní business analytik pro digitální mediální agentury. Zaměřuješ se VÝHRADNĚ na ekonomický růst, efektivitu a statistiky. Tvé odpovědi jsou stručné, profesionální a motivační. Používej odrážky ve formátu '* **Bod**: Popis'."
        : "You are Nexus AI, an elite business analyst for digital media agencies. You focus EXCLUSIVELY on economic growth, efficiency, and statistics. Your answers are concise, professional, and motivational. Use bullets in format '* **Point**: Description'.";

      userPrompt = isCz
        ? `Analyzuj tato ekonomická data a napiš 3 body, co je dnes klíčové pro růst firmy. Zde jsou data: ${context}`
        : `Analyze these economic metrics and write 3 bullet points on what is key for business growth today. Here is the data: ${context}`;
    }

    const response = await askAi(userPrompt, systemPrompt);
    if (response) {
      setInsight(response);
    }
  };

  const handleDetailedAction = async () => {
    if (activeRole === 'app_owner') {
      setShowDetailedAudit(true);
      if (!detailedReport && !isReportLoading) {
        setIsReportLoading(true);
        const isCz = lang === 'cz' || lang === 'cs';
        const context = `
          Full Infrastructure State:
          - CPU: Load Avg ${systemHealth.cpu.loadAvg.join(', ')}
          - RAM: ${systemHealth.memory.percent}% used (${systemHealth.memory.used} of ${systemHealth.memory.total})
          - Disk: ${systemHealth.disk.percent} (${systemHealth.disk.used} of ${systemHealth.disk.total})
          - SWAP: ${systemHealth.memory.swapUsed} / ${systemHealth.memory.swapTotal}
          - OS: ${systemHealth.os.platform} ${systemHealth.os.release}
          - Node Version: ${systemHealth.os.nodeVersion}
          - Total Agencies: ${stats?.totalAgencies || 0}
          - Total Active Messages: ${stats?.totalMessages || 0}
        `;
        
        const systemPrompt = isCz
          ? "Jsi Nexus Core AI, hloubkový systémový auditor. Tvým úkolem je vypracovat detailní technický report o stavu platformy. Používej markdown formátování: nadpisy pomocí '**Nadpis**' a odrážky pomocí '* **Bod**: Popis'."
          : "You are Nexus Core AI, a deep system auditor. Your task is to generate a detailed technical report. Use markdown formatting: headers with '**Header**' and bullets with '* **Point**: Description'.";
        
        const userPrompt = isCz
          ? `Vypracuj hloubkový technický audit na základě těchto dat: ${context}. Report by měl mít cca 150 slov.`
          : `Generate a deep-dive technical audit based on this data: ${context}. The report should be around 150 words.`;

        const resp = await askAi(userPrompt, systemPrompt);
        setDetailedReport(resp);
        setIsReportLoading(false);
      }
    } else {
      setActiveTab('analytics');
    }
  };

  useEffect(() => {
    if (stats && !insight && !isAiLoading) {
      const timer = setTimeout(() => generateInsight(), 0);
      return () => clearTimeout(timer);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stats]);

  const isCz = lang === 'cz' || lang === 'cs';

  return (
    <>
      <div className="glass-card fade-in" style={{ 
        padding: '2rem', 
        background: 'linear-gradient(135deg, rgba(99, 102, 241, 0.08) 0%, rgba(168, 85, 247, 0.08) 100%)',
        border: '1px solid rgba(99, 102, 241, 0.2)',
        position: 'relative',
        overflow: 'hidden'
      }}>
        {/* Background Decor */}
        <div style={{ position: 'absolute', top: '-20px', right: '-20px', opacity: 0.1 }}>
          <Brain size={120} color="var(--accent-color)" />
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1.5rem', position: 'relative' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <div style={{ 
              width: '40px', height: '40px', borderRadius: '12px', 
              background: 'var(--accent-color)', display: 'flex', 
              alignItems: 'center', justifyContent: 'center',
              boxShadow: '0 0 20px rgba(99, 102, 241, 0.4)'
            }}>
              <Sparkles size={20} color="white" />
            </div>
            <div>
              <h3 style={{ fontSize: '1rem', fontWeight: '900', letterSpacing: '0.02em' }}>NEXUS AI INSIGHT</h3>
              <div style={{ fontSize: '0.6rem', color: 'var(--accent-color)', fontWeight: '800', letterSpacing: '0.1em' }}>POWERED BY LLAMA 3.1</div>
            </div>
          </div>
          
          <button 
            onClick={generateInsight}
            disabled={isAiLoading}
            style={{ 
              background: 'rgba(255,255,255,0.05)', border: 'none', 
              color: 'var(--text-secondary)', cursor: 'pointer',
              padding: '0.5rem', borderRadius: '10px',
              transition: 'all 0.2s',
              opacity: isAiLoading ? 0.5 : 1
            }}
          >
            <RefreshCw size={16} className={isAiLoading ? 'spin-animation' : ''} />
          </button>
        </div>

        <div style={{ minHeight: '100px' }}>
          {isAiLoading ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
              <div className="skeleton-text" style={{ width: '90%', height: '12px', borderRadius: '4px' }}></div>
              <div className="skeleton-text" style={{ width: '70%', height: '12px', borderRadius: '4px' }}></div>
              <div className="skeleton-text" style={{ width: '85%', height: '12px', borderRadius: '4px' }}></div>
            </div>
          ) : aiError ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', color: 'var(--error-color)', fontSize: '0.85rem', fontWeight: '600', padding: '1rem', background: 'rgba(239, 68, 68, 0.05)', borderRadius: '10px' }}>
              <AlertCircle size={18} /> {aiError}
            </div>
          ) : insight ? (
            <div style={{ position: 'relative' }}>
              <div style={{ color: 'white' }}>
                {renderFormattedContent(insight)}
              </div>
              <div 
                onClick={handleDetailedAction}
                style={{ 
                  marginTop: '1.5rem', 
                  display: 'inline-flex', 
                  alignItems: 'center', 
                  gap: '0.5rem', 
                  fontSize: '0.7rem', 
                  color: 'var(--accent-color)', 
                  fontWeight: '900',
                  cursor: 'pointer',
                  transition: 'all 0.2s',
                  padding: '0.5rem 1rem',
                  background: 'rgba(99, 102, 241, 0.1)',
                  borderRadius: '8px',
                  border: '1px solid rgba(99, 102, 241, 0.2)'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'rgba(99, 102, 241, 0.2)';
                  e.currentTarget.style.transform = 'translateX(4px)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'rgba(99, 102, 241, 0.1)';
                  e.currentTarget.style.transform = 'translateX(0)';
                }}
              >
                {isCz ? 'ZOBRAZIT DETAILNÍ ANALÝZU' : 'VIEW DETAILED ANALYSIS'} <ArrowRight size={14} />
              </div>
            </div>
          ) : (
            <div style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', fontStyle: 'italic', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
               <RefreshCw size={14} className="spin-animation" /> {isCz ? 'Čekám na data pro analýzu...' : 'Waiting for data to analyze...'}
            </div>
          )}
        </div>

        {/* Decorative gradient blur */}
        <div style={{ 
          position: 'absolute', bottom: '-30px', left: '-30px', 
          width: '100px', height: '100px', 
          background: 'var(--accent-color)', filter: 'blur(60px)', opacity: 0.1 
        }}></div>
      </div>

      {/* Technical Audit Modal for App Owner */}
      {showDetailedAudit && (
        <div style={{ 
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, 
          zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center', 
          padding: isMobile ? '1rem' : '2rem', backdropFilter: 'blur(15px)', background: 'rgba(0,0,0,0.85)' 
        }}>
          <div className="glass-card fade-in" style={{ 
            maxWidth: '900px', width: '100%', maxHeight: '90vh', overflowY: 'auto',
            background: '#080a0f', border: '1px solid var(--card-border)', padding: isMobile ? '1.5rem' : '3rem',
            position: 'relative', display: 'flex', flexDirection: 'column', gap: '2rem',
            boxShadow: '0 25px 50px -12px rgba(0, 0, 0, 0.5)'
          }}>
            <button 
              onClick={() => setShowDetailedAudit(false)}
              style={{ position: 'absolute', top: '2rem', right: '2rem', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', color: 'white', cursor: 'pointer', width: '40px', height: '40px', borderRadius: '12px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            >
              <X size={20} />
            </button>

            <div style={{ display: 'flex', alignItems: 'center', gap: '1.25rem' }}>
              <div style={{ width: '60px', height: '60px', borderRadius: '18px', background: 'rgba(99, 102, 241, 0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1px solid var(--accent-color)', boxShadow: '0 0 20px rgba(99, 102, 241, 0.2)' }}>
                <Activity size={28} color="var(--accent-color)" />
              </div>
              <div>
                <h2 style={{ fontSize: '1.75rem', fontWeight: '900', letterSpacing: '-0.01em' }}>{isCz ? 'Technický Audit Systému' : 'System Technical Audit'}</h2>
                <div style={{ fontSize: '0.7rem', color: 'var(--accent-color)', fontWeight: '900', letterSpacing: '0.1em' }}>{isCz ? 'ZALOŽENO NA REÁLNÉ TELEMETRII' : 'BASED ON REAL-TIME TELEMETRY'}</div>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(4, 1fr)', gap: '1rem' }}>
              {[
                { label: 'CPU LOAD', value: systemHealth?.cpu?.loadAvg[0], icon: <Activity size={14} />, color: '#60a5fa' },
                { label: 'MEMORY', value: `${systemHealth?.memory?.percent}%`, icon: <Brain size={14} />, color: '#a855f7' },
                { label: 'DISK USAGE', value: systemHealth?.disk?.percent, icon: <HardDrive size={14} />, color: '#f59e0b' },
                { label: 'UPTIME', value: `${systemHealth?.uptime?.days}d`, icon: <RefreshCw size={14} />, color: '#10b981' }
              ].map((m, i) => (
                <div key={i} style={{ background: 'rgba(255,255,255,0.02)', padding: '1.5rem', borderRadius: '16px', border: '1px solid rgba(255,255,255,0.05)', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                  <div style={{ fontSize: '0.6rem', fontWeight: '900', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '0.4rem', letterSpacing: '0.05em' }}>
                    <span style={{ color: m.color }}>{m.icon}</span> {m.label}
                  </div>
                  <div style={{ fontSize: '1.5rem', fontWeight: '900', color: 'white' }}>{m.value}</div>
                </div>
              ))}
            </div>

            <div style={{ background: 'rgba(99, 102, 241, 0.03)', borderRadius: '20px', padding: isMobile ? '1.5rem' : '2.5rem', border: '1px solid rgba(99, 102, 241, 0.1)', position: 'relative' }}>
              <div style={{ position: 'absolute', top: '1.5rem', right: '1.5rem', opacity: 0.1 }}>
                <Brain size={40} color="var(--accent-color)" />
              </div>
              <h4 style={{ fontSize: '0.9rem', fontWeight: '900', marginBottom: '1.5rem', display: 'flex', alignItems: 'center', gap: '0.75rem', color: 'var(--accent-color)', letterSpacing: '0.05em' }}>
                <Sparkles size={18} /> {isCz ? 'AI ANALÝZA A DOPORUČENÍ' : 'AI ANALYSIS & RECOMMENDATIONS'}
              </h4>
              <div style={{ fontSize: '1rem', color: '#e2e8f0' }}>
                {isReportLoading ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
                    <div className="skeleton-text" style={{ width: '100%', height: '14px', borderRadius: '4px' }}></div>
                    <div className="skeleton-text" style={{ width: '90%', height: '14px', borderRadius: '4px' }}></div>
                    <div className="skeleton-text" style={{ width: '95%', height: '14px', borderRadius: '4px' }}></div>
                  </div>
                ) : (
                  // Písmo se dědí z body (Inter). Dřív tu stálo
                  // odkaz na proměnnou font-main, jenže ta nikdy neexistovala:
                  // deklarace byla neplatná a stejně se dědilo.
                  <div>
                    {renderFormattedContent(detailedReport)}
                  </div>
                )}
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '1rem' }}>
              <button 
                onClick={() => setShowDetailedAudit(false)}
                style={{ 
                  padding: '1rem 3rem', 
                  borderRadius: '14px', 
                  background: 'var(--accent-color)', 
                  color: 'white', 
                  border: 'none', 
                  fontWeight: '900', 
                  fontSize: '0.9rem',
                  cursor: 'pointer',
                  boxShadow: '0 10px 20px rgba(99, 102, 241, 0.3)',
                  transition: 'all 0.2s'
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.transform = 'translateY(-2px)';
                  e.currentTarget.style.boxShadow = '0 15px 25px rgba(99, 102, 241, 0.4)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.transform = 'translateY(0)';
                  e.currentTarget.style.boxShadow = '0 10px 20px rgba(99, 102, 241, 0.3)';
                }}
              >
                {isCz ? 'POTVRDIT PŘEČTENÍ' : 'ACKNOWLEDGE AUDIT'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default AIInsightCard;
