import { useState, useEffect, useCallback, useRef } from 'react';
import {
  UserCheck, RefreshCw, Sparkles, Send, Clock,
  ShoppingBag, TrendingUp, ChevronDown, ChevronUp,
  CheckSquare, Square, AlertCircle, Loader, Brain, Zap,
  FileText, ToggleLeft, ToggleRight, ChevronDown as ChevronDownIcon,
} from 'lucide-react';
import { api, reengagementAPI } from '../utils/api.js';

function Tooltip({ text, children, position = 'top' }) {
  const [show, setShow] = useState(false);
  const ref = useRef(null);

  const tipStyle = {
    position: 'absolute',
    backgroundColor: '#1a2530',
    color: '#e9edef',
    fontSize: '11.5px',
    lineHeight: 1.5,
    padding: '7px 11px',
    borderRadius: '7px',
    border: '1px solid #2a3942',
    boxShadow: '0 4px 14px rgba(0,0,0,0.6)',
    zIndex: 9999,
    pointerEvents: 'none',
    whiteSpace: 'normal',
    maxWidth: '200px',
    textAlign: 'center',
    ...(position === 'top'    && { bottom: 'calc(100% + 6px)', left: '50%', transform: 'translateX(-50%)' }),
    ...(position === 'bottom' && { top:    'calc(100% + 6px)', left: '50%', transform: 'translateX(-50%)' }),
    ...(position === 'left'   && { right:  'calc(100% + 6px)', top: '50%',  transform: 'translateY(-50%)' }),
    ...(position === 'right'  && { left:   'calc(100% + 6px)', top: '50%',  transform: 'translateY(-50%)' }),
  };

  return (
    <span ref={ref} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', cursor: 'default' }}
      onMouseEnter={() => setShow(true)}
      onMouseLeave={() => setShow(false)}>
      {children}
      {show && <span style={tipStyle}>{text}</span>}
    </span>
  );
}

// Ventanas de tiempo para agrupar predicciones
const WINDOWS = [
  { key: 'hoy',     label: 'Hoy / Mañana',  color: '#00c853', bg: '#0a2e15', desc: 'Predicción: comprarían en las próximas 24-48h' },
  { key: 'semana',  label: 'Esta semana',    color: '#00a884', bg: '#0d2e25', desc: 'Predicción: comprarían en los próximos 7 días' },
  { key: 'mes',     label: 'Este mes',       color: '#f0b429', bg: '#2e2100', desc: 'Predicción: comprarían en los próximos 30 días' },
];

const confColor = (conf) =>
  conf >= 80 ? '#00c853' : conf >= 60 ? '#00a884' : conf >= 40 ? '#f0b429' : '#8696a0';

