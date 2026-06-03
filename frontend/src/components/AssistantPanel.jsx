/**
 * AssistantPanel — Asistente IA del CRM
 *
 * Modo onboarding: guía la configuración completa por chat
 * Modo asistente:  responde preguntas, actualiza config, muestra stats
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { Bot, Send, RotateCcw, Sparkles, ExternalLink, X } from 'lucide-react';
import { assistantAPI, setupAPI } from '../utils/api.js';
import { useTheme } from '../theme.js';

const BASE_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001';

// Mensaje de bienvenida según modo
function welcomeMessage(isSetupDone, orgName) {
  if (!isSetupDone) {
    return {
      role: 'assistant',
      content: `¡Hola! 👋 Vamos a dejar tu asistente de ventas listo en unos minutos.\n\n¿Cómo se llama tu tienda?`,
    };
  }
  return {
    role: 'assistant',
    content: `Hola${orgName ? ` de ${orgName}` : ''}! 😊 ¿En qué te ayudo hoy?\n\nPuedo cambiar cómo habla el bot, mostrarte cómo va el negocio, probar respuestas o ayudarte con cualquier configuración.`,
  };
}

export default function AssistantPanel({ org, onSetupComplete, onClose }) {
  const { colors, isDark } = useTheme();
  const isSetupDone = !!(org?.setup_done);

  const [messages,  setMessages]  = useState([]);
  const [input,     setInput]     = useState('');
  const [loading,   setLoading]   = useState(false);
  const [histLoaded, setHistLoaded] = useState(false);
  const chatRef = useRef(null);
  const inputRef = useRef(null);

  // Cargar historial guardado o mostrar bienvenida
  useEffect(() => {
    assistantAPI.getHistory()
      .then(({ history }) => {
        if (history?.length > 0) {
          setMessages(history);
        } else {
          setMessages([welcomeMessage(isSetupDone, org?.name)]);
        }
        setHistLoaded(true);
      })
      .catch(() => {
        setMessages([welcomeMessage(isSetupDone, org?.name)]);
        setHistLoaded(true);
      });
  }, []);

  // Scroll al fondo cuando llegan mensajes
  useEffect(() => {
    if (chatRef.current) {
      chatRef.current.scrollTop = chatRef.current.scrollHeight;
    }
  }, [messages, loading]);

  const handleOAuth = useCallback((service) => {
    const token = localStorage.getItem('crm_token');
    if (service === 'shopify') {
      // Mostrar input de nombre de tienda inline
      setMessages(prev => [...prev, {
        role: 'action',
        actionType: 'shopify_input',
      }]);
    } else if (service === 'whatsapp') {
      const kapsoUrl = `${BASE_URL}/api/setup/kapso/connect?token=${token}`;
      window.location.href = kapsoUrl;
    }
  }, []);

  const connectShopify = useCallback(async (shopName) => {
    if (!shopName.trim()) return;
    try {
      const shop = shopName.trim().replace(/^https?:\/\//, '').replace(/\.myshopify\.com.*/, '').replace(/\/$/, '');
      const { url } = await setupAPI.getShopifyAuthUrl(shop);
      window.location.href = url;
    } catch (err) {
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: `⚠️ No pude generar el link de Shopify: ${err.response?.data?.error || err.message}`,
      }]);
    }
  }, []);

  const sendMessage = useCallback(async (text) => {
    const msg = (text || input).trim();
    if (!msg || loading) return;

    const userMsg   = { role: 'user', content: msg };
    const history   = messages.filter(m => m.role === 'user' || m.role === 'assistant');
    const newMsgs   = [...messages, userMsg];
    setMessages(newMsgs);
    setInput('');
    setLoading(true);

    try {
      const res = await assistantAPI.chat({ message: msg, history });

      const botMsg = { role: 'assistant', content: res.response };
      setMessages(prev => [...prev, botMsg]);

      // Manejar acciones del backend
      if (res.clientAction) {
        const { type, service } = res.clientAction;

        if (type === 'oauth') {
          setTimeout(() => handleOAuth(service), 300);
        }

        if (type === 'setup_complete') {
          setTimeout(() => {
            setMessages(prev => [...prev, {
              role: 'assistant',
              content: `🎉 ¡Todo listo! Tu asistente de ventas está activo. Ahora puedes verlo en acción en la sección de Chats.`,
            }]);
            if (onSetupComplete) onSetupComplete();
          }, 800);
        }
      }
    } catch (err) {
      const noInternet = !err.response;
      const errContent = noInternet
        ? '📶 Sin conexión a internet. Revisa tu señal y vuelve a intentarlo.'
        : `⚠️ ${err.response?.data?.error || 'Algo salió mal, intenta de nuevo.'}`;
      setMessages(prev => [...prev, { role: 'assistant', content: errContent }]);
    } finally {
      setLoading(false);
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [input, loading, messages, handleOAuth, onSetupComplete]);

  const reset = async () => {
    await assistantAPI.clearHistory();
    setMessages([welcomeMessage(isSetupDone, org?.name)]);
    setInput('');
  };

  // ── Estilos ──────────────────────────────────────────────────────

  const userBubble = {
    maxWidth: '80%', padding: '10px 14px',
    borderRadius: '16px 16px 2px 16px',
    backgroundColor: colors.green, color: '#fff',
    fontSize: '14px', lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
    alignSelf: 'flex-end',
  };

  const botBubble = {
    maxWidth: '85%', padding: '10px 14px',
    borderRadius: '16px 16px 16px 2px',
    backgroundColor: isDark ? colors.bgPanel : '#f0f0f0',
    color: colors.textPrimary,
    fontSize: '14px', lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
    border: `1px solid ${colors.border}`,
    alignSelf: 'flex-start',
  };

  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column',
      height: '100vh', backgroundColor: colors.bgApp, overflow: 'hidden',
    }}>

      {/* Header */}
      <div style={{
        padding: '16px 24px', borderBottom: `1px solid ${colors.border}`,
        backgroundColor: colors.bgPanel,
        display: 'flex', alignItems: 'center', gap: '12px',
      }}>
        <div style={{
          width: '38px', height: '38px', borderRadius: '50%',
          backgroundColor: `${colors.green}20`,
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
        }}>
          <Sparkles size={18} color={colors.green} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: '15px', fontWeight: 700, color: colors.textPrimary }}>
            {isSetupDone ? 'Asistente IA' : 'Configuración guiada'}
          </div>
          <div style={{ fontSize: '11px', color: colors.textMuted }}>
            {isSetupDone
              ? 'Pregúntame cualquier cosa sobre tu CRM'
              : 'Te ayudo a configurar todo en minutos'}
          </div>
        </div>
        <button onClick={reset} title="Nueva conversación"
          style={{ background: 'none', border: 'none', cursor: 'pointer',
            color: colors.textMuted, padding: '6px', borderRadius: '8px' }}>
          <RotateCcw size={15} />
        </button>
        {onClose && (
          <button onClick={onClose} title="Cerrar"
            style={{ background: 'none', border: 'none', cursor: 'pointer',
              color: colors.textMuted, padding: '6px', borderRadius: '8px' }}>
            <X size={16} />
          </button>
        )}
      </div>

      {/* Mensajes */}
      <div ref={chatRef} style={{
        flex: 1, overflowY: 'auto', padding: '20px 24px',
        display: 'flex', flexDirection: 'column', gap: '12px',
      }}>
        {!histLoaded && (
          <div style={{ textAlign: 'center', color: colors.textMuted, fontSize: '13px', marginTop: '40px' }}>
            Cargando...
          </div>
        )}

        {messages.map((msg, i) => {
          if (msg.role === 'user') {
            return (
              <div key={i} style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <div style={userBubble}>{msg.content}</div>
              </div>
            );
          }

          if (msg.role === 'action' && msg.actionType === 'shopify_input') {
            return <ShopifyInputCard key={i} colors={colors} isDark={isDark} onConnect={connectShopify} />;
          }

          // Mensaje del asistente
          return (
            <div key={i} style={{ display: 'flex', alignItems: 'flex-end', gap: '8px' }}>
              <div style={{
                width: '28px', height: '28px', borderRadius: '50%', flexShrink: 0,
                backgroundColor: `${colors.green}20`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <Bot size={13} color={colors.green} />
              </div>
              <div style={botBubble}>{msg.content}</div>
            </div>
          );
        })}

        {/* Typing indicator */}
        {loading && (
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: '8px' }}>
            <div style={{
              width: '28px', height: '28px', borderRadius: '50%', flexShrink: 0,
              backgroundColor: `${colors.green}20`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <Bot size={13} color={colors.green} />
            </div>
            <div style={{ ...botBubble, display: 'flex', gap: '5px', alignItems: 'center', padding: '12px 16px' }}>
              {[0, 0.3, 0.6].map((d, i) => (
                <span key={i} style={{
                  width: '6px', height: '6px', borderRadius: '50%',
                  backgroundColor: colors.textMuted, display: 'inline-block',
                  animation: `typing-dot 1.2s ease-in-out ${d}s infinite`,
                }} />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Input */}
      <div style={{
        padding: '16px 24px', borderTop: `1px solid ${colors.border}`,
        backgroundColor: colors.bgPanel,
        display: 'flex', gap: '10px', alignItems: 'flex-end',
      }}>
        <textarea
          ref={inputRef}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
          }}
          placeholder="Escribe un mensaje..."
          disabled={loading}
          rows={1}
          style={{
            flex: 1, resize: 'none', padding: '10px 14px',
            backgroundColor: colors.bgApp, border: `1px solid ${colors.borderStrong}`,
            borderRadius: '12px', color: colors.textPrimary, fontSize: '14px',
            outline: 'none', fontFamily: 'inherit', lineHeight: 1.4,
            maxHeight: '100px', overflowY: 'auto',
            opacity: loading ? 0.6 : 1,
          }}
        />
        <button
          onClick={() => sendMessage()}
          disabled={loading || !input.trim()}
          style={{
            width: '40px', height: '40px', borderRadius: '50%', flexShrink: 0,
            backgroundColor: (!input.trim() || loading) ? colors.borderStrong : colors.green,
            border: 'none', cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            transition: 'background-color 0.15s',
          }}
        >
          <Send size={15} color="white" />
        </button>
      </div>

      <style>{`
        @keyframes typing-dot {
          0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
          30% { transform: translateY(-4px); opacity: 1; }
        }
      `}</style>
    </div>
  );
}

// ── Tarjeta inline para conectar Shopify ─────────────────────────

function ShopifyInputCard({ colors, isDark, onConnect }) {
  const [shop, setShop] = useState('');

  return (
    <div style={{
      backgroundColor: isDark ? colors.bgPanel : '#f8f8f8',
      border: `1.5px solid ${colors.green}44`,
      borderRadius: '14px', padding: '16px',
      display: 'flex', flexDirection: 'column', gap: '12px',
      maxWidth: '340px',
    }}>
      <div style={{ fontSize: '13px', fontWeight: 600, color: colors.textPrimary }}>
        🛍️ Conectar Shopify
      </div>
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
        <input
          value={shop}
          onChange={e => setShop(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && onConnect(shop)}
          placeholder="mi-tienda"
          autoFocus
          style={{
            flex: 1, padding: '8px 12px', borderRadius: '8px',
            backgroundColor: colors.bgApp, border: `1px solid ${colors.borderStrong}`,
            color: colors.textPrimary, fontSize: '13px', outline: 'none',
          }}
        />
        <span style={{ fontSize: '12px', color: colors.textMuted, whiteSpace: 'nowrap' }}>
          .myshopify.com
        </span>
      </div>
      <button
        onClick={() => onConnect(shop)}
        disabled={!shop.trim()}
        style={{
          padding: '9px 16px', borderRadius: '9px', border: 'none',
          backgroundColor: shop.trim() ? colors.green : colors.borderStrong,
          color: 'white', fontSize: '13px', fontWeight: 600,
          cursor: shop.trim() ? 'pointer' : 'not-allowed',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
        }}
      >
        <ExternalLink size={13} /> Ir a Shopify para autorizar
      </button>
    </div>
  );
}
