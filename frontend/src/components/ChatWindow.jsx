import { useState, useRef, useEffect, useCallback } from 'react';
import { Bot, User, Send, Play, ThumbsUp, ThumbsDown, Trash2, FileText, X, Loader, AlertCircle, ChevronLeft, ShoppingCart, Plus, Minus, GitMerge, Search, History, BellOff, BarChart2, MessagesSquare, MoreVertical, Pencil, Paperclip, Image as ImageIcon, CircleDollarSign, CheckCircle2, Pin, StickyNote, Megaphone } from 'lucide-react';
import MessageBubble from './MessageBubble.jsx';
import AgentToggle from './AgentToggle.jsx';
import ClientAddressFields from './ClientAddressFields.jsx';
import OrderProductEditor from './OrderProductEditor.jsx';
import { conversationsAPI, api } from '../utils/api.js';
import { useTheme } from '../theme.js';
import { buildBodyTemplateComponent, getBodyComponent, getTemplateVariables, renderTemplate } from '../utils/template-renderer.js';
import { alertOrderEditNotification } from '../utils/order-edit-notification.js';

const DEV_EMAIL = 'raivaldiviabou@gmail.com';

const channelKey = (item) => item?.whatsapp_channel_id
  ? `channel:${item.whatsapp_channel_id}`
  : `official:${item?.whatsapp_provider || 'meta'}`;

const channelLabel = (item) => {
  const provider = item?.whatsapp_provider === 'evolution'
    ? 'Evolution'
    : item?.whatsapp_provider === 'kapso'
      ? 'Kapso'
      : 'WhatsApp oficial';
  const channel = item?.whatsapp_channel_phone
    ? `+${String(item.whatsapp_channel_phone).replace(/^\+/, '')}`
    : item?.whatsapp_channel_name || 'número sin identificar';
  return `${provider} · ${channel}`;
};

const normalizeProductSearch = (value) => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .trim();