export default function ReengagementPanel() {
  const [candidates, setCandidates]   = useState([]);
  const [loading, setLoading]         = useState(true);
  const [loadingStep, setLoadingStep] = useState('');
  const [error, setError]             = useState(null);
  const [fromCache, setFromCache]     = useState(false);
  const [activeWindow, setActiveWindow] = useState('hoy');
  const [selected, setSelected]       = useState(new Set());
  const [messages, setMessages]       = useState({});
  const [generating, setGenerating]   = useState(new Set());
  const [sending, setSending]         = useState(new Set());
  const [sendingBulk, setSendingBulk] = useState(false);
  const [expanded, setExpanded]       = useState(new Set());
  const [toast, setToast]             = useState(null);
  const [minConf, setMinConf]         = useState(65);

  // ── Template mode ──────────────────────────────────────────────
  const [useTemplate, setUseTemplate]       = useState(false);
  const [templates, setTemplates]           = useState([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [templatesError, setTemplatesError] = useState(null);
  const [selectedTemplate, setSelectedTemplate] = useState(null);
  // varMap: { "1": "name" | "phone" | "manual" }
  const [varMap, setVarMap]                 = useState({});
  // manualVars: { "1": "texto manual" }
  const [manualVars, setManualVars]         = useState({});

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 4000);
  };

  const load = useCallback(async (forceRefresh = false) => {
    setLoading(true);
    setError(null);
    setSelected(new Set());
    setLoadingStep(forceRefresh
      ? 'Descargando órdenes de Shopify...'
      : 'Cargando análisis predictivo...');

    try {
      const res = await api.get(
        `/reengagement/candidates${forceRefresh ? '?refresh=true' : ''}`,
        { timeout: 180000 }
      );
      setCandidates(res.data.data || []);
      setFromCache(res.data.fromCache || false);
      // Auto-seleccionar la ventana con más candidatos
      const data = res.data.data || [];
      if (data.some(c => c.buyWindow === 'hoy')) setActiveWindow('hoy');
      else if (data.some(c => c.buyWindow === 'semana')) setActiveWindow('semana');
      else setActiveWindow('mes');
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(true); }, []);

  // Cargar templates cuando se activa el modo template
  const loadTemplates = useCallback(async () => {
    setTemplatesLoading(true);
    setTemplatesError(null);
    try {
      const res = await reengagementAPI.getTemplates();
      setTemplates(res.data || []);
    } catch (err) {
      setTemplatesError(err.response?.data?.error || err.message);
    } finally {
      setTemplatesLoading(false);
    }
  }, []);

  const toggleTemplateMode = () => {
    const next = !useTemplate;
    setUseTemplate(next);
    if (next && templates.length === 0) loadTemplates();
  };

  // Parsea las variables {{N}} del texto de un template
  const parseTemplateVars = (tpl) => {
    if (!tpl) return [];
    const bodyComp = (tpl.components || []).find(c => c.type === 'BODY');
    if (!bodyComp?.text) return [];
    const matches = [...bodyComp.text.matchAll(/\{\{(\d+)\}\}/g)];
    return [...new Set(matches.map(m => m[1]))].sort();
  };

  // Seleccionar template e inicializar varMap con "name" por defecto para {{1}}
  const handleSelectTemplate = (tpl) => {
    setSelectedTemplate(tpl);
    const vars = parseTemplateVars(tpl);
    const defaultMap = {};
    vars.forEach((v, i) => { defaultMap[v] = i === 0 ? 'name' : 'manual'; });
    setVarMap(defaultMap);
    setManualVars({});
  };

  // Construye components[] para un cliente específico
  const buildComponents = (candidate) => {
    if (!selectedTemplate) return [];
    const vars = parseTemplateVars(selectedTemplate);
    if (vars.length === 0) return [];
    const parameters = vars.map(v => {
      const mapping = varMap[v] || 'manual';
      let text = '';
      if (mapping === 'name')  text = candidate.name || candidate.phone;
      else if (mapping === 'phone') text = candidate.phone;
      else text = manualVars[v] || '';
      return { type: 'text', text };
    });
    return [{ type: 'body', parameters }];
  };

  // Preview del template con variables sustituidas para un cliente
  const previewTemplate = (candidate) => {
    if (!selectedTemplate) return '';
    const bodyComp = (selectedTemplate.components || []).find(c => c.type === 'BODY');
    if (!bodyComp?.text) return `[Template: ${selectedTemplate.name}]`;
    let text = bodyComp.text;
    const vars = parseTemplateVars(selectedTemplate);
    vars.forEach(v => {
      const mapping = varMap[v] || 'manual';
      let val = '';
      if (mapping === 'name')       val = candidate?.name || candidate?.phone || `{{${v}}}`;
      else if (mapping === 'phone') val = candidate?.phone || `{{${v}}}`;
      else val = manualVars[v] || `{{${v}}}`;
      text = text.replace(new RegExp(`\\{\\{${v}\\}\\}`, 'g'), val);
    });
    return text;
  };

  // Score de relevancia: vencidos primero, luego confianza alta, luego más cercanos
  const relevanceScore = (c) => {
    const overdueBonus = c.predictedDays <= 0 ? 100 + Math.abs(c.predictedDays) * 2 : 0;
    const urgencyBonus = c.predictedDays <= 1 ? 30 : c.predictedDays <= 3 ? 15 : 0;
    const proximityPenalty = Math.max(0, c.predictedDays) * 0.4;
    return c.confidence + overdueBonus + urgencyBonus - proximityPenalty;
  };

  // Agrupar por ventana, filtrar por confianza mínima y ordenar por relevancia
  const byWindow = (window) => candidates
    .filter(c => c.buyWindow === window && c.confidence >= minConf)
    .sort((a, b) => relevanceScore(b) - relevanceScore(a));

  // Candidatos visibles según tab activo
  const visible = byWindow(activeWindow);

  // ── Selección ──────────────────────────────────────────────────
  const toggleSelect = (phone) => setSelected(prev => {
    const n = new Set(prev);
    n.has(phone) ? n.delete(phone) : n.add(phone);
    return n;
  });

  const toggleAll = () => {
    if (selected.size === visible.length) setSelected(new Set());
    else setSelected(new Set(visible.map(c => c.phone)));
  };

  // ── Generar mensaje IA ─────────────────────────────────────────
  const generateMessage = async (phone) => {
    setGenerating(prev => new Set(prev).add(phone));
    try {
      const res = await api.post('/reengagement/generate', { phone });
      setMessages(prev => ({ ...prev, [phone]: res.data.message }));
      setSelected(prev => new Set(prev).add(phone));
    } catch (err) {
      showToast(err.response?.data?.error || 'Error generando mensaje', 'error');
    } finally {
      setGenerating(prev => { const n = new Set(prev); n.delete(phone); return n; });
    }
  };

  const generateAll = async () => {
    const targets = selected.size > 0
      ? visible.filter(c => selected.has(c.phone))
      : visible;
    for (const c of targets) {
      if (!messages[c.phone]) {
        await generateMessage(c.phone);
        await new Promise(r => setTimeout(r, 400));
      }
    }
  };

  // ── Enviar ─────────────────────────────────────────────────────
  const sendOne = async (phone) => {
    const candidate = candidates.find(c => c.phone === phone);

    if (useTemplate) {
      if (!selectedTemplate) { showToast('Selecciona un template primero', 'error'); return; }
      setSending(prev => new Set(prev).add(phone));
      try {
        await reengagementAPI.send({
          phone,
          templateName:  selectedTemplate.name,
          languageCode:  selectedTemplate.language,
          components:    buildComponents(candidate),
        });
        showToast('✅ Template enviado');
        setCandidates(prev => prev.filter(c => c.phone !== phone));
        setSelected(prev => { const n = new Set(prev); n.delete(phone); return n; });
      } catch (err) {
        showToast(err.response?.data?.error || 'Error enviando template', 'error');
      } finally {
        setSending(prev => { const n = new Set(prev); n.delete(phone); return n; });
      }
    } else {
      const msg = messages[phone];
      if (!msg?.trim()) { showToast('Primero genera un mensaje con IA', 'error'); return; }
      setSending(prev => new Set(prev).add(phone));
      try {
        await reengagementAPI.send({ phone, message: msg });
        showToast('✅ Mensaje enviado');
        setCandidates(prev => prev.filter(c => c.phone !== phone));
        setSelected(prev => { const n = new Set(prev); n.delete(phone); return n; });
      } catch (err) {
        showToast(err.response?.data?.error || 'Error enviando', 'error');
      } finally {
        setSending(prev => { const n = new Set(prev); n.delete(phone); return n; });
      }
    }
  };

  const sendBulk = async () => {
    let targets;
    let items;

    if (useTemplate) {
      if (!selectedTemplate) { showToast('Selecciona un template primero', 'error'); return; }
      targets = visible.filter(c => selected.has(c.phone));
      if (!targets.length) { showToast('Selecciona al menos un cliente', 'error'); return; }
      items = targets.map(c => ({
        phone:        c.phone,
        templateName: selectedTemplate.name,
        languageCode: selectedTemplate.language,
        components:   buildComponents(c),
      }));
    } else {
      targets = visible.filter(c => selected.has(c.phone) && messages[c.phone]?.trim());
      if (!targets.length) { showToast('Selecciona clientes con mensajes generados', 'error'); return; }
      items = targets.map(c => ({ phone: c.phone, message: messages[c.phone] }));
    }

    setSendingBulk(true);
    try {
      const res = await reengagementAPI.sendBulk(items);
      showToast(`✅ ${res.sent} enviados${res.failed > 0 ? ` · ${res.failed} fallaron` : ''}`);
      const sent = new Set(res.results.filter(r => r.success).map(r => r.phone));
      setCandidates(prev => prev.filter(c => !sent.has(c.phone)));
      setSelected(new Set());
    } catch (err) {
      showToast(err.response?.data?.error || 'Error en envío masivo', 'error');
    } finally {
      setSendingBulk(false);
    }
  };

  const selectedWithMsg  = useTemplate
    ? visible.filter(c => selected.has(c.phone)).length
    : visible.filter(c => selected.has(c.phone) && messages[c.phone]?.trim()).length;
  const totalCandidates  = candidates.length;
  const filteredTotal    = candidates.filter(c => c.confidence >= minConf).length;
  const hiddenByFilter   = totalCandidates - filteredTotal;

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100vh', backgroundColor: '#0b141a', overflow: 'hidden' }}>

      {/* Header */}
      <div style={{ padding: '14px 24px', backgroundColor: '#202c33', borderBottom: '1px solid #2a3942', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <UserCheck size={20} color="#00a884" />
          <h1 style={{ color: '#e9edef', fontSize: '17px', fontWeight: 600 }}>Re-enganche</h1>
          <span style={{ backgroundColor: '#0d2e25', color: '#00a884', borderRadius: '6px', padding: '2px 8px', fontSize: '11px', fontWeight: 600, border: '1px solid #00a88433', display: 'flex', alignItems: 'center', gap: '4px' }}>
            <Brain size={11} /> Pronóstico IA
          </span>
          {!loading && totalCandidates > 0 && (
            <span style={{ backgroundColor: '#2a3942', color: '#8696a0', borderRadius: '12px', padding: '2px 8px', fontSize: '12px' }}>
              {totalCandidates} clientes analizados
            </span>
          )}
          {!loading && hiddenByFilter > 0 && (
            <Tooltip text={`${hiddenByFilter} clientes ocultos por tener menos de ${minConf}% de confianza`} position="bottom">
              <span style={{ color: '#4a5568', fontSize: '11px', cursor: 'default' }}>
                · {hiddenByFilter} ocultos &lt;{minConf}%
              </span>
            </Tooltip>
          )}
          {fromCache && !loading && (
            <span style={{ color: '#374045', fontSize: '11px' }}>· desde caché</span>
          )}
        </div>

        {/* Filtro de confianza mínima */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Tooltip text="Mostrar solo predicciones con este nivel mínimo de confianza" position="bottom">
            <span style={{ color: '#4a5568', fontSize: '11px' }}>Confianza mín.</span>
          </Tooltip>
          {[50, 65, 75, 85].map(val => (
            <button key={val} onClick={() => setMinConf(val)}
              style={{
                padding: '4px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: 700,
                cursor: 'pointer', border: 'none',
                backgroundColor: minConf === val ? '#00a884' : '#2a3942',
                color: minConf === val ? '#fff' : '#8696a0',
                transition: 'all 0.15s',
              }}>
              {val}%+
            </button>
          ))}
        </div>

        {/* Toggle modo Template */}
        <button onClick={toggleTemplateMode}
          title={useTemplate ? 'Cambiar a modo texto libre' : 'Cambiar a modo template WhatsApp'}
          style={{
            display: 'flex', alignItems: 'center', gap: '7px',
            padding: '7px 14px', borderRadius: '8px',
            backgroundColor: useTemplate ? '#1a3040' : '#2a3942',
            border: `1px solid ${useTemplate ? '#00a884' : '#374045'}`,
            cursor: 'pointer',
            color: useTemplate ? '#00a884' : '#8696a0',
            fontSize: '12px', fontWeight: useTemplate ? 600 : 400,
            transition: 'all 0.15s',
          }}>
          <FileText size={13} />
          {useTemplate ? '📋 Modo Template' : '📋 Usar Template'}
          {useTemplate
            ? <ToggleRight size={15} color="#00a884" />
            : <ToggleLeft size={15} />}
        </button>

        <button onClick={() => load(true)} disabled={loading}
          style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '7px 14px', borderRadius: '8px', backgroundColor: '#2a3942', border: '1px solid #374045', cursor: loading ? 'not-allowed' : 'pointer', color: '#8696a0', fontSize: '12px', opacity: loading ? 0.5 : 1 }}>
          <RefreshCw size={13} style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }} />
          Nuevo análisis
        </button>
      </div>

      {/* Tabs de ventanas de tiempo */}
      {!loading && !error && totalCandidates > 0 && (
        <div style={{ display: 'flex', backgroundColor: '#111b21', borderBottom: '1px solid #2a3942', padding: '0 24px' }}>
          {WINDOWS.map(w => {
            const count   = byWindow(w.key).length;
            const isActive = activeWindow === w.key;
            return (
              <button key={w.key} onClick={() => { setActiveWindow(w.key); setSelected(new Set()); }}
                style={{
                  display: 'flex', alignItems: 'center', gap: '8px',
                  padding: '12px 20px', background: 'none', border: 'none', cursor: 'pointer',
                  borderBottom: isActive ? `2px solid ${w.color}` : '2px solid transparent',
                  color: isActive ? w.color : '#8696a0', fontSize: '13px', fontWeight: isActive ? 600 : 400,
                  transition: 'all 0.15s',
                }}>
                {w.key === 'hoy' && <Zap size={13} />}
                {w.label}
                {count > 0 && (
                  <span style={{ backgroundColor: isActive ? w.bg : '#2a3942', color: isActive ? w.color : '#8696a0', borderRadius: '10px', padding: '1px 7px', fontSize: '11px', fontWeight: 700 }}>
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* Descripción de la ventana activa */}
      {!loading && !error && visible.length > 0 && (
        <div style={{ padding: '8px 24px', backgroundColor: '#0b141a', borderBottom: '1px solid #1a2530' }}>
          <span style={{ color: '#8696a0', fontSize: '12px', fontStyle: 'italic' }}>
            {WINDOWS.find(w => w.key === activeWindow)?.desc}
          </span>
        </div>
      )}

      {/* Panel de templates */}
      {useTemplate && !loading && (
        <div style={{ backgroundColor: '#0d1f2d', borderBottom: '1px solid #1e3a50', padding: '12px 24px' }}>
          {templatesLoading ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: '#8696a0', fontSize: '13px' }}>
              <Loader size={14} style={{ animation: 'spin 1s linear infinite' }} />
              Cargando templates aprobados...
            </div>
          ) : templatesError ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <AlertCircle size={14} color="#e57373" />
              <span style={{ color: '#e57373', fontSize: '12px' }}>{templatesError}</span>
              <button onClick={loadTemplates} style={{ color: '#00a884', fontSize: '12px', background: 'none', border: 'none', cursor: 'pointer' }}>Reintentar</button>
            </div>
          ) : templates.length === 0 ? (
            <span style={{ color: '#8696a0', fontSize: '12px' }}>
              No hay templates aprobados. Créalos en Meta Business Manager y espera la aprobación.
            </span>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {/* Selector de template */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                <span style={{ color: '#8696a0', fontSize: '12px', flexShrink: 0 }}>Template:</span>
                <div style={{ position: 'relative', flex: 1, maxWidth: '380px' }}>
                  <select
                    value={selectedTemplate?.name || ''}
                    onChange={e => {
                      const tpl = templates.find(t => t.name === e.target.value);
                      if (tpl) handleSelectTemplate(tpl);
                      else { setSelectedTemplate(null); setVarMap({}); }
                    }}
                    style={{
                      width: '100%', backgroundColor: '#182028', color: '#e9edef',
                      border: '1px solid #2a3942', borderRadius: '7px',
                      padding: '7px 12px', fontSize: '13px', cursor: 'pointer', outline: 'none',
                    }}
                  >
                    <option value="">— Selecciona un template —</option>
                    {templates.map(t => (
                      <option key={t.name} value={t.name}>
                        {t.name} ({t.language})
                      </option>
                    ))}
                  </select>
                </div>

                {selectedTemplate && (
                  <span style={{
                    backgroundColor: '#0a2e15', color: '#00c853',
                    borderRadius: '5px', padding: '3px 8px', fontSize: '11px',
                    border: '1px solid #00c85333',
                  }}>
                    ✓ {selectedTemplate.category || 'MARKETING'}
                  </span>
                )}
              </div>

              {/* Preview del template */}
              {selectedTemplate && (() => {
                const bodyComp = selectedTemplate.components?.find(c => c.type === 'BODY');
                const headerComp = selectedTemplate.components?.find(c => c.type === 'HEADER');
                const footerComp = selectedTemplate.components?.find(c => c.type === 'FOOTER');
                const vars = parseTemplateVars(selectedTemplate);
                return (
                  <div>
                    {/* Variables */}
                    {vars.length > 0 && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '10px' }}>
                        {vars.map(v => (
                          <div key={v} style={{ display: 'flex', alignItems: 'center', gap: '6px', backgroundColor: '#182028', borderRadius: '6px', padding: '5px 10px', border: '1px solid #2a3942' }}>
                            <span style={{ color: '#00a884', fontSize: '11px', fontWeight: 700 }}>{'{{' + v + '}}'}</span>
                            <span style={{ color: '#8696a0', fontSize: '11px' }}>→</span>
                            <select
                              value={varMap[v] || 'manual'}
                              onChange={e => setVarMap(prev => ({ ...prev, [v]: e.target.value }))}
                              style={{ backgroundColor: '#0f1820', color: '#e9edef', border: 'none', fontSize: '11px', cursor: 'pointer', outline: 'none' }}
                            >
                              <option value="name">Nombre del cliente</option>
                              <option value="phone">Teléfono</option>
                              <option value="manual">Texto fijo</option>
                            </select>
                            {(varMap[v] || 'manual') === 'manual' && (
                              <input
                                value={manualVars[v] || ''}
                                onChange={e => setManualVars(prev => ({ ...prev, [v]: e.target.value }))}
                                placeholder="Escribe aquí..."
                                style={{ backgroundColor: '#0f1820', color: '#e9edef', border: '1px solid #2a3942', borderRadius: '4px', padding: '2px 6px', fontSize: '11px', width: '100px' }}
                              />
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Preview del mensaje */}
                    <div style={{ backgroundColor: '#182028', borderRadius: '8px', padding: '10px 12px', border: '1px solid #2a3942', maxWidth: '480px' }}>
                      <div style={{ color: '#4a5568', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '6px' }}>Vista previa</div>
                      {headerComp?.text && <div style={{ color: '#e9edef', fontSize: '13px', fontWeight: 700, marginBottom: '4px' }}>{headerComp.text}</div>}
                      <div style={{ color: '#c8d1d9', fontSize: '13px', lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>
                        {previewTemplate(visible[0])}
                      </div>
                      {footerComp?.text && <div style={{ color: '#8696a0', fontSize: '11px', marginTop: '6px' }}>{footerComp.text}</div>}
                    </div>
                  </div>
                );
              })()}
            </div>
          )}
        </div>
      )}

      {/* Barra de acciones */}
      {visible.length > 0 && !loading && (
        <div style={{ padding: '8px 24px', backgroundColor: '#111b21', borderBottom: '1px solid #2a3942', display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
          <button onClick={toggleAll}
            style={{ display: 'flex', alignItems: 'center', gap: '6px', background: 'none', border: 'none', cursor: 'pointer', color: '#8696a0', fontSize: '13px' }}>
            {selected.size === visible.length && visible.length > 0
              ? <CheckSquare size={16} color="#00a884" />
              : <Square size={16} />}
            {selected.size === visible.length && visible.length > 0
              ? 'Deseleccionar todos'
              : `Seleccionar todos (${visible.length})`}
          </button>

          <div style={{ flex: 1 }} />

          {!useTemplate && (
            <button onClick={generateAll}
              style={{ display: 'flex', alignItems: 'center', gap: '6px', backgroundColor: '#1a2530', color: '#00a884', padding: '7px 14px', borderRadius: '8px', fontSize: '13px', fontWeight: 500, border: '1px solid #00a88433', cursor: 'pointer' }}>
              <Sparkles size={14} />
              Generar mensajes IA {selected.size > 0 ? `(${selected.size})` : '(todos)'}
            </button>
          )}

          {useTemplate && !selectedTemplate && (
            <span style={{ color: '#f0b429', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <FileText size={13} /> Selecciona un template arriba para continuar
            </span>
          )}

          <button onClick={sendBulk}
            disabled={sendingBulk || selectedWithMsg === 0 || (useTemplate && !selectedTemplate)}
            style={{
              display: 'flex', alignItems: 'center', gap: '6px',
              backgroundColor: (selectedWithMsg > 0 && (!useTemplate || selectedTemplate)) ? (useTemplate ? '#1a4060' : '#00a884') : '#2a3942',
              color: (selectedWithMsg > 0 && (!useTemplate || selectedTemplate)) ? (useTemplate ? '#4db6e8' : 'white') : '#8696a0',
              padding: '7px 14px', borderRadius: '8px', fontSize: '13px', fontWeight: 500,
              border: useTemplate ? '1px solid #1e5a80' : 'none',
              cursor: (selectedWithMsg > 0 && (!useTemplate || selectedTemplate)) ? 'pointer' : 'not-allowed',
              opacity: sendingBulk ? 0.7 : 1,
            }}>
            {sendingBulk ? <Loader size={14} style={{ animation: 'spin 1s linear infinite' }} /> : (useTemplate ? <FileText size={14} /> : <Send size={14} />)}
            {sendingBulk ? 'Enviando...' : useTemplate
              ? `Enviar template a ${selectedWithMsg} clientes`
              : `Enviar a ${selectedWithMsg} clientes`}
          </button>
        </div>
      )}

      {/* Contenido */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '14px 20px' }}>

        {loading ? (
          <div style={{ textAlign: 'center', padding: '80px 40px', color: '#8696a0' }}>
            <div style={{ width: '40px', height: '40px', border: '3px solid #2a3942', borderTop: '3px solid #00a884', borderRadius: '50%', animation: 'spin 1s linear infinite', margin: '0 auto 20px' }} />
            <div style={{ fontSize: '15px', fontWeight: 500, color: '#e9edef', marginBottom: '8px' }}>{loadingStep}</div>
            <div style={{ fontSize: '12px', opacity: 0.6, lineHeight: 1.6 }}>
              Claude analiza frecuencias, patrones semanales y tendencias de gasto<br/>para predecir cuándo comprará cada cliente
            </div>
          </div>
        ) : error ? (
          <div style={{ textAlign: 'center', padding: '60px', color: '#e57373' }}>
            <AlertCircle size={40} style={{ marginBottom: '12px', opacity: 0.7 }} />
            <div style={{ fontSize: '14px', marginBottom: '16px', maxWidth: '400px', margin: '0 auto 16px', lineHeight: 1.5 }}>{error}</div>
            <button onClick={() => load(true)} style={{ backgroundColor: '#00a88422', color: '#00a884', border: '1px solid #00a88433', borderRadius: '8px', padding: '8px 16px', fontSize: '13px', cursor: 'pointer' }}>
              Reintentar
            </button>
          </div>
        ) : totalCandidates === 0 ? (
          <div style={{ textAlign: 'center', padding: '80px', color: '#8696a0' }}>
            <Brain size={48} style={{ marginBottom: '16px', opacity: 0.2 }} />
            <div style={{ fontSize: '15px', fontWeight: 500 }}>Sin datos suficientes</div>
            <div style={{ fontSize: '13px', marginTop: '8px', opacity: 0.7 }}>
              No se encontraron órdenes con teléfono registrado en Shopify
            </div>
          </div>
        ) : visible.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '60px', color: '#8696a0' }}>
            <UserCheck size={40} style={{ marginBottom: '12px', opacity: 0.3 }} />
            <div style={{ fontSize: '14px' }}>
              La IA no predice compras para esta ventana de tiempo
            </div>
            <div style={{ fontSize: '12px', marginTop: '8px', opacity: 0.7 }}>
              Prueba otra pestaña
            </div>
          </div>
        ) : (
          visible.map(c => (
            <div key={c.phone} style={{ marginBottom: '8px' }}>
              <CandidateCard
                candidate={c}
                isSelected={selected.has(c.phone)}
                isExpanded={expanded.has(c.phone)}
                message={messages[c.phone] || ''}
                isGenerating={generating.has(c.phone)}
                isSending={sending.has(c.phone)}
                onToggleSelect={() => toggleSelect(c.phone)}
                onToggleExpand={() => setExpanded(prev => {
                  const n = new Set(prev); n.has(c.phone) ? n.delete(c.phone) : n.add(c.phone); return n;
                })}
                onGenerate={() => generateMessage(c.phone)}
                onMessageChange={val => setMessages(prev => ({ ...prev, [c.phone]: val }))}
                onSend={() => sendOne(c.phone)}
                useTemplate={useTemplate}
                templatePreview={useTemplate && selectedTemplate ? previewTemplate(c) : null}
              />
            </div>
          ))
        )}
      </div>

      {toast && (
        <div style={{
          position: 'fixed', bottom: '24px', right: '24px', zIndex: 1000,
          backgroundColor: toast.type === 'error' ? '#2d1a1a' : '#0d2e25',
          border: `1px solid ${toast.type === 'error' ? '#5c2626' : '#00a884'}`,
          color: toast.type === 'error' ? '#e57373' : '#00a884',
          padding: '12px 18px', borderRadius: '10px', fontSize: '13px', fontWeight: 500,
          boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
        }}>
          {toast.msg}
        </div>
      )}

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

function CandidateCard({ candidate: c, isSelected, isExpanded, message, isGenerating, isSending, onToggleSelect, onToggleExpand, onGenerate, onMessageChange, onSend, useTemplate, templatePreview }) {
  const hasMsg  = message?.trim().length > 0;
  const conf    = c.confidence || 0;
  const cColor  = confColor(conf);
  const overdue = c.avgFreqDays && c.daysInactive > c.avgFreqDays;

  const predDays  = c.predictedDays ?? 0;
  const predLabel = predDays < 0
    ? `vencido hace ${Math.abs(predDays)}d`
    : predDays === 0 ? 'compraría hoy'
    : predDays === 1 ? 'compraría mañana'
    : `en ~${predDays}d`;

  const predColor = predDays <= 0 ? '#e57373' : predDays <= 1 ? '#00c853' : predDays <= 7 ? '#00a884' : '#f0b429';
  const predBg    = predDays <= 0 ? '#3a1a1a'  : predDays <= 1 ? '#0a2e15'  : predDays <= 7 ? '#0d2e25'  : '#2e2100';

  return (
    <div style={{
      backgroundColor: isSelected ? '#162820' : '#182028',
      border: `1px solid ${isSelected ? '#00a884' : '#2a3942'}`,
      borderLeft: `3px solid ${predColor}`,
      borderRadius: '10px',
      overflow: 'hidden',
      transition: 'border-color 0.15s',
    }}>

      {/* ── FILA 1: cabecera ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '12px 14px 0' }}>

        {/* Checkbox */}
        <button onClick={onToggleSelect}
          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, flexShrink: 0 }}>
          {isSelected
            ? <CheckSquare size={15} color="#00a884" />
            : <Square size={15} color="#374045" />}
        </button>

        {/* Avatar */}
        <div style={{
          width: '36px', height: '36px', borderRadius: '50%', flexShrink: 0,
          backgroundColor: '#1e2d3a',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: '14px', fontWeight: 700, color: cColor,
          border: `2px solid ${cColor}55`,
        }}>
          {(c.name?.[0] || '?').toUpperCase()}
        </div>

        {/* Nombre */}
        <span style={{ color: '#e9edef', fontWeight: 700, fontSize: '14px', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {c.name}
        </span>

        {/* Badge predicción */}
        <Tooltip text={predDays <= 0
          ? `Lleva ${Math.abs(predDays)}d más de lo normal sin comprar. Su ciclo habitual es ~${c.avgFreqDays}d.`
          : predDays <= 1 ? 'La IA predice que comprará hoy o mañana según su patrón de compras.'
          : `La IA estima que comprará en aproximadamente ${predDays} días, basado en su ciclo habitual.`}>
          <span style={{
            backgroundColor: predBg, color: predColor,
            borderRadius: '6px', padding: '3px 10px',
            fontSize: '12px', fontWeight: 700,
            border: `1px solid ${predColor}44`,
            flexShrink: 0,
          }}>
            {predLabel}
          </span>
        </Tooltip>

        {/* Confianza */}
        <Tooltip text={`Confianza de la predicción. ${conf >= 80 ? 'Alta — patrón de compra muy regular.' : conf >= 60 ? 'Media — patrón moderadamente consistente.' : 'Baja — pocos datos o compras irregulares.'}`}>
          <span style={{
            backgroundColor: '#1e2d3a', color: cColor,
            borderRadius: '6px', padding: '3px 8px',
            fontSize: '11px', fontWeight: 700, flexShrink: 0,
          }}>
            {conf}%
          </span>
        </Tooltip>
      </div>

      {/* ── FILA 2: tags secundarios ── */}
      {(overdue || (c.spendTrend && c.spendTrend !== 'estable')) && (
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', padding: '6px 14px 0 55px' }}>
          {overdue && (
            <Tooltip text={`Lleva ${c.daysInactive - c.avgFreqDays} días más de lo habitual sin comprar. Su ciclo normal es cada ~${c.avgFreqDays} días.`} position="bottom">
              <span style={{ backgroundColor: '#3a1a1a', color: '#e57373', borderRadius: '5px', padding: '2px 8px', fontSize: '11px', fontWeight: 600 }}>
                ⚠ {c.daysInactive - c.avgFreqDays}d fuera de ciclo
              </span>
            </Tooltip>
          )}
          {c.spendTrend && c.spendTrend !== 'estable' && (
            <Tooltip text={c.spendTrend === 'creciente' ? 'Este cliente gasta más en sus compras recientes que en las anteriores.' : 'Este cliente gasta menos en sus compras recientes que antes.'} position="bottom">
              <span style={{ backgroundColor: '#1e2d3a', color: c.spendTrend === 'creciente' ? '#00c853' : '#e57373', borderRadius: '5px', padding: '2px 8px', fontSize: '11px', fontWeight: 600 }}>
                {c.spendTrend === 'creciente' ? '↑' : '↓'} gasto {c.spendTrend}
              </span>
            </Tooltip>
          )}
        </div>
      )}

      {/* ── FILA 3: razón IA ── */}
      {c.aiReason && (
        <div style={{ margin: '8px 14px 0', backgroundColor: '#0f1e28', borderRadius: '7px', padding: '7px 10px', display: 'flex', alignItems: 'flex-start', gap: '7px' }}>
          <Brain size={13} color="#00a884" style={{ flexShrink: 0, marginTop: '1px' }} />
          <span style={{ color: '#8696a0', fontSize: '12px', fontStyle: 'italic', lineHeight: 1.45 }}>
            {c.aiReason}
          </span>
        </div>
      )}

      {/* ── FILA 4: stats ── */}
      <div style={{ display: 'flex', gap: '18px', flexWrap: 'wrap', alignItems: 'center', padding: '8px 14px' }}>
        <Tooltip text={`Días desde su última compra (${c.lastOrderDate || '—'}). ${overdue ? `Su ciclo habitual es ~${c.avgFreqDays}d, lleva ${c.daysInactive - c.avgFreqDays}d de retraso.` : ''}`}>
          <span style={{ color: '#8696a0', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px' }}>
            <Clock size={11} />
            <strong style={{ color: overdue ? '#e57373' : '#c8d1d9' }}>{c.daysInactive}d</strong>
            <span style={{ color: '#4a5568' }}>inactivo</span>
          </span>
        </Tooltip>

        <Tooltip text={`Total de pedidos realizados en la tienda. Más pedidos = predicción más precisa.`}>
          <span style={{ color: '#8696a0', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px' }}>
            <ShoppingBag size={11} />
            <strong style={{ color: '#c8d1d9' }}>{c.totalOrders}</strong>
            <span style={{ color: '#4a5568' }}>pedido{c.totalOrders !== 1 ? 's' : ''}</span>
          </span>
        </Tooltip>

        {c.avgFreqDays && (
          <Tooltip text={`Frecuencia promedio de compra. Normalmente compra cada ~${c.avgFreqDays} días.`}>
            <span style={{ color: '#8696a0', fontSize: '12px' }}>
              🔁 <strong style={{ color: '#c8d1d9' }}>~{c.avgFreqDays}d</strong>
            </span>
          </Tooltip>
        )}

        {c.favDay && (
          <Tooltip text={`Día de la semana en que más compra. Ideal para contactar los días ${c.favDay}.`}>
            <span style={{ color: '#8696a0', fontSize: '12px' }}>
              📅 <strong style={{ color: '#c8d1d9' }}>{c.favDay}</strong>
            </span>
          </Tooltip>
        )}

        <Tooltip text={`Total gastado histórico en la tienda. Ticket promedio: $${Math.round((c.avgOrderVal || 0)).toLocaleString('es-CL')}`}>
          <span style={{ color: '#00a884', fontSize: '12px', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '4px' }}>
            <TrendingUp size={11} />
            ${Math.round(c.totalSpent || 0).toLocaleString('es-CL')}
          </span>
        </Tooltip>

        {c.lastProducts && (
          <Tooltip text={`Últimos productos comprados: ${c.lastProducts}`}>
            <span style={{ color: '#374045', fontSize: '11px', fontStyle: 'italic', maxWidth: '180px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {c.lastProducts}
            </span>
          </Tooltip>
        )}
      </div>

      {/* ── FILA 5: botones de acción ── */}
      <div style={{ display: 'flex', gap: '8px', padding: '0 14px 12px', alignItems: 'center' }}>
        {!useTemplate && (
          <button onClick={onGenerate} disabled={isGenerating}
            style={{
              display: 'flex', alignItems: 'center', gap: '6px',
              backgroundColor: hasMsg ? '#0d2419' : '#1e2d3a',
              color: hasMsg ? '#00c853' : '#8696a0',
              padding: '7px 14px', borderRadius: '7px', fontSize: '12px', fontWeight: 500,
              border: `1px solid ${hasMsg ? '#00c85333' : '#2a3942'}`,
              cursor: isGenerating ? 'not-allowed' : 'pointer',
              opacity: isGenerating ? 0.6 : 1, flex: 1,
            }}>
            {isGenerating
              ? <Loader size={13} style={{ animation: 'spin 1s linear infinite' }} />
              : <Sparkles size={13} />}
            {isGenerating ? 'Generando...' : hasMsg ? '✓ Regenerar IA' : 'Generar con IA'}
          </button>
        )}

        {useTemplate && (
          <div style={{ flex: 1, backgroundColor: '#0f1820', borderRadius: '7px', padding: '6px 10px', border: '1px solid #1e3a50', fontSize: '12px', color: '#8696a0', fontStyle: 'italic' }}>
            {templatePreview
              ? <span style={{ color: '#c8d1d9' }}>{templatePreview.slice(0, 80)}{templatePreview.length > 80 ? '…' : ''}</span>
              : <span>Template personalizado para {c.name || c.phone}</span>}
          </div>
        )}

        <button onClick={onSend} disabled={isSending || (useTemplate && !templatePreview)}
          style={{
            display: 'flex', alignItems: 'center', gap: '6px',
            backgroundColor: (useTemplate ? !!templatePreview : hasMsg) ? (useTemplate ? '#1a4060' : '#00a884') : '#1e2d3a',
            color: (useTemplate ? !!templatePreview : hasMsg) ? (useTemplate ? '#4db6e8' : '#fff') : '#374045',
            padding: '7px 18px', borderRadius: '7px', fontSize: '12px', fontWeight: 600,
            border: useTemplate ? '1px solid #1e5a80' : 'none',
            cursor: (isSending || (useTemplate && !templatePreview)) ? 'not-allowed' : (useTemplate ? !!templatePreview : hasMsg) ? 'pointer' : 'not-allowed',
            opacity: isSending ? 0.7 : 1, flexShrink: 0,
          }}>
          {isSending
            ? <Loader size={13} style={{ animation: 'spin 1s linear infinite' }} />
            : useTemplate ? <FileText size={13} /> : <Send size={13} />}
          {isSending ? 'Enviando...' : useTemplate ? 'Enviar template' : 'Enviar'}
        </button>

        {!useTemplate && (
          <button onClick={onToggleExpand}
            style={{
              display: 'flex', alignItems: 'center', gap: '4px',
              padding: '7px 10px', backgroundColor: '#1e2d3a', border: 'none',
              borderRadius: '7px', cursor: 'pointer', color: '#8696a0', fontSize: '11px', flexShrink: 0,
            }}>
            {isExpanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </button>
        )}
      </div>

      {/* ── Área de mensaje expandible (solo modo texto libre) ── */}
      {!useTemplate && isExpanded && (
        <div style={{ padding: '12px 14px 14px', borderTop: '1px solid #2a3942', backgroundColor: '#0f1820' }}>
          <div style={{ color: '#4a5568', fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.6px', marginBottom: '8px' }}>
            Mensaje WhatsApp
          </div>
          <textarea
            value={message}
            onChange={e => onMessageChange(e.target.value)}
            placeholder="Genera un mensaje con IA o escríbelo manualmente..."
            rows={4}
            style={{
              width: '100%', backgroundColor: '#182028', color: '#e9edef',
              border: '1px solid #2a3942', borderRadius: '8px',
              padding: '10px 12px', fontSize: '13px', lineHeight: 1.55,
              resize: 'vertical', outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box',
            }}
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '8px' }}>
            <span style={{ color: '#374045', fontSize: '11px' }}>{message.length} caracteres</span>
            {hasMsg && (
              <button onClick={onSend} disabled={isSending}
                style={{ display: 'flex', alignItems: 'center', gap: '6px', backgroundColor: '#00a884', color: 'white', padding: '7px 16px', borderRadius: '7px', fontSize: '12px', fontWeight: 600, border: 'none', cursor: 'pointer', opacity: isSending ? 0.7 : 1 }}>
                <Send size={13} /> {isSending ? 'Enviando...' : 'Enviar por WhatsApp'}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
