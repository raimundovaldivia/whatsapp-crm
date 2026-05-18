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
import { useSocket }  from './hooks/useSocket.js';
import { conversationsAPI, authAPI, ordersAPI } from './utils/api.js';

export default function App() {
  const [appState, setAppState] = useState('loading');
  const [user, setUser]         = useState(null);
  const [org, setOrg]           = useState(null);
  const [view, setView]         = useState('chats'); // 'chats'|'catalogo'|'orders'|'dashboard'|'settings'

  // CRM state
  const [conversations, setConversations] = useState([]);
  const [selectedId, setSelectedId]       = useState(null);
  const [messages, setMessages]           = useState({});
  const [loadingConvs, setLoadingConvs]   = useState(false);
  const [pendingOrders, setPendingOrders] = useState(0);

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

  const { connected } = useSocket(org?.id, handleNewMessage, handleAgentModeChanged, handleMessageStatus, handleOrderCreated);

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
    <div style={{ height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: '#111b21' }}>
      <div style={{ color: '#00a884', fontSize: '14px' }}>Cargando...</div>
    </div>
  );

  if (appState === 'auth')  return <AuthPage onAuth={handleAuth} />;
  if (appState === 'setup') return <SetupWizard org={org} onComplete={handleSetupComplete} />;

  const selectedConv = conversations.find(c => c.id === selectedId);
  const selectedMsgs = messages[selectedId] || [];
  const totalUnread  = conversations.reduce((sum, c) => sum + (c.unread_count || 0), 0);

  return (
    <div style={{ display: 'flex', height: '100vh', width: '100vw', overflow: 'hidden' }}>

      {/* Barra de navegación vertical */}
      <NavBar
        view={view}
        onChangeView={handleChangeView}
        orgName={org?.name}
        connected={connected}
        onLogout={handleLogout}
        unreadCount={totalUnread}
        pendingOrders={pendingOrders}
      />

      {/* Vista Chats: sidebar de conversaciones + chat */}
      {view === 'chats' && (
        <>
          <Sidebar
            conversations={conversations}
            selectedId={selectedId}
            onSelect={handleSelectConversation}
            loading={loadingConvs}
            onRefresh={loadConversations}
          />
          {selectedConv ? (
            <ChatWindow
              conversation={selectedConv}
              messages={selectedMsgs}
              onSendMessage={handleSendMessage}
              onToggleAgentMode={handleToggleAgentMode}
            />
          ) : (
            <EmptyState orgName={org?.name} />
          )}
        </>
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
        <ClientesPanel onOpenConversation={(id) => { handleSelectConversation(id); setView('chats'); }} />
      )}

      {/* Vista Re-enganche */}
      {view === 'reengagement' && <ReengagementPanel />}

      {/* Vista Dashboard */}
      {view === 'dashboard' && <DashboardPanel />}

      {/* Vista Ajustes */}
      {view === 'settings' && <SettingsPanel />}
    </div>
  );
}
