import { useState, useCallback, useEffect, useRef } from 'react';
import AuthPage       from './components/AuthPage.jsx';
import SetupWizard    from './components/SetupWizard.jsx';
import NavBar         from './components/NavBar.jsx';
import Sidebar        from './components/Sidebar.jsx';
import ChatWindow     from './components/ChatWindow.jsx';
import EmptyState     from './components/EmptyState.jsx';
import OrdersPanel    from './components/OrdersPanel.jsx';
import CatalogoPanel  from './components/CatalogoPanel.jsx';
import DashboardPanel     from './components/DashboardPanel.jsx';
import ReengagementPanel from './components/ReengagementPanel.jsx';
import ClientesPanel    from './components/ClientesPanel.jsx';
import SettingsPanel     from './components/SettingsPanel.jsx';
import AssistantPanel   from './components/AssistantPanel.jsx';
import { useSocket }  from './hooks/useSocket.js';
import { conversationsAPI, authAPI, ordersAPI, api } from './utils/api.js';
import { DARK, LIGHT, ThemeCtx } from './theme.js';

export default function App() {
  const [appState, setAppState] = useState('loading');
  const [user, setUser]         = useState(null);
  const [org, setOrg]           = useState(null);
  const [view, setView]         = useState('dashboard');

  // Responsive
  const [isMobile, setIsMobile] = useState(() => window.innerWidth <= 768);
  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth <= 768);
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);

  // Theme
  const [theme, setTheme] = useState(() => localStorage.getItem('crm_theme') || 'dark');
  const colors = theme === 'dark' ? DARK : LIGHT;
  const toggleTheme = () => {
    const n = theme === 'dark' ? 'light' : 'dark';
    setTheme(n);
    localStorage.setItem('crm_theme', n);
  };

  // CRM state
  const [conversations, setConversations] = useState([]);
  const [selectedId, setSelectedId]       = useState(null);
  const [messages, setMessages]           = useState({});
  const [loadingConvs, setLoadingConvs]   = useState(false);
  const [pendingOrders, setPendingOrders] = useState(0);
  const [botTypingConvs, setBotTypingConvs] = useState(new Set());
  const [reengagementPhone, setReengagementPhone] = useState(null);

  // Deduplicar mensajes entre optimistic update y socket event
  const seenMessageIds = useRef(new Set());

  // ── Verificar sesión al inicio ──────────────────────────────────
  useEffect(() => {
    const token = localStorage.getItem('crm_token');
    if (!token) { setAppState('auth'); return; }
    authAPI.me()
      .then(data => {
        setUser(data.user);
        setOrg(data.organization);
        setAppState(data.organization.setup_done ? 'crm' : 'setup');
      })
      .catch(() => { localStorage.removeItem('crm_token'); setAppState('auth'); });
  }, []);

  const handleAuth = useCallback((data) => {
    setUser(data.user);
    setOrg(data.organization);
    setAppState(data.organization.setup_done ? 'crm' : 'setup');
  }, []);

  const handleSetupComplete = useCallback(() => {
    setOrg(o => ({ ...o, setup_done: 1 }));
    setAppState('crm');
  }, []);

  // ── Retorno de Kapso (reconexión desde Settings) ───────────────
  useEffect(() => {
    if (appState !== 'crm') return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('kapso_success') === '1') {
      const phoneNumberId      = params.get('phone_number_id');
      const displayPhoneNumber = params.get('display_phone_number');
      const businessAccountId  = params.get('business_account_id');
      window.history.replaceState({}, '', window.location.pathname);
      if (phoneNumberId) {
        api.post('/setup/kapso/save', { phoneNumberId, displayPhoneNumber, businessAccountId })
          .then(() => setView('settings'))
          .catch(console.error);
      }
    }
    if (params.get('kapso_error') === '1') {
      window.history.replaceState({}, '', window.location.pathname);
      setView('settings');
    }
  }, [appState]);

  // ── Cargar conversaciones ───────────────────────────────────────
  const loadConversations = useCallback(async () => {
    if (appState !== 'crm') return;
    setLoadingConvs(true);
    try {
      const data = await conversationsAPI.getAll();
      setConversations(data);
    } catch (err) { console.error(err); }
    finally { setLoadingConvs(false); }
  }, [appState]);

  const loadOrderStats = useCallback(async () => {
    try {
      const stats = await ordersAPI.getStats();
      setPendingOrders(stats.pending || 0);
    } catch { /* silencioso */ }
  }, []);

  useEffect(() => {
    if (appState === 'crm') {
      loadConversations();
      loadOrderStats();
    }
  }, [appState]);

  // ── Socket.io ───────────────────────────────────────────────────
  const handleNewMessage = useCallback(({ message, conversation }) => {
    setConversations(prev => {
      const exists = prev.find(c => c.id === conversation.id);
      const updated = exists
        ? prev.map(c => c.id === conversation.id ? conversation : c)
        : [conversation, ...prev];
      return updated.sort((a, b) => new Date(b.last_message_at) - new Date(a.last_message_at));
    });
    if (message) {
      if (seenMessageIds.current.has(message.id)) {
        seenMessageIds.current.delete(message.id);
        return;
      }
      seenMessageIds.current.add(message.id);
      setMessages(prev => {
        const existing = prev[conversation.id] || [];
        if (existing.some(m => m.id === message.id)) return prev;
        return { ...prev, [conversation.id]: [...existing, message] };
      });
    }
  }, []);

  const handleAgentModeChanged = useCallback(({ conversationId, mode }) => {
    setConversations(prev => prev.map(c => c.id === conversationId ? { ...c, agent_mode: mode } : c));
  }, []);

  const handleMessageStatus = useCallback(({ messageId, status }) => {
    setMessages(prev => {
      const updated = {};
      for (const [id, msgs] of Object.entries(prev)) {
        updated[id] = msgs.map(m => m.whatsapp_message_id === messageId ? { ...m, status } : m);
      }
      return updated;
    });
  }, []);

  const handleOrderCreated = useCallback(() => {
    setPendingOrders(n => n + 1);
  }, []);

  const handleBotTyping = useCallback(({ conversationId, typing }) => {
    setBotTypingConvs(prev => {
      const n = new Set(prev);
      typing ? n.add(conversationId) : n.delete(conversationId);
      return n;
    });
  }, []);

  const { connected } = useSocket(org?.id, handleNewMessage, handleAgentModeChanged, handleMessageStatus, handleOrderCreated, handleBotTyping);

  // En móvil, volver al sidebar limpiando la selección
  const handleBackToSidebar = useCallback(() => setSelectedId(null), []);

  // ── Seleccionar conversación ────────────────────────────────────
  const handleSelectConversation = useCallback(async (id) => {
    setView('chats');
    setSelectedId(id);
    if (!messages[id]) {
      try {
        const { messages: msgs } = await conversationsAPI.getMessages(id);
        setMessages(prev => ({ ...prev, [id]: msgs }));
        setConversations(prev => prev.map(c => c.id === id ? { ...c, unread_count: 0 } : c));
      } catch (err) { console.error(err); }
    } else {
      conversationsAPI.markAsRead(id).catch(() => {});
      setConversations(prev => prev.map(c => c.id === id ? { ...c, unread_count: 0 } : c));
    }
  }, [messages]);

  const handleSendMessage = useCallback(async (convId, text) => {
    const msg = await conversationsAPI.sendMessage(convId, text);
    seenMessageIds.current.add(msg.id);
    setMessages(prev => {
      const existing = prev[convId] || [];
      if (existing.some(m => m.id === msg.id)) return prev;
      return { ...prev, [convId]: [...existing, msg] };
    });
    setConversations(prev =>
      prev.map(c => c.id === convId ? { ...c, last_message: text, last_message_at: new Date().toISOString() } : c)
        .sort((a, b) => new Date(b.last_message_at) - new Date(a.last_message_at))
    );
  }, []);

  const handleToggleAgentMode = useCallback(async (convId, currentMode) => {
    const newMode = currentMode === 'ai' ? 'human' : 'ai';
    await conversationsAPI.setAgentMode(convId, newMode);
    setConversations(prev => prev.map(c => c.id === convId ? { ...c, agent_mode: newMode } : c));
  }, []);

  const handleLogout = useCallback(() => {
    localStorage.clear();
    setAppState('auth');
    setUser(null); setOrg(null);
    setConversations([]); setMessages({}); setSelectedId(null);
  }, []);

  // ── Cambiar vista ───────────────────────────────────────────────
  const handleChangeView = useCallback((newView) => {
    setView(newView);
    // Si vamos a chats y no hay conv seleccionada, limpiar selección no hace falta
  }, []);

  // ── Render ──────────────────────────────────────────────────────
  if (appState === 'loading') return (
    <ThemeCtx.Provider value={{ colors, isDark: theme === 'dark', toggle: toggleTheme }}>
      <div style={{
        height: '100vh', width: '100vw',
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        backgroundColor: colors.bgApp, gap: '28px',
      }}>
        {/* Logo / ícono */}
        <div style={{
          width: '64px', height: '64px', borderRadius: '18px',
          backgroundColor: `${colors.green}18`,
          border: `1.5px solid ${colors.green}44`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
            <path d="M16 2C8.268 2 2 8.268 2 16c0 2.4.625 4.656 1.72 6.613L2 30l7.613-1.72A13.94 13.94 0 0016 30c7.732 0 14-6.268 14-14S23.732 2 16 2z" fill={colors.green} opacity="0.15"/>
            <path d="M16 3.5C9.096 3.5 3.5 9.096 3.5 16c0 2.22.574 4.307 1.584 6.12L3.5 28.5l6.38-1.584A12.44 12.44 0 0016 28.5c6.904 0 12.5-5.596 12.5-12.5S22.904 3.5 16 3.5z" stroke={colors.green} strokeWidth="1.5" fill="none"/>
            <path d="M11 13.5c0-.828.672-1.5 1.5-1.5h7c.828 0 1.5.672 1.5 1.5v.5H11v-.5zM11 16.5h10M11 19.5h7" stroke={colors.green} strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        </div>

        {/* Nombre */}
        <div style={{ textAlign: 'center', lineHeight: 1.4 }}>
          <div style={{ color: colors.textPrimary, fontSize: '20px', fontWeight: 700, letterSpacing: '-0.3px' }}>
            WhatsApp CRM
          </div>
          <div style={{ color: colors.textMuted, fontSize: '12px', marginTop: '4px' }}>
            Agente IA para tu tienda Shopify
          </div>
        </div>

        {/* Spinner animado */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          {[0, 0.2, 0.4].map((delay, i) => (
            <div key={i} style={{
              width: '7px', height: '7px', borderRadius: '50%',
              backgroundColor: colors.green,
              animation: `loading-pulse 1.2s ease-in-out ${delay}s infinite`,
              opacity: 0.4,
            }} />
          ))}
        </div>

        <style>{`
          @keyframes loading-pulse {
            0%, 80%, 100% { transform: scale(0.7); opacity: 0.3; }
            40% { transform: scale(1); opacity: 1; }
          }
        `}</style>
      </div>
    </ThemeCtx.Provider>
  );

  if (appState === 'auth')  return (
    <ThemeCtx.Provider value={{ colors, isDark: theme === 'dark', toggle: toggleTheme }}>
      <AuthPage onAuth={handleAuth} />
    </ThemeCtx.Provider>
  );
  if (appState === 'setup') return (
    <ThemeCtx.Provider value={{ colors, isDark: theme === 'dark', toggle: toggleTheme }}>
      <SetupWizard org={org} onComplete={handleSetupComplete} />
    </ThemeCtx.Provider>
  );

  const selectedConv = conversations.find(c => c.id === selectedId);
  const selectedMsgs = messages[selectedId] || [];
  const totalUnread  = conversations.reduce((sum, c) => sum + (c.unread_count || 0), 0);

  // En móvil: mostrar sidebar solo si no hay conversación seleccionada
  const showSidebar = !isMobile || (isMobile && !selectedId);
  const showChat    = !isMobile || (isMobile && !!selectedId);

  return (
    <ThemeCtx.Provider value={{ colors, isDark: theme === 'dark', toggle: toggleTheme }}>
    <div style={{
      display: 'flex', height: '100vh', width: '100vw',
      overflow: 'hidden', backgroundColor: colors.bgApp,
      flexDirection: isMobile ? 'column' : 'row',
      paddingBottom: isMobile ? '60px' : 0,
      boxSizing: 'border-box',
    }}>

      {/* Barra de navegación (lateral desktop / inferior móvil) */}
      <NavBar
        view={view}
        onChangeView={handleChangeView}
        orgName={org?.name}
        connected={connected}
        onLogout={handleLogout}
        unreadCount={totalUnread}
        pendingOrders={pendingOrders}
        colors={colors}
        isMobile={isMobile}
      />

      {/* Vista Chats */}
      {view === 'chats' && (
        <div style={{ display: 'flex', flex: 1, overflow: 'hidden', height: isMobile ? '100%' : '100vh' }}>
          {showSidebar && (
            <Sidebar
              conversations={conversations}
              selectedId={selectedId}
              onSelect={handleSelectConversation}
              loading={loadingConvs}
              onRefresh={loadConversations}
              isMobile={isMobile}
            />
          )}
          {showChat && (
            selectedConv ? (
              <ChatWindow
                conversation={selectedConv}
                messages={selectedMsgs}
                onSendMessage={handleSendMessage}
                onToggleAgentMode={handleToggleAgentMode}
                botTyping={botTypingConvs.has(selectedId)}
                onEscalationFeedback={async (convId, feedback) => {
                  await conversationsAPI.sendEscalationFeedback(convId, feedback);
                }}
                currentUserEmail={user?.email}
                onBack={handleBackToSidebar}
                isMobile={isMobile}
                onDeleteMessages={async (convId) => {
                  await conversationsAPI.deleteMessages(convId);
                  setMessages(prev => ({ ...prev, [convId]: [] }));
                  const updated = await conversationsAPI.getAll();
                  setConversations(updated);
                }}
              />
            ) : !isMobile ? (
              <EmptyState orgName={org?.name} onChangeView={handleChangeView} />
            ) : null
          )}
        </div>
      )}

      {/* Vista Catálogo */}
      {view === 'catalogo' && <CatalogoPanel />}

      {/* Vista Pedidos */}
      {view === 'orders' && (
        <OrdersPanel
          onSelectConversation={(id) => { handleSelectConversation(id); setView('chats'); }}
          onOrderPaid={() => setPendingOrders(n => Math.max(0, n - 1))}
        />
      )}

      {/* Vista Clientes */}
      {view === 'clientes' && (
        <ClientesPanel
          onOpenConversation={(id) => { handleSelectConversation(id); setView('chats'); }}
          onOpenReengagement={(phone) => { setReengagementPhone(phone); setView('reengagement'); }}
        />
      )}

      {/* Vista Re-enganche */}
      {view === 'reengagement' && (
        <ReengagementPanel
          filterPhone={reengagementPhone}
          onClearFilter={() => setReengagementPhone(null)}
          testPhone={org?.display_phone_number}
        />
      )}

      {/* Vista Dashboard */}
      {view === 'dashboard' && <DashboardPanel onChangeView={setView} />}

      {/* Vista Ajustes */}
      {view === 'settings' && <SettingsPanel />}

      {/* Vista Asistente IA */}
      {view === 'asistente' && (
        <AssistantPanel
          org={org}
          onSetupComplete={handleSetupComplete}
        />
      )}
    </div>
    </ThemeCtx.Provider>
  );
}
