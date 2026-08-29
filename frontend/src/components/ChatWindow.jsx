import { useState, useRef, useEffect, useCallback } from 'react';
import { Bot, User, Send, Play, ThumbsUp, ThumbsDown, Trash2, FileText, X, Loader, AlertCircle, ChevronLeft, ShoppingCart, Plus, Minus, GitMerge, Search, History, BellOff, BarChart2 } from 'lucide-react';
import MessageBubble from './MessageBubble.jsx';
import AgentToggle from './AgentToggle.jsx';
import { conversationsAPI, api } from '../utils/api.js';
import { useTheme } from '../theme.js';

const DEV_EMAIL = 'raivaldiviabou@gmail.com';

export default function ChatWindow({ conversation, messages, onSendMessage, onToggleAgentMode, onRefresh, onEscalationFeedback, onDeleteMessages, currentUserEmail, onBack, isMobile, botTyping }) {
  const { colors, isDark } = useTheme();
  const [inputText, setInputText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const [feedbackSent, setFeedbackSent] = useState(null); // 'correct' | 'unnecessary' | null
  const [deleting, setDeleting] = useState(false);

  // Historial de compras
  const [showHistory, setShowHistory]       = useState(false);
  const [historyData, setHistoryData]       = useState(null);
  const [historyLoading, setHistoryLoading] = useState(false);

  const openHistory = useCallback(async () => {
    const phone = conversation.phone_number;
    if (!phone) return;
    setShowHistory(true);
    setHistoryLoading(true);
    try {
      const res = await api.get(`/orders/history/${encodeURIComponent(phone)}`);
      setHistoryData(res.data?.data || null);
    } catch {
      setHistoryData(null);
    } finally {
      setHistoryLoading(false);
    }
  }, [conversation.phone_number]);

  // Order modal state
  const [showOrderModal, setShowOrderModal]   = useState(false);
  const [products, setProducts]               = useState([]);
  const [productsLoading, setProductsLoading] = useState(false);
  const [orderItems, setOrderItems]           = useState({}); // { productId: quantity }
  const [orderAddress, setOrderAddress]       = useState('');
  const [orderCity, setOrderCity]             = useState('');
  const [sendSummary, setSendSummary]         = useState(true);
  const [creatingOrder, setCreatingOrder]     = useState(false);
  const [orderError, setOrderError]           = useState('');

  // Merge modal state
  const [showMergeModal, setShowMergeModal]     = useState(false);
  const [mergeSearch, setMergeSearch]           = useState('');
  const [mergeConvs, setMergeConvs]             = useState([]);
  const [mergeLoading, setMergeLoading]         = useState(false);
  const [merging, setMerging]                   = useState(false);
  const [mergeError, setMergeError]             = useState('');

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
  const HOT_STATES = ['interested', 'collecting_order'];
  const isHotLead = HOT_STATES.includes(conversation.pipeline_state);
  const isEmpresa  = conversation.client_type === 'empresa';
  const [optOut, setOptOut] = useState(!!conversation.opt_out);
  const [togglingOptOut, setTogglingOptOut] = useState(false);

  // Análisis de conversación
  const [showAnalysis, setShowAnalysis] = useState(false);
  const [analysisData, setAnalysisData] = useState(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);

  // Mejoras del bot desde el análisis
  const [improvementsLoading, setImprovementsLoading] = useState(false);
  const [improvementsData, setImprovementsData]       = useState(null); // { rules: string[], existing: string[] }
  const [savingRules, setSavingRules]                 = useState(false);
  const [rulesSaved, setRulesSaved]                   = useState(false);

  const openAnalysis = useCallback(async () => {
    setShowAnalysis(true);
    setAnalysisData(null);
    setAnalysisLoading(true);
    setImprovementsData(null);
    setRulesSaved(false);
    try {
      const res = await api.post(`/conversations/${conversation.id}/analyze`);
      const analysis = res.data?.analysis || null;
      setAnalysisData(analysis);
      // Si el estado cambió, recargar la lista de conversaciones
      if (analysis?.estado_aplicado) onRefresh?.();
    } catch (e) {
      setAnalysisData({ error: e.response?.data?.error || 'Error analizando conversación' });
    } finally {
      setAnalysisLoading(false);
    }
  }, [conversation.id, onRefresh]);

  const generateImprovements = useCallback(async (analysis) => {
    setImprovementsLoading(true);
    setImprovementsData(null);
    setRulesSaved(false);
    try {
      // Obtener reglas existentes
      const [rulesRes, genRes] = await Promise.all([
        api.get('/settings').catch(() => ({ data: { data: {} } })),
        api.post(`/conversations/${conversation.id}/generate-improvements`, {
          errores: analysis.errores || [],
          oportunidades: analysis.oportunidades || [],
          resumen: analysis.resumen || '',
        }),
      ]);
      const existing = rulesRes.data?.data?.bot_improvement_rules || [];
      const newRules = genRes.data?.rules || [];
      // Deduplicar
      const combined = [...existing];
      newRules.forEach(r => { if (!combined.includes(r)) combined.push(r); });
      setImprovementsData({ newRules, existing, combined });
    } catch (e) {
      setImprovementsData({ error: e.response?.data?.error || 'Error generando mejoras' });
    } finally {
      setImprovementsLoading(false);
    }
  }, [conversation.id]);

  const saveRules = useCallback(async (rules) => {
    setSavingRules(true);
    try {
      await api.put('/settings', { bot_improvement_rules: rules });
      setRulesSaved(true);
      setImprovementsData(prev => prev ? { ...prev, existing: rules } : prev);
    } catch (e) {
      alert('Error guardando reglas: ' + (e.response?.data?.error || e.message));
    } finally {
      setSavingRules(false);
    }
  }, []);

  // Sync si cambia de conversación
  useEffect(() => { setOptOut(!!conversation.opt_out); }, [conversation.id, conversation.opt_out]);

  const handleToggleOptOut = async () => {
    if (togglingOptOut) return;
    const phone = conversation.phone_number;
    if (!phone) return;
    const newVal = !optOut;
    const label  = newVal ? 'No contactar' : 'Volver a contactar';
    if (!window.confirm(`¿${label} a ${conversation.contact_name || phone}?`)) return;
    setTogglingOptOut(true);
    try {
      await api.patch(`/contacts/${encodeURIComponent(phone)}/opt-out`, { optOut: newVal });
      setOptOut(newVal);
    } catch (e) { console.error(e); }
    setTogglingOptOut(false);
  };

  const handleRemoveHotLead = async () => {
    try {
      await api.patch(`/conversations/${conversation.id}/pipeline-state`, { state: 'exploring', excludeHotLead: true });
      onRefresh?.();
    } catch (e) { console.error(e); }
  };

  const handleToggleEmpresa = async () => {
    const newType = isEmpresa ? 'personal' : 'empresa';
    try {
      await api.patch(`/conversations/${conversation.id}/client-type`, { clientType: newType });
      onRefresh?.();
    } catch (e) { console.error(e); }
  };

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

  const _rawName = conversation.contact_name;
  const _isGenericName = !_rawName || _rawName === 'Cliente' || /^\d+$/.test(_rawName);
  const displayContactName = _isGenericName ? (conversation.phone_number || '?') : _rawName;
  const initials = displayContactName.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();

  // ── Order modal handlers ────────────────────────────────────────
  const openOrderModal = async () => {
    setShowOrderModal(true);
    setOrderItems({});
    setOrderAddress('');
    setOrderCity('');
    setOrderError('');
    setProductsLoading(true);
    // Precargar dirección del contacto
    try {
      const phone = conversation.phone_number;
      const cr = await api.get('/contacts/by-phone', { params: { phone } });
      const ct = cr.data?.contact;
      if (ct) {
        const addr = ct.address1 || ct.address || '';
        if (addr) setOrderAddress(addr);
        if (ct.city) setOrderCity(ct.city);
      }
    } catch { /* ignorar si falla */ }
    try {
      const r = await api.get('/products');
      const all = (r.data.products || r.data.data || []).filter(p => p.active !== false);
      // Si el cliente es empresa, mostrar solo productos empresa (is_business=true); si no, solo productos normales
      const empresaProds = all.filter(p => p.is_business === true || p.is_business === 1 || p.is_business === 'true');
      const normalProds  = all.filter(p => !p.is_business);
      if (isEmpresa) {
        // Si no hay productos empresa configurados, mostrar todos con advertencia
        setProducts(empresaProds.length > 0 ? empresaProds : all);
        if (empresaProds.length === 0) console.warn('[Nueva orden] Cliente es empresa pero no hay productos con is_business=true. Mostrando todos.', all.map(p => ({ id: p.id, title: p.title, is_business: p.is_business })));
      } else {
        setProducts(normalProds.length > 0 ? normalProds : all);
      }
    } catch { setProducts([]); }
    finally { setProductsLoading(false); }
  };

  const setQty = (id, delta) => {
    setOrderItems(prev => {
      const cur = prev[id] || 0;
      const next = Math.max(0, cur + delta);
      if (next === 0) { const n = {...prev}; delete n[id]; return n; }
      return { ...prev, [id]: next };
    });
  };

  const handleCreateOrder = async () => {
    const items = Object.entries(orderItems).map(([id, qty]) => {
      const p = products.find(p => String(p.id) === String(id));
      return { productId: id, title: p?.title || id, price: p?.price || 0, quantity: qty };
    });
    if (!items.length) { setOrderError('Agrega al menos un producto'); return; }
    setCreatingOrder(true); setOrderError('');
    try {
      const shippingAddress = orderAddress.trim() ? { address: orderAddress.trim(), city: orderCity.trim() } : {};
      await api.post(`/conversations/${conversation.id}/orders`, { items, sendSummary, shippingAddress });
      setShowOrderModal(false);
      setOrderItems({});
      setOrderAddress('');
      setOrderCity('');
    } catch (err) {
      setOrderError(err.response?.data?.error || err.message);
    } finally { setCreatingOrder(false); }
  };

  const orderTotal = Object.entries(orderItems).reduce((s, [id, qty]) => {
    const p = products.find(p => String(p.id) === String(id));
    return s + (parseFloat(p?.price || 0) * qty);
  }, 0);

  // ── Merge modal handlers ────────────────────────────────────────
  const openMergeModal = async () => {
    setShowMergeModal(true);
    setMergeSearch('');
    setMergeError('');
    setMergeLoading(true);
    try {
      const r = await api.get('/conversations');
      const all = r.data?.data || [];
      setMergeConvs(all.filter(c => c.id !== conversation.id));
    } catch { setMergeConvs([]); }
    finally { setMergeLoading(false); }
  };

  const handleMerge = async (sourceId) => {
    if (!window.confirm('¿Fusionar esa conversación en esta? Los mensajes del número anterior quedarán aquí y esa conversación se eliminará.')) return;
    setMerging(true); setMergeError('');
    try {
      await api.post(`/conversations/${conversation.id}/merge-from/${sourceId}`);
      setShowMergeModal(false);
      window.location.reload(); // recargar para ver el historial completo
    } catch (err) {
      setMergeError(err.response?.data?.error || err.message);
    } finally { setMerging(false); }
  };

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
              {displayContactName}
            </div>
            {!isMobile && (
              <div onClick={openHistory}
                style={{ fontSize: '12px', color: colors.green, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px' }}
                title="Ver historial de compras">
                <History size={11} />
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
            onClick={openOrderModal}
            title="Crear orden"
            style={{
              backgroundColor: 'transparent',
              border: `1px solid ${colors.borderStrong}`,
              borderRadius: '6px', padding: isMobile ? '5px' : '5px 8px',
              color: colors.green,
              cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: '4px',
              fontSize: '11px', transition: 'all 0.15s',
            }}
          >
            <ShoppingCart size={13} />
            {!isMobile && 'Nueva orden'}
          </button>
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
          {isHotLead && (
            <button
              onClick={handleRemoveHotLead}
              title="Sacar de Hot Leads"
              style={{
                backgroundColor: 'transparent',
                border: '1px solid #f9731666',
                borderRadius: '20px',
                padding: '4px 10px',
                color: '#f97316',
                cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: '4px',
                fontSize: '11px', fontWeight: 600, transition: 'all 0.15s',
              }}
              onMouseEnter={e => { e.currentTarget.style.backgroundColor = '#f9731620'; }}
              onMouseLeave={e => { e.currentTarget.style.backgroundColor = 'transparent'; }}
            >
              🔥 Hot Lead <X size={10} />
            </button>
          )}
          <button
            onClick={handleToggleOptOut}
            disabled={togglingOptOut}
            title={optOut ? 'Volver a contactar (quitar opt-out)' : 'Marcar como No contactar'}
            style={{
              backgroundColor: optOut ? '#ef444420' : 'transparent',
              border: optOut ? '1px solid #ef4444' : `1px solid ${colors.borderStrong}`,
              borderRadius: '20px',
              padding: '4px 10px',
              color: optOut ? '#ef4444' : colors.textMuted,
              cursor: togglingOptOut ? 'not-allowed' : 'pointer',
              display: 'flex', alignItems: 'center', gap: '4px',
              fontSize: '11px', fontWeight: optOut ? 600 : 400, transition: 'all 0.15s',
            }}
          >
            <BellOff size={11} />
            {!isMobile && (optOut ? 'No contactar' : 'Opt-out')}
          </button>
          <button
            onClick={handleToggleEmpresa}
            title={isEmpresa ? 'Marcar como cliente particular' : 'Marcar como empresa (B2B)'}
            style={{
              backgroundColor: isEmpresa ? '#6366f1' : 'transparent',
              border: isEmpresa ? '1px solid #6366f1' : `1px solid ${colors.borderStrong}`,
              borderRadius: '20px',
              padding: '4px 10px',
              color: isEmpresa ? 'white' : colors.textMuted,
              cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: '4px',
              fontSize: '11px', fontWeight: isEmpresa ? 600 : 400, transition: 'all 0.15s',
            }}
            onMouseEnter={e => { e.currentTarget.style.backgroundColor = isEmpresa ? '#4f46e5' : '#6366f120'; e.currentTarget.style.color = isEmpresa ? 'white' : '#6366f1'; }}
            onMouseLeave={e => { e.currentTarget.style.backgroundColor = isEmpresa ? '#6366f1' : 'transparent'; e.currentTarget.style.color = isEmpresa ? 'white' : colors.textMuted; }}
          >
            🏢 {isEmpresa ? 'Empresa' : 'Empresa'}
          </button>
          <button
            onClick={openAnalysis}
            title="Analizar conversación con IA"
            style={{
              backgroundColor: 'transparent',
              border: `1px solid ${colors.borderStrong}`,
              borderRadius: '6px', padding: isMobile ? '5px' : '5px 8px',
              color: '#a78bfa',
              cursor: 'pointer',
              display: 'flex', alignItems: 'center', gap: '4px',
              fontSize: '11px', transition: 'all 0.15s',
            }}
          >
            <BarChart2 size={13} />
            {!isMobile && 'Analizar'}
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
          messages.reduce((acc, msg, i) => {
            const msgDay = msg.created_at ? new Date(msg.created_at).toDateString() : null;
            const prevDay = i > 0 && messages[i-1].created_at ? new Date(messages[i-1].created_at).toDateString() : null;
            if (msgDay && msgDay !== prevDay) {
              const d = new Date(msg.created_at);
              const today = new Date();
              const yesterday = new Date(); yesterday.setDate(today.getDate() - 1);
              let label;
              if (d.toDateString() === today.toDateString()) label = 'Hoy';
              else if (d.toDateString() === yesterday.toDateString()) label = 'Ayer';
              else label = d.toLocaleDateString('es-CL', { weekday: 'long', day: 'numeric', month: 'long' });
              acc.push(
                <div key={`sep-${msgDay}`} style={{ display: 'flex', alignItems: 'center', gap: '10px', margin: '10px 0' }}>
                  <div style={{ flex: 1, height: '1px', backgroundColor: colors.border }} />
                  <span style={{ fontSize: '11px', color: colors.textSecondary, fontWeight: 500, whiteSpace: 'nowrap', textTransform: 'capitalize' }}>{label}</span>
                  <div style={{ flex: 1, height: '1px', backgroundColor: colors.border }} />
                </div>
              );
            }
            acc.push(<MessageBubble key={msg.id} message={msg} />);
            return acc;
          }, [])
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

      {/* ── Modal Historial de Compras ── */}
      {showHistory && (
        <div onClick={() => setShowHistory(false)} style={{ position:'fixed', inset:0, backgroundColor:'rgba(0,0,0,0.6)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center', padding:'16px' }}>
          <div onClick={e => e.stopPropagation()} style={{ backgroundColor: colors.bgPanel, borderRadius:'14px', border:`1px solid ${colors.border}`, width:'100%', maxWidth:'500px', maxHeight:'80vh', display:'flex', flexDirection:'column', boxShadow:'0 20px 60px rgba(0,0,0,0.5)' }}>
            {/* Header */}
            <div style={{ padding:'16px 20px', borderBottom:`1px solid ${colors.border}`, display:'flex', alignItems:'center', justifyContent:'space-between' }}>
              <div style={{ display:'flex', alignItems:'center', gap:'8px' }}>
                <History size={16} color={colors.green} />
                <span style={{ fontWeight:700, fontSize:'15px', color:colors.textPrimary }}>Historial de compras</span>
                <span style={{ fontSize:'12px', color:colors.textSecondary }}>— {conversation.contact_name || conversation.phone_number}</span>
              </div>
              <button onClick={() => setShowHistory(false)} style={{ background:'none', border:'none', cursor:'pointer', color:colors.textSecondary, padding:'4px' }}><X size={18} /></button>
            </div>

            {/* Body */}
            <div style={{ flex:1, overflowY:'auto', padding:'16px 20px' }}>
              {historyLoading ? (
                <div style={{ display:'flex', alignItems:'center', justifyContent:'center', padding:'40px', color:colors.textSecondary }}>
                  <Loader size={20} style={{ animation:'spin 1s linear infinite' }} />
                </div>
              ) : !historyData || (historyData.shopifyOrders.length === 0 && historyData.botOrders.length === 0) ? (
                <div style={{ textAlign:'center', color:colors.textSecondary, padding:'40px', fontSize:'13px' }}>Sin compras registradas</div>
              ) : (
                <>
                  {/* Resumen — combina Shopify + bot */}
                  {(() => {
                    const botTotal = (historyData.botOrders || []).reduce((s, o) => s + parseFloat(o.total_price || 0), 0);
                    const totalGastado = historyData.summary.totalGastado + botTotal;
                    const totalPedidos = historyData.summary.totalPedidos + (historyData.botOrders || []).length;
                    const allDates = [
                      historyData.summary.ultimaCompra,
                      ...(historyData.botOrders || []).map(o => o.created_at),
                    ].filter(Boolean).map(d => new Date(d));
                    const ultimaCompra = allDates.length ? new Date(Math.max(...allDates)) : null;
                    return (
                      <>
                        <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:'10px', marginBottom: historyData.contactAddress ? '10px' : '16px' }}>
                          {[
                            { label:'Pedidos', value: totalPedidos },
                            { label:'Total gastado', value: `$${Number(totalGastado).toLocaleString('es-CL')}` },
                            { label:'Última compra', value: ultimaCompra ? ultimaCompra.toLocaleDateString('es-CL', { day:'numeric', month:'short', year:'numeric' }) : '—' },
                          ].map(({ label, value }) => (
                            <div key={label} style={{ backgroundColor:colors.bg, borderRadius:'10px', padding:'10px 12px', border:`1px solid ${colors.border}` }}>
                              <div style={{ fontSize:'10px', color:colors.textSecondary, marginBottom:'4px' }}>{label}</div>
                              <div style={{ fontSize:'14px', fontWeight:700, color:colors.textPrimary }}>{value}</div>
                            </div>
                          ))}
                        </div>
                        {historyData.contactAddress && (
                          <div style={{ display:'flex', alignItems:'center', gap:'6px', backgroundColor:colors.bg, borderRadius:'8px', padding:'8px 12px', border:`1px solid ${colors.border}`, marginBottom:'16px', fontSize:'12px', color:colors.textSecondary }}>
                            <span style={{ fontSize:'13px' }}>📍</span>
                            <span><strong style={{ color:colors.textPrimary }}>Dirección registrada:</strong> {historyData.contactAddress}</span>
                          </div>
                        )}
                      </>
                    );
                  })()}

                  {/* Lista unificada: Shopify + bot, ordenados por fecha desc */}
                  <div style={{ display:'flex', flexDirection:'column', gap:'8px' }}>
                    {[
                      ...(historyData.shopifyOrders || []).map(o => ({ ...o, _source: 'shopify', _date: o.shopify_created_at })),
                      ...(historyData.botOrders     || []).map(o => ({ ...o, _source: 'bot',     _date: o.created_at })),
                    ]
                      .sort((a, b) => new Date(b._date) - new Date(a._date))
                      .map((o, i) => {
                        const fecha = o._date ? new Date(o._date).toLocaleDateString('es-CL', { day:'numeric', month:'short', year:'numeric' }) : '—';
                        const items = Array.isArray(o.items) ? o.items : [];
                        const isShopify = o._source === 'shopify';
                        const fs = isShopify ? (o.financial_status||'').toUpperCase() : (o.status||'').toUpperCase();
                        const fsColor = ['PAID','CONFIRMED','PAYMENT_RECEIVED'].includes(fs) ? colors.green : ['PENDING','NUEVO','SENT'].includes(fs) ? colors.yellow : colors.textSecondary;
                        const fsLabel = { PAID:'Pagado', PENDING:'Pendiente', REFUNDED:'Reembolsado', VOIDED:'Anulado', NUEVO:'Nuevo', CONFIRMED:'Confirmado', PAYMENT_RECEIVED:'Pagado', SENT:'Enviado' }[fs] || fs;
                        return (
                          <div key={i} style={{ backgroundColor:colors.bg, borderRadius:'10px', padding:'12px 14px', border:`1px solid ${colors.border}` }}>
                            <div style={{ display:'flex', justifyContent:'space-between', marginBottom:'6px' }}>
                              <div style={{ display:'flex', alignItems:'center', gap:'6px' }}>
                                <span style={{ fontSize:'10px', padding:'1px 6px', borderRadius:'4px', backgroundColor: isShopify ? '#0d2020' : colors.bgSub, color: isShopify ? '#4db6ac' : colors.textSecondary, border:`1px solid ${isShopify ? '#1a3d3d' : colors.border}` }}>
                                  {isShopify ? 'Shopify' : 'Bot'}
                                </span>
                                <span style={{ fontSize:'12px', color:colors.textSecondary }}>{fecha}{o.shopify_name ? ` · ${o.shopify_name}` : ''}</span>
                              </div>
                              <div style={{ display:'flex', alignItems:'center', gap:'8px' }}>
                                <span style={{ fontSize:'11px', color:fsColor, fontWeight:600 }}>{fsLabel}</span>
                                <span style={{ fontSize:'13px', fontWeight:700, color:colors.textPrimary }}>${Number(o.total_price||0).toLocaleString('es-CL')}</span>
                              </div>
                            </div>
                            {items.length > 0 && (
                              <div style={{ fontSize:'11px', color:colors.textSecondary }}>
                                {items.map(it => `${it.quantity}x ${it.name || it.title}`).join(' · ')}
                              </div>
                            )}
                            {(() => {
                              const addr = isShopify
                                ? [o.shipping_address1, o.shipping_city].filter(Boolean).join(', ')
                                : (o.shipping_address || '');
                              return addr ? (
                                <div style={{ fontSize:'11px', color:colors.textMuted, marginTop:'4px', display:'flex', alignItems:'center', gap:'4px' }}>
                                  📍 {addr}
                                </div>
                              ) : null;
                            })()}
                          </div>
                        );
                      })}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Modal de templates */}
      {/* ── Modal Nueva Orden ── */}
      {showOrderModal && (
        <div style={{ position:'fixed', inset:0, backgroundColor:'rgba(0,0,0,0.6)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center', padding:'16px' }}>
          <div style={{ backgroundColor: colors.bgPanel, borderRadius:'14px', border:`1px solid ${colors.border}`, width:'100%', maxWidth:'520px', maxHeight:'85vh', display:'flex', flexDirection:'column', boxShadow:'0 20px 60px rgba(0,0,0,0.5)' }}>

            {/* Header */}
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'16px 20px', borderBottom:`1px solid ${colors.border}` }}>
              <div style={{ display:'flex', alignItems:'center', gap:'8px', flexWrap:'wrap' }}>
                <ShoppingCart size={16} color={colors.green} />
                <span style={{ fontWeight:700, fontSize:'15px', color:colors.textPrimary }}>Nueva orden</span>
                <span style={{ fontSize:'12px', color:colors.textMuted }}>— {conversation.contact_name || conversation.phone_number}</span>
                {isEmpresa && (
                  <span style={{ fontSize:'10px', fontWeight:700, backgroundColor:'#6366f120', color:'#6366f1', border:'1px solid #6366f155', borderRadius:'20px', padding:'2px 8px' }}>
                    🏢 Productos empresa
                  </span>
                )}
              </div>
              <button onClick={() => setShowOrderModal(false)} style={{ background:'none', border:'none', cursor:'pointer', color:colors.textMuted, padding:'4px' }}>
                <X size={18} />
              </button>
            </div>

            {/* Product list */}
            <div style={{ flex:1, overflowY:'auto', padding:'12px 16px' }}>
              {productsLoading ? (
                <div style={{ textAlign:'center', padding:'40px', color:colors.textMuted }}>Cargando productos...</div>
              ) : products.length === 0 ? (
                <div style={{ textAlign:'center', padding:'40px', color:colors.textMuted }}>
                  {isEmpresa
                    ? '⚠️ No hay productos marcados como empresa. Ve a Productos → editar → activar "Solo para empresas (B2B)".'
                    : 'No hay productos en el catálogo'}
                </div>
              ) : products.map(p => {
                const qty = orderItems[p.id] || 0;
                return (
                  <div key={p.id} style={{ display:'flex', alignItems:'center', gap:'12px', padding:'10px 0', borderBottom:`1px solid ${colors.border}` }}>
                    {p.image_url && <img src={p.image_url} alt={p.title} style={{ width:'44px', height:'44px', borderRadius:'8px', objectFit:'cover', flexShrink:0 }} />}
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontWeight:600, fontSize:'13px', color:colors.textPrimary }}>{p.title}</div>
                      <div style={{ fontSize:'12px', color:colors.green, fontWeight:700 }}>${parseFloat(p.price).toLocaleString('es-CL')}</div>
                    </div>
                    <div style={{ display:'flex', alignItems:'center', gap:'8px', flexShrink:0 }}>
                      <button onClick={() => setQty(p.id, -1)} disabled={qty===0} style={{ width:'28px', height:'28px', borderRadius:'50%', border:`1px solid ${colors.border}`, background:'none', cursor:qty===0?'not-allowed':'pointer', color:colors.textSecondary, display:'flex', alignItems:'center', justifyContent:'center', opacity:qty===0?0.4:1 }}>
                        <Minus size={12} />
                      </button>
                      <span style={{ minWidth:'20px', textAlign:'center', fontWeight:700, fontSize:'14px', color:qty>0?colors.green:colors.textMuted }}>{qty}</span>
                      <button onClick={() => setQty(p.id, +1)} style={{ width:'28px', height:'28px', borderRadius:'50%', border:`1px solid ${colors.green}`, background:colors.green, cursor:'pointer', color:'#fff', display:'flex', alignItems:'center', justifyContent:'center' }}>
                        <Plus size={12} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Footer */}
            <div style={{ padding:'14px 20px', borderTop:`1px solid ${colors.border}` }}>
              {/* Dirección de despacho */}
              <div style={{ marginBottom:'12px', display:'flex', flexDirection:'column', gap:'6px' }}>
                <div style={{ fontSize:'11px', color:colors.textSecondary, textTransform:'uppercase', letterSpacing:'0.5px' }}>Dirección de despacho</div>
                <input
                  value={orderAddress} onChange={e => setOrderAddress(e.target.value)}
                  placeholder="Calle y número"
                  style={{ backgroundColor:colors.bgSub, color:colors.textPrimary, border:`1px solid ${colors.border}`, borderRadius:'8px', padding:'7px 10px', fontSize:'13px', outline:'none' }}
                />
                <input
                  value={orderCity} onChange={e => setOrderCity(e.target.value)}
                  placeholder="Ciudad / Comuna"
                  style={{ backgroundColor:colors.bgSub, color:colors.textPrimary, border:`1px solid ${colors.border}`, borderRadius:'8px', padding:'7px 10px', fontSize:'13px', outline:'none' }}
                />
              </div>
              <label style={{ display:'flex', alignItems:'center', gap:'8px', marginBottom:'12px', cursor:'pointer', fontSize:'13px', color:colors.textSecondary }}>
                <input type="checkbox" checked={sendSummary} onChange={e => setSendSummary(e.target.checked)} />
                Enviar resumen por WhatsApp al cliente
              </label>
              {orderError && <div style={{ color:colors.red, fontSize:'12px', marginBottom:'8px' }}>{orderError}</div>}
              <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
                <div>
                  <span style={{ fontSize:'12px', color:colors.textMuted }}>Total: </span>
                  <span style={{ fontWeight:700, fontSize:'16px', color:colors.green }}>${orderTotal.toLocaleString('es-CL')}</span>
                </div>
                <button onClick={handleCreateOrder} disabled={creatingOrder || Object.keys(orderItems).length===0} style={{ display:'flex', alignItems:'center', gap:'6px', padding:'8px 20px', borderRadius:'8px', border:'none', backgroundColor:Object.keys(orderItems).length>0?colors.green:colors.bgHover, color:Object.keys(orderItems).length>0?'#fff':colors.textMuted, fontWeight:700, fontSize:'13px', cursor:creatingOrder||Object.keys(orderItems).length===0?'not-allowed':'pointer', opacity:creatingOrder?0.7:1 }}>
                  <ShoppingCart size={14} />
                  {creatingOrder ? 'Creando...' : 'Crear orden'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

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

      {/* ── Modal Análisis de conversación ── */}
      {showAnalysis && (
        <div onClick={() => setShowAnalysis(false)} style={{ position:'fixed', inset:0, backgroundColor:'rgba(0,0,0,0.65)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center', padding:'16px' }}>
          <div onClick={e => e.stopPropagation()} style={{ backgroundColor: colors.bgPanel, borderRadius:'14px', border:`1px solid ${colors.border}`, width:'100%', maxWidth:'560px', maxHeight:'85vh', display:'flex', flexDirection:'column', boxShadow:'0 20px 60px rgba(0,0,0,0.5)' }}>
            {/* Header */}
            <div style={{ padding:'16px 20px', borderBottom:`1px solid ${colors.border}`, display:'flex', justifyContent:'space-between', alignItems:'center' }}>
              <div style={{ display:'flex', alignItems:'center', gap:'8px' }}>
                <BarChart2 size={16} color='#a78bfa' />
                <span style={{ fontWeight:600, color:colors.textPrimary, fontSize:'14px' }}>Análisis de conversación</span>
              </div>
              <button onClick={() => setShowAnalysis(false)} style={{ background:'none', border:'none', cursor:'pointer', color:colors.textMuted, padding:'2px', display:'flex', alignItems:'center' }}>
                <X size={18} />
              </button>
            </div>

            {/* Body */}
            <div style={{ overflowY:'auto', padding:'20px', flex:1 }}>
              {analysisLoading && (
                <div style={{ display:'flex', flexDirection:'column', alignItems:'center', gap:'12px', padding:'40px 0', color:colors.textMuted }}>
                  <Loader size={24} style={{ animation:'spin 1s linear infinite' }} />
                  <span style={{ fontSize:'13px' }}>Analizando conversación con IA...</span>
                </div>
              )}

              {!analysisLoading && analysisData?.error && (
                <div style={{ padding:'12px', backgroundColor:'#ef444420', borderRadius:'8px', color:'#ef4444', fontSize:'13px' }}>
                  {analysisData.error}
                </div>
              )}

              {!analysisLoading && analysisData && !analysisData.error && (() => {
                const a = analysisData;
                const puntaje = a.puntaje_bot || 0;
                const puntajeColor = puntaje >= 4 ? '#22c55e' : puntaje >= 3 ? '#f59e0b' : '#ef4444';
                const estadoColors = {
                  'compró': '#22c55e', 'agendó': '#a78bfa', 'interesado': '#f59e0b',
                  'exploró': colors.textMuted, 'insatisfecho': '#ef4444', 'se dio de baja': '#6b7280', 'otro': colors.textMuted,
                };
                const estadoColor = estadoColors[a.estado_final] || colors.textMuted;

                const Section = ({ title, color, items }) => items?.length ? (
                  <div style={{ marginBottom:'16px' }}>
                    <div style={{ fontSize:'11px', fontWeight:700, color, textTransform:'uppercase', letterSpacing:'0.05em', marginBottom:'6px' }}>{title}</div>
                    <ul style={{ margin:0, paddingLeft:'16px', display:'flex', flexDirection:'column', gap:'4px' }}>
                      {items.map((item, i) => (
                        <li key={i} style={{ fontSize:'13px', color:colors.textPrimary, lineHeight:'1.4' }}>{item}</li>
                      ))}
                    </ul>
                  </div>
                ) : null;

                return (
                  <div style={{ display:'flex', flexDirection:'column', gap:'4px' }}>
                    {/* Resumen */}
                    <div style={{ backgroundColor:colors.bgSecondary, borderRadius:'10px', padding:'14px', marginBottom:'16px' }}>
                      <div style={{ fontSize:'13px', color:colors.textPrimary, lineHeight:'1.5' }}>{a.resumen}</div>
                    </div>

                    {/* Métricas clave */}
                    <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:'10px', marginBottom:'16px' }}>
                      <div style={{ backgroundColor:colors.bgSecondary, borderRadius:'10px', padding:'12px', textAlign:'center' }}>
                        <div style={{ fontSize:'22px', fontWeight:700, color:puntajeColor }}>{puntaje}/5</div>
                        <div style={{ fontSize:'11px', color:colors.textMuted, marginTop:'2px' }}>Puntaje bot</div>
                      </div>
                      <div style={{ backgroundColor:colors.bgSecondary, borderRadius:'10px', padding:'12px', textAlign:'center' }}>
                        <div style={{ fontSize:'13px', fontWeight:600, color:estadoColor }}>{a.estado_final || '—'}</div>
                        <div style={{ fontSize:'11px', color:colors.textMuted, marginTop:'2px' }}>
                          {a.estado_aplicado ? `✓ Aplicado (${a.estado_aplicado})` : 'Estado final'}
                        </div>
                      </div>
                      <div style={{ backgroundColor:colors.bgSecondary, borderRadius:'10px', padding:'12px', textAlign:'center' }}>
                        <div style={{ fontSize:'13px', fontWeight:600, color: a.deteccion_correcta ? '#22c55e' : '#ef4444' }}>
                          {a.deteccion_correcta ? '✓ Correcto' : '✗ Falló'}
                        </div>
                        <div style={{ fontSize:'11px', color:colors.textMuted, marginTop:'2px' }}>Detección</div>
                      </div>
                    </div>

                    {/* Intención */}
                    {a.intencion_cliente && (
                      <div style={{ marginBottom:'16px' }}>
                        <div style={{ fontSize:'11px', fontWeight:700, color:colors.textMuted, textTransform:'uppercase', letterSpacing:'0.05em', marginBottom:'4px' }}>Intención del cliente</div>
                        <div style={{ fontSize:'13px', color:colors.textPrimary }}>{a.intencion_cliente}</div>
                      </div>
                    )}

                    <Section title="✓ Aciertos" color="#22c55e" items={a.aciertos} />
                    <Section title="✗ Errores detectados" color="#ef4444" items={a.errores} />
                    <Section title="💡 Oportunidades de mejora" color="#f59e0b" items={a.oportunidades} />

                    {/* Próxima acción */}
                    {a.proxima_accion && (
                      <div style={{ backgroundColor:'#a78bfa18', border:'1px solid #a78bfa40', borderRadius:'10px', padding:'12px' }}>
                        <div style={{ fontSize:'11px', fontWeight:700, color:'#a78bfa', textTransform:'uppercase', letterSpacing:'0.05em', marginBottom:'4px' }}>Próxima acción recomendada</div>
                        <div style={{ fontSize:'13px', color:colors.textPrimary }}>{a.proxima_accion}</div>
                      </div>
                    )}
                  </div>
                );
              })()}
            </div>

            {/* Panel de mejoras del bot */}
            {!analysisLoading && improvementsData && !improvementsData.error && (
              <div style={{ borderTop:`1px solid ${colors.border}`, padding:'16px 20px', backgroundColor: colors.bgSecondary }}>
                <div style={{ fontSize:'12px', fontWeight:700, color:'#f59e0b', textTransform:'uppercase', letterSpacing:'0.05em', marginBottom:'10px' }}>
                  🤖 Reglas generadas para el bot
                </div>
                {improvementsData.newRules.length === 0 ? (
                  <div style={{ fontSize:'13px', color:colors.textMuted }}>No se detectaron mejoras necesarias.</div>
                ) : (
                  <>
                    <div style={{ display:'flex', flexDirection:'column', gap:'6px', marginBottom:'12px' }}>
                      {improvementsData.newRules.map((rule, i) => (
                        <div key={i} style={{ display:'flex', alignItems:'flex-start', gap:'8px', fontSize:'13px', color:colors.textPrimary, backgroundColor:colors.bgPanel, borderRadius:'8px', padding:'8px 10px', border:`1px solid ${colors.border}` }}>
                          <span style={{ color:'#f59e0b', fontWeight:700, flexShrink:0 }}>{i+1}.</span>
                          <span style={{ lineHeight:'1.4' }}>{rule}</span>
                        </div>
                      ))}
                    </div>
                    {improvementsData.existing.length > 0 && (
                      <div style={{ fontSize:'11px', color:colors.textMuted, marginBottom:'10px' }}>
                        + {improvementsData.existing.length} regla(s) ya guardadas se mantienen
                      </div>
                    )}
                    {rulesSaved ? (
                      <div style={{ fontSize:'13px', color:'#22c55e', display:'flex', alignItems:'center', gap:'6px' }}>
                        ✓ Reglas guardadas — el bot las aplicará desde ahora
                      </div>
                    ) : (
                      <button
                        onClick={() => saveRules(improvementsData.combined)}
                        disabled={savingRules}
                        style={{ fontSize:'13px', fontWeight:600, color:'#fff', backgroundColor:'#f59e0b', border:'none', borderRadius:'8px', padding:'8px 16px', cursor: savingRules ? 'not-allowed' : 'pointer', opacity: savingRules ? 0.7 : 1 }}
                      >
                        {savingRules ? 'Guardando...' : '💾 Guardar en el bot'}
                      </button>
                    )}
                  </>
                )}
              </div>
            )}
            {!analysisLoading && improvementsData?.error && (
              <div style={{ borderTop:`1px solid ${colors.border}`, padding:'12px 20px', color:'#ef4444', fontSize:'13px' }}>
                Error generando mejoras: {improvementsData.error}
              </div>
            )}

            {/* Footer */}
            {!analysisLoading && (
              <div style={{ padding:'12px 20px', borderTop:`1px solid ${colors.border}`, display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                <button onClick={openAnalysis} style={{ fontSize:'12px', color:'#a78bfa', background:'none', border:'none', cursor:'pointer', display:'flex', alignItems:'center', gap:'4px' }}>
                  <BarChart2 size={12} /> Volver a analizar
                </button>
                {analysisData && !analysisData.error && (analysisData.errores?.length || analysisData.oportunidades?.length) ? (
                  improvementsLoading ? (
                    <span style={{ fontSize:'12px', color:'#f59e0b' }}>Generando mejoras...</span>
                  ) : !improvementsData ? (
                    <button
                      onClick={() => generateImprovements(analysisData)}
                      style={{ fontSize:'12px', fontWeight:600, color:'#f59e0b', background:'none', border:`1px solid #f59e0b`, borderRadius:'6px', padding:'4px 10px', cursor:'pointer', display:'flex', alignItems:'center', gap:'4px' }}
                    >
                      🚀 Mejorar bot con este análisis
                    </button>
                  ) : null
                ) : null}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
