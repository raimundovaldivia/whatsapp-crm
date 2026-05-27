import { useState, useRef, useEffect } from 'react';
import { Bot, User, Send, Play, ThumbsUp, ThumbsDown, Trash2, FileText, X, Loader, AlertCircle, ChevronLeft } from 'lucide-react';
import MessageBubble from './MessageBubble.jsx';
import AgentToggle from './AgentToggle.jsx';
import { conversationsAPI } from '../utils/api.js';
import { useTheme } from '../theme.js';

const DEV_EMAIL = 'raivaldiviabou@gmail.com';

export default function ChatWindow({ conversation, messages, onSendMessage, onToggleAgentMode, onEscalationFeedback, onDeleteMessages, currentUserEmail, onBack, isMobile, botTyping }) {
  const { colors, isDark } = useTheme();
  const [inputText, setInputText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [feedbackSent, setFeedbackSent] = useState(null); // 'correct' | 'unnecessary' | null
  const [deleting, setDeleting] = useState(false);

  // Template modal state
  const [showTemplateModal, setShowTemplateModal] = useState(false);
  const [templates, setTemplates] = useState([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [templatesError, setTemplatesError] = useState(null);
  const [selectedTemplate, setSelectedTemplate] = useState(null);
  const [templateVarMap, setTemplateVarMap] = useState({}); // { "1": "name"|"manual" }
  const [templateManualVars, setTemplateManualVars] = useState({}); // { "1": "texto" }
  const [sendingTemplate, setSendingTemplate] = useState(false);
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);

  const isHumanMode = conversation.agent_mode === 'human';
  const isDevUser = currentUserEmail === DEV_EMAIL;

  // Reset feedback state when conversation changes
  useEffect(() => {
    setFeedbackSent(null);
  }, [conversation.id]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Determinar si mostrar botones de feedback
  // Solo mostrar si: modo humano + hay trigger de escalación reciente (< 60 min)
  const showFeedback = isHumanMode &&
    conversation.last_escalation_trigger &&
    !feedbackSent &&
    (() => {
      if (!conversation.last_escalation_at) return false;
      const mins = (Date.now() - new Date(conversation.last_escalation_at).getTime()) / 60000;
      return mins < 60;
    })();

  const handleFeedback = async (feedback) => {
    setFeedbackSent(feedback);
    try {
      await onEscalationFeedback(conversation.id, feedback);
    } catch (err) {
      console.error('Error guardando feedback:', err);
    }
  };

  const handleDeleteMessages = async () => {
    if (!window.confirm(`¿Borrar todos los mensajes de ${conversation.contact_name || conversation.phone_number}?\n\nEsto resetea el estado del agente para este número.`)) return;
    setDeleting(true);
    try {
      await onDeleteMessages(conversation.id);
    } catch (err) {
      setError('Error borrando mensajes.');
    } finally {
      setDeleting(false);
    }
  };

  // ── Template helpers ────────────────────────────────────────────
  const openTemplateModal = async () => {
    setShowTemplateModal(true);
    setSelectedTemplate(null);
    setTemplateVarMap({});
    setTemplateManualVars({});
    if (templates.length === 0) {
      setTemplatesLoading(true);
      setTemplatesError(null);
      try {
        const res = await conversationsAPI.sendTemplate(0, {}); // dummy to trigger error and get config
      } catch {}
      try {
        const { api } = await import('../utils/api.js');
        const res = await api.get('/reengagement/templates');
        setTemplates(res.data.data || []);
      } catch (err) {
        setTemplatesError(err.response?.data?.error || err.message);
      } finally {
        setTemplatesLoading(false);
      }
    }
  };

  const parseVars = (tpl) => {
    if (!tpl) return [];
    const bodyComp = (tpl.components || []).find(c => c.type === 'BODY');
    if (!bodyComp?.text) return [];
    const matches = [...bodyComp.text.matchAll(/\{\{(\d+)\}\}/g)];
    return [...new Set(matches.map(m => m[1]))].sort();
  };

  const handleSelectTpl = (tpl) => {
    setSelectedTemplate(tpl);
    const vars = parseVars(tpl);
    const defaultMap = {};
    vars.forEach((v, i) => { defaultMap[v] = i === 0 ? 'name' : 'manual'; });
    setTemplateVarMap(defaultMap);
    setTemplateManualVars({});
  };

  const buildTplComponents = () => {
    if (!selectedTemplate) return [];
    const vars = parseVars(selectedTemplate);
    if (vars.length === 0) return [];
    const contactName = conversation.contact_name || conversation.phone_number;
    const parameters = vars.map(v => {
      const mapping = templateVarMap[v] || 'manual';
      let text = '';
      if (mapping === 'name')  text = contactName;
      else if (mapping === 'phone') text = conversation.phone_number;
      else text = templateManualVars[v] || '';
      return { type: 'text', text };
    });
    return [{ type: 'body', parameters }];
  };

  const previewTpl = () => {
    if (!selectedTemplate) return '';
    const bodyComp = (selectedTemplate.components || []).find(c => c.type === 'BODY');
    if (!bodyComp?.text) return `[Template: ${selectedTemplate.name}]`;
    let text = bodyComp.text;
    const vars = parseVars(selectedTemplate);
    const contactName = conversation.contact_name || conversation.phone_number;
    vars.forEach(v => {
      const mapping = templateVarMap[v] || 'manual';
      let val = '';
      if (mapping === 'name')       val = contactName;
      else if (mapping === 'phone') val = conversation.phone_number;
      else val = templateManualVars[v] || `{{${v}}}`;
      text = text.replace(new RegExp(`\\{\\{${v}\\}\\}`, 'g'), val);
    });
    return text;
  };

  const sendTemplateMessage = async () => {
    if (!selectedTemplate) return;
    setSendingTemplate(true);
    try {
      await conversationsAPI.sendTemplate(conversation.id, {
        templateName:  selectedTemplate.name,
        languageCode:  selectedTemplate.language,
        components:    buildTplComponents(),
        previewText:   previewTpl(),
      });
      setShowTemplateModal(false);
      setError(null);
    } catch (err) {
      setTemplatesError(err.response?.data?.error || 'Error enviando template');
    } finally {
      setSendingTemplate(false);
    }
  };

  const handleSend = async () => {
    const text = inputText.trim();
    if (!text || sending) return;
    setInputText('');
    setSending(true);
    setError(null);
    try {
      await onSendMessage(conversation.id, text);
    } catch (err) {
      const is24h = err.response?.data?.error === 'WINDOW_EXPIRED';
      if (is24h) {
        setError('⏰ Ventana de 24h expirada — el cliente debe escribirte primero para poder responder.');
      } else {
        setError('Error enviando el mensaje. Intenta de nuevo.');
      }
      setInputText(text);
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const initials = (conversation.contact_name || conversation.phone_number || '?')
    .split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();

  return (
    <div style={{
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      height: isMobile ? '100%' : '100vh',
      overflow: 'hidden',
      position: 'relative',
      backgroundColor: isDark ? '#0b141a' : '#efeae2',
      backgroundImage: isDark
        ? `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='60' height='60'%3E%3Cpath d='M30 5l5 10h10l-8 7 3 10-10-6-10 6 3-10-8-7h10z' fill='%23ffffff05'/%3E%3C/svg%3E")`
        : `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='60' height='60'%3E%3Cpath d='M30 5l5 10h10l-8 7 3 10-10-6-10 6 3-10-8-7h10z' fill='%2300000008'/%3E%3C/svg%3E")`,
    }}>
      {/* Header */}
      <div style={{
        padding: isMobile ? '8px 10px' : '10px 16px',
        backgroundColor: colors.bgPanel,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderBottom: `1px solid ${colors.border}`,
        minHeight: '56px',
        zIndex: 10,
        flexShrink: 0,
      }}>
        {/* Left: back + avatar + contact info */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0, flex: 1 }}>
          {isMobile && onBack && (
            <button onClick={onBack} style={{
              background: 'none', border: 'none', cursor: 'pointer', padding: '4px',
              color: colors.textSecondary, display: 'flex', alignItems: 'center',
              borderRadius: '8px', flexShrink: 0,
            }}>
              <ChevronLeft size={22} />
            </button>
          )}
          <div style={{
            width: isMobile ? '34px' : '40px', height: isMobile ? '34px' : '40px',
            borderRadius: '50%', backgroundColor: '#4db6ac', flexShrink: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontWeight: 600, color: 'white', fontSize: '13px',
          }}>
            {initials}
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{
              fontWeight: 600, fontSize: isMobile ? '14px' : '15px', color: colors.textPrimary,
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              maxWidth: isMobile ? '110px' : 'none',
            }}>
              {conversation.contact_name || conversation.phone_number}
            </div>
            {!isMobile && (
              <div style={{ fontSize: '12px', color: colors.textSecondary }}>
                {conversation.phone_number}
              </div>
            )}
          </div>
        </div>

        {/* Right: action buttons */}
        <div style={{ display: 'flex', alignItems: 'center', gap: isMobile ? '4px' : '8px', flexShrink: 0 }}>
          {isDevUser && (
            <button
              onClick={handleDeleteMessages}
              disabled={deleting}
              title={deleting ? 'Borrando...' : 'Borrar todos los mensajes'}
              style={{
                backgroundColor: 'transparent',
                border: `1px solid ${colors.borderStrong}`,
                borderRadius: '6px', padding: isMobile ? '5px' : '5px 8px',
                color: deleting ? colors.textMuted : colors.red,
                cursor: deleting ? 'not-allowed' : 'pointer',
                display: 'flex', alignItems: 'center', gap: '4px',
                fontSize: '11px', transition: 'all 0.15s',
              }}
            >
              <Trash2 size={13} />
              {!isMobile && (deleting ? 'Borrando...' : 'Reset chat')}
            </button>
          )}
          <button
            onClick={openTemplateModal}
            title="Enviar template de WhatsApp"
            style={{
              backgroundColor: 'transparent',
              border: `1px solid ${colors.borderStrong}`,
              borderRadius: '6px', padding: isMobile ? '5px' : '5px 8px',
              color: '#4db6e8',
              cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: '4px',
              fontSize: '11px', transition: 'all 0.15s',
            }}
          >
            <FileText size={13} />
            {!isMobile && 'Template'}
          </button>
          <AgentToggle
            mode={conversation.agent_mode}
            onToggle={() => onToggleAgentMode(conversation.id, conversation.agent_mode)}
            isMobile={isMobile}
          />
        </div>
      </div>

      {/* Banner modo humano */}
      {isHumanMode && (
        <div style={{
          backgroundColor: '#f0b429',
          color: '#000',
          padding: '8px 16px',
          fontSize: '13px',
          fontWeight: 500,
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          flexWrap: 'wrap',
        }}>
          <User size={14} />
          <span style={{ flex: 1 }}>Modo manual — el agente IA está pausado.</span>
          <button
            onClick={() => onToggleAgentMode(conversation.id, conversation.agent_mode)}
            style={{
              backgroundColor: 'rgba(0,0,0,0.15)',
              color: '#000',
              padding: '3px 10px',
              borderRadius: '12px',
              fontSize: '12px',
              fontWeight: 600,
              display: 'flex', alignItems: 'center', gap: '4px',
              border: 'none', cursor: 'pointer',
            }}
          >
            <Play size={11} /> Reactivar IA
          </button>
        </div>
      )}

      {/* Banner ventana 24h expirada */}
      {error?.includes('Ventana de 24h') && (
        <div style={{
          backgroundColor: '#2d1b00',
          borderBottom: '1px solid #4a3000',
          padding: '8px 16px',
          fontSize: '12px',
          color: '#fb923c',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
        }}>
          <span>⏰</span>
          <span>
            <strong>Ventana de 24 horas expirada.</strong>{' '}
            WhatsApp solo permite responder si el cliente ha escrito en las últimas 24h.
            Espera a que el cliente te escriba primero.
          </span>
        </div>
      )}

      {/* Panel de feedback de escalación */}
      {showFeedback && (
        <div style={{
          backgroundColor: '#1e2d3a',
          borderBottom: '1px solid #2a3942',
          padding: '10px 16px',
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
        }}>
          <div style={{ fontSize: '12px', color: '#8696a0', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <Bot size={13} />
            <span>El agente derivó esta conversación por: <em style={{ color: '#aebac1' }}>{conversation.last_escalation_reason}</em></span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '12px', color: '#8696a0' }}>¿Fue correcta la derivación?</span>
            <button
              onClick={() => handleFeedback('correct')}
              style={{
                backgroundColor: '#1a4731',
                color: '#4ade80',
                border: '1px solid #166534',
                padding: '4px 12px',
                borderRadius: '8px',
                fontSize: '12px',
                fontWeight: 600,
                display: 'flex', alignItems: 'center', gap: '4px',
                cursor: 'pointer',
              }}
            >
              <ThumbsUp size={12} /> Sí, era correcta
            </button>
            <button
              onClick={() => handleFeedback('unnecessary')}
              style={{
                backgroundColor: '#4a1c1c',
                color: '#f87171',
                border: '1px solid #7f1d1d',
                padding: '4px 12px',
                borderRadius: '8px',
                fontSize: '12px',
                fontWeight: 600,
                display: 'flex', alignItems: 'center', gap: '4px',
                cursor: 'pointer',
              }}
            >
              <ThumbsDown size={12} /> No, se equivocó
            </button>
          </div>
        </div>
      )}

      {/* Confirmación de feedback enviado */}
      {feedbackSent && isHumanMode && (
        <div style={{
          backgroundColor: feedbackSent === 'correct' ? '#0d2b1e' : '#2b1414',
          borderBottom: '1px solid #2a3942',
          padding: '8px 16px',
          fontSize: '12px',
          color: feedbackSent === 'correct' ? '#4ade80' : '#f87171',
          display: 'flex', alignItems: 'center', gap: '6px',
        }}>
          {feedbackSent === 'correct'
            ? '✅ Gracias — el agente refuerza este criterio'
            : '🧠 Aprendido — el agente no repetirá este error'}
        </div>
      )}

      {/* Mensajes */}
      <div style={{
        flex: 1,
        overflowY: 'auto',
        padding: '16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
      }}>
        {messages.length === 0 ? (
          <div style={{
            flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: colors.textSecondary, fontSize: '14px',
          }}>
            Sin mensajes aún
          </div>
        ) : (
          messages.map((msg) => (
            <MessageBubble key={msg.id} message={msg} />
          ))
        )}
        {/* Typing indicator */}
        {botTyping && (
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: '6px', padding: '4px 0' }}>
            <div style={{
              width: '28px', height: '28px', borderRadius: '50%',
              backgroundColor: '#4db6ac', display: 'flex', alignItems: 'center',
              justifyContent: 'center', flexShrink: 0,
            }}>
              <Bot size={13} color="white" />
            </div>
            <div style={{
              backgroundColor: colors.bgPanel,
              borderRadius: '12px 12px 12px 2px',
              padding: '10px 14px',
              display: 'flex', alignItems: 'center', gap: '5px',
              border: `1px solid ${colors.border}`,
            }}>
              {[0, 0.35, 0.7].map((delay, i) => (
                <span key={i} style={{
                  width: '7px', height: '7px', borderRadius: '50%',
                  backgroundColor: colors.textSecondary,
                  display: 'inline-block',
                  animation: `typing-dot 1.2s ease-in-out ${delay}s infinite`,
                }} />
              ))}
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {error && (
        <div style={{
          padding: '8px 16px',
          backgroundColor: `${colors.red}22`,
          color: colors.red,
          fontSize: '13px',
          textAlign: 'center',
        }}>
          {error}
        </div>
      )}

      {/* Modal de templates */}
      {showTemplateModal && (
        <div style={{
          position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.6)',
          zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px',
        }}>
          <div style={{
            backgroundColor: colors.bgPanel, borderRadius: '12px',
            border: `1px solid ${colors.border}`, width: '100%', maxWidth: '520px',
            maxHeight: '80vh', overflow: 'auto',
            boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '16px 20px', borderBottom: `1px solid ${colors.border}` }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <FileText size={16} color="#4db6e8" />
                <span style={{ color: colors.textPrimary, fontWeight: 600, fontSize: '15px' }}>Enviar Template</span>
              </div>
              <button onClick={() => setShowTemplateModal(false)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: colors.textSecondary, padding: '4px' }}>
                <X size={18} />
              </button>
            </div>
            <div style={{ padding: '10px 20px', backgroundColor: colors.bgAccent, borderBottom: `1px solid ${colors.border}`, fontSize: '12px', color: '#4db6e8', display: 'flex', alignItems: 'flex-start', gap: '6px' }}>
              <span>💡</span>
              <span>Los templates funcionan aunque la ventana de 24h haya expirado.</span>
            </div>
            <div style={{ padding: '20px' }}>
              {templatesLoading ? (
                <div style={{ textAlign: 'center', padding: '30px', color: colors.textSecondary }}>
                  <Loader size={24} color={colors.green} style={{ animation: 'spin 1s linear infinite', marginBottom: '10px' }} />
                  <div style={{ fontSize: '13px' }}>Cargando templates aprobados...</div>
                </div>
              ) : templatesError ? (
                <div style={{ color: colors.red, fontSize: '13px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <AlertCircle size={14} /> {templatesError}
                </div>
              ) : templates.length === 0 ? (
                <div style={{ color: colors.textSecondary, fontSize: '13px', textAlign: 'center', padding: '20px' }}>
                  No hay templates aprobados.<br />Créalos desde la sección Templates.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  <div>
                    <label style={{ color: colors.textSecondary, fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.5px', display: 'block', marginBottom: '6px' }}>Template</label>
                    <select value={selectedTemplate?.name || ''}
                      onChange={e => { const tpl = templates.find(t => t.name === e.target.value); if (tpl) handleSelectTpl(tpl); else setSelectedTemplate(null); }}
                      style={{ width: '100%', backgroundColor: colors.bgInput, color: colors.textPrimary, border: `1px solid ${colors.borderStrong}`, borderRadius: '7px', padding: '9px 12px', fontSize: '13px', cursor: 'pointer', outline: 'none' }}>
                      <option value="">— Selecciona un template —</option>
                      {templates.map(t => (
                        <option key={t.name} value={t.name}>{t.name} · {t.language} · {t.category || 'MARKETING'}</option>
                      ))}
                    </select>
                  </div>
                  {selectedTemplate && parseVars(selectedTemplate).length > 0 && (
                    <div>
                      <label style={{ color: colors.textSecondary, fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.5px', display: 'block', marginBottom: '8px' }}>Variables</label>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        {parseVars(selectedTemplate).map(v => (
                          <div key={v} style={{ display: 'flex', alignItems: 'center', gap: '8px', backgroundColor: colors.bgSub, borderRadius: '7px', padding: '8px 12px', border: `1px solid ${colors.border}` }}>
                            <span style={{ color: colors.green, fontSize: '12px', fontWeight: 700, flexShrink: 0 }}>{'{{' + v + '}}'}</span>
                            <select value={templateVarMap[v] || 'manual'} onChange={e => setTemplateVarMap(prev => ({ ...prev, [v]: e.target.value }))}
                              style={{ backgroundColor: colors.bgInput, color: colors.textPrimary, border: `1px solid ${colors.border}`, borderRadius: '5px', padding: '4px 8px', fontSize: '12px', cursor: 'pointer' }}>
                              <option value="name">Nombre del contacto</option>
                              <option value="phone">Teléfono</option>
                              <option value="manual">Texto fijo</option>
                            </select>
                            {(templateVarMap[v] || 'manual') === 'manual' && (
                              <input value={templateManualVars[v] || ''} onChange={e => setTemplateManualVars(prev => ({ ...prev, [v]: e.target.value }))}
                                placeholder={`Texto para {{${v}}}...`}
                                style={{ flex: 1, backgroundColor: colors.bgInput, color: colors.textPrimary, border: `1px solid ${colors.border}`, borderRadius: '5px', padding: '4px 8px', fontSize: '12px', outline: 'none' }} />
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {selectedTemplate && (
                    <div>
                      <label style={{ color: colors.textSecondary, fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.5px', display: 'block', marginBottom: '6px' }}>Vista previa</label>
                      <div style={{ backgroundColor: colors.bgSub, borderRadius: '8px', padding: '12px 14px', border: `1px solid ${colors.border}` }}>
                        {(() => {
                          const header = selectedTemplate.components?.find(c => c.type === 'HEADER');
                          const footer = selectedTemplate.components?.find(c => c.type === 'FOOTER');
                          return (<>
                            {header?.text && <div style={{ color: colors.textPrimary, fontWeight: 700, fontSize: '13px', marginBottom: '6px' }}>{header.text}</div>}
                            <div style={{ color: colors.textPrimary, fontSize: '13px', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{previewTpl()}</div>
                            {footer?.text && <div style={{ color: colors.textSecondary, fontSize: '11px', marginTop: '8px' }}>{footer.text}</div>}
                          </>);
                        })()}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
            {!templatesLoading && templates.length > 0 && (
              <div style={{ padding: '12px 20px', borderTop: `1px solid ${colors.border}`, display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                <button onClick={() => setShowTemplateModal(false)}
                  style={{ padding: '8px 16px', borderRadius: '8px', backgroundColor: 'transparent', color: colors.textSecondary, border: `1px solid ${colors.borderStrong}`, cursor: 'pointer', fontSize: '13px' }}>
                  Cancelar
                </button>
                <button onClick={sendTemplateMessage} disabled={!selectedTemplate || sendingTemplate}
                  style={{ padding: '8px 20px', borderRadius: '8px', backgroundColor: selectedTemplate ? '#4db6e8' : colors.bgHover, color: selectedTemplate ? '#000' : colors.textSecondary, border: 'none', cursor: selectedTemplate ? 'pointer' : 'not-allowed', fontSize: '13px', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '6px', opacity: sendingTemplate ? 0.7 : 1 }}>
                  {sendingTemplate ? <><Loader size={13} style={{ animation: 'spin 1s linear infinite' }} /> Enviando...</> : <><Send size={13} /> Enviar Template</>}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Input */}
      <div style={{
        padding: '10px 16px',
        backgroundColor: colors.bgPanel,
        display: 'flex',
        alignItems: 'flex-end',
        gap: '10px',
        borderTop: `1px solid ${colors.border}`,
      }}>
        <textarea
          ref={inputRef}
          value={inputText}
          onChange={e => setInputText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={isHumanMode ? 'Escribe un mensaje...' : 'Escribe para responder manualmente...'}
          rows={1}
          style={{
            flex: 1,
            backgroundColor: colors.bgInput,
            border: `1px solid ${colors.border}`,
            borderRadius: '8px',
            padding: '10px 14px',
            color: colors.textPrimary,
            fontSize: '14px',
            resize: 'none',
            maxHeight: '120px',
            lineHeight: '1.5',
            fontFamily: 'inherit',
            outline: 'none',
          }}
          onInput={e => {
            e.target.style.height = 'auto';
            e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
          }}
        />
        <style>{`
          @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
          @keyframes typing-dot {
            0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
            30% { transform: translateY(-4px); opacity: 1; }
          }
        `}</style>
        <button
          onClick={handleSend}
          disabled={!inputText.trim() || sending}
          style={{
            backgroundColor: inputText.trim() ? colors.green : colors.bgHover,
            color: 'white',
            width: '42px',
            height: '42px',
            borderRadius: '50%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'background 0.2s',
            flexShrink: 0,
            border: 'none',
            cursor: inputText.trim() ? 'pointer' : 'default',
          }}
        >
          <Send size={18} />
        </button>
      </div>
    </div>
  );
}
