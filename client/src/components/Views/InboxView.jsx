import React, { Fragment } from 'react';
import { safeRedirect } from '../../utils/safeRedirect';
import { najdiDidProfilu } from '../../utils/sipDial';
import { 
  Search, MessageSquare, Phone, Clock, Link, Globe, Shield, Check, 
  Zap, Calendar, ChevronDown, ChevronLeft, ChevronRight, PlusCircle, 
  Signal, MoreVertical, StickyNote, Languages, Sparkles, Loader2, RefreshCw, UserCheck, X, Lock, AlertTriangle, CheckCheck
} from 'lucide-react';
import { deliveryState } from '../../utils/deliveryState';
import { canReviewCommunication } from '../../utils/canReviewCommunication';
import MessageReview from '../Inbox/MessageReview';

import { useNexus } from '../../context/ContextHook';
import { useOmnichannel } from '../../hooks/useOmnichannel';
import PremiumSelector from '../UI/PremiumSelector';
import useAI from '../../hooks/useAI';


/**
 * Stav doručení odchozí zprávy.
 *
 * Relay telefon hlásí výsledek odeslání zpět (PATCH /api/messages/:id/status),
 * server ho uloží a rozešle přes socket jako `message_updated`. Klient tu
 * informaci dostával, ale nikde ji nevykresloval — nedoručená SMS vypadala
 * úplně stejně jako doručená. Operátorka tak byla přesvědčená, že klient
 * zprávu má, i když mu nikdy nedorazila.
 *
 * Selhání nesmí být poznat jen podle barvy: kdo barvy nerozliší nebo jen
 * rychle přejede očima po hustém výpisu, si toho nevšimne. Proto ikona i věta.
 */
const DeliveryState = ({ status, isCz, onResend }) => {
  const state = deliveryState(status);
  if (state.kind === 'none') return null;

  if (state.kind === 'failed') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginTop: '6px', flexWrap: 'wrap' }}>
        <AlertTriangle size={13} color="#f87171" style={{ flex: 'none' }} />
        <span style={{ fontSize: '0.7rem', color: '#fca5a5', fontWeight: '700' }}>
          {isCz ? 'Klientovi nedošla' : 'Not delivered'}
        </span>
        {state.showResend && onResend && (
          <button
            onClick={onResend}
            style={{ background: 'none', border: 'none', padding: 0, marginLeft: '0.2rem', color: '#f87171', fontSize: '0.7rem', fontWeight: '800', cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: '3px' }}
          >
            {isCz ? 'Poslat znovu' : 'Send again'}
          </button>
        )}
      </div>
    );
  }
  if (state.kind === 'pending') {
    return <Clock size={12} style={{ opacity: 0.5 }} aria-label={isCz ? 'Odesílá se' : 'Sending'} />;
  }
  if (state.kind === 'delivered') {
    return <CheckCheck size={13} style={{ opacity: 0.55 }} aria-label={isCz ? 'Doručeno' : 'Delivered'} />;
  }
  if (state.kind === 'sent') {
    return <Check size={13} style={{ opacity: 0.5 }} aria-label={isCz ? 'Odesláno' : 'Sent'} />;
  }
  return null;
};