export default function ChatWindow({ conversation, messages, onSendMessage, onToggleAgentMode, onRefresh, onEscalationFeedback, onDeleteMessages, currentUserEmail, onBack, isMobile, botTyping, onConversationUpdated, onAlternateConversationStarted, onSelectConversation }) {
  const { colors, isDark } = useTheme();
  const [inputText, setInputText] = useState('');
  const [sending, setSending] = useState(false);
  const [attachment, setAttachment] = useState(null);
  const [dragActive, setDragActive] = useState(false);
  const [error, setError] = useState(null);
  const [feedbackSent, setFeedbackSent] = useState(null); // 'correct' | 'unnecessary' | null
  const [deleting, setDeleting] = useState(false);
  const [mobileActionsOpen, setMobileActionsOpen] = useState(false);
  const [alternateSend, setAlternateSend] = useState(null);
  const [alternateSending, setAlternateSending] = useState(false);
  const [alternateError, setAlternateError] = useState('');
  const [channelConversations, setChannelConversations] = useState([conversation]);
  const [loadingChannels, setLoadingChannels] = useState(false);
  const [isPinned, setIsPinned] = useState(!!conversation.is_pinned);
  const [pinSaving, setPinSaving] = useState(false);
  const [customerNote, setCustomerNote] = useState(conversation.contact_notes || '');
  const [showNoteEditor, setShowNoteEditor] = useState(false);
  const [noteDraft, setNoteDraft] = useState(conversation.contact_notes || '');
  const [noteSaving, setNoteSaving] = useState(false);
  const [noteError, setNoteError] = useState('');

  useEffect(() => {
    setMobileActionsOpen(false);
    setAttachment(null);
    setAlternateSend(null);
    setAlternateError('');
    setIsPinned(!!conversation.is_pinned);
    setCustomerNote(conversation.contact_notes || '');
    setNoteDraft(conversation.contact_notes || '');
    setShowNoteEditor(false);
    setNoteError('');
  }, [conversation.id]);

  useEffect(() => {
    setIsPinned(!!conversation.is_pinned);
  }, [conversation.is_pinned]);

  useEffect(() => {
    setCustomerNote(conversation.contact_notes || '');
    if (!showNoteEditor) setNoteDraft(conversation.contact_notes || '');
  }, [conversation.contact_notes, showNoteEditor]);

  const handleTogglePin = useCallback(async () => {
    if (pinSaving) return;
    const nextPinned = !isPinned;
    setPinSaving(true);
    try {
      const { data } = await api.patch(`/conversations/${conversation.id}/pin`, { pinned: nextPinned });
      const updated = data?.data || { ...conversation, is_pinned: nextPinned, pinned_at: nextPinned ? new Date().toISOString() : null };
      setIsPinned(!!updated.is_pinned);
      onConversationUpdated?.(updated);
    } catch (err) {
      setError(err.response?.data?.error || 'No se pudo fijar la conversación');
    } finally {
      setPinSaving(false);
    }
  }, [conversation, isPinned, onConversationUpdated, pinSaving]);

  const openNoteEditor = useCallback(() => {
    setNoteDraft(customerNote);
    setNoteError('');
    setShowNoteEditor(true);
  }, [customerNote]);

  const handleSaveCustomerNote = useCallback(async () => {
    if (noteDraft.trim().length > 1000) {
      setNoteError('La nota no puede superar 1000 caracteres.');
      return;
    }
    setNoteSaving(true);
    setNoteError('');
    try {
      const { data } = await api.patch(`/conversations/${conversation.id}/customer-note`, { note: noteDraft });
      const saved = data?.note || '';
      setCustomerNote(saved);
      setNoteDraft(saved);
      setShowNoteEditor(false);
      onConversationUpdated?.(data?.data || { ...conversation, contact_notes: saved });
    } catch (err) {
      setNoteError(err.response?.data?.error || 'No se pudo guardar la nota.');
    } finally {
      setNoteSaving(false);
    }
  }, [conversation, noteDraft, onConversationUpdated]);

  useEffect(() => {
    let cancelled = false;
    setChannelConversations([conversation]);
    setLoadingChannels(true);

    conversationsAPI.getByPhone(conversation.phone_number)
      .then((rows) => {
        if (cancelled) return;
        const unique = new Map([[channelKey(conversation), conversation]]);
        rows.forEach((row) => {
          const key = channelKey(row);
          if (!unique.has(key)) unique.set(key, row);
        });
        setChannelConversations([...unique.values()]);
      })
      .catch(() => {
        if (!cancelled) setChannelConversations([conversation]);
      })
      .finally(() => {
        if (!cancelled) setLoadingChannels(false);
      });

    return () => { cancelled = true; };
  }, [conversation.id, conversation.phone_number]);

  const selectChannelConversation = useCallback((conversationId) => {
    if (Number(conversationId) !== Number(conversation.id)) return onSelectConversation?.(Number(conversationId));
  }, [conversation.id, onSelectConversation]);

  // ── Editar contacto ──────────────────────────────────────────────
  const [showEditContact, setShowEditContact]     = useState(false);
  const [editContactName, setEditContactName]     = useState('');
  const [editContactAddress, setEditContactAddress] = useState('');
  const [editContactCity, setEditContactCity]     = useState('');
  const [savingContact, setSavingContact]         = useState(false);
  const [localContactName, setLocalContactName]   = useState(null); // override local del nombre
  const [editContactFromHistory, setEditContactFromHistory] = useState(false);

  const openEditContact = useCallback(async () => {
    setEditContactName(conversation.contact_name || '');
    setEditContactAddress('');
    setEditContactCity('');
    // Intentar cargar datos actuales del contacto
    try {
      const r = await api.get('/contacts/by-phone', { params: { phone: conversation.phone_number } });
      const ct = r.data?.contact;
      if (ct) {
        setEditContactName(ct.name || conversation.contact_name || '');
        setEditContactAddress(ct.address || '');
        setEditContactCity(ct.city || '');
      }
    } catch (_) {}
    setShowEditContact(true);
  }, [conversation.contact_name, conversation.phone_number]);

  const handleSaveContact = useCallback(async () => {
    if (!editContactName.trim() && !editContactAddress.trim()) return;
    setSavingContact(true);
    try {
      await api.patch(`/contacts/${encodeURIComponent(conversation.phone_number)}`, {
        name:    editContactName.trim(),
        address: editContactAddress.trim() || undefined,
        city:    editContactCity.trim() || undefined,
      });
      if (editContactName.trim()) setLocalContactName(editContactName.trim());
      setShowEditContact(false);
      if (editContactFromHistory) {
        const nextAddress = [editContactAddress.trim(), editContactCity.trim()].filter(Boolean).join(', ');
        setHistoryData(current => current ? { ...current, contactAddress: nextAddress || null } : current);
        setShowHistory(true);
        setEditContactFromHistory(false);
      }
      onConversationUpdated?.({ ...conversation, contact_name: editContactName.trim() || conversation.contact_name });
    } catch (err) {
      alert('Error guardando: ' + (err.response?.data?.error || err.message));
    } finally {
      setSavingContact(false);
    }
  }, [conversation, editContactName, editContactAddress, editContactCity, editContactFromHistory, onConversationUpdated]);

  // Historial de compras
  const [showHistory, setShowHistory]       = useState(false);
  const [historyData, setHistoryData]       = useState(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyEdit, setHistoryEdit]       = useState(null);
  const [historyEditSaving, setHistoryEditSaving] = useState(false);
  const [historyEditError, setHistoryEditError] = useState('');
  const [historyProducts, setHistoryProducts] = useState([]);
  const [historyProductsLoading, setHistoryProductsLoading] = useState(false);
  const [historyPayment, setHistoryPayment] = useState(null);
  const [historyPaymentSaving, setHistoryPaymentSaving] = useState(false);
  const [historyPaymentError, setHistoryPaymentError] = useState('');

  const closeContactEditor = useCallback(() => {
    setShowEditContact(false);
    if (editContactFromHistory) {
      setEditContactFromHistory(false);
      setShowHistory(true);
    }
  }, [editContactFromHistory]);

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

  const reloadHistory = useCallback(async () => {
    const phone = conversation.phone_number;
    if (!phone) return;
    const res = await api.get(`/orders/history/${encodeURIComponent(phone)}`);
    setHistoryData(res.data?.data || null);
  }, [conversation.phone_number]);

  const openHistoryEdit = useCallback((order) => {
    let items = [];
    try { items = Array.isArray(order.items) ? order.items : JSON.parse(order.items || '[]'); } catch { items = []; }
    if (!Array.isArray(items)) items = [];
    let address = '';
    let city = '';
    if (order._source === 'shopify') {
      address = order.shipping_address1 || '';
      city = order.shipping_city || '';
    } else {
      let raw = order.shipping_address;
      if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { raw = {}; } }
      address = raw?.address || raw?.address1 || '';
      city = raw?.city || '';
    }
    setHistoryEdit({
      source: order._source,
      id: order._source === 'shopify' ? order.shopify_order_id : order.id,
      dbId: order.id,
      label: order.shopify_name || `#${order.id}`,
      address,
      city,
      note: order.delivery_note || (order._source === 'bot' ? order.notes : '') || '',
      updateContact: true,
      items: items.map((item, index) => ({
        key: `${Date.now()}_${index}`,
        name: item.name || item.title || '',
        quantity: Math.max(1, Number(item.quantity) || 1),
        price: Math.max(0, Number(item.price) || 0),
      })),
    });
    setHistoryEditError('');
    setHistoryProductsLoading(true);
    api.get('/products')
      .then(response => {
        const catalog = response.data?.products || response.data?.data || [];
        setHistoryProducts(catalog.filter(product => product.active !== false));
      })
      .catch(() => setHistoryProducts([]))
      .finally(() => setHistoryProductsLoading(false));
  }, []);

  const updateHistoryItem = useCallback((key, field, value) => {
    setHistoryEdit(current => current ? {
      ...current,
      items: current.items.map(item => item.key === key ? { ...item, [field]: value } : item),
    } : current);
  }, []);

  const selectHistoryProduct = useCallback((key, productId) => {
    const product = historyProducts.find(item => String(item.id) === String(productId));
    if (!product) return;
    setHistoryEdit(current => current ? {
      ...current,
      items: current.items.map(item => item.key === key ? {
        ...item,
        name: product.title || item.name,
        price: Math.max(0, Number(product.price) || 0),
      } : item),
    } : current);
  }, [historyProducts]);

  const saveHistoryEdit = useCallback(async () => {
    if (!historyEdit) return;
    const address = historyEdit.address.trim();
    const cleanItems = historyEdit.items.map(item => ({
      name: item.name.trim(),
      quantity: Math.max(0, Math.round(Number(item.quantity) || 0)),
      price: Math.max(0, Math.round(Number(item.price) || 0)),
    })).filter(item => item.name && item.quantity > 0);
    if (!address) { setHistoryEditError('Ingresa la dirección de entrega.'); return; }
    if (!cleanItems.length) { setHistoryEditError('El pedido debe tener al menos un producto.'); return; }
    setHistoryEditSaving(true);
    setHistoryEditError('');
    try {
      const { data } = await api.patch('/orders/history-edit', {
        source: historyEdit.source,
        id: historyEdit.id,
        items: cleanItems,
        address,
        city: historyEdit.city.trim(),
        note: historyEdit.note.trim(),
        updateContact: historyEdit.updateContact,
      });
      alertOrderEditNotification(data.notification);
      await reloadHistory();
      setHistoryEdit(null);
    } catch (err) {
      setHistoryEditError(err.response?.data?.error || 'No se pudo guardar el pedido.');
    } finally {
      setHistoryEditSaving(false);
    }
  }, [historyEdit, reloadHistory]);

  const openHistoryPayment = useCallback((order) => {
    const total = Math.round(Number(order.total_price) || 0);
    setHistoryPayment({
      source: order._source,
      id: order._source === 'shopify' ? order.shopify_order_id : order.id,
      label: order.shopify_name || `#${order.id}`,
      total,
      paymentMethod: order.payment_method || 'transferencia',
      cashAmount: '',
      transferAmount: '',
    });
    setHistoryPaymentError('');
  }, []);

  const saveHistoryPayment = useCallback(async () => {
    if (!historyPayment) return;
    const payload = {
      source: historyPayment.source,
      id: historyPayment.id,
      paymentMethod: historyPayment.paymentMethod,
    };
    if (historyPayment.paymentMethod === 'mixto') {
      payload.paymentCashAmount = Number(historyPayment.cashAmount);
      payload.paymentTransferAmount = Number(historyPayment.transferAmount);
      if (payload.paymentCashAmount <= 0 || payload.paymentTransferAmount <= 0 || payload.paymentCashAmount + payload.paymentTransferAmount !== historyPayment.total) {
        setHistoryPaymentError(`Efectivo y transferencia deben sumar $${historyPayment.total.toLocaleString('es-CL')}.`);
        return;
      }
    }
    setHistoryPaymentSaving(true);
    setHistoryPaymentError('');
    try {
      await api.patch('/orders/history-payment', payload);
      await reloadHistory();
      setHistoryPayment(null);
    } catch (err) {
      setHistoryPaymentError(err.response?.data?.error || 'No se pudo registrar el pago.');
    } finally {
      setHistoryPaymentSaving(false);
    }
  }, [historyPayment, reloadHistory]);

  // Order modal state
  const [showOrderModal, setShowOrderModal]   = useState(false);
  const [editingOrderProduct, setEditingOrderProduct] = useState(null);
  const [products, setProducts]               = useState([]);
  const [productsLoading, setProductsLoading] = useState(false);
  const [orderProductSearch, setOrderProductSearch] = useState('');
  const [orderItems, setOrderItems]           = useState({}); // { productId: quantity }
  const [orderAddress, setOrderAddress]       = useState('');
  const [orderCity, setOrderCity]             = useState('');
  const [orderNote, setOrderNote]             = useState('');
  const [sendSummary, setSendSummary]         = useState(true);
  const [creatingOrder, setCreatingOrder]     = useState(false);
  const [orderError, setOrderError]           = useState('');
  const [showNewProdForm, setShowNewProdForm] = useState(false);
  const [newProdForm, setNewProdForm]         = useState({ title: '', price: '', description: '' });
  const [savingNewProd, setSavingNewProd]     = useState(false);
  const [newProdError, setNewProdError]       = useState('');
  const [newProdEmpresas, setNewProdEmpresas] = useState([]); // lista de empresa contacts
  const [newProdSelEmpresas, setNewProdSelEmpresas] = useState(new Set()); // seleccionadas
  const [newProdForEmpresas, setNewProdForEmpresas] = useState(false); // toggle "solo ciertas empresas"
  const [orderDiscount, setOrderDiscount]           = useState('');
  const [orderDiscountType, setOrderDiscountType]   = useState('percent'); // 'percent' | 'fixed'

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
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [paymentPreview, setPaymentPreview] = useState('');
  const [paymentLoading, setPaymentLoading] = useState(false);
  const [paymentSending, setPaymentSending] = useState(false);
  const [paymentError, setPaymentError] = useState('');
  const messagesEndRef = useRef(null);
  const inputRef = useRef(null);
  const fileInputRef = useRef(null);
  const dragDepthRef = useRef(0);

  const isHumanMode = conversation.agent_mode === 'human';
  const isCoordinating = conversation.agent_mode === 'coordinating';
  const isDevUser = currentUserEmail === DEV_EMAIL;
  const HOT_STATES = ['interested', 'collecting_order'];
  const isHotLead = HOT_STATES.includes(conversation.pipeline_state);
  const [clientType, setClientType] = useState(conversation.client_type || 'personal');
  const [togglingEmpresa, setTogglingEmpresa] = useState(false);
  const isEmpresa  = clientType === 'empresa';
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
  useEffect(() => { setClientType(conversation.client_type || 'personal'); }, [conversation.id, conversation.client_type]);

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
    if (togglingEmpresa) return;
    const newType = isEmpresa ? 'personal' : 'empresa';
    setTogglingEmpresa(true);
    try {
      const response = await api.patch(`/conversations/${conversation.id}/client-type`, { clientType: newType });
      const savedType = response.data?.clientType || newType;
      setClientType(savedType);
      onConversationUpdated?.({ ...conversation, client_type: savedType });
      await onRefresh?.();
    } catch (e) {
      console.error(e);
      setError(e.response?.data?.error || 'No se pudo cambiar el tipo de cliente.');
    } finally {
      setTogglingEmpresa(false);
    }
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
        const res = await api.get('/templates');
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
    return getTemplateVariables(getBodyComponent(tpl)?.text || '');
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
    const contactName = conversation.contact_name || conversation.phone_number;
    const values = Object.fromEntries(vars.map(v => {
      const mapping = templateVarMap[v] || 'manual';
      let text = '';
      if (mapping === 'name')  text = contactName;
      else if (mapping === 'phone') text = conversation.phone_number;
      else text = templateManualVars[v] ?? '';
      return [v, text];
    }));
    return buildBodyTemplateComponent(getBodyComponent(selectedTemplate)?.text || '', values);
  };

  const previewTpl = () => {
    if (!selectedTemplate) return '';
    const bodyComp = getBodyComponent(selectedTemplate);
    if (!bodyComp?.text) return `[Template: ${selectedTemplate.name}]`;
    const vars = parseVars(selectedTemplate);
    const contactName = conversation.contact_name || conversation.phone_number;
    const values = {};
    vars.forEach(v => {
      const mapping = templateVarMap[v] || 'manual';
      if (mapping === 'name') values[v] = contactName;
      else if (mapping === 'phone') values[v] = conversation.phone_number;
      else if (Object.prototype.hasOwnProperty.call(templateManualVars, v)) values[v] = templateManualVars[v];
    });
    return renderTemplate(bodyComp.text, values);
  };

  const missingTemplateVars = () => selectedTemplate
    ? parseVars(selectedTemplate).filter(v => {
        const mapping = templateVarMap[v] || 'manual';
        return mapping === 'manual' && (templateManualVars[v] === undefined || templateManualVars[v] === '');
      })
    : [];

  const sendTemplateMessage = async () => {
    if (!selectedTemplate) return;
    const missing = missingTemplateVars();
    if (missing.length) {
      setTemplatesError(`Completa ${missing.map(v => `{{${v}}}`).join(', ')} antes de enviar.`);
      return;
    }
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

  const openPaymentOptions = async () => {
    setShowPaymentModal(true);
    setPaymentPreview('');
    setPaymentError('');
    setPaymentLoading(true);
    try {
      const result = await conversationsAPI.getPaymentOptions(conversation.id);
      setPaymentPreview(result.text || '');
    } catch (err) {
      setPaymentError(err.response?.data?.error || 'No se pudieron cargar las opciones de pago.');
    } finally {
      setPaymentLoading(false);
    }
  };

  const sendPaymentOptions = async () => {
    if (!paymentPreview || paymentSending) return;
    setPaymentSending(true);
    setPaymentError('');
    try {
      await conversationsAPI.sendPaymentOptions(conversation.id);
      setShowPaymentModal(false);
      setError(null);
    } catch (err) {
      setPaymentError(err.response?.data?.message || err.response?.data?.error || 'No se pudieron enviar las opciones de pago.');
    } finally {
      setPaymentSending(false);
    }
  };

  const openExpiredWindowAlternative = async (draftText = '') => {
    const preservedText = draftText || inputText;

    try {
      const peers = await conversationsAPI.getByPhone(conversation.phone_number);
      const evolutionConversation = peers.find(item =>
        item.whatsapp_provider === 'evolution'
        && Number(item.id) !== Number(conversation.id)
      );
      if (evolutionConversation) {
        setAlternateSend(null);
        setAlternateError('');
        setInputText(preservedText);
        setError(null);
        await selectChannelConversation(evolutionConversation.id);
        return;
      }
    } catch (_) {
      // Si falla la búsqueda del historial, se intenta con los canales conectados.
    }

    try {
      const response = await api.get('/settings/whatsapp/channels');
      const channels = (response.data?.data || []).filter(channel =>
        channel.provider === 'evolution'
        && channel.status === 'connected'
        && String(channel.id) !== String(conversation.whatsapp_channel_id || '')
      );
      if (channels.length) {
        const preferred = channels.find(channel => channel.is_default) || channels[0];
        setAlternateError('');
        setAlternateSend({
          channels,
          channelId: String(preferred.id),
          text: preservedText,
        });
        return;
      }
    } catch (_) {
      // Si no se pueden recuperar los otros canales, todavía queda el template.
    }
    if (!conversation.whatsapp_channel_id) await openTemplateModal();
  };

  const sendThroughAlternateChannel = async () => {
    const text = alternateSend?.text?.trim();
    if (!text || alternateSending) return;
    setAlternateSending(true);
    setAlternateError('');
    try {
      const result = await conversationsAPI.startConversation({
        phone: conversation.phone_number,
        name: conversation.contact_name || '',
        text,
        channelId: alternateSend.channelId,
      });
      setAlternateSend(null);
      setInputText('');
      setError(null);
      await onAlternateConversationStarted?.(result.data);
    } catch (err) {
      setAlternateError(err.response?.data?.error || err.message || 'No se pudo enviar por el canal alternativo.');
    } finally {
      setAlternateSending(false);
    }
  };

  const handleSend = async () => {
    const text = inputText.trim();
    if ((!text && !attachment) || sending) return;
    const pendingAttachment = attachment;
    setInputText('');
    setAttachment(null);
    setSending(true);
    setError(null);
    try {
      if (pendingAttachment) {
        await conversationsAPI.sendMedia(conversation.id, {
          data: pendingAttachment.data,
          mimeType: pendingAttachment.mimeType,
          fileName: pendingAttachment.fileName,
          caption: text,
        });
      } else {
        await onSendMessage(conversation.id, text);
      }
    } catch (err) {
      const is24h = err.response?.data?.error === 'WINDOW_EXPIRED';
      if (is24h) {
        setError('⏰ Ventana de 24h expirada — usa otro WhatsApp conectado o un template aprobado.');
        if (!pendingAttachment) await openExpiredWindowAlternative(text);
      } else {
        const serverMessage = err.response?.data?.message;
        const serverError = err.response?.data?.error;
        setError(
          serverMessage && serverMessage !== serverError
            ? serverMessage
            : (typeof serverError === 'string' && !/^ERR_/i.test(serverError)
                ? serverError
                : 'Error enviando el mensaje. Intenta de nuevo.')
        );
      }
      setInputText(text);
      setAttachment(pendingAttachment);
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  };

  const prepareAttachment = (file) => {
    if (!file) return;
    if (file.size > 6 * 1024 * 1024) {
      setError('El archivo supera el máximo de 6 MB.');
      return;
    }
    const extension = String(file.name || '').toLowerCase().split('.').pop();
    const mimeByExtension = {
      jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', webp:'image/webp',
      pdf:'application/pdf', doc:'application/msword',
      docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xls:'application/vnd.ms-excel',
      xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      csv:'text/csv', txt:'text/plain',
    };
    const mimeType = file.type || mimeByExtension[extension] || '';
    const allowed = [
      'image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/csv', 'text/plain',
    ];
    if (!allowed.includes(mimeType)) {
      setError('Formato no permitido. Usa imágenes, PDF, Word, Excel, CSV o TXT.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const imageExtension = {
        'image/jpeg': 'jpg',
        'image/png': 'png',
        'image/webp': 'webp',
      }[mimeType];
      const fileName = file.name || (imageExtension ? `imagen-pegada.${imageExtension}` : 'archivo-adjunto');
      setAttachment({ data: reader.result, mimeType, fileName, size: file.size });
      setError(null);
      inputRef.current?.focus();
    };
    reader.onerror = () => setError('No se pudo leer el archivo.');
    reader.readAsDataURL(file);
  };

  const handleFileSelected = (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    prepareAttachment(file);
  };

  const handleDragEnter = (event) => {
    if (!event.dataTransfer?.types?.includes('Files')) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setDragActive(true);
  };

  const handleDragOver = (event) => {
    if (!event.dataTransfer?.types?.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  };

  const handleDragLeave = (event) => {
    if (!event.dataTransfer?.types?.includes('Files')) return;
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragActive(false);
  };

  const handleDrop = (event) => {
    event.preventDefault();
    dragDepthRef.current = 0;
    setDragActive(false);
    const files = Array.from(event.dataTransfer?.files || []);
    if (files.length > 1) {
      setError('Arrastra un archivo por vez para poder revisarlo antes de enviarlo.');
      return;
    }
    prepareAttachment(files[0]);
  };

  const handlePaste = (event) => {
    const imageItems = Array.from(event.clipboardData?.items || [])
      .filter(item => item.kind === 'file' && ['image/jpeg', 'image/png', 'image/webp'].includes(item.type));
    if (!imageItems.length) return;

    event.preventDefault();
    if (imageItems.length > 1) {
      setError('Pega una imagen por vez para poder revisarla antes de enviarla.');
      return;
    }

    prepareAttachment(imageItems[0].getAsFile());
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const _rawName = localContactName ?? conversation.contact_name;
  const _isGenericName = !_rawName || _rawName === 'Cliente' || /^\d+$/.test(_rawName);
  const displayContactName = _isGenericName ? (conversation.phone_number || '?') : _rawName;
  const initials = displayContactName.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();

  // ── Order modal handlers ────────────────────────────────────────
  const openOrderModal = async () => {
    setShowOrderModal(true);
    setEditingOrderProduct(null);
    setOrderItems({});
    setOrderProductSearch('');
    setOrderAddress('');
    setOrderCity('');
    setOrderNote(customerNote || '');
    setOrderDiscount('');
    setOrderDiscountType('percent');
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
      let displayProds;
      if (isEmpresa) {
        // Para empresas: intentar mostrar SOLO los productos que tienen precio asignado para este cliente
        try {
          const ov = await api.get(`/contacts/${encodeURIComponent(conversation.phone_number)}/prices`);
          const overrides = ov.data.data || [];
          if (overrides.length > 0) {
            // La empresa tiene productos asignados → mostrar SOLO esos con su precio especial
            const overrideMap = {};
            for (const o of overrides) overrideMap[String(o.product_id)] = o.custom_price;
            // Filtrar al catálogo completo (no solo B2B) para encontrar el producto aunque sea mixto
            displayProds = all
              .filter(p => overrideMap[String(p.id)] != null)
              .map(p => ({ ...p, price: overrideMap[String(p.id)], _specialPrice: true }));
          } else {
            // Sin overrides → fallback a todos los productos B2B del catálogo
            displayProds = empresaProds.length > 0 ? empresaProds : all;
          }
        } catch {
          displayProds = empresaProds.length > 0 ? empresaProds : all;
        }
      } else {
        displayProds = normalProds.length > 0 ? normalProds : all;
      }
      setProducts(displayProds);
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
      await api.post(`/conversations/${conversation.id}/orders`, {
        items, sendSummary, shippingAddress,
        discount: discountNum,
        discountType: orderDiscountType,
        note: orderNote.trim(),
      });
      setShowOrderModal(false);
      setOrderItems({});
      setOrderAddress('');
      setOrderCity('');
      setOrderNote('');
      setOrderDiscount('');
      setOrderDiscountType('percent');
    } catch (err) {
      setOrderError(err.response?.data?.error || err.message);
    } finally { setCreatingOrder(false); }
  };

  const handleSaveNewProduct = async () => {
    if (!newProdForm.title.trim() || !newProdForm.price) return;
    setSavingNewProd(true); setNewProdError('');
    try {
      const { data } = await api.post('/products', {
        title: newProdForm.title.trim(),
        price: parseFloat(newProdForm.price),
        description: newProdForm.description.trim() || null,
        active: true,
        stock: -1,
        isBusiness: isEmpresa,
      });
      const newProd = data.product || data;
      // Si se eligieron empresas específicas → asignar precio especial a cada una
      if (newProdForEmpresas && newProdSelEmpresas.size > 0) {
        await api.post('/contacts/prices/bulk', {
          product_id:    String(newProd.id),
          product_title: newProd.title,
          custom_price:  parseFloat(newProdForm.price),
          phones:        [...newProdSelEmpresas],
        }).catch(() => {}); // no bloquear si falla
      }
      setProducts(prev => [...prev, newProd]);
      setNewProdForm({ title: '', price: '', description: '' });
      setNewProdForEmpresas(false);
      setNewProdSelEmpresas(new Set());
      setShowNewProdForm(false);
    } catch (e) {
      setNewProdError(e.response?.data?.error || e.message);
    } finally { setSavingNewProd(false); }
  };

  const orderSubtotal = Object.entries(orderItems).reduce((s, [id, qty]) => {
    const p = products.find(p => String(p.id) === String(id));
    return s + (parseFloat(p?.price || 0) * qty);
  }, 0);
  const discountNum    = parseFloat(orderDiscount) || 0;
  const discountAmount = discountNum > 0
    ? (orderDiscountType === 'percent' ? orderSubtotal * (discountNum / 100) : Math.min(discountNum, orderSubtotal))
    : 0;
  const productSearchTerm = normalizeProductSearch(orderProductSearch);
  const filteredOrderProducts = productSearchTerm
    ? products.filter(product => normalizeProductSearch([
        product.title, product.description, product.sku, product.category,
      ].filter(Boolean).join(' ')).includes(productSearchTerm))
    : products;
  const orderTotal = Math.max(0, orderSubtotal - discountAmount);

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

  const channelSelector = (
    <select
      aria-label="Cambiar historial de canal"
      title={loadingChannels
        ? 'Buscando otros canales de este cliente…'
        : channelConversations.length > 1
          ? 'Cambiar entre los historiales de Evolution y Kapso'
          : 'Este cliente solo tiene historial en este canal'}
      value={String(conversation.id)}
      onChange={(event) => selectChannelConversation(event.target.value)}
      disabled={loadingChannels || channelConversations.length < 2}
      style={{
        maxWidth: isMobile ? '170px' : '280px', minWidth: 0,
        height: isMobile ? '22px' : '24px',
        padding: isMobile ? '1px 22px 1px 6px' : '2px 24px 2px 7px',
        borderRadius: '10px',
        border: `1px solid ${conversation.whatsapp_provider === 'evolution' ? '#3b82f655' : colors.green + '55'}`,
        backgroundColor: conversation.whatsapp_provider === 'evolution' ? '#2563eb22' : `${colors.green}18`,
        color: conversation.whatsapp_provider === 'evolution' ? '#60a5fa' : colors.green,
        fontSize: isMobile ? '9px' : '11px', fontWeight: 700,
        cursor: loadingChannels || channelConversations.length < 2 ? 'default' : 'pointer',
        opacity: loadingChannels ? 0.7 : 1, textOverflow: 'ellipsis',
      }}
    >
      {channelConversations.map((item) => (
        <option key={item.id} value={String(item.id)} style={{ color: colors.textPrimary, backgroundColor: colors.bgPanel }}>
          {channelLabel(item)}
        </option>
      ))}
    </select>
  );

  return (
    <div
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      style={{
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      height: isMobile ? '100%' : '100vh',
      overflow: 'hidden',
      position: 'relative',
      backgroundColor: isDark ? '#0b141a' : '#efeae2',
      backgroundImage: isDark
        ? `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='60' height='60'%3E%3Cpath d='M30 5l5 10h10l-8 7 3 10-10-6-10 6 3-10-8-7h10z' fill='white' fill-opacity='0.03'/%3E%3C/svg%3E")`
        : `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='60' height='60'%3E%3Cpath d='M30 5l5 10h10l-8 7 3 10-10-6-10 6 3-10-8-7h10z' fill='black' fill-opacity='0.035'/%3E%3C/svg%3E")`,
    }}>
      {dragActive && (
        <div style={{
          position:'absolute', inset:'10px', zIndex:80, pointerEvents:'none',
          display:'flex', alignItems:'center', justifyContent:'center', flexDirection:'column', gap:'10px',
          border:`2px dashed ${colors.green}`, borderRadius:'14px',
          backgroundColor:isDark ? 'rgba(8, 31, 30, 0.94)' : 'rgba(232, 250, 246, 0.96)',
          color:colors.textPrimary, boxShadow:'0 10px 32px rgba(0,0,0,0.25)',
        }}>
          <div style={{ width:'58px', height:'58px', borderRadius:'50%', display:'flex', alignItems:'center', justifyContent:'center', backgroundColor:colors.green, color:'#fff' }}>
            <Paperclip size={26} />
          </div>
          <div style={{ fontSize:'17px', fontWeight:700 }}>Suelta el archivo aquí</div>
          <div style={{ fontSize:'12px', color:colors.textSecondary }}>Foto, PDF, Word, Excel, CSV o TXT · máximo 6 MB</div>
        </div>
      )}
      {/* Header */}
      <div style={{
        padding: isMobile ? '8px 10px' : '10px 16px',
        backgroundColor: colors.bgPanel,
        position: isMobile ? 'sticky' : 'relative',
        top: 0,
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
            <button onClick={onBack} aria-label="Volver a todos los chats" title="Volver a todos los chats" style={{
              background: 'none', border: 'none', cursor: 'pointer', padding: '4px',
              color: colors.textSecondary, display: 'flex', alignItems: 'center',
              borderRadius: '8px', flexShrink: 0,
            }}>
              <ChevronLeft size={22} />
            </button>
          )}
          <div style={{
            width: isMobile ? '34px' : '40px', height: isMobile ? '34px' : '40px',
            borderRadius: '50%', backgroundColor: colors.tealSoft, flexShrink: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontWeight: 600, color: 'white', fontSize: '13px',
          }}>
            {initials}
          </div>
          <div style={{ minWidth: 0, flex: 1, overflow: 'hidden' }}>
            <div
              onClick={openEditContact}
              title="Editar contacto"
              style={{
                fontWeight: 600, fontSize: isMobile ? '14px' : '15px', color: colors.textPrimary,
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                maxWidth: '100%',
                cursor: 'pointer',
                borderBottom: `1px dashed ${colors.border}`,
                display: 'block',
              }}>
              {displayContactName}
            </div>
            {isMobile && displayContactName !== conversation.phone_number && (
              <div style={{ color: colors.textSecondary, fontSize: '10px', marginTop: '1px', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {String(conversation.phone_number).startsWith('+') ? '' : '+'}{conversation.phone_number}
              </div>
            )}
            {!isMobile && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '7px', flexWrap: 'wrap' }}>
                <div onClick={openHistory}
                  style={{ fontSize: '12px', color: colors.green, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '4px' }}
                  title="Ver historial de compras">
                  <History size={11} />
                  Cliente: {conversation.phone_number}
                </div>
                <span style={{ color: colors.textMuted, fontSize: '10px' }}>·</span>
                {channelSelector}
              </div>
            )}
            {isMobile && (
              <div style={{ marginTop: '1px', display: 'flex', minWidth: 0 }}>
                {channelSelector}
              </div>
            )}
          </div>
        </div>

        {/* Right: action buttons */}
        <div style={{ display: 'flex', alignItems: 'center', gap: isMobile ? '6px' : '8px', flexShrink: 0, position: 'relative' }}>
          <button
            onClick={handleTogglePin}
            disabled={pinSaving}
            title={isPinned ? 'Quitar chat de fijados' : 'Fijar chat arriba'}
            style={{
              backgroundColor: isPinned ? colors.green + '20' : 'transparent',
              border: `1px solid ${isPinned ? colors.green : colors.borderStrong}`,
              borderRadius: '6px', padding: '5px 8px',
              color: isPinned ? colors.green : colors.textMuted,
              cursor: pinSaving ? 'wait' : 'pointer',
              display: isMobile ? 'none' : 'flex', alignItems: 'center', gap: '4px',
              fontSize: '11px', fontWeight: isPinned ? 700 : 400,
            }}
          >
            <Pin size={13} fill={isPinned ? 'currentColor' : 'none'} />
            {isPinned ? 'Fijado' : 'Fijar'}
          </button>
          <button
            onClick={openNoteEditor}
            title={customerNote ? 'Ver o editar nota del cliente' : 'Agregar nota del cliente'}
            style={{
              backgroundColor: customerNote ? '#f59e0b20' : 'transparent',
              border: `1px solid ${customerNote ? '#f59e0b88' : colors.borderStrong}`,
              borderRadius: '6px', padding: '5px 8px',
              color: customerNote ? '#f59e0b' : colors.textMuted,
              cursor: 'pointer',
              display: isMobile ? 'none' : 'flex', alignItems: 'center', gap: '4px',
              fontSize: '11px', fontWeight: customerNote ? 700 : 400,
            }}
          >
            <StickyNote size={13} />
            Nota
          </button>
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
                display: isMobile ? 'none' : 'flex', alignItems: 'center', gap: '4px',
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
              display: isMobile ? 'none' : 'flex', alignItems: 'center', gap: '4px',
              fontSize: '11px', transition: 'all 0.15s',
            }}
          >
            <ShoppingCart size={13} />
            {!isMobile && 'Nueva orden'}
          </button>
          <button
            onClick={openPaymentOptions}
            title="Enviar opciones de pago"
            style={{
              backgroundColor: 'transparent',
              border: `1px solid ${colors.borderStrong}`,
              borderRadius: '6px', padding: isMobile ? '5px' : '5px 8px',
              color: colors.green,
              cursor: 'pointer',
              display: isMobile ? 'none' : 'flex', alignItems: 'center', gap: '4px',
              fontSize: '11px', transition: 'all 0.15s',
            }}
          >
            <CircleDollarSign size={13} />
            {!isMobile && 'Pago'}
          </button>
          {!conversation.whatsapp_channel_id && <button
            onClick={openTemplateModal}
            title="Enviar template de WhatsApp"
            style={{
              backgroundColor: 'transparent',
              border: `1px solid ${colors.borderStrong}`,
              borderRadius: '6px', padding: isMobile ? '5px' : '5px 8px',
              color: colors.infoSoft,
              cursor: 'pointer',
              display: isMobile ? 'none' : 'flex', alignItems: 'center', gap: '4px',
              fontSize: '11px', transition: 'all 0.15s',
            }}
          >
            <FileText size={13} />
            {!isMobile && 'Template'}
          </button>}
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
                display: isMobile ? 'none' : 'flex', alignItems: 'center', gap: '4px',
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
              backgroundColor: optOut ? colors.danger + '20' : 'transparent',
              border: optOut ? `1px solid ${colors.danger}` : `1px solid ${colors.borderStrong}`,
              borderRadius: '20px',
              padding: '4px 10px',
              color: optOut ? colors.danger : colors.textMuted,
              cursor: togglingOptOut ? 'not-allowed' : 'pointer',
              display: isMobile ? 'none' : 'flex', alignItems: 'center', gap: '4px',
              fontSize: '11px', fontWeight: optOut ? 600 : 400, transition: 'all 0.15s',
            }}
          >
            <BellOff size={11} />
            {!isMobile && (optOut ? 'No contactar' : 'Opt-out')}
          </button>
          <button
            onClick={handleToggleEmpresa}
            disabled={togglingEmpresa}
            title={isEmpresa ? 'Marcar como cliente particular' : 'Marcar como empresa (B2B)'}
            style={{
              backgroundColor: isEmpresa ? colors.indigo : 'transparent',
              border: isEmpresa ? `1px solid ${colors.indigo}` : `1px solid ${colors.borderStrong}`,
              borderRadius: '20px',
              padding: '4px 10px',
              color: isEmpresa ? 'white' : colors.textMuted,
              cursor: togglingEmpresa ? 'wait' : 'pointer',
              display: isMobile ? 'none' : 'flex', alignItems: 'center', gap: '4px',
              fontSize: '11px', fontWeight: isEmpresa ? 600 : 400, transition: 'all 0.15s',
            }}
            onMouseEnter={e => { e.currentTarget.style.backgroundColor = isEmpresa ? '#4f46e5' : colors.indigo + '20'; e.currentTarget.style.color = isEmpresa ? 'white' : colors.indigo; }}
            onMouseLeave={e => { e.currentTarget.style.backgroundColor = isEmpresa ? colors.indigo : 'transparent'; e.currentTarget.style.color = isEmpresa ? 'white' : colors.textMuted; }}
          >
            🏢 {togglingEmpresa ? 'Guardando...' : 'Empresa'}
          </button>
          <button
            onClick={openAnalysis}
            title="Analizar conversación con IA"
            style={{
              backgroundColor: 'transparent',
              border: `1px solid ${colors.borderStrong}`,
              borderRadius: '6px', padding: isMobile ? '5px' : '5px 8px',
              color: colors.purpleSoft,
              cursor: 'pointer',
              display: isMobile ? 'none' : 'flex', alignItems: 'center', gap: '4px',
              fontSize: '11px', transition: 'all 0.15s',
            }}
          >
            <BarChart2 size={13} />
            {!isMobile && 'Analizar'}
          </button>
          <AgentToggle
            mode={conversation.agent_mode}
            onToggle={() => onToggleAgentMode(conversation.id, conversation.agent_mode, conversation.agent_mode === 'human' ? 'ai' : 'human')}
            isMobile={isMobile}
          />
          {isMobile && (
            <>
              {mobileActionsOpen && (
                <button
                  aria-label="Cerrar menú de acciones"
                  onClick={() => setMobileActionsOpen(false)}
                  style={{ position: 'fixed', inset: 0, zIndex: 18, background: 'transparent', border: 'none' }}
                />
              )}
              <button
                onClick={() => setMobileActionsOpen(open => !open)}
                aria-label="Más acciones del chat"
                aria-expanded={mobileActionsOpen}
                style={{
                  width: '34px', height: '34px', borderRadius: '10px', flexShrink: 0,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  backgroundColor: mobileActionsOpen ? colors.bgHover : 'transparent',
                  color: colors.textSecondary, border: `1px solid ${colors.borderStrong}`,
                }}
              >
                <MoreVertical size={18} />
              </button>
              {mobileActionsOpen && (
                <div style={{
                  position: 'absolute', top: '44px', right: 0, zIndex: 20,
                  width: '238px', maxHeight: 'min(430px, calc(100dvh - 150px))', overflowY: 'auto',
                  padding: '7px', borderRadius: '14px', backgroundColor: colors.bgPanel,
                  border: `1px solid ${colors.border}`, boxShadow: '0 14px 38px rgba(0,0,0,.38)',
                }}>
                  <MobileHeaderAction icon={<ShoppingCart size={17} />} label="Crear pedido" colors={colors}
                    onClick={() => { setMobileActionsOpen(false); openOrderModal(); }} />
                  <MobileHeaderAction icon={<CircleDollarSign size={17} />} label="Enviar opciones de pago" colors={colors}
                    onClick={() => { setMobileActionsOpen(false); openPaymentOptions(); }} />
                  <MobileHeaderAction icon={<Pin size={17} fill={isPinned ? 'currentColor' : 'none'} />}
                    label={isPinned ? 'Quitar de fijados' : 'Fijar chat arriba'} colors={colors} active={isPinned}
                    disabled={pinSaving} onClick={() => { setMobileActionsOpen(false); handleTogglePin(); }} />
                  <MobileHeaderAction icon={<StickyNote size={17} />} label={customerNote ? 'Ver o editar nota' : 'Agregar nota'}
                    colors={colors} active={!!customerNote}
                    onClick={() => { setMobileActionsOpen(false); openNoteEditor(); }} />
                  {!conversation.whatsapp_channel_id && <MobileHeaderAction icon={<FileText size={17} />} label="Enviar template" colors={colors}
                    onClick={() => { setMobileActionsOpen(false); openTemplateModal(); }} />}
                  <MobileHeaderAction icon={<History size={17} />} label="Historial de compras" colors={colors}
                    onClick={() => { setMobileActionsOpen(false); openHistory(); }} />
                  <MobileHeaderAction icon={<BarChart2 size={17} />} label="Analizar conversación" colors={colors}
                    onClick={() => { setMobileActionsOpen(false); openAnalysis(); }} />
                  <MobileHeaderAction icon={<span style={{ fontSize: '15px' }}>🏢</span>}
                    label={isEmpresa ? 'Marcar como particular' : 'Marcar como empresa'} colors={colors}
                    active={isEmpresa} disabled={togglingEmpresa} onClick={() => { setMobileActionsOpen(false); handleToggleEmpresa(); }} />
                  <MobileHeaderAction icon={<BellOff size={17} />}
                    label={optOut ? 'Volver a contactar' : 'No contactar'} colors={colors}
                    active={optOut} danger={optOut} disabled={togglingOptOut}
                    onClick={() => { setMobileActionsOpen(false); handleToggleOptOut(); }} />
                  {isHotLead && (
                    <MobileHeaderAction icon={<span style={{ fontSize: '15px' }}>🔥</span>} label="Quitar de Hot Leads" colors={colors}
                      onClick={() => { setMobileActionsOpen(false); handleRemoveHotLead(); }} />
                  )}
                  {isDevUser && (
                    <MobileHeaderAction icon={<Trash2 size={17} />} label={deleting ? 'Borrando mensajes…' : 'Borrar mensajes'}
                      colors={colors} danger disabled={deleting}
                      onClick={() => { setMobileActionsOpen(false); handleDeleteMessages(); }} />
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {conversation.attribution_first_seen_at && (
        <div style={{
          padding: isMobile ? '7px 12px' : '8px 16px', flexShrink: 0,
          display: 'flex', alignItems: 'center', gap: 8,
          background: isDark ? '#231d38' : '#f3efff',
          borderBottom: '1px solid #8b5cf644', color: isDark ? '#ddd6fe' : '#5b21b6',
          fontSize: 12,
        }}>
          <Megaphone size={14} />
          <strong>Llegó desde un anuncio:</strong>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {conversation.attribution_campaign_name || conversation.attribution_ad_name || conversation.attribution_headline || 'Campaña de WhatsApp'}
          </span>
          {conversation.attribution_source_url && <a href={conversation.attribution_source_url} target="_blank" rel="noreferrer" style={{ marginLeft: 'auto', color: 'inherit', fontWeight: 750 }}>Ver anuncio</a>}
        </div>
      )}

      {customerNote && (
        <button
          onClick={openNoteEditor}
          title="Editar nota del cliente"
          style={{
            width: '100%', border: 'none', borderBottom: '1px solid #f59e0b55',
            backgroundColor: isDark ? '#33270f' : '#fff7df', color: isDark ? '#fcd58a' : '#7c4a03',
            padding: isMobile ? '7px 12px' : '8px 16px', cursor: 'pointer', textAlign: 'left',
            display: 'flex', alignItems: 'flex-start', gap: '8px', flexShrink: 0,
          }}
        >
          <StickyNote size={15} style={{ marginTop: '1px', flexShrink: 0 }} />
          <span style={{ minWidth: 0, flex: 1, fontSize: '12px', lineHeight: 1.4 }}>
            <strong>Nota del cliente:</strong>{' '}{customerNote}
          </span>
          <span style={{ fontSize: '11px', fontWeight: 700, whiteSpace: 'nowrap' }}>Editar</span>
        </button>
      )}

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

      {/* Banner Diva coordinando con el equipo */}
      {isCoordinating && (
        <div style={{
          backgroundColor: isDark ? '#2a2142' : '#f1eafe',
          color: isDark ? '#c4b5fd' : '#5b21b6',
          padding: '8px 16px', fontSize: '13px', fontWeight: 500,
          display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap',
        }}>
          <MessagesSquare size={14} />
          <span style={{ flex: 1 }}>Diva está coordinando una respuesta con el equipo.</span>
          <button onClick={() => onToggleAgentMode(conversation.id, conversation.agent_mode, 'human')}
            style={{ border: 'none', borderRadius: '12px', padding: '4px 10px', cursor: 'pointer', color: 'white', background: '#7c3aed' }}>
            Tomar control
          </button>
          <button onClick={() => onToggleAgentMode(conversation.id, conversation.agent_mode, 'ai')}
            style={{ border: 'none', borderRadius: '12px', padding: '4px 10px', cursor: 'pointer', color: 'white', background: colors.green }}>
            Activar Diva
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
          color: colors.warning,
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
        }}>
          <span>⏰</span>
          <span>
            <strong>Ventana de 24 horas expirada.</strong>{' '}
            El canal oficial no permite texto libre. Usa tu otro WhatsApp conectado o un template aprobado.
          </span>
          <button
            onClick={() => openExpiredWindowAlternative(inputText)}
            style={{
              marginLeft: 'auto', border: '1px solid #d97706', borderRadius: '7px',
              background: '#78350f', color: '#fde68a', padding: '5px 9px',
              fontSize: '11px', fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap',
            }}>
            Abrir alternativa
          </button>
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
                color: colors.successSoft,
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
                color: colors.dangerSoft,
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
          color: feedbackSent === 'correct' ? colors.successSoft : colors.dangerSoft,
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
            acc.push(<MessageBubble key={msg.id} message={msg} conversation={conversation} />);
            return acc;
          }, [])
        )}
        {/* Typing indicator */}
        {botTyping && (
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: '6px', padding: '4px 0' }}>
            <div style={{
              width: '28px', height: '28px', borderRadius: '50%',
              backgroundColor: colors.tealSoft, display: 'flex', alignItems: 'center',
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

      {/* ── Modal Editar Contacto ── */}
      {showEditContact && (
        <div onClick={closeContactEditor} style={{ position:'fixed', inset:0, backgroundColor:'rgba(0,0,0,0.55)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center', padding:'16px' }}>
          <div onClick={e => e.stopPropagation()} style={{ backgroundColor: colors.bgPanel, borderRadius:'14px', border:`1px solid ${colors.border}`, width:'100%', maxWidth:'420px', boxShadow:'0 20px 60px rgba(0,0,0,0.5)', padding:'24px' }}>
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:'20px' }}>
              <span style={{ fontWeight:700, fontSize:'16px', color: colors.textPrimary }}>Editar contacto</span>
              <button onClick={closeContactEditor} style={{ background:'none', border:'none', cursor:'pointer', color: colors.textSecondary, padding:'4px' }}><X size={18}/></button>
            </div>

            <div style={{ fontSize:'12px', color: colors.textMuted, marginBottom:'16px' }}>
              {conversation.phone_number}
            </div>

            {/* Nombre */}
            <div style={{ marginBottom:'14px' }}>
              <label style={{ fontSize:'12px', color: colors.textSecondary, display:'block', marginBottom:'6px', textTransform:'uppercase', letterSpacing:'0.5px' }}>Nombre</label>
              <input
                value={editContactName}
                onChange={e => setEditContactName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSaveContact()}
                placeholder="Nombre del contacto"
                autoFocus
                style={{ width:'100%', padding:'9px 12px', borderRadius:'8px', border:`1px solid ${colors.border}`, backgroundColor: colors.bgSub, color: colors.textPrimary, fontSize:'14px', boxSizing:'border-box' }}
              />
            </div>

            <div style={{ marginBottom:'22px' }}>
              <label style={{ fontSize:'12px', color: colors.textSecondary, display:'block', marginBottom:'6px', textTransform:'uppercase', letterSpacing:'0.5px' }}>Dirección</label>
              <ClientAddressFields phone={conversation.phone_number} address={editContactAddress} city={editContactCity}
                onAddressChange={setEditContactAddress} onCityChange={setEditContactCity} colors={colors} />
            </div>

            <div style={{ display:'flex', gap:'10px', justifyContent:'flex-end' }}>
              <button onClick={closeContactEditor} style={{ padding:'9px 18px', borderRadius:'8px', border:`1px solid ${colors.border}`, background:'none', color: colors.textSecondary, cursor:'pointer', fontSize:'14px' }}>
                Cancelar
              </button>
              <button
                onClick={handleSaveContact}
                disabled={savingContact || (!editContactName.trim() && !editContactAddress.trim())}
                style={{ padding:'9px 18px', borderRadius:'8px', border:'none', backgroundColor: colors.green, color:'white', cursor: savingContact ? 'wait' : 'pointer', fontSize:'14px', fontWeight:600, opacity: (!editContactName.trim() && !editContactAddress.trim()) ? 0.5 : 1 }}>
                {savingContact ? 'Guardando...' : 'Guardar'}
              </button>
            </div>
          </div>
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
                        <div style={{ display:'flex', alignItems:'center', gap:'8px', backgroundColor:colors.bg, borderRadius:'8px', padding:'8px 10px 8px 12px', border:`1px solid ${colors.border}`, marginBottom:'16px', fontSize:'12px', color:colors.textSecondary }}>
                            <span style={{ fontSize:'13px' }}>📍</span>
                            <span style={{ flex:1, minWidth:0 }}><strong style={{ color:colors.textPrimary }}>Dirección registrada:</strong> {historyData.contactAddress || 'Sin dirección'}</span>
                            <button
                              type="button"
                              onClick={() => {
                                setEditContactFromHistory(true);
                                setShowHistory(false);
                                openEditContact();
                              }}
                              style={{ display:'inline-flex', alignItems:'center', gap:'4px', padding:'5px 8px', borderRadius:'7px', border:`1px solid ${colors.green}66`, backgroundColor:`${colors.green}16`, color:colors.green, cursor:'pointer', fontSize:'10px', fontWeight:800, whiteSpace:'nowrap' }}>
                              {historyData.contactAddress ? <Pencil size={11} /> : <Plus size={11} />}
                              {historyData.contactAddress ? 'Cambiar' : 'Agregar'}
                            </button>
                          </div>
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
                        let items = [];
                        try { items = Array.isArray(o.items) ? o.items : (typeof o.items === 'string' ? JSON.parse(o.items || '[]') : []); } catch { items = []; }
                        if (!Array.isArray(items)) items = [];
                        const isShopify = o._source === 'shopify';
                        const fs = isShopify ? (o.financial_status||'').toUpperCase() : (o.status||'').toUpperCase();
                        const isPaid = isShopify ? fs === 'PAID' : ['PAID', 'PAYMENT_RECEIVED'].includes(fs);
                        const canMarkPaid = !isPaid && !['CANCELLED', 'VOIDED', 'REFUNDED'].includes(fs);
                        // Etiqueta + color para TODOS los estados (Shopify y bot).
                        const STATUS_STYLE = {
                          PAID:{ l:'Pagado', c:'#22c55e' }, CONFIRMED:{ l:'Confirmado', c:'#22c55e' }, PAYMENT_RECEIVED:{ l:'Pago recibido', c:'#22c55e' },
                          ENTREGADO:{ l:'Entregado', c:'#22c55e' },
                          PENDING:{ l:'Pendiente', c:'#f59e0b' }, NUEVO:{ l:'Nuevo', c:'#f59e0b' }, SENT:{ l:'Enviado', c:'#f59e0b' }, POR_DESPACHAR:{ l:'Por despachar', c:'#f59e0b' },
                          DRAFT:{ l:'Borrador', c:'#9ca3af' },
                          EN_CAMINO:{ l:'En camino', c:'#3b82f6' },
                          CANCELLED:{ l:'Cancelado', c:'#ef4444' }, VOIDED:{ l:'Anulado', c:'#ef4444' }, REFUNDED:{ l:'Reembolsado', c:'#ef4444' },
                        };
                        const st = STATUS_STYLE[fs] || { l: (fs || '—').replace(/_/g,' ').toLowerCase().replace(/^\w/, m=>m.toUpperCase()), c: colors.textSecondary };
                        return (
                          <div key={`${o._source}_${o.id || o.shopify_order_id || i}`} style={{ backgroundColor:colors.bg, borderRadius:'10px', padding:'12px 14px', border:`1px solid ${colors.border}` }}>
                            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start', gap:'8px', flexWrap:'wrap', marginBottom:'6px' }}>
                              <div style={{ display:'flex', alignItems:'center', gap:'6px' }}>
                                <span style={{ fontSize:'10px', padding:'1px 6px', borderRadius:'4px', backgroundColor: isShopify ? '#0d2020' : colors.bgSub, color: isShopify ? colors.tealSoft : colors.textSecondary, border:`1px solid ${isShopify ? '#1a3d3d' : colors.border}` }}>
                                  {isShopify ? 'Shopify' : 'Bot'}
                                </span>
                                <span style={{ fontSize:'12px', color:colors.textSecondary }}>{fecha}{o.shopify_name ? ` · ${o.shopify_name}` : ''}</span>
                              </div>
                              <div style={{ display:'flex', alignItems:'center', justifyContent:'flex-end', gap:'6px', flexWrap:'wrap' }}>
                                <button
                                  type="button"
                                  onClick={() => openHistoryEdit(o)}
                                  title="Editar productos y dirección"
                                  style={{ display:'inline-flex', alignItems:'center', gap:'4px', padding:'4px 8px', borderRadius:'7px', border:`1px solid ${colors.border}`, backgroundColor:colors.bgSub, color:colors.textPrimary, cursor:'pointer', fontSize:'10px', fontWeight:700 }}>
                                  <Pencil size={11} /> Editar
                                </button>
                                {canMarkPaid && (
                                  <button
                                    type="button"
                                    onClick={() => openHistoryPayment(o)}
                                    title="Registrar este pedido como pagado"
                                    style={{ display:'inline-flex', alignItems:'center', gap:'4px', padding:'4px 8px', borderRadius:'7px', border:`1px solid ${colors.green}66`, backgroundColor:`${colors.green}16`, color:colors.green, cursor:'pointer', fontSize:'10px', fontWeight:800 }}>
                                    <CircleDollarSign size={11} /> Marcar pagado
                                  </button>
                                )}
                                <span style={{ fontSize:'10px', fontWeight:700, padding:'2px 8px', borderRadius:'999px', color:st.c, backgroundColor:`${st.c}1f`, border:`1px solid ${st.c}55`, whiteSpace:'nowrap' }}>{st.l}</span>
                                <span style={{ fontSize:'13px', fontWeight:700, color:colors.textPrimary }}>${Number(o.total_price||0).toLocaleString('es-CL')}</span>
                              </div>
                            </div>
                            {items.length > 0 && (
                              <div style={{ fontSize:'11px', color:colors.textSecondary }}>
                                {items.map(it => `${it.quantity}x ${it.name || it.title}`).join(' · ')}
                              </div>
                            )}
                            {(o.delivery_note || (!isShopify && o.notes)) && (
                              <div style={{ fontSize:'11px', color:isDark?'#fcd58a':'#8a5707', backgroundColor:isDark?'#33270f':'#fff7df', border:`1px solid #f59e0b44`, borderRadius:'7px', marginTop:'6px', padding:'5px 7px', display:'flex', alignItems:'flex-start', gap:'5px' }}>
                                <StickyNote size={12} style={{ marginTop:'1px', flexShrink:0 }} />
                                <span><strong>Nota de entrega:</strong> {o.delivery_note || o.notes}</span>
                              </div>
                            )}
                            {isPaid && (
                              <div style={{ fontSize:'10px', color:colors.green, marginTop:'5px', display:'flex', alignItems:'center', gap:'4px', fontWeight:700 }}>
                                <CheckCircle2 size={11} /> Pago registrado{o.payment_method ? ` · ${({ efectivo:'Efectivo', transferencia:'Transferencia', mixto:'Mixto', otro:'Otro' })[o.payment_method] || o.payment_method}` : ''}
                              </div>
                            )}
                            {(() => {
                              let addr;
                              if (isShopify) {
                                addr = [o.shipping_address1, o.shipping_city].filter(Boolean).join(', ');
                              } else {
                                // shipping_address del bot es un objeto/JSON { address, city } — nunca mostrarlo crudo
                                let a = o.shipping_address;
                                if (typeof a === 'string') { try { a = JSON.parse(a); } catch {} }
                                addr = (a && typeof a === 'object')
                                  ? [a.address || a.address1, a.city].filter(Boolean).join(', ')
                                  : (typeof a === 'string' ? a : '');
                              }
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

            {historyPayment && (
              <div onClick={e => { e.stopPropagation(); if (!historyPaymentSaving) setHistoryPayment(null); }} style={{ position:'fixed', inset:0, zIndex:1120, backgroundColor:'rgba(0,0,0,0.72)', display:'flex', alignItems:'center', justifyContent:'center', padding:'16px' }}>
                <div onClick={e => e.stopPropagation()} style={{ width:'100%', maxWidth:'420px', backgroundColor:colors.bgPanel, border:`1px solid ${colors.border}`, borderRadius:'14px', boxShadow:'0 24px 70px rgba(0,0,0,.55)', overflow:'hidden' }}>
                  <div style={{ padding:'16px 18px', borderBottom:`1px solid ${colors.border}`, display:'flex', alignItems:'center', justifyContent:'space-between', gap:'12px' }}>
                    <div style={{ display:'flex', alignItems:'center', gap:'9px' }}>
                      <CircleDollarSign size={18} color={colors.green} />
                      <div>
                        <div style={{ color:colors.textPrimary, fontSize:'14px', fontWeight:800 }}>Registrar pago</div>
                        <div style={{ color:colors.textSecondary, fontSize:'11px', marginTop:'2px' }}>{historyPayment.label} · ${historyPayment.total.toLocaleString('es-CL')}</div>
                      </div>
                    </div>
                    <button type="button" disabled={historyPaymentSaving} onClick={() => setHistoryPayment(null)} style={{ border:'none', background:'transparent', color:colors.textSecondary, cursor:'pointer', padding:'4px' }}><X size={18} /></button>
                  </div>
                  <div style={{ padding:'18px' }}>
                    <label style={{ display:'block', color:colors.textSecondary, fontSize:'11px', fontWeight:700, marginBottom:'7px' }}>Medio de pago</label>
                    <select value={historyPayment.paymentMethod} onChange={e => setHistoryPayment(current => ({ ...current, paymentMethod:e.target.value }))}
                      style={{ width:'100%', border:`1px solid ${colors.border}`, backgroundColor:colors.bg, color:colors.textPrimary, borderRadius:'9px', padding:'10px 11px', fontSize:'13px', outline:'none' }}>
                      <option value="transferencia">Transferencia</option>
                      <option value="efectivo">Efectivo</option>
                      <option value="mixto">Pago mixto</option>
                      <option value="otro">Otro</option>
                    </select>
                    {historyPayment.paymentMethod === 'mixto' && (
                      <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'9px', marginTop:'12px' }}>
                        <label style={{ color:colors.textSecondary, fontSize:'10px' }}>Efectivo
                          <input type="number" min="0" value={historyPayment.cashAmount} onChange={e => setHistoryPayment(current => ({ ...current, cashAmount:e.target.value }))}
                            style={{ width:'100%', boxSizing:'border-box', marginTop:'5px', border:`1px solid ${colors.border}`, backgroundColor:colors.bg, color:colors.textPrimary, borderRadius:'8px', padding:'9px' }} />
                        </label>
                        <label style={{ color:colors.textSecondary, fontSize:'10px' }}>Transferencia
                          <input type="number" min="0" value={historyPayment.transferAmount} onChange={e => setHistoryPayment(current => ({ ...current, transferAmount:e.target.value }))}
                            style={{ width:'100%', boxSizing:'border-box', marginTop:'5px', border:`1px solid ${colors.border}`, backgroundColor:colors.bg, color:colors.textPrimary, borderRadius:'8px', padding:'9px' }} />
                        </label>
                      </div>
                    )}
                    <div style={{ marginTop:'12px', padding:'9px 10px', borderRadius:'8px', backgroundColor:`${colors.green}0d`, border:`1px solid ${colors.green}33`, color:colors.textSecondary, fontSize:'10px', lineHeight:1.45 }}>
                      Esta acción registra el pago en la cuenta corriente. No realiza un cobro ni modifica el pago remoto de Shopify.
                    </div>
                    {historyPaymentError && <div style={{ color:'#ef4444', fontSize:'11px', marginTop:'10px' }}>{historyPaymentError}</div>}
                  </div>
                  <div style={{ padding:'12px 18px', borderTop:`1px solid ${colors.border}`, display:'flex', justifyContent:'flex-end', gap:'8px' }}>
                    <button type="button" disabled={historyPaymentSaving} onClick={() => setHistoryPayment(null)} style={{ border:`1px solid ${colors.border}`, backgroundColor:colors.bgSub, color:colors.textSecondary, borderRadius:'8px', padding:'8px 12px', cursor:'pointer', fontSize:'12px' }}>Cancelar</button>
                    <button type="button" disabled={historyPaymentSaving} onClick={saveHistoryPayment} style={{ border:'none', backgroundColor:colors.green, color:'#fff', borderRadius:'8px', padding:'8px 13px', cursor:historyPaymentSaving?'wait':'pointer', fontSize:'12px', fontWeight:800, display:'inline-flex', alignItems:'center', gap:'6px' }}>
                      {historyPaymentSaving ? <Loader size={13} style={{ animation:'spin 1s linear infinite' }} /> : <CheckCircle2 size={13} />}
                      {historyPaymentSaving ? 'Registrando…' : 'Confirmar pago'}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {historyEdit && (
              <div onClick={e => { e.stopPropagation(); if (!historyEditSaving) setHistoryEdit(null); }} style={{ position:'fixed', inset:0, zIndex:1100, backgroundColor:'rgba(0,0,0,0.68)', display:'flex', alignItems:'center', justifyContent:'center', padding:'16px' }}>
                <div onClick={e => e.stopPropagation()} style={{ width:'100%', maxWidth:'560px', maxHeight:'88vh', overflowY:'auto', backgroundColor:colors.bgPanel, border:`1px solid ${colors.border}`, borderRadius:'14px', boxShadow:'0 24px 70px rgba(0,0,0,.55)' }}>
                  <div style={{ position:'sticky', top:0, zIndex:1, display:'flex', alignItems:'center', justifyContent:'space-between', padding:'15px 18px', backgroundColor:colors.bgPanel, borderBottom:`1px solid ${colors.border}` }}>
                    <div>
                      <div style={{ color:colors.textPrimary, fontWeight:800, fontSize:'15px' }}>Editar pedido {historyEdit.label}</div>
                      <div style={{ color:colors.textSecondary, fontSize:'11px', marginTop:'2px' }}>Productos, cantidades, precios y lugar de entrega</div>
                    </div>
                    <button type="button" onClick={() => setHistoryEdit(null)} disabled={historyEditSaving} style={{ border:0, background:'none', color:colors.textSecondary, cursor:'pointer', padding:'4px' }}><X size={18} /></button>
                  </div>

                  <div style={{ padding:'16px 18px' }}>
                    <div style={{ fontSize:'12px', fontWeight:800, color:colors.textPrimary, marginBottom:'9px' }}>Productos</div>
                    <div style={{ display:'flex', flexDirection:'column', gap:'8px' }}>
                      {historyEdit.items.map((item, index) => (
                        <div key={item.key} style={{ display:'grid', gridTemplateColumns:'minmax(0,1fr) 76px 105px 34px', gap:'7px', alignItems:'center' }}>
                          <select
                            value={historyProducts.find(product => product.title === item.name)?.id || (item.name ? `custom_${item.key}` : '')}
                            onChange={e => selectHistoryProduct(item.key, e.target.value)}
                            disabled={historyProductsLoading}
                            aria-label={`Producto ${index + 1}`}
                            style={{ minWidth:0, width:'100%', padding:'9px 10px', borderRadius:'8px', border:`1px solid ${colors.border}`, backgroundColor:colors.bg, color:item.name ? colors.textPrimary : colors.textSecondary, cursor:historyProductsLoading?'wait':'pointer' }}>
                            <option value="">{historyProductsLoading ? 'Cargando productos…' : 'Seleccionar producto…'}</option>
                            {item.name && !historyProducts.some(product => product.title === item.name) && (
                              <option value={`custom_${item.key}`}>{item.name} (fuera del catálogo)</option>
                            )}
                            {historyProducts.map(product => (
                              <option key={product.id} value={product.id}>
                                {product.title} · ${Number(product.price || 0).toLocaleString('es-CL')}
                              </option>
                            ))}
                          </select>
                          <input type="number" min="1" value={item.quantity} onChange={e => updateHistoryItem(item.key, 'quantity', e.target.value)} aria-label={`Cantidad producto ${index + 1}`}
                            style={{ minWidth:0, padding:'9px 8px', borderRadius:'8px', border:`1px solid ${colors.border}`, backgroundColor:colors.bg, color:colors.textPrimary }} />
                          <input type="number" min="0" value={item.price} onChange={e => updateHistoryItem(item.key, 'price', e.target.value)} aria-label={`Precio producto ${index + 1}`}
                            style={{ minWidth:0, padding:'9px 8px', borderRadius:'8px', border:`1px solid ${colors.border}`, backgroundColor:colors.bg, color:colors.textPrimary }} />
                          <button type="button" onClick={() => setHistoryEdit(current => ({ ...current, items:current.items.filter(row => row.key !== item.key) }))}
                            title="Quitar producto" style={{ width:'34px', height:'34px', borderRadius:'8px', border:`1px solid ${colors.dangerSoft}55`, backgroundColor:`${colors.dangerSoft}14`, color:colors.dangerSoft, cursor:'pointer' }}><X size={14} /></button>
                        </div>
                      ))}
                    </div>
                    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', gap:'12px', marginTop:'10px' }}>
                      <button type="button" onClick={() => setHistoryEdit(current => ({ ...current, items:[...current.items, { key:`new_${Date.now()}`, name:'', quantity:1, price:0 }] }))}
                        style={{ display:'inline-flex', alignItems:'center', gap:'5px', padding:'7px 10px', borderRadius:'8px', border:`1px solid ${colors.border}`, backgroundColor:colors.bgSub, color:colors.textPrimary, cursor:'pointer', fontSize:'11px', fontWeight:700 }}><Plus size={13} /> Agregar producto</button>
                      <div style={{ color:colors.textPrimary, fontSize:'12px', fontWeight:800 }}>
                        Total: ${historyEdit.items.reduce((sum, item) => sum + (Number(item.quantity) || 0) * (Number(item.price) || 0), 0).toLocaleString('es-CL')}
                      </div>
                    </div>

                    <div style={{ height:'1px', backgroundColor:colors.border, margin:'17px 0' }} />
                    <div style={{ fontSize:'12px', fontWeight:800, color:colors.textPrimary, marginBottom:'9px' }}>Entrega</div>
                    <ClientAddressFields phone={conversation.phone_number} address={historyEdit.address} city={historyEdit.city}
                      onAddressChange={value => setHistoryEdit(current => ({ ...current, address:value }))}
                      onCityChange={value => setHistoryEdit(current => ({ ...current, city:value }))} colors={colors} />
                    <div style={{ marginTop:'13px' }}>
                      <div style={{ fontSize:'11px', fontWeight:800, color:colors.textSecondary, textTransform:'uppercase', letterSpacing:'.5px', marginBottom:'6px' }}>Nota para el despacho</div>
                      <textarea value={historyEdit.note} onChange={e => setHistoryEdit(current => ({ ...current, note:e.target.value }))}
                        maxLength={1000} rows={3} placeholder="Horario, referencia o instrucción adicional"
                        style={{ width:'100%', boxSizing:'border-box', resize:'vertical', backgroundColor:colors.bgSub, color:colors.textPrimary, border:`1px solid ${colors.border}`, borderRadius:'8px', padding:'8px 10px', fontSize:'13px', outline:'none' }} />
                    </div>
                    <label style={{ display:'flex', alignItems:'center', gap:'8px', marginTop:'11px', color:colors.textSecondary, fontSize:'11px', cursor:'pointer' }}>
                      <input type="checkbox" checked={historyEdit.updateContact} onChange={e => setHistoryEdit(current => ({ ...current, updateContact:e.target.checked }))} />
                      Usar también como dirección registrada del cliente
                    </label>

                    {historyEditError && <div style={{ marginTop:'12px', padding:'9px 11px', borderRadius:'8px', color:colors.dangerSoft, backgroundColor:`${colors.dangerSoft}12`, border:`1px solid ${colors.dangerSoft}44`, fontSize:'12px' }}>{historyEditError}</div>}
                    <div style={{ display:'flex', justifyContent:'flex-end', gap:'9px', marginTop:'17px' }}>
                      <button type="button" onClick={() => setHistoryEdit(null)} disabled={historyEditSaving}
                        style={{ padding:'9px 14px', borderRadius:'8px', border:`1px solid ${colors.border}`, background:'none', color:colors.textSecondary, cursor:'pointer' }}>Cancelar</button>
                      <button type="button" onClick={saveHistoryEdit} disabled={historyEditSaving}
                        style={{ padding:'9px 15px', borderRadius:'8px', border:0, backgroundColor:colors.green, color:'white', fontWeight:800, cursor:historyEditSaving?'wait':'pointer', opacity:historyEditSaving?.7:1 }}>
                        {historyEditSaving ? 'Guardando…' : 'Guardar cambios'}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {showNoteEditor && (
        <div style={{ position:'fixed', inset:0, backgroundColor:'rgba(0,0,0,0.6)', zIndex:1100, display:'flex', alignItems:'center', justifyContent:'center', padding:'16px' }}>
          <div style={{ width:'100%', maxWidth:'480px', backgroundColor:colors.bgPanel, border:`1px solid ${colors.border}`, borderRadius:'14px', boxShadow:'0 20px 60px rgba(0,0,0,0.5)', overflow:'hidden' }}>
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', padding:'15px 18px', borderBottom:`1px solid ${colors.border}` }}>
              <div style={{ display:'flex', alignItems:'center', gap:'8px', color:colors.textPrimary, fontWeight:700 }}>
                <StickyNote size={17} color="#f59e0b" /> Nota del cliente
              </div>
              <button onClick={() => setShowNoteEditor(false)} disabled={noteSaving} style={{ border:'none', background:'none', color:colors.textMuted, cursor:'pointer', padding:'3px' }}><X size={18} /></button>
            </div>
            <div style={{ padding:'16px 18px' }}>
              <div style={{ color:colors.textSecondary, fontSize:'12px', lineHeight:1.45, marginBottom:'10px' }}>
                Información interna que conviene recordar en todos sus chats, por ejemplo horario preferido, referencias de dirección o indicaciones habituales.
              </div>
              <textarea
                autoFocus
                value={noteDraft}
                onChange={e => setNoteDraft(e.target.value)}
                maxLength={1000}
                rows={5}
                placeholder="Ej: Entregar después de las 18:00. Llamar al llegar."
                style={{ width:'100%', boxSizing:'border-box', resize:'vertical', padding:'10px 12px', borderRadius:'9px', border:`1px solid ${colors.borderStrong}`, backgroundColor:colors.bgSub, color:colors.textPrimary, fontSize:'13px', lineHeight:1.5, outline:'none' }}
              />
              <div style={{ display:'flex', justifyContent:'space-between', marginTop:'5px', fontSize:'11px', color:colors.textMuted }}>
                <span>No se envía por WhatsApp.</span><span>{noteDraft.length}/1000</span>
              </div>
              {noteError && <div style={{ color:colors.red, fontSize:'12px', marginTop:'8px' }}>{noteError}</div>}
              <div style={{ display:'flex', justifyContent:'flex-end', gap:'8px', marginTop:'15px' }}>
                <button onClick={() => setShowNoteEditor(false)} disabled={noteSaving} style={{ padding:'8px 13px', borderRadius:'8px', border:`1px solid ${colors.border}`, background:'none', color:colors.textSecondary, cursor:'pointer' }}>Cancelar</button>
                <button onClick={handleSaveCustomerNote} disabled={noteSaving} style={{ padding:'8px 15px', borderRadius:'8px', border:'none', backgroundColor:colors.green, color:'#fff', fontWeight:700, cursor:noteSaving?'wait':'pointer', opacity:noteSaving?.7:1 }}>
                  {noteSaving ? 'Guardando…' : noteDraft.trim() ? 'Guardar nota' : 'Eliminar nota'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Modal de templates */}
      {showOrderModal && editingOrderProduct && <OrderProductEditor
        key={editingOrderProduct.id}
        product={editingOrderProduct} colors={colors}
        onClose={() => setEditingOrderProduct(null)}
        onSaved={updated => {
          setProducts(previous => previous.map(p => String(p.id) === String(updated.id)
            ? { ...p, ...updated, ...(p._specialPrice ? { price:p.price, _specialPrice:true } : {}) }
            : p));
          setEditingOrderProduct(null);
        }}
      />}
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
                  <span style={{ fontSize:'10px', fontWeight:700, backgroundColor: colors.indigo + '20', color: colors.indigo, border:`1px solid ${colors.indigo}55`, borderRadius:'20px', padding:'2px 8px' }}>
                    🏢 Productos empresa
                  </span>
                )}
              </div>
              <button onClick={() => setShowOrderModal(false)} style={{ background:'none', border:'none', cursor:'pointer', color:colors.textMuted, padding:'4px' }}>
                <X size={18} />
              </button>
            </div>

            {/* Buscador de productos */}
            <div style={{ padding:'10px 16px', borderBottom:`1px solid ${colors.border}`, backgroundColor:colors.bgPanel }}>
              <div style={{ position:'relative' }}>
                <Search size={15} color={colors.textMuted} style={{ position:'absolute', left:'11px', top:'50%', transform:'translateY(-50%)', pointerEvents:'none' }} />
                <input
                  value={orderProductSearch}
                  onChange={event => setOrderProductSearch(event.target.value)}
                  placeholder="Buscar por nombre, calibre, color o presentación…"
                  aria-label="Buscar productos para la nueva orden"
                  style={{ width:'100%', boxSizing:'border-box', padding:'9px 34px 9px 34px', borderRadius:'9px', border:`1px solid ${colors.borderStrong}`, backgroundColor:colors.bgInput, color:colors.textPrimary, fontSize:'13px', outline:'none' }}
                />
                {orderProductSearch && (
                  <button onClick={() => setOrderProductSearch('')} aria-label="Limpiar búsqueda"
                    style={{ position:'absolute', right:'8px', top:'50%', transform:'translateY(-50%)', border:0, background:'none', color:colors.textMuted, cursor:'pointer', padding:'3px', display:'flex' }}>
                    <X size={14} />
                  </button>
                )}
              </div>
              {orderProductSearch && <div style={{ marginTop:'5px', fontSize:'11px', color:colors.textMuted }}>{filteredOrderProducts.length} producto{filteredOrderProducts.length === 1 ? '' : 's'} encontrado{filteredOrderProducts.length === 1 ? '' : 's'}</div>}
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
              ) : filteredOrderProducts.length === 0 ? (
                <div style={{ textAlign:'center', padding:'36px 18px', color:colors.textMuted }}>
                  No encontramos productos con “{orderProductSearch}”.
                </div>
              ) : filteredOrderProducts.map(p => {
                const qty = orderItems[p.id] || 0;
                return (
                  <div key={p.id} style={{ display:'flex', alignItems:'center', gap:'12px', padding:'10px 0', borderBottom:`1px solid ${colors.border}` }}>
                    <div style={{ width:'48px', height:'48px', borderRadius:'9px', flexShrink:0, overflow:'hidden', position:'relative', display:'flex', alignItems:'center', justifyContent:'center', backgroundColor:colors.bgSub, border:`1px solid ${colors.border}` }}>
                      <span aria-hidden="true" style={{ fontSize:'20px', opacity:.55 }}>{String(p.category || '').toLowerCase().includes('huevo') ? '🥚' : '📦'}</span>
                      {p.image_url && <img src={p.image_url} alt={p.title} loading="lazy" onError={event => { event.currentTarget.style.display='none'; }} style={{ position:'absolute', inset:0, width:'100%', height:'100%', objectFit:'cover' }} />}
                    </div>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontWeight:600, fontSize:'13px', color:colors.textPrimary }}>{p.title}</div>
                      <button type="button" aria-label={`Editar ${p.title}`} disabled={creatingOrder} onClick={() => setEditingOrderProduct(p)} style={{ display:'inline-flex', alignItems:'center', gap:'4px', padding:'5px 0', background:'none', border:0, color:colors.green, cursor:'pointer', fontSize:'12px' }}><Pencil size={12} /> Editar</button>
                      <div style={{ display:'flex', alignItems:'center', gap:'6px' }}>
                        <span style={{ fontSize:'12px', color:colors.green, fontWeight:700 }}>${parseFloat(p.price).toLocaleString('es-CL')}</span>
                        {p._specialPrice && <span style={{ fontSize:'10px', backgroundColor:'#05966922', color:'#059669', borderRadius:'4px', padding:'1px 5px', fontWeight:700 }}>precio especial</span>}
                      </div>
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

              {/* Botón + formulario nuevo producto */}
              {!showNewProdForm ? (
                <button
                  onClick={() => { setShowNewProdForm(true); setNewProdError(''); }}
                  style={{ display:'flex', alignItems:'center', gap:'6px', marginTop:'10px', background:'none', border:`1px dashed ${colors.border}`, borderRadius:'8px', padding:'8px 14px', cursor:'pointer', color:colors.textSecondary, fontSize:'13px', width:'100%', justifyContent:'center' }}>
                  <Plus size={14} /> Nuevo producto
                </button>
              ) : (
                <div style={{ marginTop:'12px', padding:'12px', borderRadius:'10px', border:`1px solid ${colors.border}`, background: colors.bgSub, display:'flex', flexDirection:'column', gap:'8px' }}>
                  <div style={{ fontSize:'12px', fontWeight:700, color:colors.textSecondary, marginBottom:'2px' }}>NUEVO PRODUCTO</div>
                  <input
                    autoFocus
                    placeholder='Nombre del producto *'
                    value={newProdForm.title}
                    onChange={e => setNewProdForm(f => ({ ...f, title: e.target.value }))}
                    style={{ padding:'8px 10px', borderRadius:'7px', border:`1px solid ${colors.border}`, background:colors.bgPanel, color:colors.textPrimary, fontSize:'13px' }}
                  />
                  <input
                    type='number' min='0' placeholder='Precio *'
                    value={newProdForm.price}
                    onChange={e => setNewProdForm(f => ({ ...f, price: e.target.value }))}
                    style={{ padding:'8px 10px', borderRadius:'7px', border:`1px solid ${colors.border}`, background:colors.bgPanel, color:colors.textPrimary, fontSize:'13px' }}
                  />
                  <input
                    placeholder='Descripción (opcional)'
                    value={newProdForm.description}
                    onChange={e => setNewProdForm(f => ({ ...f, description: e.target.value }))}
                    style={{ padding:'8px 10px', borderRadius:'7px', border:`1px solid ${colors.border}`, background:colors.bgPanel, color:colors.textPrimary, fontSize:'13px' }}
                  />

                  {/* Toggle: asignar a empresas específicas */}
                  <label style={{ display:'flex', alignItems:'center', gap:'8px', cursor:'pointer', fontSize:'13px', color:colors.textSecondary, userSelect:'none' }}>
                    <input type='checkbox' checked={newProdForEmpresas}
                      onChange={e => {
                        const next = e.target.checked;
                        setNewProdForEmpresas(next);
                        if (next && newProdEmpresas.length === 0) {
                          api.get('/contacts/empresas').then(({ data }) => {
                            let list = data.data || [];
                            // Garantizar que el contacto actual siempre aparezca si es empresa
                            if (isEmpresa) {
                              const phone = conversation.phone_number;
                              const ya = list.find(e => e.phone === phone);
                              if (!ya) list = [{ phone, name: conversation.contact_name || null, address: null, city: null }, ...list];
                            }
                            setNewProdEmpresas(list);
                          }).catch(() => {});
                        }
                        if (!next) setNewProdSelEmpresas(new Set());
                      }} />
                    🏢 Asignar a empresas específicas
                  </label>

                  {/* Lista de empresas */}
                  {newProdForEmpresas && (
                    <div style={{ border:`1px solid ${colors.border}`, borderRadius:'8px', overflow:'hidden', maxHeight:'160px', overflowY:'auto' }}>
                      {newProdEmpresas.length === 0 ? (
                        <div style={{ padding:'12px', fontSize:'12px', color:colors.textSecondary, textAlign:'center' }}>
                          No hay contactos empresa. Marca un contacto como 🏢 Empresa desde el chat.
                        </div>
                      ) : (
                        <>
                          {/* Seleccionar todas */}
                          <div
                            onClick={() => {
                              if (newProdSelEmpresas.size === newProdEmpresas.length) {
                                setNewProdSelEmpresas(new Set());
                              } else {
                                setNewProdSelEmpresas(new Set(newProdEmpresas.map(e => e.phone)));
                              }
                            }}
                            style={{ display:'flex', alignItems:'center', gap:'8px', padding:'7px 10px', borderBottom:`1px solid ${colors.border}`, cursor:'pointer', background: colors.bgPanel }}>
                            <input type='checkbox' readOnly style={{ pointerEvents:'none' }}
                              checked={newProdSelEmpresas.size === newProdEmpresas.length && newProdEmpresas.length > 0} />
                            <span style={{ fontSize:'11px', fontWeight:600, color:colors.textSecondary }}>Seleccionar todas</span>
                          </div>
                          {newProdEmpresas.map(e => (
                            <div key={e.phone}
                              onClick={() => {
                                const next = new Set(newProdSelEmpresas);
                                next.has(e.phone) ? next.delete(e.phone) : next.add(e.phone);
                                setNewProdSelEmpresas(next);
                              }}
                              style={{ display:'flex', alignItems:'center', gap:'8px', padding:'7px 10px',
                                background: newProdSelEmpresas.has(e.phone) ? (colors.green + '18') : 'transparent',
                                cursor:'pointer', borderBottom:`1px solid ${colors.border}` }}>
                              <input type='checkbox' readOnly style={{ pointerEvents:'none' }} checked={newProdSelEmpresas.has(e.phone)} />
                              <div>
                                <div style={{ fontSize:'12px', fontWeight:500, color:colors.textPrimary }}>{e.name || e.phone}</div>
                                {e.name && <div style={{ fontSize:'11px', color:colors.textSecondary }}>{e.phone}</div>}
                              </div>
                            </div>
                          ))}
                        </>
                      )}
                    </div>
                  )}
                  {newProdForEmpresas && newProdSelEmpresas.size > 0 && (
                    <div style={{ fontSize:'11px', color:'#059669', fontWeight:600 }}>
                      ✓ Se asignará a {newProdSelEmpresas.size} empresa{newProdSelEmpresas.size !== 1 ? 's' : ''}
                    </div>
                  )}

                  {newProdError && <div style={{ color:colors.red, fontSize:'12px' }}>{newProdError}</div>}
                  <div style={{ display:'flex', gap:'8px' }}>
                    <button
                      onClick={handleSaveNewProduct}
                      disabled={savingNewProd || !newProdForm.title.trim() || !newProdForm.price}
                      style={{ flex:1, padding:'7px', borderRadius:'7px', border:'none', background:colors.green, color:'#fff', fontWeight:700, fontSize:'13px', cursor:'pointer', opacity:(savingNewProd || !newProdForm.title.trim() || !newProdForm.price)?0.6:1 }}>
                      {savingNewProd ? 'Guardando...' : 'Guardar'}
                    </button>
                    <button
                      onClick={() => { setShowNewProdForm(false); setNewProdForm({ title:'', price:'', description:'' }); setNewProdError(''); setNewProdForEmpresas(false); setNewProdSelEmpresas(new Set()); }}
                      style={{ padding:'7px 14px', borderRadius:'7px', border:`1px solid ${colors.border}`, background:'none', color:colors.textSecondary, fontSize:'13px', cursor:'pointer' }}>
                      Cancelar
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Footer */}
            <div style={{ padding:'14px 20px', borderTop:`1px solid ${colors.border}` }}>
              {/* Dirección de despacho */}
              <div style={{ marginBottom:'12px', display:'flex', flexDirection:'column', gap:'6px' }}>
                <div style={{ fontSize:'11px', color:colors.textSecondary, textTransform:'uppercase', letterSpacing:'0.5px' }}>Dirección de despacho</div>
                <ClientAddressFields phone={conversation.phone_number} address={orderAddress} city={orderCity}
                  onAddressChange={setOrderAddress} onCityChange={setOrderCity} colors={colors} compact />
              </div>
              <div style={{ marginBottom:'12px', display:'flex', flexDirection:'column', gap:'6px' }}>
                <div style={{ display:'flex', justifyContent:'space-between', gap:'8px', alignItems:'center' }}>
                  <div style={{ fontSize:'11px', color:colors.textSecondary, textTransform:'uppercase', letterSpacing:'0.5px' }}>Nota para este despacho (opcional)</div>
                  {customerNote && <span style={{ fontSize:'10px', color:'#f59e0b' }}>Sugerida desde la nota del cliente</span>}
                </div>
                <textarea
                  value={orderNote}
                  onChange={e => setOrderNote(e.target.value)}
                  maxLength={1000}
                  rows={2}
                  placeholder="Ej: Entregar entre 18:00 y 20:00; llamar al llegar."
                  style={{ width:'100%', boxSizing:'border-box', resize:'vertical', backgroundColor:colors.bgSub, color:colors.textPrimary, border:`1px solid ${colors.border}`, borderRadius:'8px', padding:'8px 10px', fontSize:'13px', outline:'none' }}
                />
                <div style={{ fontSize:'10px', color:colors.textMuted }}>La verá el equipo de despacho. No se enviará en el resumen de WhatsApp.</div>
              </div>
              {/* Descuento */}
              <div style={{ marginBottom:'12px', display:'flex', flexDirection:'column', gap:'6px' }}>
                <div style={{ fontSize:'11px', color:colors.textSecondary, textTransform:'uppercase', letterSpacing:'0.5px' }}>Descuento (opcional)</div>
                <div style={{ display:'flex', gap:'6px' }}>
                  <input
                    type='number' min='0'
                    value={orderDiscount}
                    onChange={e => setOrderDiscount(e.target.value)}
                    placeholder={orderDiscountType === 'percent' ? 'Ej: 10' : 'Ej: 5000'}
                    style={{ flex:1, backgroundColor:colors.bgSub, color:colors.textPrimary, border:`1px solid ${colors.border}`, borderRadius:'8px', padding:'7px 10px', fontSize:'13px', outline:'none' }}
                  />
                  <select value={orderDiscountType} onChange={e => setOrderDiscountType(e.target.value)}
                    style={{ backgroundColor:colors.bgSub, color:colors.textPrimary, border:`1px solid ${colors.border}`, borderRadius:'8px', padding:'7px 10px', fontSize:'13px', cursor:'pointer', outline:'none' }}>
                    <option value="percent">%</option>
                    <option value="fixed">$</option>
                  </select>
                </div>
              </div>

              <label style={{ display:'flex', alignItems:'center', gap:'8px', marginBottom:'12px', cursor:'pointer', fontSize:'13px', color:colors.textSecondary }}>
                <input type="checkbox" checked={sendSummary} onChange={e => setSendSummary(e.target.checked)} />
                Enviar resumen por WhatsApp al cliente
              </label>
              {orderError && <div style={{ color:colors.red, fontSize:'12px', marginBottom:'8px' }}>{orderError}</div>}
              <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
                <div style={{ display:'flex', flexDirection:'column', gap:'2px' }}>
                  {discountAmount > 0 && (
                    <div style={{ fontSize:'11px', color:colors.textMuted }}>
                      Subtotal: <span style={{ fontWeight:600 }}>${orderSubtotal.toLocaleString('es-CL')}</span>
                    </div>
                  )}
                  {discountAmount > 0 && (
                    <div style={{ fontSize:'11px', color:colors.dangerSoft }}>
                      Descuento ({orderDiscountType === 'percent' ? `${discountNum}%` : `$${discountNum.toLocaleString('es-CL')}`}): <span style={{ fontWeight:600 }}>-${Math.round(discountAmount).toLocaleString('es-CL')}</span>
                    </div>
                  )}
                  <div>
                    <span style={{ fontSize:'12px', color:colors.textMuted }}>Total: </span>
                    <span style={{ fontWeight:700, fontSize:'16px', color:colors.green }}>${orderTotal.toLocaleString('es-CL')}</span>
                  </div>
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

      {showPaymentModal && (
        <div style={{
          position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.66)',
          zIndex: 105, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px',
        }} onClick={() => !paymentSending && setShowPaymentModal(false)}>
          <div style={{
            width: '100%', maxWidth: '500px', backgroundColor: colors.bgPanel,
            border: `1px solid ${colors.border}`, borderRadius: '14px', overflow: 'hidden',
            boxShadow: '0 20px 60px rgba(0,0,0,.42)',
          }} onClick={event => event.stopPropagation()}>
            <div style={{ padding: '16px 18px', borderBottom: `1px solid ${colors.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display:'flex', alignItems:'center', gap:'9px' }}>
                <CircleDollarSign size={18} color={colors.green} />
                <div>
                  <div style={{ color: colors.textPrimary, fontWeight: 700, fontSize: '15px' }}>Enviar opciones de pago</div>
                  <div style={{ color: colors.textSecondary, fontSize: '11px', marginTop: '2px' }}>Revisa el mensaje antes de enviarlo al cliente.</div>
                </div>
              </div>
              <button onClick={() => setShowPaymentModal(false)} disabled={paymentSending}
                style={{ border:0, background:'none', color:colors.textSecondary, cursor:'pointer', padding:'4px' }}>
                <X size={18} />
              </button>
            </div>
            <div style={{ padding:'18px' }}>
              {paymentLoading ? (
                <div style={{ display:'flex', alignItems:'center', justifyContent:'center', gap:'8px', minHeight:'110px', color:colors.textSecondary, fontSize:'13px' }}>
                  <Loader size={18} style={{ animation:'spin 1s linear infinite' }} /> Cargando datos configurados…
                </div>
              ) : paymentError ? (
                <div role="alert" style={{ color:colors.red, fontSize:'13px', display:'flex', gap:'7px', alignItems:'flex-start', padding:'12px', backgroundColor:`${colors.red}12`, borderRadius:'8px' }}>
                  <AlertCircle size={16} style={{ flexShrink:0 }} /> {paymentError}
                </div>
              ) : (
                <div style={{ padding:'14px 16px', backgroundColor:colors.bgSub, border:`1px solid ${colors.border}`, borderRadius:'9px', color:colors.textPrimary, fontSize:'13px', lineHeight:1.55, whiteSpace:'pre-wrap' }}>
                  {paymentPreview}
                </div>
              )}
            </div>
            <div style={{ padding:'12px 18px', borderTop:`1px solid ${colors.border}`, display:'flex', justifyContent:'flex-end', gap:'8px' }}>
              <button onClick={() => setShowPaymentModal(false)} disabled={paymentSending}
                style={{ padding:'8px 15px', borderRadius:'8px', backgroundColor:'transparent', color:colors.textSecondary, border:`1px solid ${colors.borderStrong}`, cursor:'pointer', fontSize:'13px' }}>
                Cancelar
              </button>
              <button onClick={sendPaymentOptions} disabled={paymentLoading || paymentSending || !paymentPreview || !!paymentError}
                style={{ padding:'8px 17px', borderRadius:'8px', border:'none', backgroundColor:paymentPreview && !paymentError ? colors.green : colors.bgHover, color:paymentPreview && !paymentError ? '#fff' : colors.textMuted, cursor:paymentPreview && !paymentError ? 'pointer' : 'not-allowed', fontSize:'13px', fontWeight:700, display:'flex', alignItems:'center', gap:'6px' }}>
                {paymentSending ? <><Loader size={14} style={{ animation:'spin 1s linear infinite' }} /> Enviando…</> : <><Send size={14} /> Enviar</>}
              </button>
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
                <FileText size={16} color={colors.infoSoft} />
                <span style={{ color: colors.textPrimary, fontWeight: 600, fontSize: '15px' }}>Enviar Template</span>
              </div>
              <button onClick={() => setShowTemplateModal(false)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: colors.textSecondary, padding: '4px' }}>
                <X size={18} />
              </button>
            </div>
            <div style={{ padding: '10px 20px', backgroundColor: colors.bgAccent, borderBottom: `1px solid ${colors.border}`, fontSize: '12px', color: colors.infoSoft, display: 'flex', alignItems: 'flex-start', gap: '6px' }}>
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
                              <textarea value={templateManualVars[v] ?? ''} onChange={e => setTemplateManualVars(prev => ({ ...prev, [v]: e.target.value }))}
                                placeholder={`Texto para {{${v}}}...`}
                                rows={Math.max(2, String(templateManualVars[v] ?? '').split('\n').length)}
                                style={{ flex: 1, backgroundColor: colors.bgInput, color: colors.textPrimary, border: `1px solid ${colors.border}`, borderRadius: '5px', padding: '4px 8px', fontSize: '12px', outline: 'none', resize: 'vertical', whiteSpace: 'pre-wrap' }} />
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
                  {selectedTemplate && missingTemplateVars().length > 0 && (
                    <div style={{ color: colors.red, fontSize: '12px' }}>
                      Completa {missingTemplateVars().map(v => `{{${v}}}`).join(', ')} para poder enviar.
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
                <button onClick={sendTemplateMessage} disabled={!selectedTemplate || sendingTemplate || missingTemplateVars().length > 0}
                  style={{ padding: '8px 20px', borderRadius: '8px', backgroundColor: selectedTemplate && missingTemplateVars().length === 0 ? colors.infoSoft : colors.bgHover, color: selectedTemplate && missingTemplateVars().length === 0 ? '#000' : colors.textSecondary, border: 'none', cursor: selectedTemplate && missingTemplateVars().length === 0 ? 'pointer' : 'not-allowed', fontSize: '13px', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '6px', opacity: sendingTemplate ? 0.7 : 1 }}>
                  {sendingTemplate ? <><Loader size={13} style={{ animation: 'spin 1s linear infinite' }} /> Enviando...</> : <><Send size={13} /> Enviar Template</>}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {alternateSend && (
        <div style={{
          position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.66)',
          zIndex: 110, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '20px',
        }} onClick={() => !alternateSending && setAlternateSend(null)}>
          <div style={{
            width: '100%', maxWidth: '480px', backgroundColor: colors.bgPanel,
            border: `1px solid ${colors.border}`, borderRadius: '14px', overflow: 'hidden',
            boxShadow: '0 20px 60px rgba(0,0,0,.42)',
          }} onClick={event => event.stopPropagation()}>
            <div style={{ padding: '16px 18px', borderBottom: `1px solid ${colors.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div style={{ color: colors.textPrimary, fontWeight: 700, fontSize: '15px' }}>Enviar por otro WhatsApp</div>
                <div style={{ color: colors.textSecondary, fontSize: '11px', marginTop: '3px' }}>La ventana del canal oficial venció; tu mensaje sigue listo.</div>
              </div>
              <button onClick={() => setAlternateSend(null)} disabled={alternateSending}
                style={{ border: 0, background: 'none', color: colors.textSecondary, cursor: 'pointer', padding: '4px' }}>
                <X size={18} />
              </button>
            </div>
            <div style={{ padding: '18px', display: 'flex', flexDirection: 'column', gap: '13px' }}>
              <div style={{ padding: '10px 12px', borderRadius: '9px', backgroundColor: '#2563eb18', border: '1px solid #3b82f644', color: colors.infoSoft, fontSize: '12px' }}>
                Se enviará a <strong>{conversation.contact_name || conversation.phone_number}</strong> ({conversation.phone_number}) desde Evolution.
              </div>
              {alternateSend.channels.length > 1 && (
                <label style={{ color: colors.textSecondary, fontSize: '11px' }}>
                  Número de salida
                  <select value={alternateSend.channelId}
                    onChange={event => setAlternateSend(current => ({ ...current, channelId: event.target.value }))}
                    style={{ width: '100%', marginTop: '6px', padding: '9px 10px', borderRadius: '7px', backgroundColor: colors.bgInput, color: colors.textPrimary, border: `1px solid ${colors.border}` }}>
                    {alternateSend.channels.map(channel => (
                      <option key={channel.id} value={channel.id}>{channel.name}{channel.phone_number ? ` · ${channel.phone_number}` : ''}</option>
                    ))}
                  </select>
                </label>
              )}
              <label style={{ color: colors.textSecondary, fontSize: '11px' }}>
                Mensaje
                <textarea value={alternateSend.text}
                  onChange={event => setAlternateSend(current => ({ ...current, text: event.target.value }))}
                  rows={4} autoFocus
                  style={{ width: '100%', boxSizing: 'border-box', marginTop: '6px', padding: '10px 11px', resize: 'vertical', borderRadius: '8px', backgroundColor: colors.bgInput, color: colors.textPrimary, border: `1px solid ${colors.border}`, fontFamily: 'inherit' }} />
              </label>
              {alternateError && <div style={{ color: colors.red, fontSize: '12px' }}>{alternateError}</div>}
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px' }}>
                <button onClick={() => setAlternateSend(null)} disabled={alternateSending}
                  style={{ border: `1px solid ${colors.border}`, background: 'none', color: colors.textSecondary, borderRadius: '8px', padding: '9px 13px', cursor: 'pointer' }}>
                  Cancelar
                </button>
                <button onClick={sendThroughAlternateChannel} disabled={alternateSending || !alternateSend.text.trim()}
                  style={{ border: 0, backgroundColor: '#2563eb', color: '#fff', borderRadius: '8px', padding: '9px 15px', fontWeight: 700, cursor: alternateSending ? 'wait' : 'pointer', display: 'flex', alignItems: 'center', gap: '7px' }}>
                  {alternateSending ? <Loader size={14} className="spin" /> : <Send size={14} />}
                  {alternateSending ? 'Enviando...' : 'Enviar por Evolution'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Input */}
      <div style={{
        padding: '8px 16px 10px',
        backgroundColor: colors.bgPanel,
        borderTop: `1px solid ${colors.border}`,
      }}>
        {attachment && (
          <div style={{ display:'flex', alignItems:'center', gap:'10px', padding:'7px 9px', marginBottom:'8px', borderRadius:'9px', backgroundColor:colors.bgInput, border:`1px solid ${colors.border}` }}>
            {attachment.mimeType.startsWith('image/')
              ? <img src={attachment.data} alt="Vista previa" style={{ width:'44px', height:'44px', borderRadius:'7px', objectFit:'cover' }} />
              : <FileText size={25} color={colors.infoSoft || colors.green} />}
            <div style={{ flex:1, minWidth:0 }}>
              <div style={{ color:colors.textPrimary, fontSize:'12px', fontWeight:600, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{attachment.fileName}</div>
              <div style={{ color:colors.textMuted, fontSize:'10px', marginTop:'2px' }}>{(attachment.size / 1024).toFixed(0)} KB · agrega una descripción si quieres</div>
            </div>
            <button onClick={() => setAttachment(null)} aria-label="Quitar archivo" style={{ border:'none', background:'transparent', color:colors.textMuted, cursor:'pointer', padding:'5px', display:'flex' }}><X size={17} /></button>
          </div>
        )}
        <div style={{ display:'flex', alignItems:'flex-end', gap:'9px' }}>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp,.pdf,.doc,.docx,.xls,.xlsx,.csv,.txt"
            onChange={handleFileSelected}
            style={{ display:'none' }}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={sending}
            aria-label="Adjuntar foto o archivo"
            title="Adjuntar foto o archivo (máx. 6 MB)"
            style={{ width:'42px', height:'42px', borderRadius:'50%', border:`1px solid ${colors.border}`, backgroundColor:colors.bgInput, color:colors.textSecondary, cursor:sending?'default':'pointer', display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
            <Paperclip size={18} />
          </button>
          <textarea
          ref={inputRef}
          value={inputText}
          onChange={e => setInputText(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={isHumanMode ? 'Escribe un mensaje o pega una imagen...' : 'Escribe o pega una imagen para responder...'}
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
          disabled={(!inputText.trim() && !attachment) || sending}
          style={{
            backgroundColor: (inputText.trim() || attachment) ? colors.green : colors.bgHover,
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
            cursor: (inputText.trim() || attachment) ? 'pointer' : 'default',
          }}
        >
          {sending ? <Loader size={18} style={{ animation:'spin 1s linear infinite' }} /> : attachment ? <ImageIcon size={18} /> : <Send size={18} />}
        </button>
        </div>
      </div>

      {/* ── Modal Análisis de conversación ── */}
      {showAnalysis && (
        <div onClick={() => setShowAnalysis(false)} style={{ position:'fixed', inset:0, backgroundColor:'rgba(0,0,0,0.65)', zIndex:1000, display:'flex', alignItems:'center', justifyContent:'center', padding:'16px' }}>
          <div onClick={e => e.stopPropagation()} style={{ backgroundColor: colors.bgPanel, borderRadius:'14px', border:`1px solid ${colors.border}`, width:'100%', maxWidth:'560px', maxHeight:'85vh', display:'flex', flexDirection:'column', boxShadow:'0 20px 60px rgba(0,0,0,0.5)' }}>
            {/* Header */}
            <div style={{ padding:'16px 20px', borderBottom:`1px solid ${colors.border}`, display:'flex', justifyContent:'space-between', alignItems:'center' }}>
              <div style={{ display:'flex', alignItems:'center', gap:'8px' }}>
                <BarChart2 size={16} color={colors.purpleSoft} />
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
                <div style={{ padding:'12px', backgroundColor:colors.danger + '20', borderRadius:'8px', color:colors.danger, fontSize:'13px' }}>
                  {analysisData.error}
                </div>
              )}

              {!analysisLoading && analysisData && !analysisData.error && (() => {
                const a = analysisData;
                const puntaje = a.puntaje_bot || 0;
                const puntajeColor = puntaje >= 4 ? colors.success : puntaje >= 3 ? colors.amberStrong : colors.danger;
                const estadoColors = {
                  'compró': colors.success, 'agendó': colors.purpleSoft, 'interesado': colors.amberStrong,
                  'exploró': colors.textMuted, 'insatisfecho': colors.danger, 'se dio de baja': '#6b7280', 'otro': colors.textMuted,
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
                        <div style={{ fontSize:'13px', fontWeight:600, color: a.deteccion_correcta ? colors.success : colors.danger }}>
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

                    <Section title="✓ Aciertos" color={colors.success} items={a.aciertos} />
                    <Section title="✗ Errores detectados" color={colors.danger} items={a.errores} />
                    <Section title="💡 Oportunidades de mejora" color={colors.amberStrong} items={a.oportunidades} />

                    {/* Próxima acción */}
                    {a.proxima_accion && (
                      <div style={{ backgroundColor:colors.purpleSoft + '18', border:`1px solid ${colors.purpleSoft}40`, borderRadius:'10px', padding:'12px' }}>
                        <div style={{ fontSize:'11px', fontWeight:700, color:colors.purpleSoft, textTransform:'uppercase', letterSpacing:'0.05em', marginBottom:'4px' }}>Próxima acción recomendada</div>
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
                <div style={{ fontSize:'12px', fontWeight:700, color:colors.amberStrong, textTransform:'uppercase', letterSpacing:'0.05em', marginBottom:'10px' }}>
                  🤖 Reglas generadas para el bot
                </div>
                {improvementsData.newRules.length === 0 ? (
                  <div style={{ fontSize:'13px', color:colors.textMuted }}>No se detectaron mejoras necesarias.</div>
                ) : (
                  <>
                    <div style={{ display:'flex', flexDirection:'column', gap:'6px', marginBottom:'12px' }}>
                      {improvementsData.newRules.map((rule, i) => (
                        <div key={i} style={{ display:'flex', alignItems:'flex-start', gap:'8px', fontSize:'13px', color:colors.textPrimary, backgroundColor:colors.bgPanel, borderRadius:'8px', padding:'8px 10px', border:`1px solid ${colors.border}` }}>
                          <span style={{ color:colors.amberStrong, fontWeight:700, flexShrink:0 }}>{i+1}.</span>
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
                      <div style={{ fontSize:'13px', color:colors.success, display:'flex', alignItems:'center', gap:'6px' }}>
                        ✓ Reglas guardadas — el bot las aplicará desde ahora
                      </div>
                    ) : (
                      <button
                        onClick={() => saveRules(improvementsData.combined)}
                        disabled={savingRules}
                        style={{ fontSize:'13px', fontWeight:600, color:'#fff', backgroundColor:colors.amberStrong, border:'none', borderRadius:'8px', padding:'8px 16px', cursor: savingRules ? 'not-allowed' : 'pointer', opacity: savingRules ? 0.7 : 1 }}
                      >
                        {savingRules ? 'Guardando...' : '💾 Guardar en el bot'}
                      </button>
                    )}
                  </>
                )}
              </div>
            )}
            {!analysisLoading && improvementsData?.error && (
              <div style={{ borderTop:`1px solid ${colors.border}`, padding:'12px 20px', color:colors.danger, fontSize:'13px' }}>
                Error generando mejoras: {improvementsData.error}
              </div>
            )}

            {/* Footer */}
            {!analysisLoading && (
              <div style={{ padding:'12px 20px', borderTop:`1px solid ${colors.border}`, display:'flex', justifyContent:'space-between', alignItems:'center' }}>
                <button onClick={openAnalysis} style={{ fontSize:'12px', color:colors.purpleSoft, background:'none', border:'none', cursor:'pointer', display:'flex', alignItems:'center', gap:'4px' }}>
                  <BarChart2 size={12} /> Volver a analizar
                </button>
                {analysisData && !analysisData.error && (analysisData.errores?.length || analysisData.oportunidades?.length) ? (
                  improvementsLoading ? (
                    <span style={{ fontSize:'12px', color:colors.amberStrong }}>Generando mejoras...</span>
                  ) : !improvementsData ? (
                    <button
                      onClick={() => generateImprovements(analysisData)}
                      style={{ fontSize:'12px', fontWeight:600, color:colors.amberStrong, background:'none', border:`1px solid ${colors.amberStrong}`, borderRadius:'6px', padding:'4px 10px', cursor:'pointer', display:'flex', alignItems:'center', gap:'4px' }}
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

function MobileHeaderAction({ icon, label, colors, onClick, active = false, danger = false, disabled = false }) {
  const color = danger ? colors.danger : active ? colors.green : colors.textPrimary;
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        width: '100%', minHeight: '42px', padding: '0 10px', borderRadius: '9px',
        display: 'flex', alignItems: 'center', gap: '10px', textAlign: 'left',
        color, backgroundColor: active ? `${color}16` : 'transparent', border: 'none',
        opacity: disabled ? 0.55 : 1, cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      <span style={{ width: '20px', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        {icon}
      </span>
      <span style={{ fontSize: '13px', fontWeight: active ? 650 : 500 }}>{label}</span>
    </button>
  );
}