const InboxView = () => {
  const nexus = useNexus() || {};
  
  // 1. Destructure with safety AT THE TOP
  const {
    isMobile = false, mobileView = 'list', setMobileView = () => {}, 
    activeProfileId = 'all', setActiveProfileId = () => {},
    myProfiles: assignedProfiles = [], selectedChatId = null, setSelectedChatId = () => {},
    isTranslating = false, sourceText = '', setSourceText = () => {}, translatedText = '',
    internalNote = '', setInternalNote = () => {}, clientNotes = {}, clientNames = {},
    filteredMessages = [], selectedChat = null, chatMessages = [], isHistoryLoading = false,
    chatScrollRef = null, isUserScrolled = { current: false }, typingProfiles = {}, inlinePanelTab = null,
    setInlinePanelTab = () => {}, activeOperator = null, setShowPanicConfirm = () => {},
    messageValue = '', setMessageValue = () => {},
    bookingSchedule = [], calViewDate = new Date(), setCalViewDate = () => {}, setIsBookingModalOpen = () => {},
    setNewBookingForm = () => {}, activeContextTab = 'translator', setActiveContextTab = () => {}, 
    translateTargetLang = 'AUTO', setTranslateTargetLang = () => {},
    lang = 'en', t = (k) => k, token = '', API_BASE = '',
    activeProfile = null, handleSendMessage = () => {}, handleTranslate = () => {}, handleSaveNote = () => {},
    handleDeleteNote = () => {}, showToast = () => {}, handleSyncChatHistory = () => {},
    loading: isInitialLoading = false,
    initData: refreshData = () => {}, isBackgroundLoading = false, fetchClientByPhone = () => {},
    setActiveTab = () => {}, agencies = [], handleRefreshMessages = () => {},
    startCall = () => ({ ok: false }), sipDids = []
  } = nexus;

  // Číslo, pod kterým se u téhle konverzace smí volat ven. Seznam chodí ze
  // serveru; když profil číslo nemá, tlačítko volání je nedostupné.
  const didProfilu = React.useMemo(
    () => najdiDidProfilu(sipDids, selectedChat?.profileId),
    [sipDids, selectedChat?.profileId]
  );

  const omnichannel = useOmnichannel({
    token,
    API_BASE
  });

  const { 
    messages: omnichannelMessages, 
    sendMessage: sendOmnichannelMessage,
    isLoading: _isOmniLoading 
  } = omnichannel;

  const sendMessage = React.useCallback(async (content) => {
    if (!content || !content.trim() || !selectedChat) return;

    const channel = (selectedChat.channel || selectedChat.transport || 'sms').toLowerCase();
    
    if (channel !== 'sms' && channel !== 'relay') {
      try {
        await sendOmnichannelMessage(channel, {
          content,
          recipient: selectedChat.from,
          conversationId: selectedChatId
        });
        setMessageValue('');
        return;
      } catch (err) {
        console.error("Omnichannel send failed:", err);
        showToast(
          lang === 'cz'
            ? `Kanál ${channel} zatím není nakonfigurovaný pro odesílání.`
            : `${channel} is not configured for sending yet.`,
          "error"
        );
        return;
      }
    }

    // Fallback to legacy
    handleSendMessage(content);
    setMessageValue('');
  }, [selectedChat, selectedChatId, sendOmnichannelMessage, handleSendMessage, showToast, lang, setMessageValue]);

  // Combine legacy and omnichannel messages
  const allMessages = React.useMemo(() => {
    if (!selectedChatId) return [];
    
    // Filter omnichannel messages for this conversation
    const omniMatch = omnichannelMessages.filter(m => 
      m.conversationId === selectedChatId || 
      m.chatId === selectedChatId
    );

    // Merge and sort
    const combined = [...chatMessages, ...omniMatch];
    
    // Pre-calculate timestamps to avoid O(N log N) Date allocations which cause UI freezes
    const withTime = combined.map(m => {
      const ts = m.createdAt || m.timestamp || 0;
      const timeVal = typeof ts === 'number' ? ts : (new Date(ts).getTime() || 0);
      return { msg: m, timeVal };
    });
    
    withTime.sort((a, b) => a.timeVal - b.timeVal);
    
    return withTime.map(item => item.msg);
  }, [chatMessages, omnichannelMessages, selectedChatId]);

  const [clientCrmData, setClientCrmData] = React.useState(null);
  const [isCrmLoading, setIsCrmLoading] = React.useState(false);
  const [aiSuggestions, setAiSuggestions] = React.useState([]);
  const [isUpgrading, setIsUpgrading] = React.useState(false);
  const [isChatMenuOpen, setIsChatMenuOpen] = React.useState(false);
  const chatMenuRef = React.useRef(null);
  const { getSuggestion, isAiLoading, aiError } = useAI();

  const agency = agencies?.[0] || {};
  const hasAiAccess = agency.plan === 'Professional' || agency.plan === 'Agency' || agency.extraFeatures?.ai_features === true;

  const handleUpgradeAi = async () => {
    setIsUpgrading(true);
    try {
      const response = await fetch(`${API_BASE}/billing/checkout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ 
          planId: 'ai_module',
          successUrl: window.location.href,
          cancelUrl: window.location.href
        })
      });
      const data = await response.json();
      if (data.url) safeRedirect(data.url);
    } catch (err) {
      console.error("AI Upgrade failed:", err);
    } finally {
      setIsUpgrading(false);
    }
  };

  // 2. All functions must be defined BEFORE useEffects to avoid TDZ in production
  const loadClientCrm = React.useCallback(async (phone) => {
    if (!fetchClientByPhone || !phone) return;
    
    // Prevent redundant loading if we already have the data for this phone
    if (clientCrmData && (clientCrmData.phone === phone || clientCrmData.externalId === phone)) {
      return;
    }

    setIsCrmLoading(true);
    try {
      const data = await fetchClientByPhone(phone);
      setClientCrmData(data);
    } catch (err) {
      console.error("CRM Load error:", err);
    } finally {
      setIsCrmLoading(false);
    }
  }, [fetchClientByPhone, clientCrmData]);

  const lastMsgId = chatMessages.length > 0 ? chatMessages[chatMessages.length - 1].id : null;

  const loadAiSuggestions = React.useCallback(async () => {
    if (!selectedChat || !chatMessages.length) {
      console.warn("[AI] Cannot load suggestions: missing chat or messages", { selectedChat, count: chatMessages.length });
      return;
    }
    
    console.log("[AI] Requesting suggestions for chat:", selectedChatId);
    try {
      const history = chatMessages.slice(-10).map(m => ({
        role: m.direction === 'OUTBOUND' ? 'assistant' : 'user',
        content: m.text
      }));

      const suggestions = await getSuggestion(history, activeProfileId === 'all' ? null : activeProfileId);
      console.log("[AI] Suggestions received:", suggestions);
      
      if (suggestions && Array.isArray(suggestions)) {
        setAiSuggestions(suggestions);
      } else if (suggestions) {
        setAiSuggestions([suggestions]);
      } else {
        setAiSuggestions([]);
        showToast(lang === 'cz' ? 'AI nevrátilo žádné návrhy.' : 'AI returned no suggestions.', 'info');
      }
    } catch (_err) {
      console.error("AI load error:", _err);
      showToast(lang === 'cz' ? 'Chyba AI modulu.' : 'AI Module Error.', 'error');
    }
  }, [selectedChat, chatMessages, activeProfileId, getSuggestion, selectedChatId, showToast, lang]);

  // 3. UseEffects AFTER definitions
  React.useEffect(() => {
    if (selectedChat?.from && activeContextTab === 'crm') {
      loadClientCrm(selectedChat.from);
    }
  }, [selectedChat?.from, activeContextTab, loadClientCrm]);

  // Reset CRM data when switching chats to avoid showing old data
  React.useEffect(() => {
    setClientCrmData(null);
  }, [selectedChat?.from]);

  React.useEffect(() => {
    if (selectedChatId && inlinePanelTab === 'ai' && chatMessages.length > 0 && hasAiAccess) {
      loadAiSuggestions();
    }
  }, [selectedChatId, inlinePanelTab, lastMsgId, hasAiAccess, chatMessages.length, loadAiSuggestions]);

  // Auto-refresh messages every 10 seconds for web users without push notifications
  React.useEffect(() => {
    const interval = setInterval(() => {
      // Refresh messages silently in the background
      handleRefreshMessages();
    }, 10000);
    return () => clearInterval(interval);
  }, [handleRefreshMessages]);

  React.useEffect(() => {
    if (!isChatMenuOpen) return undefined;
    const onPointerDown = (event) => {
      if (chatMenuRef.current && !chatMenuRef.current.contains(event.target)) {
        setIsChatMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [isChatMenuOpen]);

  const latestUnreadInbound = React.useMemo(() => (
    [...allMessages].reverse().find(msg => String(msg.direction || '').toUpperCase() === 'INBOUND' && msg.status !== 'read')
  ), [allMessages]);

  const copySelectedPhone = React.useCallback(async () => {
    if (!selectedChat?.from) return;
    try {
      await navigator.clipboard.writeText(selectedChat.from);
      showToast(lang === 'cz' ? 'Číslo zkopírováno.' : 'Number copied.', 'success');
    } catch {
      showToast(selectedChat.from, 'info');
    } finally {
      setIsChatMenuOpen(false);
    }
  }, [selectedChat?.from, showToast, lang]);

  const markLatestInboundRead = React.useCallback(async () => {
    if (!latestUnreadInbound?.id) return;
    try {
      const response = await fetch(`${API_BASE}/messages/${latestUnreadInbound.id}/read`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      handleRefreshMessages();
      showToast(lang === 'cz' ? 'Zpráva označena jako přečtená.' : 'Message marked as read.', 'success');
    } catch {
      showToast(lang === 'cz' ? 'Stav zprávy se nepovedlo uložit.' : 'Could not update message status.', 'error');
    } finally {
      setIsChatMenuOpen(false);
    }
  }, [API_BASE, token, latestUnreadInbound?.id, handleRefreshMessages, showToast, lang]);

  const runChatMenuAction = React.useCallback((action) => {
    setIsChatMenuOpen(false);
    action?.();
  }, []);

  // Pull to refresh logic
  const [pullDistance, setPullDistance] = React.useState(0);
  const pullStartRef = React.useRef(0);
  const isPullingRef = React.useRef(false);

  const handleTouchStart = (_err) => {
    const scrollEl = document.querySelector('.inbox-scroll-container');
    if (scrollEl && scrollEl.scrollTop === 0) {
      pullStartRef.current = _err.touches[0].clientY;
      isPullingRef.current = true;
    }
  };

  const handleTouchMove = (_err) => {
    if (!isPullingRef.current) return;
    const currentY = _err.touches[0].clientY;
    const distance = currentY - pullStartRef.current;
    if (distance > 0) {
      setPullDistance(Math.min(distance * 0.4, 80));
      if (distance > 10) _err.preventDefault();
    }
  };

  const handleTouchEnd = () => {
    if (isPullingRef.current) {
      if (pullDistance > 60) {
        void refreshData();
      }
      setPullDistance(0);
      isPullingRef.current = false;
    }
  };

  // ENSURE WE HAVE A VALID FILTER (Default to 'all' if somehow null or invalid for better UX)
  React.useEffect(() => {
    if (!activeProfileId) {
      setActiveProfileId('all');
    }
  }, [activeProfileId, setActiveProfileId]);

  return (
    <div data-testid="page-inbox-container" style={{ display: 'flex', flex: 1, height: '100%', overflow: 'hidden', position: 'relative' }} className="fade-in inbox-grid">
      {/* Column 1: Inbox List */}
      {(!isMobile || mobileView === 'list') && (
        <div 
          className={`inbox-panel ${!selectedChatId ? 'active' : ''}`} 
          style={{ width: isMobile ? '100%' : '380px', flexShrink: 0, borderRight: '1px solid var(--card-border)', display: 'flex', flexDirection: 'column', position: 'relative' }}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
        >
          {pullDistance > 0 && (
            <div style={{ position: 'absolute', top: `${pullDistance - 40}px`, left: '0', right: '0', display: 'flex', justifyContent: 'center', zIndex: 100, transition: pullDistance === 0 ? 'all 0.3s ease' : 'none' }}>
              <div style={{ width: '40px', height: '40px', borderRadius: '50%', background: 'var(--accent-color)', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 4px 12px rgba(0,0,0,0.3)', transform: `rotate(${pullDistance * 4}deg)` }}>
                <RefreshCw size={20} color="white" />
              </div>
            </div>
          )}

          {isMobile && (
            <div style={{ padding: '1rem 1.25rem', borderBottom: '1px solid var(--card-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--bg-color)' }}>
              <h2 style={{ fontSize: '1.25rem', fontWeight: '800', margin: 0 }}>{t('inbox')}</h2>
              <div style={{ display: 'flex', gap: '0.75rem' }}>
                <button onClick={() => refreshData()} style={{ background: 'rgba(255,255,255,0.05)', border: 'none', color: 'white', width: '36px', height: '36px', borderRadius: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <RefreshCw size={18} className={isBackgroundLoading ? 'rotate' : ''} />
                </button>
                {!activeOperator?.isModel && (
                  <div style={{ position: 'relative', width: '140px' }}>
                    <PremiumSelector
                      options={assignedProfiles}
                      value={activeProfileId}
                      onChange={(val) => {
                        setActiveProfileId(val);
                        setSelectedChatId(null); 
                      }}
                      showAllOption={true}
                      allLabel={lang === 'cz' ? 'Všechny' : 'All'}
                      placeholder={t('selectProfile')}
                    />
                  </div>
                )}
              </div>
            </div>
          )}

          {!isMobile && (
            <div style={{ padding: '2rem 1.5rem', borderBottom: '1px solid var(--card-border)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.5rem', gap: '1rem', flexWrap: 'wrap' }}>
                <h2 data-testid="page-inbox-title" style={{ fontSize: '1.5rem', fontWeight: '800', margin: 0 }}>{t('inbox')}</h2>
                {!activeOperator?.isModel && (
                  <div style={{ position: 'relative', width: '180px' }} className="premium-selector-fix">
                    <PremiumSelector
                      options={assignedProfiles}
                      value={activeProfileId}
                      onChange={(val) => {
                        setActiveProfileId(val);
                        setSelectedChatId(null); 
                      }}
                      showAllOption={true}
                      allLabel={lang === 'cz' ? 'Všechny profily' : 'All Profiles'}
                      placeholder={t('selectProfile')}
                    />
                  </div>
                )}
              </div>
              <div style={{ position: 'relative', marginTop: '0.5rem' }}>
                <Search size={18} color="var(--text-secondary)" style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', zIndex: 2 }} />
                <input 
                  data-testid="input-search-chats" 
                  type="text" 
                  placeholder={t('searchPlaceholder')} 
                  style={{ 
                    width: '100%', 
                    background: 'rgba(255,255,255,0.05)', 
                    border: '1px solid var(--card-border)', 
                    padding: '0.85rem 1rem 0.85rem 2.8rem', 
                    borderRadius: '12px', 
                    color: 'white',
                    outline: 'none',
                    boxSizing: 'border-box'
                  }} 
                />
              </div>
            </div>
          )}
          <div className="inbox-scroll-container" style={{ overflowY: 'auto', flex: 1 }}>
            {filteredMessages.length > 0 ? filteredMessages.map(msg => {
              const isSelected = selectedChatId === msg.id;
              const isUnread = msg.status === 'unread';
              
              return (
                <div 
                  key={msg.id} 
                  onClick={() => { 
                    setSelectedChatId(msg.id); 
                    if (isMobile) setMobileView('chat');
                    if (!isTranslating) { setSourceText(""); }
                    setInternalNote("");
                  }}
                  className={`conversation-item ${isSelected ? 'active' : ''} ${isUnread ? 'unread' : ''}`}
                  data-testid={`chat-list-item-${msg.id}`}
                  style={{ 
                    padding: isMobile ? '1.25rem 1.25rem 1.25rem 2.2rem' : '1.5rem 1.5rem 1.5rem 2.5rem', 
                    borderBottom: '1px solid var(--card-border)', 
                    cursor: 'pointer', 
                    position: 'relative'
                  }}
                >
                  {isUnread && <div className="dot"></div>}
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.4rem' }}>
                    <span style={{ 
                      fontWeight: (isUnread || isSelected) ? '800' : '600', 
                      fontSize: '1rem', 
                      color: isSelected ? 'white' : (isUnread ? 'var(--accent-color)' : 'inherit'),
                      display: 'flex', 
                      alignItems: 'center', 
                      gap: '0.5rem' 
                    }}>
                      {clientNames[msg.from] || msg.from}
                      {activeProfileId === 'all' && msg.profileName && (
                        <span style={{ fontSize: '0.6rem', padding: '1px 5px', borderRadius: '4px', background: 'rgba(59,130,246,0.1)', color: 'var(--accent-color)', border: '1px solid rgba(59,130,246,0.2)' }}>{msg.profileName}</span>
                      )}
                    </span>
                    <span style={{ fontSize: '0.72rem', color: isUnread ? 'var(--accent-color)' : 'var(--text-secondary)', fontWeight: isUnread ? '800' : '400' }}>
                      {(() => {
                        if (msg.time) return msg.time;
                        const embeddedTimeMatch = (msg.text || '').match(/\s?(\d{4}-\d{2}-\d{2}\s(\d{2}:\d{2}):\d{2})$/);
                        if (embeddedTimeMatch) return embeddedTimeMatch[2]; // just HH:mm
                        
                        const rawDate = msg.createdAt || msg.timestamp;
                        if (rawDate) {
                          const validDate = new Date(rawDate);
                          if (!isNaN(validDate.getTime())) {
                            return validDate.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Prague' });
                          }
                        }
                        return '';
                      })()}
                    </span>
                  </div>
                  <div className="truncate-text" style={{ 
                    opacity: isSelected ? 1 : (isUnread ? 0.9 : 0.6),
                    color: isUnread ? 'white' : 'var(--text-secondary)',
                    fontWeight: isUnread ? '600' : '400',
                    fontSize: '0.85rem'
                  }}>
                    {(() => {
                      const stripped = (msg.text || '').replace(/\s?(\d{4}-\d{2}-\d{2}\s\d{2}:\d{2}:\d{2})$/, '').trim();
                      return stripped === '' ? 'Zpráva' : stripped;
                    })()}
                  </div>
                </div>
              );
            }) : (
              isInitialLoading ? (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '5rem 1rem', gap: '1rem' }}>
                  <Loader2 className="animate-spin" size={32} color="var(--accent-color)" />
                  <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', fontWeight: '600' }}>{lang === 'cz' ? 'Načítám zprávy...' : 'Loading messages...'}</div>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '3rem 1rem', gap: '0.75rem' }}>
                  <MessageSquare size={48} color="#374151" />
                  <div style={{ fontSize: '1rem', fontWeight: '700', color: '#64748b' }}>{t('noMessages')}</div>
                  <div style={{ fontSize: '0.8rem', color: '#475569' }}>
                    {lang === 'cz' ? 'Zprávy se zobrazí po přijetí první konverzace' : 'Messages will appear once you receive your first conversation'}
                  </div>
                </div>
              )
            )}
            <div style={{ height: isMobile ? '80px' : '0' }}></div>
          </div>
        </div>
      )}

      {/* Column 2 & 3 Container */}
      {(!isMobile || mobileView !== 'list') && (
        <div className={`inbox-panel ${selectedChatId ? 'active' : ''} ${isMobile && !selectedChatId ? 'hidden-mobile' : ''}`} style={{ flex: 1, display: 'flex', flexDirection: isMobile ? 'column' : 'row', minWidth: 0, overflow: 'hidden' }}>
          
          {/* Column 2: Chat Detail */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: 'rgba(0,0,0,0.1)', minWidth: 0, overflow: 'hidden', minHeight: 0 }}>
            {selectedChat ? (
              <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden', minHeight: 0 }}>
                <div style={{ paddingTop: '4px', paddingBottom: isMobile ? '0.5rem' : '1.5rem', paddingLeft: isMobile ? '1rem' : '2rem', paddingRight: isMobile ? '1rem' : '2rem', borderBottom: '1px solid var(--card-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--bg-color)', flexShrink: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                    {isMobile && <button onClick={() => setMobileView('list')} style={{ background: 'none', border: 'none', color: 'white' }}><ChevronLeft size={24} /></button>}
                    <div style={{ width: '32px', height: '32px', borderRadius: '8px', background: 'var(--accent-color)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: '800', fontSize: '0.9rem' }}>
                      {(clientNames[selectedChat?.from] || selectedChat?.from || '??').slice(-2)}
                    </div>
                    <div>
                      <div style={{ fontWeight: '800', fontSize: '1.2rem' }}>{clientNames[selectedChat.from] || selectedChat.from}</div>
                      {clientNames[selectedChat.from] && (
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{selectedChat.from}</div>
                      )}
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: isMobile ? '0.5rem' : '1rem' }}>
                    {/* Tlačítko CALL se vrátilo — od #108 existuje odchozí směr
                        v dialplanu. Klient uvidí číslo modelky, ne číslo agentury.

                        Když profil číslo přiřazené nemá, tlačítko je nedostupné
                        a řekne proč. Poctivější než nechat kliknout a mlčky
                        zahodit hovor. */}
                    <button
                      onClick={() => startCall(selectedChat.profileId, selectedChat.from, {
                        jmenoKlienta: clientNames[selectedChat.from] || '',
                        jmenoModelky: selectedChat.profileName || null,
                      })}
                      disabled={!didProfilu}
                      data-testid="chat-call-button"
                      aria-label={lang === 'cz' ? 'Zavolat klientovi' : 'Call client'}
                      title={didProfilu
                        ? (lang === 'cz'
                          ? `Zavolat — klient uvidí ${didProfilu}`
                          : `Call — the client will see ${didProfilu}`)
                        : (lang === 'cz'
                          ? 'Profil nemá přiřazené telefonní číslo, není pod čím volat.'
                          : 'This profile has no phone number assigned, there is nothing to call from.')}
                      style={{
                        background: didProfilu ? 'rgba(74, 222, 128, 0.1)' : 'rgba(148, 163, 184, 0.08)',
                        border: `1px solid ${didProfilu ? 'rgba(74, 222, 128, 0.2)' : 'rgba(148, 163, 184, 0.15)'}`,
                        color: didProfilu ? '#4ade80' : 'var(--text-secondary)',
                        width: '36px',
                        height: '36px',
                        borderRadius: '8px',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: didProfilu ? 'pointer' : 'not-allowed',
                        opacity: didProfilu ? 1 : 0.5,
                      }}
                    >
                      <Phone size={16} />
                    </button>
                    <button 
                      onClick={() => handleSyncChatHistory(selectedChatId)} 
                      data-testid="chat-sync-button"
                      title={t('syncHistory')}
                      style={{ 
                        background: 'rgba(167, 139, 250, 0.1)', 
                        border: '1px solid rgba(167, 139, 250, 0.2)', 
                        color: '#a78bfa', 
                        width: '36px', 
                        height: '36px', 
                        borderRadius: '8px', 
                        display: 'flex', 
                        alignItems: 'center', 
                        justifyContent: 'center',
                        cursor: 'pointer'
                      }}
                    >
                      <RefreshCw size={18} />
                    </button>
                    {(activeOperator?.isModel || (isMobile && activeOperator && !activeOperator?.isAppOwner && !activeOperator?.isAdmin && !activeOperator?.isManager)) && (
                      <button
                        onClick={() => setShowPanicConfirm(true)}
                        data-testid="chat-panic-button"
                        style={{ width: '36px', height: '36px', borderRadius: '8px', background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.2)', color: '#ef4444', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                      >
                        <Shield size={20} />
                      </button>
                    )}
                    <div ref={chatMenuRef} style={{ position: 'relative' }}>
                      <button
                        onClick={() => setIsChatMenuOpen(open => !open)}
                        aria-haspopup="menu"
                        aria-expanded={isChatMenuOpen}
                        style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', width: '36px', height: '36px', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
                      >
                        <MoreVertical size={22} />
                      </button>
                      {isChatMenuOpen && (
                        <div role="menu" style={{ position: 'absolute', right: 0, top: '42px', width: '220px', background: 'rgba(15, 18, 26, 0.98)', border: '1px solid var(--card-border)', borderRadius: '12px', boxShadow: '0 18px 45px rgba(0,0,0,0.45)', padding: '0.4rem', zIndex: 30 }}>
                          <button type="button" role="menuitem" onClick={() => runChatMenuAction(handleRefreshMessages)} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: '0.6rem', padding: '0.7rem', border: 'none', background: 'transparent', color: 'white', fontSize: '0.78rem', textAlign: 'left', borderRadius: '8px', cursor: 'pointer' }}>
                            <RefreshCw size={15} /> {lang === 'cz' ? 'Obnovit zprávy' : 'Refresh messages'}
                          </button>
                          <button type="button" role="menuitem" onClick={() => runChatMenuAction(() => handleSyncChatHistory(selectedChatId))} disabled={!selectedChatId} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: '0.6rem', padding: '0.7rem', border: 'none', background: 'transparent', color: 'white', fontSize: '0.78rem', textAlign: 'left', borderRadius: '8px', cursor: selectedChatId ? 'pointer' : 'not-allowed', opacity: selectedChatId ? 1 : 0.5 }}>
                            <RefreshCw size={15} /> {lang === 'cz' ? 'Synchronizovat historii' : 'Sync history'}
                          </button>
                          <button type="button" role="menuitem" onClick={copySelectedPhone} disabled={!selectedChat?.from} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: '0.6rem', padding: '0.7rem', border: 'none', background: 'transparent', color: 'white', fontSize: '0.78rem', textAlign: 'left', borderRadius: '8px', cursor: selectedChat?.from ? 'pointer' : 'not-allowed', opacity: selectedChat?.from ? 1 : 0.5 }}>
                            <Link size={15} /> {lang === 'cz' ? 'Kopírovat číslo' : 'Copy number'}
                          </button>
                          <button type="button" role="menuitem" onClick={() => runChatMenuAction(() => { setActiveContextTab('crm'); loadClientCrm(selectedChat?.from); })} disabled={!selectedChat?.from} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: '0.6rem', padding: '0.7rem', border: 'none', background: 'transparent', color: 'white', fontSize: '0.78rem', textAlign: 'left', borderRadius: '8px', cursor: selectedChat?.from ? 'pointer' : 'not-allowed', opacity: selectedChat?.from ? 1 : 0.5 }}>
                            <UserCheck size={15} /> CRM
                          </button>
                          <button type="button" role="menuitem" onClick={markLatestInboundRead} disabled={!latestUnreadInbound?.id} style={{ width: '100%', display: 'flex', alignItems: 'center', gap: '0.6rem', padding: '0.7rem', border: 'none', background: 'transparent', color: 'white', fontSize: '0.78rem', textAlign: 'left', borderRadius: '8px', cursor: latestUnreadInbound?.id ? 'pointer' : 'not-allowed', opacity: latestUnreadInbound?.id ? 1 : 0.5 }}>
                            <Check size={15} /> {lang === 'cz' ? 'Označit jako přečtené' : 'Mark as read'}
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
                <div
                  ref={chatScrollRef}
                  onScroll={(_err) => {
                    const el = _err.currentTarget;
                    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
                    isUserScrolled.current = distFromBottom > 100;
                  }}
                  style={{ flex: 1, padding: isMobile ? '0.5rem 0.75rem' : '2rem', overflowY: 'auto', WebkitOverflowScrolling: 'touch', background: 'rgba(0,0,0,0.2)', display: 'flex', flexDirection: 'column', gap: isMobile ? '0' : '0.25rem', minHeight: 0, justifyContent: chatMessages.length > 0 ? 'flex-start' : 'flex-end' }}>
                   {isHistoryLoading && (
                     <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '1rem', flexShrink: 0 }}>
                       <Loader2 className="animate-spin" size={20} color="var(--accent-color)" />
                       <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginLeft: '0.5rem' }}>
                         {lang === 'cz' ? 'Načítám historii...' : 'Loading history...'}
                       </span>
                     </div>
                   )}
                   {allMessages.length > 0 ? (
                      (() => {
                        let lastDateStr = null;
                        return allMessages.map((msg, i) => {
                          let finalMsgText = msg.text || '';
                          let rawDate = msg.createdAt || msg.timestamp || msg.time;
                          
                          // Extract embedded timestamp from test scripts (e.g. "Test SMS 2026-06-15 14:41:13" or full ISO)
                          const embeddedTimeMatch = finalMsgText.match(/\s?(\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)$/);
                          if (embeddedTimeMatch) {
                            if (!rawDate) rawDate = new Date(embeddedTimeMatch[1]).toISOString();
                            const strippedText = finalMsgText.replace(embeddedTimeMatch[0], '');
                            finalMsgText = strippedText.trim() === '' ? 'Zpráva' : strippedText;
                          }
                          
                          if (!rawDate) rawDate = new Date();
                          const msgDate = new Date(rawDate);
                          const validDate = isNaN(msgDate.getTime()) ? new Date() : msgDate;
                          
                          // Format date for separator
                          const dateObj = new Date(validDate);
                          dateObj.setHours(0, 0, 0, 0);
                          const currentDateStr = dateObj.toISOString();
                          
                          let showDateSeparator = false;
                          if (currentDateStr !== lastDateStr) {
                            showDateSeparator = true;
                            lastDateStr = currentDateStr;
                          }
                          
                          const today = new Date();
                          today.setHours(0, 0, 0, 0);
                          const yesterday = new Date(today);
                          yesterday.setDate(yesterday.getDate() - 1);
                          
                          let displayDateStr;
                          if (dateObj.getTime() === today.getTime()) {
                            displayDateStr = lang === 'cz' ? 'Dnes' : 'Today';
                          } else if (dateObj.getTime() === yesterday.getTime()) {
                            displayDateStr = lang === 'cz' ? 'Včera' : 'Yesterday';
                          } else {
                            displayDateStr = validDate.toLocaleDateString(lang === 'cz' ? 'cs-CZ' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
                          }
                          
                          return (
                            <Fragment key={msg.id || i}>
                              {showDateSeparator && (
                                <div style={{ textAlign: 'center', margin: '1rem 0 0.5rem 0' }}>
                                  <span style={{ background: 'rgba(255,255,255,0.05)', color: 'var(--text-secondary)', padding: '0.2rem 0.6rem', borderRadius: '12px', fontSize: '0.7rem', fontWeight: '800' }}>
                                    {displayDateStr}
                                  </span>
                                </div>
                              )}
                              <div
                                className={msg.direction === 'OUTBOUND' ? 'message-bubble-out' : 'message-bubble-in'}
                                data-testid={msg.status === 'failed' ? 'message-failed' : undefined}
                                style={{
                                  alignSelf: msg.direction === 'OUTBOUND' ? 'flex-end' : 'flex-start',
                                  marginBottom: isMobile ? '0.35rem' : '0.6rem',
                                  // Rám navíc, aby selhání šlo poznat i periferním viděním
                                  // v dlouhém výpisu — ale nikdy jako jediný signál.
                                  ...(msg.status === 'failed' ? { border: '1px solid rgba(239, 68, 68, 0.55)' } : {})
                                }}
                              >
                                <div style={{ fontSize: isMobile ? '0.88rem' : '0.95rem' }}>{finalMsgText}</div>
                                <div style={{ fontSize: '0.65rem', opacity: 0.6, marginTop: '4px', display: 'flex', justifyContent: 'flex-end', gap: '10px', alignItems: 'center' }}>
                                  {msg.senderName && msg.direction === 'OUTBOUND' && (
                                    <span style={{ fontWeight: '800', marginRight: 'auto', color: 'rgba(255,255,255,0.7)' }}>
                                      {`[${msg.senderName}]`}
                                    </span>
                                  )}
                                  <span>
                                    {validDate.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Prague' })}
                                  </span>
                                  {msg.direction === 'OUTBOUND' && msg.status !== 'failed' && (
                                    <DeliveryState status={msg.status} isCz={lang === 'cz'} />
                                  )}
                                </div>
                                {msg.direction === 'OUTBOUND' && msg.status === 'failed' && (
                                  <DeliveryState
                                    status="failed"
                                    isCz={lang === 'cz'}
                                    onResend={() => sendMessage(msg.text)}
                                  />
                                )}
                                {/* Kontrola komunikace. Ovládání vidí jen vedoucí role —
                                    server to hlídá taky, ale nabízet akci, která skončí
                                    403, nemá smysl. */}
                                {msg.direction === 'OUTBOUND' && msg.id && canReviewCommunication(activeOperator) && (
                                  <MessageReview
                                    messageId={msg.id}
                                    apiBase={API_BASE}
                                    token={token}
                                    isCz={lang === 'cz'}
                                    showToast={showToast}
                                  />
                                )}
                              </div>
                            </Fragment>
                          );
                        });
                      })()
                   ) : (
                     <div className="message-bubble-in" style={{ marginBottom: '1rem' }}>{selectedChat.text}</div>
                   )}

                   {typingProfiles[activeProfileId] === selectedChat.from && (
                     <div className="message-bubble-in fade-in" style={{ alignSelf: 'flex-start', background: 'rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', gap: '8px', width: 'fit-content' }}>
                       <div className="typing-dot" style={{ width: '6px', height: '6px', background: 'var(--accent-color)', borderRadius: '50%', animation: 'bounce 0.6s infinite alternate' }}></div>
                       <div className="typing-dot" style={{ width: '6px', height: '6px', background: 'var(--accent-color)', borderRadius: '50%', animation: 'bounce 0.6s infinite alternate 0.2s' }}></div>
                       <div className="typing-dot" style={{ width: '6px', height: '6px', background: 'var(--accent-color)', borderRadius: '50%', animation: 'bounce 0.6s infinite alternate 0.4s' }}></div>
                     </div>
                   )}
                </div>
                  <div style={{ display: 'flex', gap: '0.4rem', padding: '0.6rem 1rem', borderBottom: '1px solid rgba(255,255,255,0.04)', overflowX: 'auto', scrollbarWidth: 'none' }}>
                      {[
                         { id: 'ai', icon: Sparkles, label: lang === 'cz' ? 'AI Návrhy' : 'AI Smart', color: '#a78bfa' },
                         ...(isMobile ? [
                           { id: 'notes', icon: StickyNote, label: lang === 'cz' ? 'Poznámky' : 'Notes', color: '#f59e0b' }, 
                           { id: 'calendar', icon: Calendar, label: lang === 'cz' ? 'Kalendář' : 'Calendar', color: '#6366f1' },
                           { id: 'translator', icon: Languages, label: lang === 'cz' ? 'Překladač' : 'Translator', color: '#3b82f6' }, 
                           { id: 'responses', icon: Zap, label: lang === 'cz' ? 'Odpovědi' : 'Replies', color: '#10b981' }
                         ] : [])
                       ].map(btn => (
                        <button key={btn.id} onClick={() => setInlinePanelTab(prev => prev === btn.id ? null : btn.id)} style={{ display: 'flex', alignItems: 'center', gap: '0.3rem', padding: '0.35rem 0.65rem', background: inlinePanelTab === btn.id ? `${btn.color}22` : 'rgba(255,255,255,0.03)', border: `1px solid ${inlinePanelTab === btn.id ? btn.color : 'var(--card-border)'}`, borderRadius: '10px', color: inlinePanelTab === btn.id ? btn.color : 'var(--text-secondary)', fontSize: '0.68rem', whiteSpace: 'nowrap', fontWeight: '800' }}>
                          <btn.icon size={12} /> {btn.label}
                        </button>
                      ))}
                   </div>
                   
                   {inlinePanelTab && (
                      <div style={{ padding: '0.75rem 1rem', borderBottom: '1px solid var(--card-border)', background: 'rgba(255,255,255,0.01)' }}>
                         {inlinePanelTab === 'ai' && (
                           <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                             <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                               <span style={{ fontSize: '0.65rem', fontWeight: '800', color: '#a78bfa', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                                 {lang === 'cz' ? 'AI CHYTRÉ NÁVRHY' : 'AI SMART SUGGESTIONS'}
                               </span>
                               {hasAiAccess && (
                                 <button onClick={loadAiSuggestions} style={{ background: 'none', border: 'none', color: '#a78bfa', cursor: 'pointer', padding: '2px' }}>
                                   <RefreshCw size={12} className={isAiLoading ? 'animate-spin' : ''} />
                                 </button>
                               )}
                             </div>
                             
                             {!hasAiAccess ? (
                               <div style={{ padding: '1.5rem', background: 'rgba(167, 139, 250, 0.04)', border: '1px solid rgba(167, 139, 250, 0.1)', borderRadius: '16px', textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '1rem' }}>
                                 <div style={{ width: '48px', height: '48px', background: 'rgba(167, 139, 250, 0.1)', borderRadius: '14px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                                   <Lock size={20} color="#a78bfa" />
                                 </div>
                                 <div>
                                   <div style={{ fontWeight: '800', color: 'white', fontSize: '0.9rem', marginBottom: '0.25rem' }}>
                                     {lang === 'cz' ? 'AI Modul je uzamčen' : 'AI Module Locked'}
                                   </div>
                                   <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', lineHeight: '1.5' }}>
                                     {lang === 'cz' ? 'Získejte chytré návrhy odpovědí generované AI pro rychlejší komunikaci.' : 'Get AI-powered smart replies for faster client communication.'}
                                   </div>
                                 </div>
                                 <button 
                                   onClick={handleUpgradeAi}
                                   disabled={isUpgrading}
                                   style={{ width: '100%', padding: '0.75rem', background: '#a78bfa', color: 'black', border: 'none', borderRadius: '10px', fontWeight: '900', fontSize: '0.75rem', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }}
                                 >
                                   {isUpgrading ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                                   {lang === 'cz' ? 'AKTIVOVAT AI MODUL' : 'ACTIVATE AI MODULE'}
                                 </button>
                               </div>
                             ) : (
                               <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                                  {isAiLoading ? (
                                    <div style={{ padding: '1rem', display: 'flex', alignItems: 'center', gap: '0.75rem', color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
                                      <Loader2 size={14} className="animate-spin" />
                                      {lang === 'cz' ? 'Nexus AI připravuje návrhy...' : 'Nexus AI is preparing suggestions...'}
                                    </div>
                                  ) : aiSuggestions.length > 0 ? (
                                    aiSuggestions.map((s, i) => (
                                      <div 
                                        key={i} 
                                        className="fade-in"
                                        style={{ 
                                          display: 'flex', 
                                          flexDirection: 'column',
                                          background: 'rgba(167, 139, 250, 0.04)', 
                                          border: '1px solid rgba(167, 139, 250, 0.1)', 
                                          borderRadius: '12px', 
                                          overflow: 'hidden',
                                          transition: 'all 0.2s ease',
                                          marginBottom: '0.2rem'
                                        }}
                                      >
                                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.75rem 1rem' }}>
                                          <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-start' }}>
                                            <div style={{ marginTop: '0.15rem' }}>
                                              <Sparkles size={14} color="#a78bfa" />
                                            </div>
                                            <div style={{ fontSize: '0.85rem', color: 'rgba(255,255,255,0.9)', lineHeight: '1.5' }}>
                                              {s}
                                            </div>
                                          </div>
                                        </div>
                                        <div style={{ display: 'flex', borderTop: '1px solid rgba(167, 139, 250, 0.08)' }}>
                                          <button 
                                            onClick={() => setMessageValue(s)}
                                            style={{ flex: 1, padding: '0.5rem', background: 'none', border: 'none', borderRight: '1px solid rgba(167, 139, 250, 0.08)', color: 'var(--text-secondary)', fontSize: '0.65rem', fontWeight: '800', cursor: 'pointer', transition: 'all 0.2s' }}
                                          >
                                            {lang === 'cz' ? 'UPRAVIT' : 'EDIT'}
                                          </button>
                                          <button 
                                            onClick={() => { sendMessage(s); }}
                                            style={{ flex: 1, padding: '0.5rem', background: 'none', border: 'none', color: '#a78bfa', fontSize: '0.65rem', fontWeight: '900', cursor: 'pointer', transition: 'all 0.2s' }}
                                          >
                                            {lang === 'cz' ? 'POSLAT' : 'SEND'}
                                          </button>
                                        </div>
                                      </div>
                                    ))
                                  ) : (
                                    <div style={{ padding: '1rem', color: 'var(--text-secondary)', fontSize: '0.8rem', background: 'rgba(255,255,255,0.02)', borderRadius: '12px', border: '1px dashed rgba(255,255,255,0.1)', textAlign: 'center' }}>
                                      {aiError ? (
                                        <span style={{ color: 'var(--error-color)' }}>{aiError}</span>
                                      ) : (
                                        lang === 'cz' ? 'Žádné návrhy k dispozici. Zkuste obnovit.' : 'No suggestions available. Try refreshing.'
                                      )}
                                    </div>
                                  )}
                                </div>
                             )}
                           </div>
                         )}
                         {inlinePanelTab === 'calendar' && (
                           <div className="fade-in" style={{ display: 'flex', flexDirection: 'column', height: '320px', overflow: 'hidden' }}>
                             <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.5rem 0.25rem', marginBottom: '0.5rem' }}>
                               <button onClick={() => { const d = new Date(calViewDate); d.setDate(d.getDate()-1); setCalViewDate(d); }} style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid var(--card-border)', color: 'white', padding: '0.25rem 0.5rem', borderRadius: '8px', cursor: 'pointer' }}><ChevronLeft size={14} /></button>
                               <div style={{ textAlign: 'center' }}>
                                 <div style={{ fontSize: '0.75rem', fontWeight: '900', color: 'white' }}>{calViewDate.toLocaleDateString(lang === 'cz' ? 'cs-CZ' : 'en-GB', { day: 'numeric', month: 'short' })}</div>
                               </div>
                               <button onClick={() => { const d = new Date(calViewDate); d.setDate(d.getDate()+1); setCalViewDate(d); }} style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid var(--card-border)', color: 'white', padding: '0.25rem 0.5rem', borderRadius: '8px', cursor: 'pointer' }}><ChevronRight size={14} /></button>
                             </div>
                             <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                               {(() => {
                                 const d = calViewDate || new Date();
                                 const dStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
                                 const bookings = (bookingSchedule || []).filter(b => b.startTime?.startsWith(dStr));
                                 
                                 if (bookings.length === 0) {
                                   return <div style={{ textAlign: 'center', padding: '2rem', opacity: 0.5, fontSize: '0.75rem' }}>{lang === 'cz' ? 'Žádné rezervace' : 'No bookings'}</div>;
                                 }
                                 
                                 return bookings.map(b => (
                                   <div key={b.id} style={{ padding: '0.75rem', background: 'rgba(99,102,241,0.05)', border: '1px solid rgba(99,102,241,0.15)', borderRadius: '10px', borderLeft: '3px solid #6366f1' }}>
                                     <div style={{ fontWeight: '800', fontSize: '0.8rem', color: 'white' }}>{b.time}</div>
                                     <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>{b.title}</div>
                                   </div>
                                 ));
                               })()}
                             </div>
                             <button 
                               onClick={() => setIsBookingModalOpen(true)}
                               style={{ marginTop: '0.75rem', background: '#6366f1', color: 'white', border: 'none', borderRadius: '10px', padding: '0.6rem', fontWeight: '800', fontSize: '0.75rem', cursor: 'pointer' }}
                             >
                               + {lang === 'cz' ? 'PŘIDAT REZERVACI' : 'ADD BOOKING'}
                             </button>
                           </div>
                         )}
                         {inlinePanelTab === 'notes' && (
                           <div style={{ display: 'flex', gap: '0.5rem' }}>
                             <textarea value={internalNote} onChange={(_err) => setInternalNote(_err.target.value)} placeholder={lang === 'cz' ? 'Napište poznámku...' : 'Write note...'} style={{ flex: 1, minHeight: '60px', background: 'rgba(245,158,11,0.05)', border: '1px solid rgba(245,158,11,0.2)', borderRadius: '10px', padding: '0.5rem', color: '#f59e0b', fontSize: '0.8rem', resize: 'none' }} />
                             <button onClick={handleSaveNote} style={{ background: '#f59e0b', color: 'black', border: 'none', borderRadius: '8px', padding: '0 0.75rem', fontWeight: '900', fontSize: '0.7rem' }}>ULOŽIT</button>
                           </div>
                         )}
                      </div>
                    )}

                    <div style={{ padding: '0.75rem 1rem', display: 'flex', gap: '0.75rem' }}>
                       <input 
                         data-testid="chat-message-input"
                         type="text" 
                         value={messageValue}
                         onChange={(_err) => setMessageValue(_err.target.value)}
                         onKeyDown={(_err) => { if (_err.key === 'Enter' && messageValue.trim()) sendMessage(messageValue); }}
                         placeholder={lang === 'cz' ? 'Napište zprávu...' : 'Type a message...'} 
                         style={{ flex: 1, background: 'rgba(255,255,255,0.05)', border: '1px solid var(--card-border)', padding: '0.85rem 1rem', borderRadius: '12px', color: 'white', fontSize: '0.9rem' }} 
                       />
                       <button 
                         data-testid="chat-send-button"
                         onClick={() => { if (messageValue.trim()) sendMessage(messageValue); }}
                         style={{ background: 'var(--accent-color)', color: 'white', border: 'none', padding: '0 1.2rem', borderRadius: '12px', fontWeight: '900', fontSize: '0.8rem' }}
                       >
                         POSLAT
                       </button>
                    </div>
                </div>
            ) : (
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '2rem', textAlign: 'center' }}>
                <div>
                  <MessageSquare size={64} style={{ opacity: 0.2, marginBottom: '1.5rem' }} />
                  <h3 style={{ color: 'var(--text-secondary)' }}>Select a conversation</h3>
                </div>
              </div>
            )}
          </div>

          {/* Column 3: Notes / Details (Right Sidebar) */}
          {(!isMobile || mobileView === 'details') && (
            <div className="notes-panel-container" style={{ 
              width: isMobile ? '100%' : '400px', 
              flexShrink: 0, 
              borderLeft: isMobile ? 'none' : '1px solid var(--card-border)', 
              display: 'flex', 
              flexDirection: 'column', 
              background: 'var(--bg-color)', 
              overflow: 'hidden',
              position: isMobile ? 'absolute' : 'static',
              top: 0, right: 0, bottom: 0, zIndex: 1100
            }}>
              
              {isMobile && (
                <div style={{ padding: '1rem', borderBottom: '1px solid var(--card-border)' }}>
                  <button onClick={() => setMobileView('chat')} style={{ background: 'none', border: 'none', color: 'white', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <ChevronLeft size={20} /> {t('backToChat')}
                  </button>
                </div>
              )}

              {selectedChat && (
                <div style={{ display: 'flex', flex: 1, flexDirection: 'column', overflow: 'hidden' }}>
                   
                   {/* TABS SECTION (Top Half) */}
                   <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, borderBottom: '1px solid var(--card-border)' }}>
                     {/* Tab bar */}
                     <div style={{ display: 'flex', borderBottom: '1px solid var(--card-border)', background: 'rgba(255,255,255,0.02)', flexShrink: 0 }}>
                       <button onClick={() => setActiveContextTab('translator')} style={{ flex: 1, padding: '0.6rem 0.25rem', border: 'none', background: 'transparent', color: activeContextTab === 'translator' ? 'var(--accent-color)' : 'var(--text-secondary)', fontWeight: '700', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.4rem', fontSize: '0.7rem' }}>
                         <Languages size={13} /> {lang === 'cz' ? 'Překladač' : 'Translator'}
                       </button>
                       <button onClick={() => setActiveContextTab('note')} style={{ flex: 1, padding: '0.6rem 0.25rem', border: 'none', background: 'transparent', color: activeContextTab === 'note' ? '#f59e0b' : 'var(--text-secondary)', fontWeight: '700', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.4rem', fontSize: '0.7rem' }}>
                         <StickyNote size={13} /> {lang === 'cz' ? 'Poznámky' : 'Notes'}
                       </button>
                       <button onClick={() => setActiveContextTab('quickReplies')} style={{ flex: 1, padding: '0.6rem 0.25rem', border: 'none', background: 'transparent', color: activeContextTab === 'quickReplies' ? '#10b981' : 'var(--text-secondary)', fontWeight: '700', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.4rem', fontSize: '0.7rem' }}>
                         <Zap size={13} /> {lang === 'cz' ? 'Odpovědi' : 'Replies'}
                       </button>
                       <button onClick={() => setActiveContextTab('crm')} style={{ flex: 1, padding: '0.6rem 0.25rem', border: 'none', background: 'transparent', color: activeContextTab === 'crm' ? 'var(--accent-color)' : 'var(--text-secondary)', fontWeight: '700', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.4rem', fontSize: '0.7rem' }}>
                         <UserCheck size={13} /> CRM
                       </button>
                     </div>

                     {/* Tab content */}
                      <div style={{ padding: '1.25rem', flex: 1, minHeight: 0, overflowY: 'auto' }}>
                         {activeContextTab === 'translator' ? (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                              <div style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', fontWeight: '800', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                                {lang === 'cz' ? 'Cílový jazyk' : 'Target Language'}
                              </div>
                              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
                                {['AUTO', 'en', 'cs', 'de', 'fr', 'es'].map(l => (
                                  <button key={l} onClick={() => setTranslateTargetLang(l)} style={{ padding: '0.3rem 0.6rem', borderRadius: '8px', fontSize: '0.65rem', fontWeight: '800', cursor: 'pointer', border: '1px solid', transition: 'all 0.2s ease', background: translateTargetLang === l ? 'var(--accent-color)' : 'rgba(255,255,255,0.05)', borderColor: translateTargetLang === l ? 'var(--accent-color)' : 'var(--card-border)', color: translateTargetLang === l ? 'white' : 'var(--text-secondary)' }}>
                                    {l.toUpperCase()}
                                  </button>
                                ))}
                              </div>
                            </div>
                            <textarea value={sourceText} onChange={(_err) => setSourceText(_err.target.value)} placeholder={t('typeResponse')} style={{ width: '100%', height: '100px', background: 'rgba(0, 0, 0, 0.2)', border: '1px solid var(--card-border)', borderRadius: '12px', padding: '1rem', color: 'white', resize: 'none' }} />
                            <button 
                               onClick={() => hasAiAccess ? handleTranslate() : handleUpgradeAi()} 
                               disabled={isTranslating || isUpgrading} 
                               style={{ background: hasAiAccess ? 'var(--accent-color)' : 'rgba(255,255,255,0.05)', color: hasAiAccess ? 'white' : 'var(--text-secondary)', border: hasAiAccess ? 'none' : '1px solid var(--card-border)', padding: '0.75rem 1rem', borderRadius: '12px', fontWeight: '800', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }}
                             >
                               {isTranslating || isUpgrading ? (
                                 <><div className="loader-dots" style={{ display: 'flex', gap: '4px' }}><span style={{ width: '4px', height: '4px', background: hasAiAccess ? 'white' : 'var(--text-secondary)', borderRadius: '50%' }}></span><span style={{ width: '4px', height: '4px', background: hasAiAccess ? 'white' : 'var(--text-secondary)', borderRadius: '50%' }}></span><span style={{ width: '4px', height: '4px', background: hasAiAccess ? 'white' : 'var(--text-secondary)', borderRadius: '50%' }}></span></div>{isTranslating ? t('translating') : (lang === 'cz' ? 'NAČÍTÁM...' : 'LOADING...')}</>
                               ) : (
                                 <>{hasAiAccess ? <Sparkles size={16} /> : <Lock size={16} />} {hasAiAccess ? (lang === 'cz' ? 'PŘELOŽIT PŘES AI' : 'TRANSLATE VIA AI') : (lang === 'cz' ? 'AKTIVUJTE AI PRO PŘEKLAD' : 'ACTIVATE AI TO TRANSLATE')}</>
                               )}
                             </button>
                            {translatedText && (
                              <div className="fade-in" style={{ padding: '1rem', background: 'rgba(59,130,246,0.1)', border: '1px solid rgba(59,130,246,0.2)', borderRadius: '12px', position: 'relative' }}>
                                <div style={{ position: 'absolute', top: '-8px', right: '12px', background: 'var(--accent-color)', color: 'white', fontSize: '0.6rem', fontWeight: '900', padding: '2px 8px', borderRadius: '4px' }}>{t('poweredByAi')}</div>
                                <div style={{ fontSize: '0.9rem', color: 'white', lineHeight: '1.5' }}>{translatedText}</div>
                                <button onClick={() => { setMessageValue(translatedText); setActiveContextTab('note'); }} style={{ marginTop: '0.75rem', width: '100%', background: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.2)', color: 'white', padding: '0.4rem', borderRadius: '8px', fontSize: '0.7rem', fontWeight: '800', cursor: 'pointer' }}>
                                  {lang === 'cz' ? 'POUŽÍT PŘEKLAD' : 'USE TRANSLATION'}
                                </button>
                              </div>
                            )}
                           </div>
                         ) : activeContextTab === 'note' ? (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                            <textarea value={internalNote} onChange={(_err) => setInternalNote(_err.target.value)} placeholder="Add internal note..." style={{ width: '100%', minHeight: '100px', background: 'rgba(245,158,11,0.05)', border: '1px solid rgba(245,158,11,0.2)', borderRadius: '12px', padding: '1rem', color: '#f59e0b' }} />
                            <button onClick={handleSaveNote} disabled={!internalNote.trim()} style={{ alignSelf: 'flex-end', background: 'rgba(245,158,11,0.2)', color: '#f59e0b', border: '1px solid rgba(245,158,11,0.4)', padding: '0.5rem 1rem', borderRadius: '8px', fontWeight: '700' }}>Save Note</button>
                            {(clientNotes[selectedChat?.from] || []).length > 0 && (
                              <div style={{ marginTop: '0.5rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                                <div style={{ fontSize: '0.7rem', fontWeight: '800', color: 'var(--text-secondary)', letterSpacing: '0.05em' }}>SAVED NOTES</div>
                                {(clientNotes[selectedChat.from] || []).slice().reverse().map(note => (
                                  <div key={note.id} style={{ background: 'rgba(245,158,11,0.05)', border: '1px solid rgba(245,158,11,0.15)', borderRadius: '10px', padding: '0.75rem', position: 'relative' }}>
                                    <button onClick={() => handleDeleteNote(selectedChat.from, note.id)} style={{ position: 'absolute', top: '6px', right: '8px', background: 'none', border: 'none', color: 'rgba(245,158,11,0.5)', cursor: 'pointer', fontSize: '1rem', lineHeight: 1, padding: '2px 4px' }}>×</button>
                                    <div style={{ fontSize: '0.85rem', color: '#f59e0b', lineHeight: '1.5', paddingRight: '1.5rem' }}>{note.text}</div>
                                    <div style={{ fontSize: '0.65rem', color: 'var(--text-secondary)', marginTop: '0.4rem' }}>{note.author} · {note.timestamp}</div>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        ) : activeContextTab === 'quickReplies' ? (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                            {(activeProfile?.quickReplies || []).length === 0 ? (
                              <div style={{ textAlign: 'center', padding: '2rem 1rem', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                                <Zap size={32} style={{ opacity: 0.2, marginBottom: '0.75rem', display: 'block', margin: '0 auto 0.75rem' }} />
                                {lang === 'cz' ? 'Žádné rychlé odpovědi. Přidej je v nastavení profilu.' : 'No quick replies yet. Add them in Profile Settings.'}
                              </div>
                            ) : (
                              (activeProfile.quickReplies || []).map(reply => (
                                <button key={reply.id} onClick={() => setMessageValue(reply.text)} style={{ textAlign: 'left', background: 'rgba(16,185,129,0.05)', border: '1px solid rgba(16,185,129,0.2)', borderRadius: '10px', padding: '0.75rem 1rem', cursor: 'pointer' }}>
                                  <div style={{ fontSize: '0.75rem', fontWeight: '800', color: '#10b981', marginBottom: '0.2rem' }}>{reply.label}</div>
                                  <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{reply.text}</div>
                                </button>
                              ))
                            )}
                          </div>
                        ) : activeContextTab === 'crm' ? (
                          <div className="fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                            {isCrmLoading ? (
                              <div style={{ display: 'flex', justifyContent: 'center', padding: '2rem' }}>
                                <Loader2 className="animate-spin" size={24} color="var(--accent-color)" />
                              </div>
                            ) : clientCrmData ? (
                              <>
                                <div style={{ background: 'rgba(59, 130, 246, 0.05)', border: '1px solid rgba(59, 130, 246, 0.1)', borderRadius: '14px', padding: '1rem' }}>
                                  <div style={{ fontSize: '0.65rem', fontWeight: '800', color: 'var(--text-secondary)', marginBottom: '0.5rem', textTransform: 'uppercase' }}>Financial Worth</div>
                                  <div style={{ fontSize: '1.5rem', fontWeight: '900', color: 'white' }}>{Number(clientCrmData.totalSpent).toLocaleString()} CZK</div>
                                  <div style={{ fontSize: '0.75rem', color: 'var(--success-color)', marginTop: '0.2rem', fontWeight: '700' }}>{clientCrmData._count?.bookings || 0} Successful meetings</div>
                                </div>
                                
                                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                                  {(JSON.parse(clientCrmData.tags || '[]')).map((tag, i) => (
                                    <span key={i} style={{ background: tag === 'VIP' ? 'rgba(251, 191, 36, 0.15)' : 'rgba(255,255,255,0.05)', color: tag === 'VIP' ? '#fbbf24' : 'var(--text-secondary)', fontSize: '0.65rem', fontWeight: '900', padding: '4px 10px', borderRadius: '6px', border: '1px solid rgba(255,255,255,0.05)' }}>
                                      {tag}
                                    </span>
                                  ))}
                                  {(JSON.parse(clientCrmData.tags || '[]')).length === 0 && (
                                    <span style={{ color: 'var(--text-secondary)', fontSize: '0.75rem', fontStyle: 'italic' }}>No tags assigned</span>
                                  )}
                                </div>

                                <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid var(--card-border)', borderRadius: '12px', padding: '1rem' }}>
                                  <div style={{ fontSize: '0.7rem', fontWeight: '800', color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>LAST VISIT</div>
                                  <div style={{ color: 'white', fontWeight: '700' }}>{clientCrmData.lastVisit ? new Date(clientCrmData.lastVisit).toLocaleDateString() : 'Never'}</div>
                                </div>

                                <button onClick={() => setActiveTab('crm')} style={{ marginTop: '0.5rem', background: 'transparent', border: '1px solid var(--card-border)', color: 'white', padding: '0.75rem', borderRadius: '12px', fontSize: '0.75rem', fontWeight: '750', cursor: 'pointer' }}>
                                  OPEN FULL CLIENT CARD
                                </button>
                              </>
                            ) : (
                              <div style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: '2rem' }}>
                                 No CRM record found for this number yet.
                              </div>
                            )}
                          </div>
                        ) : null}
                     </div>
                   </div>

                   {/* CALENDAR SECTION (Bottom Half) - FIXED POSITION */}
                   <div style={{ height: '380px', display: 'flex', flexDirection: 'column', flexShrink: 0, background: 'rgba(0,0,0,0.05)' }}>
                     <div style={{ padding: '0.6rem 1rem', background: 'rgba(255,255,255,0.02)', borderBottom: '1px solid var(--card-border)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <Calendar size={14} color="var(--accent-color)" />
                        <span style={{ fontSize: '0.7rem', fontWeight: '900', color: 'white', letterSpacing: '0.05em', textTransform: 'uppercase' }}>
                          {t('schedule')}
                        </span>
                     </div>
                    {(() => {
                      const calDateStr = calViewDate.toISOString().split('T')[0];
                      const bookingsForDate = (bookingSchedule || []).filter(b => b.startTime?.startsWith(calDateStr));
                      const isToday = calDateStr === new Date().toISOString().split('T')[0];
                      const dayName = calViewDate.toLocaleDateString(lang === 'cz' ? 'cs-CZ' : 'en-GB', { weekday: 'long' });
                      const dayDate = calViewDate.toLocaleDateString(lang === 'cz' ? 'cs-CZ' : 'en-GB', { day: 'numeric', month: 'long' });
                      return (
                        <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.5rem 0.75rem', background: 'rgba(99,102,241,0.05)', borderTop: '1px solid var(--card-border)', borderBottom: '1px solid var(--card-border)', flexShrink: 0 }}>
                            <button onClick={() => { const d = new Date(calViewDate); d.setDate(d.getDate()-1); setCalViewDate(d); }} style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid var(--card-border)', color: 'var(--text-secondary)', cursor: 'pointer', padding: '0.25rem 0.5rem', borderRadius: '6px', display: 'flex', alignItems: 'center' }}><ChevronLeft size={13} /></button>
                            <div style={{ textAlign: 'center' }}>
                              <div style={{ fontSize: '0.62rem', fontWeight: '700', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{isToday ? (lang === 'cz' ? 'DNES' : 'TODAY') : dayName}</div>
                              <div style={{ fontSize: '0.8rem', fontWeight: '900', color: isToday ? 'var(--accent-color)' : 'white', lineHeight: 1.2 }}>{dayDate}</div>
                            </div>
                            <div style={{ display: 'flex', gap: '0.3rem', alignItems: 'center' }}>
                              {!isToday && <button onClick={() => setCalViewDate(new Date())} style={{ background: 'rgba(99,102,241,0.15)', border: '1px solid rgba(99,102,241,0.3)', borderRadius: '5px', color: '#a5b4fc', fontSize: '0.58rem', fontWeight: '800', cursor: 'pointer', padding: '0.2rem 0.45rem' }}>{lang === 'cz' ? 'Dnes' : 'Today'}</button>}
                              <button onClick={() => { const d = new Date(calViewDate); d.setDate(d.getDate()+1); setCalViewDate(d); }} style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid var(--card-border)', color: 'var(--text-secondary)', cursor: 'pointer', padding: '0.25rem 0.5rem', borderRadius: '6px', display: 'flex', alignItems: 'center' }}><ChevronRight size={13} /></button>
                            </div>
                          </div>
                          <div style={{ flex: 1, overflowY: 'auto', padding: '0.5rem 0.75rem', display: 'flex', flexDirection: 'column', gap: '0.35rem' }}>
                            {bookingsForDate.length === 0 ? (
                              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: '0.5rem', color: 'var(--text-secondary)' }}>
                                <Calendar size={24} style={{ opacity: 0.25 }} />
                                <span style={{ fontSize: '0.72rem', fontStyle: 'italic' }}>{lang === 'cz' ? 'Žádné schůzky' : 'No bookings'}</span>
                              </div>
                            ) : bookingsForDate.map(b => {
                              const timeStr = b.startTime ? new Date(b.startTime).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Prague' }) : (b.time || '');
                              const endStr = b.endTime ? new Date(b.endTime).toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Prague' }) : '';
                              return (
                                <div key={b.id} style={{ display: 'flex', gap: '0.6rem', padding: '0.5rem 0.65rem', background: 'rgba(99,102,241,0.07)', border: '1px solid rgba(99,102,241,0.2)', borderRadius: '8px', borderLeft: '3px solid var(--accent-color)', alignItems: 'flex-start' }}>
                                  <div style={{ flexShrink: 0, textAlign: 'right', minWidth: '42px' }}>
                                    <div style={{ fontSize: '0.67rem', fontWeight: '900', color: 'var(--accent-color)', lineHeight: 1.3 }}>{timeStr}</div>
                                    {endStr && <div style={{ fontSize: '0.57rem', color: 'var(--text-secondary)', lineHeight: 1 }}>{endStr}</div>}
                                  </div>
                                  <div style={{ flex: 1, minWidth: 0 }}>
                                    <div style={{ fontSize: '0.75rem', fontWeight: '800', color: 'white', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.title}</div>
                                    {b.profileName && <div style={{ fontSize: '0.62rem', color: 'var(--text-secondary)', marginTop: '0.1rem' }}>{b.profileName}</div>}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })()}
                    <div style={{ padding: '0.75rem', borderTop: '1px solid var(--card-border)', background: 'var(--card-bg)', flexShrink: 0 }}>
                      <button
                        onClick={() => { const d = calViewDate.toISOString().split('T')[0]; setNewBookingForm(f => ({ ...f, date: d })); setIsBookingModalOpen(true); }}
                        style={{ width: '100%', padding: '0.85rem', borderRadius: '12px', background: 'var(--accent-color)', border: 'none', color: 'white', fontSize: '0.85rem', fontWeight: '800', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }}
                      >
                        <PlusCircle size={16} /> {lang === 'cz' ? 'Přidat schůzku' : 'Add booking'}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default InboxView;
