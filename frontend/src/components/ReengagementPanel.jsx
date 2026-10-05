import { useState, useEffect, useCallback, useRef } from 'react';
import {
  UserCheck, RefreshCw, Sparkles, Send, Clock,
  ShoppingBag, TrendingUp,
  CheckSquare, Square, AlertCircle, Loader, Brain, Zap,
  FileText, Download, MoreVertical, X, Check, History,
} from 'lucide-react';

import { api, reengagementAPI } from '../utils/api.js';
import { useTheme } from '../theme.js';
import { matchesPurchaseAge, selectedAudience } from '../utils/broadcast-audience.mjs';
import * as ui from '../ui.js';
import {
  buildBodyTemplateComponent,
  getBodyComponent,
  getTemplateVariables,
  renderTemplate,
} from '../utils/template-renderer.js';

function Tooltip({ text, children, position = 'top' }) {
  const { colors } = useTheme();
  const [show, setShow] = useState(false);
  const ref = useRef(null);

  const tipStyle = {
    position: 'absolute',
    backgroundColor: colors.bgHover,
    color: colors.textPrimary,
    fontSize: '11.5px',
    lineHeight: 1.5,
    padding: '7px 11px',
    borderRadius: '7px',
    border: `1px solid ${colors.border}`,
    boxShadow: '0 4px 14px rgba(0,0,0,0.4)',
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

// Ventanas de tiempo — generadas en función del theme
const getWINDOWS = (colors) => [
  { key: 'hoy',    label: 'Hoy / Mañana', color: colors.greenLight,    bg: colors.greenTint,     desc: 'Predicción: comprarían en las próximas 24-48h' },
  { key: 'semana', label: 'Esta semana',  color: colors.green,         bg: colors.greenTint,     desc: 'Predicción: comprarían en los próximos 7 días' },
  { key: 'mes',    label: 'Este mes',     color: colors.yellow,        bg: `${colors.yellow}22`, desc: 'Predicción: comprarían en los próximos 30 días' },
  { key: 'lejano', label: '1-6 meses',    color: colors.textSecondary, bg: colors.bgSub,         desc: 'Predicción: comprarían en los próximos 31-180 días' },
];

const confColor = (conf, colors) =>
  conf >= 80 ? colors.greenLight : conf >= 60 ? colors.green : conf >= 40 ? colors.yellow : colors.textSecondary;

export default function ReengagementPanel({ filterPhone = null, onClearFilter = null, testPhone = null, onNavigateToSettings = null }) {
  const { colors } = useTheme();
  const WINDOWS = getWINDOWS(colors);
  const [mainTab, setMainTab] = useState('masivo'); // 'ia' | 'masivo'

  const [candidates, setCandidates]   = useState([]);
  const [loading, setLoading]         = useState(true);
  const [loadingStep, setLoadingStep] = useState('');
  const [error, setError]             = useState(null);
  const [fromCache, setFromCache]     = useState(false);
  const [cacheDate, setCacheDate]     = useState(null);
  const [cacheSource, setCacheSource] = useState(null);
  const [calibration, setCalibration] = useState(null);
  const [calibrating, setCalibrating] = useState(false);
  const [activeWindow, setActiveWindow] = useState('hoy');
  const [selected, setSelected]       = useState(new Set());
  const [sending, setSending]         = useState(new Set());
  const [sendingBulk, setSendingBulk] = useState(false);
  const [toast, setToast]             = useState(null);
  const [minConf, setMinConf]         = useState(50);
  const [testMode, setTestMode]       = useState(false);
  const [menuOpen, setMenuOpen]       = useState(false);
  const TEST_PHONE = testPhone || '56954565558';

  // ── Templates ─────────────────────────────────────────────────
  const [templates, setTemplates]           = useState([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const [templatesError, setTemplatesError] = useState(null);


  // Estado por cliente: IA eligió template + variables + preview
  // { [phone]: { templateName, languageCode, vars, previewText, reason, loading } }
  const [clientPicks, setClientPicks]       = useState({});
  const [pickingAll, setPickingAll]         = useState(false);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), type === 'info' ? 8000 : 4000);
  };

  const pollRef = useRef(null);
  const stopPolling = () => { if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; } };

  const load = useCallback(async (forceRefresh = false) => {
    setLoading(true);
    setError(null);
    setSelected(new Set());
    stopPolling();
    setLoadingStep(forceRefresh
      ? 'Iniciando análisis en segundo plano...'
      : 'Cargando análisis predictivo...');

    try {
      const res = await api.get(
        `/reengagement/candidates${forceRefresh ? '?refresh=true' : ''}`,
        { timeout: 30000 }
      );

      if (res.data.refreshing && forceRefresh) {
        setLoading(false);
        setLoadingStep('');
        showToast('Análisis iniciado en segundo plano. Se actualizará automáticamente en ~5 min.', 'info');
        pollRef.current = setInterval(async () => {
          try {
            const poll = await api.get('/reengagement/candidates', { timeout: 15000 });
            if (poll.data.data?.length > 0) {
              stopPolling();
              setCandidates(poll.data.data);
              setFromCache(poll.data.fromCache || false);
              setCacheDate(poll.data.cacheDate || null);
              setCacheSource(poll.data.cacheSource || null);
              showToast(`Análisis completado: ${poll.data.total} clientes`, 'success');
            }
          } catch (_) {}
        }, 60000);
        return;
      }

      setCandidates(res.data.data || []);
      setFromCache(res.data.fromCache || false);
      setCacheDate(res.data.cacheDate || null);
      setCacheSource(res.data.cacheSource || null);
      try {
        const calRes = await reengagementAPI.getCalibration();
        setCalibration(calRes.data);
      } catch (_) {}
      const data = res.data.data || [];
      if (data.some(c => c.buyWindow === 'hoy')) setActiveWindow('hoy');
      else if (data.some(c => c.buyWindow === 'semana')) setActiveWindow('semana');
      else setActiveWindow('mes');
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Error de conexión');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(false); return stopPolling; }, []);

  const loadTemplates = useCallback(async () => {
    setTemplatesLoading(true);
    setTemplatesError(null);
    try {
      const res = await reengagementAPI.getTemplates();
      let tpls = res.data || [];
      // Fallback: si no vienen templates del endpoint de reengagement, usar /api/templates
      if (tpls.length === 0) {
        const r2 = await api.get('/api/templates').catch(() => ({ data: { data: [] } }));
        tpls = (r2.data.data || []).filter(t => !t.status || t.status === 'APPROVED' || t.status === 'approved');
      }
      setTemplates(tpls);
    } catch (err) {
      // Si falla completamente, intentar fallback
      try {
        const r2 = await api.get('/api/templates');
        const tpls = (r2.data.data || []).filter(t => !t.status || t.status === 'APPROVED' || t.status === 'approved');
        setTemplates(tpls);
      } catch {
        setTemplatesError(err.response?.data?.error || err.message);
      }
    } finally {
      setTemplatesLoading(false);
    }
  }, []);

  // Cargar templates al montar
  useEffect(() => { loadTemplates(); }, []);

  const parseTemplateVars = (tpl) => {
    return getTemplateVariables(getBodyComponent(tpl)?.text || '');
  };

  // Construir components para envío usando el pick de IA
  const buildComponents = (candidate) => {
    const pick = clientPicks[candidate.phone];
    if (!pick?.vars) return [];
    const tpl = templates.find(t => t.name === pick.templateName);
    if (!tpl) return [];
    return buildBodyTemplateComponent(getBodyComponent(tpl)?.text || '', pick.vars);
  };

  const getPreviewText = (candidate) => {
    const pick = clientPicks[candidate?.phone];
    const tpl = templates.find(t => t.name === pick?.templateName);
    const body = getBodyComponent(tpl)?.text || '';
    return body ? renderTemplate(body, pick?.vars || {}) : '';
  };

  // IA elige template + rellena variables para un cliente
  const aiPickForOne = async (phone) => {
    if (templates.length === 0) { showToast('No hay templates disponibles', 'error'); return; }
    setClientPicks(prev => ({ ...prev, [phone]: { ...prev[phone], loading: true } }));
    try {
      const res = await reengagementAPI.aiPickTemplate(phone, templates);
      if (res.success) {
        setClientPicks(prev => ({ ...prev, [phone]: {
          templateName: res.templateName,
          languageCode: res.languageCode,
          vars:         res.vars,
          previewText:  res.previewText,
          reason:       res.reason,
          loading:      false,
        }}));
        setSelected(prev => new Set(prev).add(phone));
      }
    } catch (err) {
      showToast('Error: ' + (err.response?.data?.error || err.message), 'error');
      setClientPicks(prev => { const n = { ...prev }; if (n[phone]) n[phone] = { ...n[phone], loading: false }; return n; });
    }
  };

  // IA elige para todos (seleccionados o todos visibles)
  const aiPickForAll = async () => {
    if (templates.length === 0) { showToast('No hay templates disponibles', 'error'); return; }
    const targets = selected.size > 0
      ? visible.filter(c => selected.has(c.phone))
      : visible;
    setPickingAll(true);
    let done = 0;
    for (const c of targets) {
      await aiPickForOne(c.phone);
      done++;
      await new Promise(r => setTimeout(r, 400));
    }
    setPickingAll(false);
    showToast(`✅ IA eligió y personalizó templates para ${done} clientes`);
  };

  const relevanceScore = (c) => {
    const overdueBonus = c.predictedDays <= 0 ? 100 + Math.abs(c.predictedDays) * 2 : 0;
    const urgencyBonus = c.predictedDays <= 1 ? 30 : c.predictedDays <= 3 ? 15 : 0;
    const proximityPenalty = Math.max(0, c.predictedDays) * 0.4;
    return c.confidence + overdueBonus + urgencyBonus - proximityPenalty;
  };

  const byWindow = (window) => candidates
    .filter(c => c.buyWindow === window && c.confidence >= minConf && (!filterPhone || c.phone === filterPhone))
    .sort((a, b) => relevanceScore(b) - relevanceScore(a));

  const visible = byWindow(activeWindow);

  const toggleSelect = (phone) => setSelected(prev => {
    const n = new Set(prev);
    n.has(phone) ? n.delete(phone) : n.add(phone);
    return n;
  });

  // Todos los del tab actual seleccionados → desmarcar solo los del tab actual.
  // Alguno o ninguno → agregar los del tab actual a la selección existente.
  const toggleAll = () => {
    const visiblePhones = visible.map(c => c.phone);
    const allVisible = visiblePhones.every(p => selected.has(p));
    setSelected(prev => {
      const n = new Set(prev);
      if (allVisible) visiblePhones.forEach(p => n.delete(p));
      else            visiblePhones.forEach(p => n.add(p));
      return n;
    });
  };

  const sendOne = async (phone) => {
    const candidate = candidates.find(c => c.phone === phone);
    const pick = clientPicks[phone];
    const tpl = templates.find(t => t.name === pick?.templateName);
    if (!tpl) { showToast('Primero usa "IA elige template" para este cliente', 'error'); return; }
    const destPhone = testMode ? TEST_PHONE : phone;
    setSending(prev => new Set(prev).add(phone));
    try {
      await reengagementAPI.send({
        phone:         destPhone,
        templateName:  tpl.name,
        languageCode:  tpl.language,
        components:    buildComponents(candidate),
        previewText:   getPreviewText(candidate),
      });
      showToast(testMode ? `🧪 Enviado a tu número (${TEST_PHONE})` : 'Plantilla aceptada · pendiente de confirmación');
      if (!testMode) {
        setCandidates(prev => prev.filter(c => c.phone !== phone));
        setSelected(prev => { const n = new Set(prev); n.delete(phone); return n; });
        setClientPicks(prev => { const n = { ...prev }; delete n[phone]; return n; });
      }
    } catch (err) {
      showToast(err.response?.data?.error || 'Error enviando template', 'error');
    } finally {
      setSending(prev => { const n = new Set(prev); n.delete(phone); return n; });
    }
  };

  const sendBulk = async () => {
    const targets = selected.size > 0
      ? visible.filter(c => selected.has(c.phone))
      : visible;
    if (!targets.length) { showToast('Selecciona al menos un cliente', 'error'); return; }
    // Verificar que todos tengan template asignado
    const sinTemplate = targets.filter(c => {
      const pick = clientPicks[c.phone];
      return !templates.find(t => t.name === pick?.templateName);
    });
    if (sinTemplate.length > 0) {
      showToast(`${sinTemplate.length} cliente(s) sin template — usa "IA elige" primero`, 'error'); return;
    }
    const items = targets.map(c => {
      const pick = clientPicks[c.phone];
      const tpl = templates.find(t => t.name === pick?.templateName);
      return {
        phone:        testMode ? TEST_PHONE : c.phone,
        templateName: tpl.name,
        languageCode: tpl.language,
        components:   buildComponents(c),
        previewText:  getPreviewText(c),
        ...(testMode ? { force: true } : {}),
      };
    });
    setSendingBulk(true);
    try {
      const res = await reengagementAPI.sendBulk(items);
      if (testMode) {
        showToast(`🧪 ${res.sent} solicitudes aceptadas para tu número (${TEST_PHONE})`);
      } else {
        const skippedMsg = res.skipped > 0 ? ` · ${res.skipped} omitidos (ya enviado hoy)` : '';
        const failedMsg  = res.failed  > 0 ? ` · ${res.failed} fallaron` : '';
        showToast(`✅ ${res.sent} aceptados por WhatsApp${skippedMsg}${failedMsg}`);
        const sent = new Set(res.results.filter(r => r.success).map(r => r.phone));
        setCandidates(prev => prev.filter(c => !sent.has(c.phone)));
        setSelected(new Set());
      }
    } catch (err) {
      showToast(err.response?.data?.error || 'Error en envío masivo', 'error');
    } finally {
      setSendingBulk(false);
    }
  };

  // Clientes seleccionados que tienen template listo para enviar
  const selectedWithTemplate = visible.filter(c => {
    if (!selected.has(c.phone)) return false;
    const pick = clientPicks[c.phone];
    return !!templates.find(t => t.name === pick?.templateName);
  }).length;
  const totalCandidates  = candidates.length;
  const filteredTotal    = candidates.filter(c => c.confidence >= minConf).length;
  const hiddenByFilter   = totalCandidates - filteredTotal;

  const exportToExcel = async () => {
    if (!candidates.length) return;
    const XLSX = await import('xlsx');

    const windowLabel = { hoy: 'Hoy-Mañana', semana: 'Esta semana', mes: 'Este mes', lejano: '1-6 meses', desconocido: 'Desconocido' };

    const mainRows = candidates.map(c => ({
      'Nombre':              c.name || '—',
      'Teléfono':            c.phone,
      'Email':               c.email || '—',
      'Ventana':             windowLabel[c.buyWindow] || c.buyWindow,
      'Días estimados':      c.predictedDays ?? '—',
      'Confianza (%)':       c.confidence ?? '—',
      'Fuente predict.':     c.predSource === 'ai' ? 'IA' : 'Matemático',
      'Razón IA':            c.aiReason || '—',
      'Días inactivo':       c.daysInactive,
      'Última compra':       c.lastOrderDate || '—',
      'Últimos productos':   c.lastProducts || '—',
      'N° pedidos':          c.totalOrders,
      'Total gastado ($)':   c.totalSpent,
      'Ticket promedio ($)': c.avgOrderVal,
      'Frec. compra (días)': c.avgFreqDays ?? '—',
      'Día favorito':        c.favDay || '—',
      'Tendencia gasto':     c.spendTrend || '—',
    }));

    const wb = XLSX.utils.book_new();
    const ws1 = XLSX.utils.json_to_sheet(mainRows);
    ws1['!cols'] = [
      { wch: 22 }, { wch: 16 }, { wch: 28 }, { wch: 14 }, { wch: 14 },
      { wch: 14 }, { wch: 14 }, { wch: 30 }, { wch: 13 }, { wch: 13 },
      { wch: 30 }, { wch: 10 }, { wch: 16 }, { wch: 16 }, { wch: 18 },
      { wch: 13 }, { wch: 14 },
    ];
    XLSX.utils.book_append_sheet(wb, ws1, 'Todos');

    const windows = ['hoy', 'semana', 'mes', 'lejano'];
    for (const w of windows) {
      const grupo = candidates.filter(c => c.buyWindow === w);
      if (!grupo.length) continue;
      const rows = grupo.map(c => ({
        'Nombre':            c.name || '—',
        'Teléfono':          c.phone,
        'Días estimados':    c.predictedDays ?? '—',
        'Confianza (%)':     c.confidence ?? '—',
        'Razón IA':          c.aiReason || '—',
        'Días inactivo':     c.daysInactive,
        'Última compra':     c.lastOrderDate || '—',
        'Últimos productos': c.lastProducts || '—',
        'N° pedidos':        c.totalOrders,
        'Total gastado ($)': c.totalSpent,
      }));
      const ws = XLSX.utils.json_to_sheet(rows);
      ws['!cols'] = [{ wch: 22 }, { wch: 16 }, { wch: 14 }, { wch: 13 }, { wch: 30 }, { wch: 13 }, { wch: 13 }, { wch: 30 }, { wch: 10 }, { wch: 16 }];
      XLSX.utils.book_append_sheet(wb, ws, windowLabel[w]);
    }

    const fecha = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `reenganche_${fecha}.xlsx`);
    showToast(`Excel generado: ${candidates.length} clientes`, 'success');
  };

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100vh', backgroundColor: colors.bgApp, overflow: 'hidden' }}>

      {/* Header — fila única */}
      <div style={{
        padding: '12px 20px', backgroundColor: colors.bgPanel,
        borderBottom: `1px solid ${colors.border}`,
        display: 'flex', alignItems: 'center', gap: '10px',
      }}>
        {/* Título + badges */}
        <UserCheck size={18} color={colors.green} style={{ flexShrink: 0 }} />
        <span style={{ color: colors.textPrimary, fontSize: '16px', fontWeight: 700 }}>Re-enganche</span>

        <span style={{
          backgroundColor: colors.greenTint, color: colors.green,
          borderRadius: '5px', padding: '2px 7px', fontSize: '10px', fontWeight: 700,
          border: `1px solid ${colors.green}33`, display: 'flex', alignItems: 'center', gap: '3px',
          flexShrink: 0,
        }}>
          <Brain size={10} /> IA
        </span>

        {/* Stats inline compactos */}
        {!loading && totalCandidates > 0 && (
          <span style={{ color: colors.textMuted, fontSize: '12px' }}>
            {totalCandidates} clientes
            {hiddenByFilter > 0 && (
              <Tooltip text={`${hiddenByFilter} ocultos por confianza < ${minConf}%`} position="bottom">
                <span style={{ color: colors.borderStrong }}> · {hiddenByFilter} ocultos</span>
              </Tooltip>
            )}
            {fromCache && <span style={{ color: colors.borderStrong }}> · {cacheDate || ''}</span>}
          </span>
        )}

        {calibration && !loading && (
          <Tooltip text={`Accuracy histórica: ${Math.round((calibration.accuracyRate||0)*100)}% · ${calibration.totalPredictions} predicciones · factor ${calibration.calibrationFactor}`} position="bottom">
            <span style={{
              backgroundColor: calibration.accuracyRate >= 0.70 ? colors.greenTint : calibration.accuracyRate >= 0.50 ? `${colors.yellow}22` : `${colors.red}22`,
              color: calibration.accuracyRate >= 0.70 ? colors.green : calibration.accuracyRate >= 0.50 ? colors.yellow : colors.red,
              border: `1px solid currentColor`,
              borderRadius: '5px', padding: '2px 7px', fontSize: '10px', fontWeight: 700,
              cursor: 'default', flexShrink: 0,
            }}>
              {Math.round((calibration.accuracyRate||0)*100)}% preciso
            </span>
          </Tooltip>
        )}

        {testMode && (
          <span style={{
            backgroundColor: `${colors.yellow}22`, color: colors.yellow,
            border: `1px solid ${colors.yellow}44`,
            borderRadius: '5px', padding: '2px 7px', fontSize: '10px', fontWeight: 700,
            flexShrink: 0,
          }}>
            🧪 Prueba ON
          </span>
        )}

        {/* Spacer */}
        <div style={{ flex: 1 }} />

        {/* Selector de modo principal — solo Envío masivo visible */}
        <div style={{ display: 'flex', backgroundColor: colors.bgApp, borderRadius: colors.radiusMd, padding: '2px', border: `1px solid ${colors.border}`, gap: '2px', flexShrink: 0 }}>
          {[
            { key: 'masivo', label: '📢 Envío masivo' },
          ].map(({ key, label }) => (
            <button key={key} onClick={() => setMainTab(key)} style={{
              padding: '5px 12px', borderRadius: colors.radiusSm, border: 'none', cursor: 'pointer',
              fontSize: '12px', fontWeight: 600, transition: 'all 0.15s',
              backgroundColor: mainTab === key ? colors.green : 'transparent',
              color: mainTab === key ? '#fff' : colors.textSecondary,
            }}>{label}</button>
          ))}
        </div>

        {/* Botón principal (solo en modo IA) */}
        {mainTab === 'ia' && <button onClick={() => load(true)} disabled={loading}
          style={{
            display: 'flex', alignItems: 'center', gap: '5px',
            padding: '7px 14px', borderRadius: colors.radiusMd,
            backgroundColor: colors.green, color: 'white',
            border: 'none', cursor: loading ? 'not-allowed' : 'pointer',
            fontSize: '12px', fontWeight: 600, opacity: loading ? 0.6 : 1,
            flexShrink: 0,
          }}>
          <RefreshCw size={13} style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }} />
          {loading ? 'Analizando...' : 'Nuevo análisis'}
        </button>}

        {/* Menú ⋮ */}
        <div style={{ position: 'relative', flexShrink: 0 }}>
          <button
            onClick={() => setMenuOpen(o => !o)}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: '34px', height: '34px', borderRadius: colors.radiusMd,
              backgroundColor: menuOpen ? colors.bgHover : 'transparent',
              border: `1px solid ${colors.border}`,
              color: colors.textSecondary, cursor: 'pointer',
            }}>
            <MoreVertical size={15} />
          </button>
          {menuOpen && (
            <div style={{
              position: 'absolute', right: 0, top: 'calc(100% + 6px)', zIndex: 200,
              backgroundColor: colors.bgPanel, borderRadius: '10px',
              border: `1px solid ${colors.border}`,
              boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
              minWidth: '200px', overflow: 'hidden',
            }}
            onMouseLeave={() => setMenuOpen(false)}>

              <button onClick={() => { exportToExcel(); setMenuOpen(false); }} disabled={loading || !candidates.length}
                style={{ width: '100%', display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 14px', background: 'none', border: 'none', color: (!candidates.length || loading) ? colors.textMuted : colors.textPrimary, fontSize: '13px', cursor: (!candidates.length || loading) ? 'not-allowed' : 'pointer', textAlign: 'left' }}
                onMouseEnter={e => { if (candidates.length && !loading) e.currentTarget.style.backgroundColor = colors.bgHover; }}
                onMouseLeave={e => e.currentTarget.style.backgroundColor = 'transparent'}>
                <Download size={14} color={colors.green} /> Exportar Excel
              </button>

              <button onClick={async () => {
                  setMenuOpen(false); setCalibrating(true);
                  try {
                    const res = await reengagementAPI.calibrate();
                    if (res.success) { setCalibration(res.data); showToast(`✅ Calibración: ${Math.round((res.data.accuracyRate||0)*100)}% accuracy`); load(true); }
                  } catch (err) { showToast('Error: ' + (err.response?.data?.error || err.message), 'error'); }
                  finally { setCalibrating(false); }
                }}
                disabled={calibrating || loading}
                style={{ width: '100%', display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 14px', background: 'none', border: 'none', color: (calibrating || loading) ? colors.textMuted : colors.textPrimary, fontSize: '13px', cursor: (calibrating || loading) ? 'not-allowed' : 'pointer', textAlign: 'left' }}
                onMouseEnter={e => { if (!calibrating && !loading) e.currentTarget.style.backgroundColor = colors.bgHover; }}
                onMouseLeave={e => e.currentTarget.style.backgroundColor = 'transparent'}>
                {calibrating ? <><Loader size={14} style={{ animation: 'spin 1s linear infinite' }} /> Calibrando...</> : <>⚖️ {calibration ? 'Recalibrar IA' : 'Calibrar IA'}</>}
              </button>

              <div style={{ height: '1px', backgroundColor: colors.border, margin: '2px 0' }} />

              <button onClick={() => { setTestMode(t => !t); setMenuOpen(false); }}
                style={{ width: '100%', display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 14px', background: 'none', border: 'none', color: testMode ? colors.yellow : colors.textSecondary, fontSize: '13px', fontWeight: testMode ? 600 : 400, cursor: 'pointer', textAlign: 'left' }}
                onMouseEnter={e => e.currentTarget.style.backgroundColor = colors.bgHover}
                onMouseLeave={e => e.currentTarget.style.backgroundColor = 'transparent'}>
                🧪 {testMode ? 'Desactivar prueba' : 'Modo prueba'}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* ── Modo Envío Masivo ── */}
      {mainTab === 'masivo' && (
        <BroadcastPanel colors={colors} testPhone={testPhone} parentTemplates={templates} />
      )}

      {/* ── Modo IA Predictiva ── */}
      {mainTab !== 'masivo' && <>

      {/* Tabs + filtro de confianza */}
      {!loading && !error && totalCandidates > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', backgroundColor: colors.bgApp, borderBottom: `1px solid ${colors.border}`, padding: '0 20px' }}>
          {/* Tabs */}
          <div style={{ display: 'flex', flex: 1 }}>
            {WINDOWS.map(w => {
              const count   = byWindow(w.key).length;
              const isActive = activeWindow === w.key;
              return (
                <button key={w.key} onClick={() => setActiveWindow(w.key)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: '6px',
                    padding: '10px 16px', background: 'none', border: 'none', cursor: 'pointer',
                    borderBottom: isActive ? `2px solid ${w.color}` : '2px solid transparent',
                    color: isActive ? w.color : colors.textSecondary, fontSize: '13px', fontWeight: isActive ? 600 : 400,
                    transition: 'all 0.15s', whiteSpace: 'nowrap',
                  }}>
                  {w.key === 'hoy' && <Zap size={12} />}
                  {w.label}
                  {count > 0 && (
                    <span style={{ backgroundColor: isActive ? w.bg : colors.bgHover, color: isActive ? w.color : colors.textSecondary, borderRadius: '10px', padding: '1px 6px', fontSize: '11px', fontWeight: 700 }}>
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Filtro confianza — al lado derecho de los tabs */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px', paddingLeft: '12px', borderLeft: `1px solid ${colors.border}` }}>
            <span style={{ color: colors.textMuted, fontSize: '11px', whiteSpace: 'nowrap' }}>Mín.</span>
            {[50, 65, 75, 85].map(val => (
              <button key={val} onClick={() => setMinConf(val)}
                style={{
                  padding: '3px 8px', borderRadius: '5px', fontSize: '11px', fontWeight: 700,
                  cursor: 'pointer', border: 'none',
                  backgroundColor: minConf === val ? colors.green : 'transparent',
                  color: minConf === val ? '#fff' : colors.textMuted,
                  transition: 'all 0.15s',
                }}>
                {val}%
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Descripción de la ventana activa */}
      {!loading && !error && visible.length > 0 && (
        <div style={{ padding: '8px 24px', backgroundColor: colors.bgApp, borderBottom: `1px solid ${colors.border}` }}>
          <span style={{ color: colors.textSecondary, fontSize: '12px', fontStyle: 'italic' }}>
            {WINDOWS.find(w => w.key === activeWindow)?.desc}
          </span>
        </div>
      )}

      {/* Panel de templates (siempre visible) */}
      {/* Banner modo prueba */}
      {testMode && (
        <div style={{
          backgroundColor: `${colors.yellow}18`, borderBottom: `1px solid ${colors.yellow}44`,
          padding: '8px 24px', display: 'flex', alignItems: 'center', gap: '8px',
        }}>
          <span style={{ fontSize: '14px' }}>🧪</span>
          <span style={{ color: colors.yellow, fontSize: '12px', fontWeight: 600 }}>
            Modo prueba activo — todos los envíos irán a {TEST_PHONE} en vez del cliente real
          </span>
          <button onClick={() => setTestMode(false)} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: colors.yellow, cursor: 'pointer', fontSize: '12px', textDecoration: 'underline' }}>
            Desactivar
          </button>
        </div>
      )}

      {/* Banner de templates */}
      {!loading && (
        <div style={{ backgroundColor: colors.bgSub, borderBottom: `1px solid ${colors.border}`, padding: '10px 24px' }}>
          {templatesLoading ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: colors.textSecondary, fontSize: '13px' }}>
              <Loader size={14} style={{ animation: 'spin 1s linear infinite' }} /> Cargando templates...
            </div>
          ) : templatesError ? (
            templatesError.toLowerCase().includes('waba') ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                <AlertCircle size={14} color={colors.yellow} style={{ flexShrink: 0 }} />
                <span style={{ color: colors.textPrimary, fontSize: '13px', fontWeight: 600 }}>Falta configurar el WABA ID</span>
                <span style={{ color: colors.textSecondary, fontSize: '12px' }}>
                  Para enviar templates necesitas ingresar tu WhatsApp Business Account ID.
                </span>
                {onNavigateToSettings ? (
                  <button
                    onClick={onNavigateToSettings}
                    style={{
                      display: 'flex', alignItems: 'center', gap: '5px',
                      backgroundColor: colors.green, color: 'white',
                      padding: '5px 12px', borderRadius: '7px',
                      border: 'none', cursor: 'pointer',
                      fontSize: '12px', fontWeight: 600, flexShrink: 0,
                    }}
                  >
                    Ir a Configuración → WhatsApp
                  </button>
                ) : null}
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <AlertCircle size={14} color={colors.red} />
                <span style={{ color: colors.red, fontSize: '12px' }}>{templatesError}</span>
                <button onClick={loadTemplates} style={{ color: colors.green, fontSize: '12px', background: 'none', border: 'none', cursor: 'pointer' }}>Reintentar</button>
              </div>
            )
          ) : templates.length === 0 ? (
            <span style={{ color: colors.textSecondary, fontSize: '12px' }}>
              No hay templates aprobados. Créalos en la sección Templates.
            </span>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: colors.textSecondary, fontSize: '12px' }}>
              <Brain size={13} color={colors.green} />
              <span>La IA elegirá el mejor template y lo personalizará por cliente</span>
              <span style={{ color: colors.textMuted }}>·</span>
              <span style={{ color: colors.textMuted }}>{templates.length} template{templates.length !== 1 ? 's' : ''} disponible{templates.length !== 1 ? 's' : ''}</span>
            </div>
          )}
        </div>
      )}

      {/* Barra de acciones */}
      {visible.length > 0 && !loading && (
        <div style={{ padding: '8px 24px', backgroundColor: colors.bgApp, borderBottom: `1px solid ${colors.border}`, display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
          <button onClick={toggleAll}
            style={{ display: 'flex', alignItems: 'center', gap: '6px', background: 'none', border: 'none', cursor: 'pointer', color: colors.textSecondary, fontSize: '13px' }}>
            {visible.every(c => selected.has(c.phone)) && visible.length > 0
              ? <CheckSquare size={16} color={colors.green} />
              : <Square size={16} />}
            {visible.every(c => selected.has(c.phone)) && visible.length > 0
              ? `Deseleccionar este tab (${visible.length})`
              : `Seleccionar este tab (${visible.length})`}
          </button>
          {selected.size > 0 && (
            <span style={{ fontSize: '12px', color: colors.green, fontWeight: 600 }}>
              {selected.size} seleccionados en total
            </span>
          )}
          {selected.size > 0 && (
            <button onClick={() => setSelected(new Set())}
              style={{ fontSize: '12px', color: colors.textSecondary, background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}>
              Limpiar
            </button>
          )}

          <div style={{ flex: 1 }} />

          {/* Botón principal: IA elige + personaliza en masa */}
          <button
            onClick={aiPickForAll}
            disabled={pickingAll || templates.length === 0}
            style={{
              display: 'flex', alignItems: 'center', gap: '6px',
              backgroundColor: colors.bgAccent2, color: colors.green,
              padding: '7px 16px', borderRadius: colors.radiusMd, fontSize: '13px', fontWeight: 600,
              border: `1px solid ${colors.green}44`,
              cursor: (pickingAll || templates.length === 0) ? 'not-allowed' : 'pointer',
              opacity: pickingAll ? 0.7 : 1,
            }}>
            {pickingAll
              ? <><Loader size={14} style={{ animation: 'spin 1s linear infinite' }} /> Analizando...</>
              : <><Sparkles size={14} /> IA elige + personaliza {selected.size > 0 ? `(${selected.size})` : `(${visible.length})`}</>}
          </button>

          <button onClick={sendBulk}
            disabled={sendingBulk || selectedWithTemplate === 0}
            style={{
              display: 'flex', alignItems: 'center', gap: '6px',
              backgroundColor: selectedWithTemplate > 0 ? colors.green : colors.bgHover,
              color: selectedWithTemplate > 0 ? 'white' : colors.textSecondary,
              padding: '7px 14px', borderRadius: colors.radiusMd, fontSize: '13px', fontWeight: 500,
              border: 'none',
              cursor: selectedWithTemplate > 0 ? 'pointer' : 'not-allowed',
              opacity: sendingBulk ? 0.7 : 1,
            }}>
            {sendingBulk ? <Loader size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Send size={14} />}
            {sendingBulk ? 'Enviando...' : `Enviar a ${selectedWithTemplate} clientes`}
          </button>
        </div>
      )}

      {/* Banner filtro por teléfono */}
      {filterPhone && (
        <div style={{
          backgroundColor: `${colors.green}12`, borderBottom: `1px solid ${colors.green}33`,
          padding: '8px 24px', display: 'flex', alignItems: 'center', gap: '10px',
        }}>
          <UserCheck size={13} color={colors.green} />
          <span style={{ color: colors.green, fontSize: '12px', fontWeight: 500 }}>
            Filtrado por cliente: <strong>{filterPhone}</strong>
          </span>
          {onClearFilter && (
            <button onClick={onClearFilter} style={{
              display: 'flex', alignItems: 'center', gap: '4px', marginLeft: 'auto',
              background: 'none', border: `1px solid ${colors.green}44`, borderRadius: colors.radiusSm,
              color: colors.green, fontSize: '11px', cursor: 'pointer', padding: '2px 8px',
            }}>
              <X size={11} /> Ver todos
            </button>
          )}
        </div>
      )}

      {/* Contenido */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '14px 20px' }}>

        {loading ? (
          <div style={{ textAlign: 'center', padding: '80px 40px', color: colors.textSecondary }}>
            <div style={{ width: '40px', height: '40px', border: `3px solid ${colors.border}`, borderTop: `3px solid ${colors.green}`, borderRadius: '50%', animation: 'spin 1s linear infinite', margin: '0 auto 20px' }} />
            <div style={{ fontSize: '15px', fontWeight: 500, color: colors.textPrimary, marginBottom: '8px' }}>{loadingStep}</div>
            <div style={{ fontSize: '12px', opacity: 0.6, lineHeight: 1.6 }}>
              Claude analiza frecuencias, patrones semanales y tendencias de gasto<br/>para predecir cuándo comprará cada cliente
            </div>
          </div>
        ) : error ? (
          <div style={{ textAlign: 'center', padding: '60px', color: colors.red }}>
            <AlertCircle size={40} style={{ marginBottom: '12px', opacity: 0.7 }} />
            <div style={{ fontSize: '14px', marginBottom: '16px', maxWidth: '400px', margin: '0 auto 16px', lineHeight: 1.5 }}>{error}</div>
            <button onClick={() => load(true)} style={{ backgroundColor: `${colors.green}22`, color: colors.green, border: `1px solid ${colors.green}33`, borderRadius: colors.radiusMd, padding: '8px 16px', fontSize: '13px', cursor: 'pointer' }}>
              Reintentar
            </button>
          </div>
        ) : totalCandidates === 0 ? (
          <div style={{ textAlign: 'center', padding: '80px', color: colors.textSecondary }}>
            <Brain size={48} style={{ marginBottom: '16px', opacity: 0.2 }} />
            <div style={{ fontSize: '15px', fontWeight: 500 }}>Sin datos suficientes</div>
            <div style={{ fontSize: '13px', marginTop: '8px', opacity: 0.7 }}>
              No se encontraron órdenes con teléfono registrado en Shopify
            </div>
          </div>
        ) : visible.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '60px', color: colors.textSecondary }}>
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
                isSending={sending.has(c.phone)}
                pick={clientPicks[c.phone] || null}
                onToggleSelect={() => toggleSelect(c.phone)}
                onAiPick={() => aiPickForOne(c.phone)}
                onSend={() => sendOne(c.phone)}
              />
            </div>
          ))
        )}
      </div>

      {toast && (
        <div style={{
          position: 'fixed', bottom: '24px', right: '24px', zIndex: 1000,
          backgroundColor: toast.type === 'error' ? `${colors.red}22` : toast.type === 'info' ? colors.bgHover : colors.greenTint,
          border: `1px solid ${toast.type === 'error' ? `${colors.red}44` : toast.type === 'info' ? `${colors.purple}44` : colors.green}`,
          color: toast.type === 'error' ? colors.red : toast.type === 'info' ? colors.purple : colors.green,
          padding: '12px 18px', borderRadius: '10px', fontSize: '13px', fontWeight: 500,
          boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
        }}>
          {toast.msg}
        </div>
      )}

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </>}

    </div>
  );
}

function CandidateCard({ candidate: c, isSelected, isSending, pick, onToggleSelect, onAiPick, onSend }) {
  const { colors } = useTheme();

  const conf    = c.confidence || 0;
  const isPickLoading = pick?.loading;
  const cColor  = confColor(conf, colors);
  const overdue = c.avgFreqDays && c.daysInactive > c.avgFreqDays;

  // ¿Ya se le envió un template hoy?
  const sentToday = (() => {
    if (!c.last_template_sent_at) return null;
    const sent = new Date(c.last_template_sent_at);
    const now  = new Date();
    if (sent.toDateString() !== now.toDateString()) return null;
    const h = sent.getHours(), m = String(sent.getMinutes()).padStart(2, '0');
    return `${h}:${m}`;
  })();

  const predDays  = c.predictedDays ?? 0;
  const predLabel = predDays < 0
    ? `vencido hace ${Math.abs(predDays)}d`
    : predDays === 0 ? 'compraría hoy'
    : predDays === 1 ? 'compraría mañana'
    : `en ~${predDays}d`;

  const predColor = predDays <= 0 ? colors.red : predDays <= 1 ? colors.greenLight : predDays <= 7 ? colors.green : colors.yellow;
  const predBg    = predDays <= 0 ? `${colors.red}22` : predDays <= 1 ? colors.greenTint : predDays <= 7 ? colors.greenTint : `${colors.yellow}22`;

  return (
    <div style={{
      backgroundColor: isSelected ? colors.bgAccent : colors.bgSub,
      border: `1px solid ${isSelected ? colors.green : colors.border}`,
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
            ? <CheckSquare size={15} color={colors.green} />
            : <Square size={15} color={colors.borderStrong} />}
        </button>

        {/* Avatar */}
        <div style={{
          width: '36px', height: '36px', borderRadius: '50%', flexShrink: 0,
          backgroundColor: colors.bgHover,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: '14px', fontWeight: 700, color: cColor,
          border: `2px solid ${cColor}55`,
        }}>
          {(c.name?.[0] || '?').toUpperCase()}
        </div>

        {/* Nombre */}
        <span style={{ color: colors.textPrimary, fontWeight: 700, fontSize: '14px', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {c.name}
        </span>

        {/* Badge predicción */}
        <Tooltip text={predDays <= 0
          ? `Lleva ${Math.abs(predDays)}d más de lo normal sin comprar. Su ciclo habitual es ~${c.avgFreqDays}d.`
          : predDays <= 1 ? 'La IA predice que comprará hoy o mañana según su patrón de compras.'
          : `La IA estima que comprará en aproximadamente ${predDays} días, basado en su ciclo habitual.`}>
          <span style={{
            backgroundColor: predBg, color: predColor,
            borderRadius: colors.radiusSm, padding: '3px 10px',
            fontSize: '12px', fontWeight: 700,
            border: `1px solid ${predColor}44`,
            flexShrink: 0,
          }}>
            {predLabel}
          </span>
        </Tooltip>

        {/* Badge "Enviado hoy" */}
        {sentToday && (
          <Tooltip text={`Ya se le envió un template hoy a las ${sentToday}. El backend lo omitirá si intentas enviarlo de nuevo.`}>
            <span style={{
              backgroundColor: colors.amberStrong + '22', color: colors.amberStrong,
              borderRadius: colors.radiusSm, padding: '3px 8px',
              fontSize: '11px', fontWeight: 700, flexShrink: 0,
              border: `1px solid ${colors.amberStrong}44`,
            }}>
              📬 {sentToday}
            </span>
          </Tooltip>
        )}

        {/* Confianza */}
        <Tooltip text={`Confianza de la predicción. ${conf >= 80 ? 'Alta — patrón de compra muy regular.' : conf >= 60 ? 'Media — patrón moderadamente consistente.' : 'Baja — pocos datos o compras irregulares.'}`}>
          <span style={{
            backgroundColor: colors.bgHover, color: cColor,
            borderRadius: colors.radiusSm, padding: '3px 8px',
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
              <span style={{ backgroundColor: `${colors.red}22`, color: colors.red, borderRadius: '5px', padding: '2px 8px', fontSize: '11px', fontWeight: 600 }}>
                ⚠ {c.daysInactive - c.avgFreqDays}d fuera de ciclo
              </span>
            </Tooltip>
          )}
          {c.spendTrend && c.spendTrend !== 'estable' && (
            <Tooltip text={c.spendTrend === 'creciente' ? 'Este cliente gasta más en sus compras recientes que en las anteriores.' : 'Este cliente gasta menos en sus compras recientes que antes.'} position="bottom">
              <span style={{ backgroundColor: colors.bgHover, color: c.spendTrend === 'creciente' ? colors.greenLight : colors.red, borderRadius: '5px', padding: '2px 8px', fontSize: '11px', fontWeight: 600 }}>
                {c.spendTrend === 'creciente' ? '↑' : '↓'} gasto {c.spendTrend}
              </span>
            </Tooltip>
          )}
        </div>
      )}

      {/* ── FILA 3: razón / fuente de predicción ── */}
      {c.aiReason && (
        <div style={{ margin: '8px 14px 0', backgroundColor: colors.bgInput, borderRadius: '7px', padding: '7px 10px', display: 'flex', alignItems: 'flex-start', gap: '7px' }}>
          {c.predSource === 'heuristic'
            ? <Zap size={13} color={colors.yellow} style={{ flexShrink: 0, marginTop: '1px' }} />
            : <Brain size={13} color={colors.green} style={{ flexShrink: 0, marginTop: '1px' }} />}
          <span style={{ color: colors.textSecondary, fontSize: '12px', fontStyle: 'italic', lineHeight: 1.45 }}>
            {c.aiReason}
            {c.predSource === 'heuristic' && (
              <span style={{ marginLeft: '6px', color: colors.textMuted, fontSize: '10px', fontStyle: 'normal' }}>(matemático)</span>
            )}
          </span>
        </div>
      )}

      {/* ── FILA 4: stats ── */}
      <div style={{ display: 'flex', gap: '18px', flexWrap: 'wrap', alignItems: 'center', padding: '8px 14px' }}>
        <Tooltip text={`Días desde su última compra (${c.lastOrderDate || '—'}). ${overdue ? `Su ciclo habitual es ~${c.avgFreqDays}d, lleva ${c.daysInactive - c.avgFreqDays}d de retraso.` : ''}`}>
          <span style={{ color: colors.textSecondary, fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px' }}>
            <Clock size={11} />
            <strong style={{ color: overdue ? colors.red : colors.textPrimary }}>{c.daysInactive}d</strong>
            <span style={{ color: colors.textMuted }}>inactivo</span>
          </span>
        </Tooltip>

        <Tooltip text="Total de pedidos realizados en la tienda. Más pedidos = predicción más precisa.">
          <span style={{ color: colors.textSecondary, fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px' }}>
            <ShoppingBag size={11} />
            <strong style={{ color: colors.textPrimary }}>{c.totalOrders}</strong>
            <span style={{ color: colors.textMuted }}>pedido{c.totalOrders !== 1 ? 's' : ''}</span>
          </span>
        </Tooltip>

        {c.avgFreqDays && (
          <Tooltip text={`Frecuencia promedio de compra. Normalmente compra cada ~${c.avgFreqDays} días.`}>
            <span style={{ color: colors.textSecondary, fontSize: '12px' }}>
              🔁 <strong style={{ color: colors.textPrimary }}>~{c.avgFreqDays}d</strong>
            </span>
          </Tooltip>
        )}

        {c.favDay && (
          <Tooltip text={`Día de la semana en que más compra. Ideal para contactar los días ${c.favDay}.`}>
            <span style={{ color: colors.textSecondary, fontSize: '12px' }}>
              📅 <strong style={{ color: colors.textPrimary }}>{c.favDay}</strong>
            </span>
          </Tooltip>
        )}

        <Tooltip text={`Total gastado histórico en la tienda. Ticket promedio: $${Math.round((c.avgOrderVal || 0)).toLocaleString('es-CL')}`}>
          <span style={{ color: colors.green, fontSize: '12px', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '4px' }}>
            <TrendingUp size={11} />
            ${Math.round(c.totalSpent || 0).toLocaleString('es-CL')}
          </span>
        </Tooltip>

        {c.lastProducts && (
          <Tooltip text={`Últimos productos comprados: ${c.lastProducts}`}>
            <span style={{ color: colors.borderStrong, fontSize: '11px', fontStyle: 'italic', maxWidth: '180px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {c.lastProducts}
            </span>
          </Tooltip>
        )}
      </div>

      {/* ── FILA 5: IA pick + envío ── */}
      <div style={{ display: 'flex', gap: '8px', padding: '0 14px 12px', alignItems: 'flex-end' }}>

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '5px' }}>

          {/* Resultado del pick de IA */}
          {pick && !pick.loading && (
            <div style={{
              backgroundColor: colors.bgAccent2, borderRadius: colors.radiusMd,
              border: `1px solid ${colors.green}33`,
              padding: '7px 10px',
            }}>
              {/* Template elegido + razón */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px', flexWrap: 'wrap' }}>
                <FileText size={11} color={colors.green} />
                <span style={{ fontSize: '11px', fontWeight: 700, color: colors.green }}>{pick.templateName}</span>
                {pick.reason && (
                  <span style={{ fontSize: '11px', color: colors.textSecondary, fontStyle: 'italic' }}>
                    — {pick.reason}
                  </span>
                )}
              </div>
              {/* Preview del mensaje */}
              <p style={{
                fontSize: '12px', color: colors.textPrimary, margin: 0,
                lineHeight: 1.45, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              }}>
                {pick.previewText?.slice(0, 140)}{(pick.previewText?.length || 0) > 140 ? '…' : ''}
              </p>
            </div>
          )}

          {/* Botón IA elige */}
          <button
            onClick={onAiPick}
            disabled={isPickLoading}
            style={{
              display: 'flex', alignItems: 'center', gap: '5px',
              backgroundColor: pick && !pick.loading ? colors.bgHover : colors.bgAccent2,
              color: pick && !pick.loading ? colors.textSecondary : colors.green,
              padding: '5px 10px', borderRadius: colors.radiusSm, fontSize: '11px', fontWeight: 500,
              border: `1px solid ${pick && !pick.loading ? colors.border : `${colors.green}44`}`,
              cursor: isPickLoading ? 'not-allowed' : 'pointer',
              opacity: isPickLoading ? 0.6 : 1, alignSelf: 'flex-start',
            }}>
            {isPickLoading
              ? <><Loader size={11} style={{ animation: 'spin 1s linear infinite' }} /> Analizando...</>
              : pick
              ? <><Sparkles size={11} /> Re-analizar</>
              : <><Sparkles size={11} /> IA elige template</>}
          </button>
        </div>

        <button onClick={onSend} disabled={isSending || !pick || pick.loading}
          style={{
            display: 'flex', alignItems: 'center', gap: '6px',
            backgroundColor: (pick && !pick.loading) ? colors.green : colors.bgHover,
            color: (pick && !pick.loading) ? 'white' : colors.textMuted,
            padding: '7px 18px', borderRadius: '7px', fontSize: '12px', fontWeight: 600,
            border: 'none',
            cursor: (isSending || !pick || pick.loading) ? 'not-allowed' : 'pointer',
            opacity: isSending ? 0.7 : 1, flexShrink: 0,
          }}>
          {isSending
            ? <Loader size={13} style={{ animation: 'spin 1s linear infinite' }} />
            : <Send size={13} />}
          {isSending ? 'Enviando...' : 'Enviar'}
        </button>
      </div>
    </div>
  );
}

// ─── Componente: Envío Masivo ────────────────────────────────────────────────

function toTitleCase(s) {
  const LOWER = new Set(['de','del','la','las','los','y','e','el','en','con','por','a']);
  return (s || '').trim().split(/\s+/).filter(Boolean).map((w, i) => {
    const wl = w.toLowerCase();
    return (i === 0 || !LOWER.has(wl)) ? wl.charAt(0).toUpperCase() + wl.slice(1) : wl;
  }).join(' ');
}

function formatDaysSince(dateValue) {
  if (!dateValue) return '';
  const timestamp = new Date(dateValue).getTime();
  if (!Number.isFinite(timestamp)) return '';
  const days = Math.max(0, Math.floor((Date.now() - timestamp) / (24 * 60 * 60 * 1000)));
  if (days === 0) return 'menos de un día';
  if (days === 1) return '1 día';
  if (days < 14) return `${days} días`;
  if (days < 60) {
    const weeks = Math.floor(days / 7);
    return `${weeks} ${weeks === 1 ? 'semana' : 'semanas'}`;
  }
  if (days < 730) {
    const months = Math.floor(days / 30);
    return `${months} ${months === 1 ? 'mes' : 'meses'}`;
  }
  const years = Math.floor(days / 365);
  return `${years} ${years === 1 ? 'año' : 'años'}`;
}

function formatOrderDate(dateValue) {
  if (!dateValue) return '';
  const date = new Date(dateValue);
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat('es-CL', { day: 'numeric', month: 'long', year: 'numeric' }).format(date);
}

function templatePreviewParts(templateBody = '') {
  const body = String(templateBody);
  const parts = [];
  let cursor = 0;
  for (const match of body.matchAll(/\{\{(\d+)\}\}/g)) {
    if (match.index > cursor) parts.push({ type: 'text', value: body.slice(cursor, match.index) });
    parts.push({ type: 'variable', number: String(Number(match[1])) });
    cursor = match.index + match[0].length;
  }
  if (cursor < body.length) parts.push({ type: 'text', value: body.slice(cursor) });
  return parts;
}

function FixedTextPreviewEditor({ number, value, onChange, colors }) {
  const fieldRef = useRef(null);

  useEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    field.style.height = 'auto';
    field.style.height = `${Math.max(52, field.scrollHeight)}px`;
  }, [value]);

  return (
    <span style={{ display: 'block', margin: '6px 0', padding: '7px 8px 8px', borderRadius: 8, border: `1px dashed ${colors.blue}`, backgroundColor: `${colors.blue}0d` }}>
      <span style={{ display: 'block', color: colors.blue, fontSize: 10, fontWeight: 800, marginBottom: 5 }}>
        Texto fijo {`{{${number}}}`} · editable en la vista previa
      </span>
      <textarea
        ref={fieldRef}
        value={value}
        rows={1}
        onChange={event => onChange(event.target.value)}
        placeholder="Escribe aquí el texto fijo"
        aria-label={`Editar texto fijo de la variable ${number}`}
        style={{
          display: 'block', width: '100%', minHeight: 52, boxSizing: 'border-box', overflow: 'hidden', resize: 'vertical',
          padding: '8px 9px', borderRadius: 6, border: `1px solid ${colors.border}`, outlineColor: colors.blue,
          backgroundColor: colors.bgApp, color: colors.textPrimary, font: 'inherit', fontSize: 13, lineHeight: 1.5,
        }}
      />
    </span>
  );
}

function BroadcastPanel({ colors, testPhone, parentTemplates = [] }) {
  const [contacts,       setContacts]       = useState([]);
  const [sources,        setSources]        = useState(null);
  const [loading,        setLoading]        = useState(true);
  const [search,         setSearch]         = useState('');
  const [purchaseAge, setPurchaseAge] = useState('all');
  const [customPurchaseDays, setCustomPurchaseDays] = useState('45');
  const [excludeEmpresas, setExcludeEmpresas] = useState(false);
  const [selected,       setSelected]       = useState(new Set());
  const [templates,      setTemplates]      = useState(parentTemplates);
  const [tplLoading,     setTplLoading]     = useState(parentTemplates.length === 0);
  const [selTpl,         setSelTpl]         = useState(parentTemplates[0] || null);
  const [previewIdx,     setPreviewIdx]     = useState(0);
  const [favMap,  setFavMap]  = useState({});    // telefono -> producto favorito
  const [varMap,  setVarMap]  = useState([]);    // fuente de datos por variable
  const [varText, setVarText] = useState([]);    // texto fijo por variable
  const [varPrefix, setVarPrefix] = useState([]); // texto fijo antes del dato dinámico
  const [varSuffix, setVarSuffix] = useState([]); // texto fijo después del dato dinámico
  const [varFallback, setVarFallback] = useState([]); // valor si el contacto no tiene el dato
  const [sendProgress, setSendProgress] = useState({ done: 0, total: 0 });
  const [sending,        setSending]        = useState(false);
  const sendingRef = useRef(false);
  const stopSendingRef = useRef(false);
  const [sendingMethods, setSendingMethods] = useState([]);
  const [methodsLoading, setMethodsLoading] = useState(true);
  const [methodsError, setMethodsError] = useState('');
  const [sendingMethodKey, setSendingMethodKey] = useState('kapso');
  const [waitSeconds, setWaitSeconds] = useState(0);
  const selectedMethod = sendingMethods.find(m => (m.channelId ? `evolution:${m.channelId}` : 'kapso') === sendingMethodKey);
  const loadSendingMethods = useCallback(async () => {
    setMethodsLoading(true);
    setMethodsError('');
    try {
      const { data } = await api.get('/reengagement/sending-methods');
      setSendingMethods(data.methods || []);
    } catch (error) {
      setMethodsError(error.response?.data?.error || 'No se pudieron cargar las conexiones.');
    } finally {
      setMethodsLoading(false);
    }
  }, []);
  useEffect(() => {
    loadSendingMethods();
    return () => { stopSendingRef.current = true; };
  }, [loadSendingMethods]);
  async function waitForNextSend(seconds) {
    for (let remaining = Math.ceil(seconds); remaining > 0 && !stopSendingRef.current; remaining--) {
      setWaitSeconds(remaining);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    setWaitSeconds(0);
  }
  const [reviewPlan,     setReviewPlan]     = useState(null);
  const [reviewIdx,      setReviewIdx]      = useState(0);
  const [guidedReview,   setGuidedReview]   = useState(false);
  const [reviewedItems,  setReviewedItems]  = useState(new Set());
  const [results,        setResults]        = useState(null);
  const [toast,          setToast]          = useState(null);
  const [testMode,       setTestMode]       = useState(false);
  const [testPhoneInput, setTestPhoneInput] = useState(testPhone || '');
  const TEST_PHONE = testPhoneInput.trim();
  const [campaigns, setCampaigns] = useState([]);
  const [campaignsLoading, setCampaignsLoading] = useState(true);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [expandedCampaign, setExpandedCampaign] = useState(null);
  const [campaignRecipients, setCampaignRecipients] = useState([]);
  const [paymentRetryPhones, setPaymentRetryPhones] = useState(new Set());
  const [followUpPreview, setFollowUpPreview] = useState(null);
  const [followUpBusy, setFollowUpBusy] = useState(false);
  const [statusCheckCampaign, setStatusCheckCampaign] = useState(null);
  const [prodTerm,  setProdTerm]  = useState('');    // texto del filtro por producto
  const [prodPhones, setProdPhones] = useState(null); // Set de teléfonos que compraron el producto (null = sin filtro)
  const [prodBusy,  setProdBusy]  = useState(false);
  const [deliveryPhones, setDeliveryPhones] = useState(null); // no entregados en la ruta de ayer
  const [deliveryCases, setDeliveryCases] = useState(new Map());
  const [deliveryBusy, setDeliveryBusy] = useState(false);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 5000);
  };

  const loadCampaigns = useCallback(() => {
    setCampaignsLoading(true);
    return api.get('/reengagement/campaigns?limit=20')
      .then(res => setCampaigns(res.data.campaigns || []))
      .catch(() => setCampaigns([]))
      .finally(() => setCampaignsLoading(false));
  }, []);

  useEffect(() => { loadCampaigns(); }, [loadCampaigns]);

  useEffect(() => {
    if (!historyOpen) return undefined;
    const closeOnEscape = event => {
      if (event.key === 'Escape') setHistoryOpen(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [historyOpen]);

  async function toggleCampaignDetails(campaign) {
    const campaignId = campaign.id;
    if (String(expandedCampaign) === String(campaignId)) {
      setExpandedCampaign(null);
      setCampaignRecipients([]);
      setFollowUpPreview(null);
      return;
    }
    setExpandedCampaign(campaignId);
    setCampaignRecipients([]);
    setFollowUpPreview(null);
    try {
      if (campaign.status === 'paused_payment' && Number(campaign.accepted_count || 0) > 0) {
        setStatusCheckCampaign(campaignId);
        try {
          const { data: verified } = await api.post(`/reengagement/campaigns/${campaignId}/reconcile-statuses`, {});
          if (verified.checked > 0) {
            showToast(`Estados verificados con Meta: ${verified.checked}${verified.failed ? ` · ${verified.failed} fallidos confirmados` : ''}.`);
            await loadCampaigns();
          }
        } catch (error) {
          showToast(error.response?.data?.error || 'No se pudieron verificar todos los estados con Meta', 'error');
        } finally {
          setStatusCheckCampaign(null);
        }
      }
      const { data } = await api.get(`/reengagement/campaigns/${campaignId}`);
      setCampaignRecipients(data.recipients || []);
    } catch {
      showToast('No se pudo cargar el detalle de esta campaña', 'error');
    }
  }

  async function preparePaymentRetry(campaign) {
    setFollowUpBusy(true);
    try {
      const { data } = await api.get(`/reengagement/campaigns/${campaign.id}/payment-retry-preview`);
      const retryItems = data.items || [];
      const template = parentTemplates.find(item => item.name === campaign.template_name) || data.template;
      if (!retryItems.length) throw new Error('No encontramos destinatarios 131042 con variables recuperables para reintentar');
      if (!template) throw new Error(`El template ${campaign.template_name} ya no está disponible en Meta`);
      setSelTpl(template);
      const retryPhones = new Set(retryItems.map(item => normPhone(item.phone)));
      setSelected(new Set(contacts.filter(contact => retryPhones.has(normPhone(contact.phone))).map(contact => contact.phone)));
      setPaymentRetryPhones(retryPhones);
      setReviewIdx(0);
      setGuidedReview(false);
      setReviewedItems(new Set());
      setReviewPlan({
        templateName: campaign.template_name,
        entries: retryItems.map(item => ({
          contact: contacts.find(contact => normPhone(contact.phone) === normPhone(item.phone))
            || { phone: item.phone, name: item.contactName || 'Cliente' },
          values: {},
          previewText: item.previewText,
          item,
        })),
        testMode: false,
        testPhone: null,
        paymentRetry: true,
        sendingProvider: 'kapso',
        sendingChannelId: null,
        sendingLabel: 'Kapso · API oficial',
        sourceCampaignId: campaign.id,
        createdAt: Date.now(),
      });
      setHistoryOpen(false);
      const excluded = data.excluded?.length || 0;
      showToast(`${retryItems.length} fallido${retryItems.length === 1 ? '' : 's'} por pago preparados con su mensaje original${excluded ? ` · ${excluded} requieren revisión manual` : ''}.`);
    } catch (error) {
      showToast(error.response?.data?.error || error.message || 'No se pudo preparar el reintento', 'error');
    } finally {
      setFollowUpBusy(false);
    }
  }

  async function previewFollowUp(campaignId) {
    setFollowUpBusy(true);
    try {
      const { data } = await api.get(`/reengagement/campaigns/${campaignId}/follow-up-preview`);
      setFollowUpPreview({ campaignId, ...data });
    } catch (error) {
      showToast(error.response?.data?.error || 'No se pudo evaluar el seguimiento', 'error');
    } finally { setFollowUpBusy(false); }
  }

  async function scheduleFollowUp(campaign) {
    setFollowUpBusy(true);
    try {
      const { data } = await api.post(`/reengagement/campaigns/${campaign.id}/follow-up`, {
        templateName: campaign.template_name,
        languageCode: 'es',
      });
      const when = new Date(data.job.scheduled_for).toLocaleString('es-CL', { dateStyle: 'short', timeStyle: 'short' });
      showToast(`Seguimiento programado para ${data.eligible} personas · ${when}`);
      setFollowUpPreview(previous => previous ? { ...previous, scheduled: true, job: data.job } : previous);
    } catch (error) {
      showToast(error.response?.data?.error || 'No se pudo programar el seguimiento', 'error');
    } finally { setFollowUpBusy(false); }
  }

  // Cargar contactos y templates en paralelo
  useEffect(() => {
    // Dedup + backfill + normalizar nombres, luego cargar la lista
    api.post('/contacts/dedup-phones').catch(() => {});
    api.post('/contacts/backfill-shopify').catch(() => {});
    api.post('/contacts/normalize-names')
      .catch(() => {})
      .finally(() => {
        api.get('/contacts/broadcast')
          .then(res => {
            const list = res.data.contacts || [];
            setContacts(list);
            setSources(res.data.sources || null);
            setSelected(new Set(list.map(c => c.phone)));
          })
          .catch(() => setContacts([]))
          .finally(() => setLoading(false));
      });

    // Solo cargar templates si el padre no los pasó
    if (parentTemplates.length === 0) {
      // Intentar /reengagement/templates primero; si falla o devuelve vacío, usar /api/templates
      const loadTpls = () =>
        api.get('/reengagement/templates')
          .then(r => {
            const tpls = r.data.data || r.data.templates || [];
            if (tpls.length > 0) return tpls;
            // fallback: traer todos los templates y filtrar APPROVED
            return api.get('/api/templates').then(r2 =>
              (r2.data.data || []).filter(t => !t.status || t.status === 'APPROVED' || t.status === 'approved')
            ).catch(() => []);
          })
          .catch(() =>
            // fallback directo si el primer endpoint falla
            api.get('/api/templates').then(r2 =>
              (r2.data.data || []).filter(t => !t.status || t.status === 'APPROVED' || t.status === 'approved')
            ).catch(() => [])
          );

      loadTpls().then(tpls => {
        setTemplates(tpls);
        if (tpls.length > 0) setSelTpl(tpls[0]);
      }).finally(() => setTplLoading(false));
    }
    // si ya vienen del padre, tplLoading ya es false
  }, []);

  // Producto favorito por cliente (para rellenar variables de template)
  useEffect(() => {
    api.get('/contacts/favorite-products').then(r => setFavMap(r.data?.favorites || {})).catch(() => {});
  }, []);

  const tplBody = getBodyComponent(selTpl);
  const tplVars = getTemplateVariables(tplBody?.text || '');
  const tplVarCount = tplVars.length;

  // Al cambiar de template, resetear el mapeo de variables (1=Nombre, resto=Producto favorito)
  useEffect(() => {
    setVarMap(Array.from({ length: tplVarCount }, (_, i) => (i === 0 ? 'name' : 'fav')));
    setVarText(Array.from({ length: tplVarCount }, () => ''));
    setVarPrefix(Array.from({ length: tplVarCount }, () => ''));
    setVarSuffix(Array.from({ length: tplVarCount }, () => ''));
    setVarFallback(Array.from({ length: tplVarCount }, () => ''));
    setReviewPlan(null);
    setGuidedReview(false);
    setReviewedItems(new Set());
  }, [selTpl?.name, tplVarCount]);

  function favProduct(phone) { return favMap[normPhone(phone)] || ''; }
  function defaultFallback(mode) {
    if (mode === 'name' || mode === 'full_name') return 'Cliente';
    if (mode === 'fav') return 'tu producto habitual';
    if (mode === 'since_order') return 'un tiempo';
    if (mode === 'last_order_date') return 'hace un tiempo';
    if (mode === 'orders_count') return '0';
    if (mode === 'delivery_reason') return 'no pudimos completar la entrega';
    if (mode === 'delivery_order') return 'tu pedido';
    return '';
  }
  function varValue(i, contact) {
    const mode = varMap[i] || (i === 0 ? 'name' : 'fav');
    let v;
    if (mode === 'name') v = toTitleCase((contact?.name || 'Cliente').split(' ')[0]);
    else if (mode === 'full_name') v = toTitleCase(contact?.name || 'Cliente');
    else if (mode === 'fav') v = favProduct(contact?.phone);
    else if (mode === 'since_order') v = formatDaysSince(contact?.last_order_at);
    else if (mode === 'last_order_date') v = formatOrderDate(contact?.last_order_at);
    else if (mode === 'orders_count') v = contact?.total_orders ?? '';
    else if (mode === 'city') v = contact?.city || '';
    else if (mode === 'phone') v = contact?.phone || '';
    else if (mode === 'delivery_reason') v = deliveryCases.get(normPhone(contact?.phone))?.reason || '';
    else if (mode === 'delivery_order') v = deliveryCases.get(normPhone(contact?.phone))?.orderLabels?.join(', ') || '';
    else if (mode === 'text') v = varText[i] || '';
    else v = '';
    v = String(v ?? '').trim();
    if (!v && mode !== 'text') v = String(varFallback[i] || defaultFallback(mode)).trim();
    if (!v) return '';
    return `${varPrefix[i] || ''}${v}${varSuffix[i] || ''}`;
  }

  function updateFixedText(index, value) {
    setVarText(current => {
      const next = [...current];
      while (next.length < tplVarCount) next.push('');
      next[index] = value;
      return next;
    });
  }

  const purchaseDays = purchaseAge === 'custom' ? customPurchaseDays : purchaseAge;
  const filtered = contacts.filter(c => {
    if (search) {
      const q = search.toLowerCase();
      if (!(c.name || '').toLowerCase().includes(q) && !(c.phone || '').includes(q)) return false;
    }
    if (!matchesPurchaseAge(c, purchaseDays)) return false;
    if (excludeEmpresas && c.client_type === 'empresa') return false;
    if (prodPhones && !prodPhones.has(normPhone(c.phone))) return false;
    if (deliveryPhones && !deliveryPhones.has(normPhone(c.phone))) return false;
    return true;
  });

  const audience = selectedAudience(filtered, selected);
  const selectedCount = audience.length;

  function toggleAll() {
    if (selectedCount === filtered.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filtered.map(c => c.phone)));
    }
  }

  function toggleOne(phone) {
    setSelected(prev => {
      const n = new Set(prev);
      n.has(phone) ? n.delete(phone) : n.add(phone);
      return n;
    });
  }

  // Normaliza el teléfono igual que el backend (569XXXXXXXX) para poder cruzar.
  function normPhone(p) {
    const n = String(p || '').replace(/\D/g, '');
    if (/^9\d{8}$/.test(n)) return '56' + n;
    return n;
  }

  // Aplica/limpia el filtro por producto (ej: "jumbo"). Trae del backend los
  // teléfonos que compraron ese producto y deja seleccionados solo esos.
  async function applyProduct() {
    const term = prodTerm.trim();
    if (!term) { setProdPhones(null); return; }
    setProdBusy(true);
    try {
      const { data } = await api.get(`/contacts/by-product?q=${encodeURIComponent(term)}`);
      const set = new Set((data.phones || []).map(normPhone));
      setProdPhones(set);
      // Auto-seleccionar los contactos que quedan tras el filtro
      setSelected(new Set(contacts.filter(c => set.has(normPhone(c.phone))).map(c => c.phone)));
      if (!data.historyComplete) {
        const since = data.orderCoverage?.oldestOrderAt
          ? ` desde ${new Date(data.orderCoverage.oldestOrderAt).toLocaleDateString('es-CL')}`
          : '';
        showToast(`${set.size} coincidencias en el historial disponible${since}. Falta habilitar el historial completo de Shopify.`, 'error');
      } else {
        showToast(`${set.size} cliente(s) compraron "${term}"`);
      }
    } catch (e) {
      showToast('No se pudo filtrar por producto: ' + (e.response?.data?.error || e.message), 'error');
    } finally { setProdBusy(false); }
  }
  function clearProduct() { setProdTerm(''); setProdPhones(null); }

  async function toggleDeliveryAudience() {
    if (deliveryPhones) {
      setDeliveryPhones(null);
      setDeliveryCases(new Map());
      setSelected(new Set(contacts.map(contact => contact.phone)));
      return;
    }
    setDeliveryBusy(true);
    try {
      const { data } = await api.get('/contacts/delivery-audience?scope=yesterday');
      const grouped = new Map();
      for (const incident of data.incidents || []) {
        const phone = normPhone(incident.phone);
        if (!phone) continue;
        const current = grouped.get(phone) || { reason: incident.reason, orderLabels: [], incidents: [] };
        if (incident.order_label && !current.orderLabels.includes(incident.order_label)) current.orderLabels.push(incident.order_label);
        current.incidents.push(incident);
        grouped.set(phone, current);
      }
      const phones = new Set(grouped.keys());
      setDeliveryCases(grouped);
      setDeliveryPhones(phones);
      setSelected(new Set(contacts.filter(contact => phones.has(normPhone(contact.phone))).map(contact => contact.phone)));
      showToast(phones.size
        ? `${phones.size} cliente${phones.size === 1 ? '' : 's'} con entrega no completada ayer`
        : 'No hay entregas pendientes de ayer');
    } catch (error) {
      showToast(error.response?.data?.error || 'No se pudo cargar la lista de entregas pendientes', 'error');
    } finally {
      setDeliveryBusy(false);
    }
  }

  function prepareReview() {
    if (!selectedMethod?.available) { showToast('Selecciona un método de envío conectado', 'error'); return; }
    if (!selTpl) { showToast('Selecciona un template primero', 'error'); return; }
    if (selectedCount === 0) { showToast('Selecciona al menos un contacto', 'error'); return; }
    if (testMode && !TEST_PHONE) { showToast('Ingresa un número de prueba antes de enviar', 'error'); return; }

    const bodyComp = getBodyComponent(selTpl);
    const variableNumbers = getTemplateVariables(bodyComp?.text || '');

    // El modo prueba valida UN mensaje. Antes se conservaba toda la audiencia
    // seleccionada y cada variante se redirigía al mismo teléfono de prueba,
    // provocando cientos de copias y una pantalla cargando durante minutos.
    const selectedPhones = audience.map(contact => contact.phone);
    const phonesToPrepare = testMode ? selectedPhones.slice(0, 1) : selectedPhones;
    const entries = phonesToPrepare.map(phone => {
      const contact = contacts.find(c => c.phone === phone);
      const nombre = toTitleCase((contact?.name || 'Cliente').split(' ')[0]); // primer nombre, formateado

      const values = Object.fromEntries(variableNumbers.map((number, index) => [number, varValue(index, contact)]));
      const components = buildBodyTemplateComponent(bodyComp?.text || '', values);
      const previewText = bodyComp?.text ? renderTemplate(bodyComp.text, values) : null;

      return {
        contact,
        values,
        previewText,
        item: {
          phone: testMode && TEST_PHONE ? TEST_PHONE : phone,
          originalPhone: phone,
          templateName: selTpl.name,
          languageCode: selTpl.language || 'es',
          components,
          contactName: nombre,
          previewText,
          ...((testMode && TEST_PHONE) || paymentRetryPhones.has(normPhone(phone)) ? { force: true } : {}),
        },
      };
    });

    const missing = entries.flatMap(entry => variableNumbers
      .filter(number => !String(entry.values[number] || '').trim())
      .map(number => `${toTitleCase(entry.contact?.name) || entry.contact?.phone}: {{${number}}}`));
    if (missing.length) {
      showToast(`Completa las variables vacías antes de revisar (${missing.slice(0, 3).join(', ')})`, 'error');
      return;
    }

    setReviewIdx(0);
    setGuidedReview(false);
    setReviewedItems(new Set());
    setReviewPlan({
      templateName: selTpl.name,
      entries,
      sendingProvider: selectedMethod.provider,
      sendingChannelId: selectedMethod.channelId,
      sendingLabel: selectedMethod.label,
      audienceLabel: purchaseAge === 'all' ? 'Todos los contactos filtrados' : `Último pedido hace más de ${purchaseDays} días`,
      intervalSeconds: selectedMethod.intervalSeconds,
      batchSize: selectedMethod.batchSize,
      batchPauseSeconds: selectedMethod.batchPauseSeconds,
      testMode,
      testPhone: TEST_PHONE,
      createdAt: Date.now(),
    });
  }

  function startGuidedReview() {
    setGuidedReview(true);
    setReviewIdx(0);
    setReviewedItems(new Set());
  }

  function markReviewedAndContinue() {
    if (!reviewPlan?.entries?.length) return;
    setReviewedItems(previous => {
      const next = new Set(previous);
      next.add(reviewIdx);
      return next;
    });
    if (reviewIdx < reviewPlan.entries.length - 1) setReviewIdx(reviewIdx + 1);
  }

  async function confirmSend() {
    if (!reviewPlan?.entries?.length || sendingRef.current) return;
    sendingRef.current = true;
    stopSendingRef.current = false;
    const direct = reviewPlan.sendingProvider === 'evolution';
    const items = reviewPlan.entries.map(entry => entry.item);
    let campaignId = null;
    let campaignStatus = 'completed';
    setSending(true);
    setResults(null);
    try {
      const created = await api.post('/reengagement/campaigns', {
        templateName: reviewPlan.templateName,
        total: items.length,
        testMode: reviewPlan.testMode,
        testPhone: reviewPlan.testPhone || null,
        sendingProvider: reviewPlan.sendingProvider,
        sendingChannelId: reviewPlan.sendingChannelId,
      });
      campaignId = created.data.campaign.id;
      let sent = 0, failed = 0, skipped = 0, pending = 0;
      const failureReasons = [];
      setSendProgress({ done: 0, total: items.length });
      // Tanto la prueba como el envío real usan la ruta individual que ya
      // confirma correctamente con Meta. En campañas se ejecutan varios
      // destinatarios en paralelo, cada uno con auditoría independiente.
      const concurrency = direct || reviewPlan.testMode ? 1 : Math.min(6, items.length);
      let nextIndex = 0;
      let completed = 0;
      let stopRequested = false;
      let paymentBlocked = false;
      const workers = Array.from({ length: concurrency }, async () => {
        while (true) {
          if (stopRequested || stopSendingRef.current) return;
          const index = nextIndex++;
          if (index >= items.length) return;
          const item = items[index];
          let processed = false;
          try {
            let res;
            while (!stopSendingRef.current) {
              try {
                res = await api.post('/reengagement/send-bulk', { items: [item], campaignId }, { timeout: 45000 });
                break;
              } catch (error) {
                if (direct && error.response?.status === 429 && error.response?.data?.rateLimited) {
                  await waitForNextSend(error.response.data.retryAfterSeconds || 60);
                } else throw error;
              }
            }
            if (!res) return;
            processed = true;
            const result = (res.data.results || [])[0];
            if (direct && !result?.success && !result?.skipped) {
              stopRequested = true;
              campaignStatus = 'interrupted';
            }
            if (res.data.campaignPaused || result?.campaignPaused) {
              stopRequested = true;
              paymentBlocked = true;
              campaignStatus = 'paused_payment';
            }
            if (result?.success) sent++;
            else if (result?.skipped) skipped++;
            else if (result?.pending) pending++;
            else failed++;
            if (result && !result.success) {
              const reason = result.error || (result.skipped ? 'Envío omitido' : 'WhatsApp rechazó el mensaje');
              if (!failureReasons.includes(reason)) failureReasons.push(reason);
            }
          } catch (error) {
            processed = true;
            if (direct) stopRequested = true;
            const pausedByPayment = error.response?.data?.campaignPaused
              || String(error.response?.data?.errorCode || '') === '131042';
            if (pausedByPayment) {
              stopRequested = true;
              paymentBlocked = true;
              campaignStatus = 'paused_payment';
            } else {
              campaignStatus = 'interrupted';
            }
            const timedOut = error.code === 'ECONNABORTED';
            if (timedOut) pending++;
            else if (!pausedByPayment) failed++;
            const reason = error.response?.data?.error || (timedOut
              ? 'La confirmación demoró demasiado. No reenvíes: el historial verificará el resultado.'
              : error.message || 'No se pudo procesar este destinatario');
            if (!failureReasons.includes(reason)) failureReasons.push(reason);
          } finally {
            if (processed) completed++;
            setSendProgress({ done: completed, total: items.length });
          }
          // Da tiempo a que llegue el webhook de Meta antes de tomar el
          // siguiente destinatario. Así un fallo de pago detiene el lote con
          // un máximo aproximado equivalente a los envíos ya simultáneos.
          if (!stopRequested && index < items.length - 1) {
            if (direct) await waitForNextSend(completed % reviewPlan.batchSize === 0 ? reviewPlan.batchPauseSeconds : reviewPlan.intervalSeconds);
            else await new Promise(resolve => setTimeout(resolve, 800));
          }
        }
      });
      await Promise.all(workers);
      const stopped = Math.max(items.length - completed, 0);
      if (stopSendingRef.current) campaignStatus = 'interrupted';
      setResults({ sent, failed, skipped, pending, stopped, paymentBlocked, reasons: failureReasons });
      if (paymentBlocked) {
        showToast(`🛑 Campaña detenida por pago de Meta. ${completed} procesados · ${stopped} no se enviaron.`, 'error');
        setReviewPlan(null);
      } else if (pending > 0) {
        campaignStatus = 'interrupted';
        showToast(`⏳ ${pending} mensaje${pending === 1 ? '' : 's'} por confirmar. No reenvíes; revisaremos el estado automáticamente.`);
        setReviewPlan(null);
      } else if (sent === 0) {
        campaignStatus = 'interrupted';
        showToast(`No se envió ningún mensaje: ${failureReasons[0] || 'WhatsApp no confirmó el envío'}`, 'error');
      } else {
        showToast(`✅ ${sent} aceptados por WhatsApp${skipped ? ` · ${skipped} omitidos` : ''}${failed ? ` · ${failed} fallidos` : ''}`);
        setPaymentRetryPhones(new Set());
        setReviewPlan(null);
      }
    } catch (err) {
      campaignStatus = 'interrupted';
      const reason = err.response?.data?.error || err.message || 'No se pudo confirmar el envío con WhatsApp';
      setResults({
        sent: 0,
        failed: err.deliveryUnconfirmed ? 0 : 1,
        skipped: 0,
        pending: err.deliveryUnconfirmed ? (err.pendingCount || 1) : 0,
        reasons: [reason],
      });
      showToast('Error: ' + reason, 'error');
    } finally {
      // Liberar la interfaz inmediatamente. El cierre auditable y la recarga
      // del historial pueden continuar sin dejar el botón girando.
      setSending(false);
      sendingRef.current = false;
      setSendProgress({ done: 0, total: 0 });
      if (campaignId) {
        await api.post(`/reengagement/campaigns/${campaignId}/finish`, { status: campaignStatus }).catch(() => {});
      }
      await loadCampaigns();
    }
  }

  const allChecked  = filtered.length > 0 && filtered.every(c => selected.has(c.phone));
  const someChecked = filtered.some(c => selected.has(c.phone));

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

      {/* Toast */}
      {toast && (
        <div style={{
          position: 'fixed', top: '70px', right: '20px', zIndex: 9999,
          backgroundColor: toast.type === 'error' ? colors.dangerSoft : colors.success,
          color: '#fff', padding: '10px 18px', borderRadius: '10px',
          fontSize: '13px', fontWeight: 600, boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
        }}>{toast.msg}</div>
      )}

      {/* Toolbar */}
      <section aria-label="Método de envío" style={{ flexShrink: 0, padding: '12px 20px', color: colors.textPrimary,
        backgroundColor: colors.bgPanel, borderBottom: `2px solid ${colors.green}`, display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
        <div style={{ minWidth: 145 }}>
          <div style={{ fontWeight: 800, fontSize: 14 }}>¿Cómo quieres enviar?</div>
          <div style={{ fontSize: 11, color: colors.textMuted, marginTop: 4 }}>Elige el método de esta campaña</div>
        </div>
        <div role="group" aria-label="Elegir Kapso o Evolution" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {(sendingMethods.length ? [
            ...sendingMethods,
            ...(!sendingMethods.some(method => method.provider === 'evolution')
              ? [{ provider: 'evolution', channelId: null, label: 'Directo · Evolution', available: false }] : []),
          ] : [
            { provider: 'kapso', label: 'Kapso · API oficial', available: false },
            { provider: 'evolution', label: 'Directo · Evolution', available: false },
          ]).map(method => {
            const methodKey = method.provider === 'evolution' ? `evolution:${method.channelId}` : 'kapso';
            const isSelected = sendingMethodKey === methodKey && method.available;
            return <button key={methodKey} type="button" aria-pressed={isSelected}
              disabled={!method.available || methodsLoading || sending || !!reviewPlan}
              onClick={() => setSendingMethodKey(methodKey)}
              style={{ minWidth: 205, textAlign: 'left', padding: '10px 14px', borderRadius: 8,
                border: `2px solid ${isSelected ? colors.green : colors.border}`,
                backgroundColor: isSelected ? `${colors.green}22` : colors.bgCard, color: colors.textPrimary,
                cursor: method.available && !sending && !reviewPlan ? 'pointer' : 'default' }}>
              <div style={{ fontSize: 13, fontWeight: 800 }}>{isSelected ? '✓ ' : ''}{method.label}</div>
              <div style={{ fontSize: 11, marginTop: 4, color: colors.textSecondary }}>
                {methodsLoading ? 'Consultando conexión…' : !method.available
                  ? (methodsError ? 'Conexión sin verificar' : 'No conectado · revisar Ajustes')
                  : method.provider === 'evolution' ? 'Lotes de 10 · pausas automáticas' : 'Plantillas de WhatsApp'}
              </div>
            </button>;
          })}
        </div>
        {!sending && !reviewPlan && <button type="button" onClick={loadSendingMethods} disabled={methodsLoading}
          style={{ background: 'transparent', border: `1px solid ${colors.border}`, color: colors.textSecondary, borderRadius: 6, padding: '7px 10px', cursor: 'pointer' }}>
          {methodsLoading ? 'Cargando…' : 'Actualizar conexiones'}
        </button>}
        {methodsError && <div role="alert" style={{ width: '100%', color: colors.red, fontSize: 12 }}>{methodsError}</div>}
        {reviewPlan && <div style={{ width: '100%', fontSize: 12 }}>Cierra la revisión para cambiar el método de envío.</div>}
        {selectedMethod?.provider === 'evolution' && <div style={{ fontSize: 12, marginTop: 6 }}>
          Lotes de 10 · 1 mensaje por minuto · pausa de 5 minutos entre lotes, luego continúa automáticamente.
          Se envía sólo el texto revisado, sin botones ni archivos. Mantén esta pantalla abierta durante el envío.
        </div>}
      </section>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '12px 20px', borderBottom: `1px solid ${colors.border}`, backgroundColor: colors.bgPanel, flexWrap: 'wrap' }}>

        {/* Search */}
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Buscar por nombre o teléfono..."
          style={{ flex: 1, minWidth: '180px', padding: '7px 12px', borderRadius: colors.radiusMd, border: `1px solid ${colors.border}`, backgroundColor: colors.bgCard, color: colors.textPrimary, fontSize: '13px', outline: 'none' }}
        />

        {/* Filtro por producto (ej: jumbo) */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', flexShrink: 0 }}>
          <input
            value={prodTerm}
            onChange={e => setProdTerm(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') applyProduct(); }}
            placeholder="Producto (ej: jumbo)"
            style={{ width: '150px', padding: '7px 12px', borderRadius: colors.radiusMd, border: `1px solid ${prodPhones ? colors.green + '66' : colors.border}`, backgroundColor: colors.bgCard, color: colors.textPrimary, fontSize: '13px', outline: 'none' }}
          />
          <button onClick={applyProduct} disabled={prodBusy}
            style={{ padding: '6px 11px', borderRadius: '7px', fontSize: '12px', fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
              border: `1px solid ${colors.green}66`, backgroundColor: colors.green + '22', color: colors.green, opacity: prodBusy ? 0.6 : 1 }}>
            {prodBusy ? '…' : 'Filtrar'}
          </button>
          {prodPhones && (
            <button onClick={clearProduct}
              style={{ padding: '6px 9px', borderRadius: '7px', fontSize: '12px', fontWeight: 600, cursor: 'pointer',
                border: `1px solid ${colors.border}`, backgroundColor: 'transparent', color: colors.textMuted }}>
              ✕
            </button>
          )}
        </div>

        <label style={{ fontSize: 12, color: colors.textSecondary, display: 'flex', alignItems: 'center', gap: 6 }}>
          Último pedido
          <select aria-label="Tiempo sin pedir" value={purchaseAge} disabled={sending || !!reviewPlan}
            onChange={e => { setPurchaseAge(e.target.value); setPreviewIdx(0); }}
            style={{ padding: '7px 10px', borderRadius: 7, backgroundColor: colors.bgCard, color: colors.textPrimary, border: `1px solid ${colors.border}` }}>
            <option value="all">Cualquier fecha</option>
            {[7, 15, 30, 60, 90].map(days => <option key={days} value={String(days)}>Hace más de {days} días</option>)}
            <option value="custom">Otra cantidad de días</option>
          </select>
          {purchaseAge === 'custom' && <input aria-label="Días sin pedir" type="number" min="1" max="3650" step="1"
            value={customPurchaseDays} disabled={sending || !!reviewPlan} onChange={e => setCustomPurchaseDays(e.target.value)}
            style={{ width: 65, padding: 7, backgroundColor: colors.bgCard, color: colors.textPrimary, border: `1px solid ${colors.border}`, borderRadius: 7 }} />}
        </label>
        {purchaseAge !== 'all' && <span style={{ fontSize: 11, color: colors.textMuted }}>
          Sólo clientes con fecha de pedido registrada. Se envía únicamente a los seleccionados de este grupo.
        </span>}

        <button onClick={toggleDeliveryAudience} disabled={deliveryBusy}
          title="Pedidos que salieron a ruta ayer y no quedaron entregados"
          style={{
            padding:'6px 11px', borderRadius:'7px', fontSize:'12px', fontWeight:700,
            cursor:deliveryBusy ? 'wait' : 'pointer', whiteSpace:'nowrap', flexShrink:0,
            border:`1px solid ${deliveryPhones ? '#fb923c' : colors.border}`,
            backgroundColor:deliveryPhones ? '#fb923c22' : 'transparent',
            color:deliveryPhones ? '#fb923c' : colors.textMuted,
          }}>
          {deliveryBusy ? 'Revisando ruta…' : `${deliveryPhones ? '✓ ' : ''}No entregados ayer${deliveryPhones ? ` (${deliveryPhones.size})` : ''}`}
        </button>

        {/* Filtro: excluir empresas */}
        <button
          onClick={() => {
            const next = !excludeEmpresas;
            setExcludeEmpresas(next);
            if (next) {
              setSelected(prev => {
                const n = new Set();
                contacts.forEach(c => {
                  if (!prev.has(c.phone)) return;
                  if (c.client_type === 'empresa') return;
                  n.add(c.phone);
                });
                return n;
              });
            }
          }}
          style={{
            padding: '6px 11px', borderRadius: '7px', fontSize: '12px', fontWeight: 600,
            cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0,
            border: `1px solid ${excludeEmpresas ? colors.yellow + '66' : colors.border}`,
            backgroundColor: excludeEmpresas ? colors.yellow + '22' : 'transparent',
            color: excludeEmpresas ? colors.yellow : colors.textMuted,
          }}
        >
          {excludeEmpresas ? '✓ ' : ''}Sin empresas
        </button>

        {/* Template selector */}
        {tplLoading ? (
          <span style={{ color: colors.textMuted, fontSize: '13px' }}>Cargando templates...</span>
        ) : templates.length === 0 ? (
          <span style={{ color: colors.red, fontSize: '13px' }}>Sin templates aprobados</span>
        ) : (
          <select
            value={selTpl?.name || ''}
            onChange={e => setSelTpl(templates.find(t => t.name === e.target.value) || null)}
            style={{ padding: '7px 10px', borderRadius: colors.radiusMd, border: `1px solid ${colors.border}`, backgroundColor: colors.bgCard, color: colors.textPrimary, fontSize: '13px', cursor: 'pointer' }}>
            {templates.map(t => (
              <option key={t.name} value={t.name}>{t.name}</option>
            ))}
          </select>
        )}

        <button
          onClick={() => {
            setHistoryOpen(true);
            loadCampaigns();
          }}
          style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px',
            borderRadius: 7, border: `1px solid ${colors.border}`,
            backgroundColor: colors.bgCard, color: colors.textSecondary,
            fontSize: 12, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap',
          }}
          title="Ver campañas anteriores y el estado de cada envío"
        >
          <History size={14} />
          Historial
          {campaigns.length > 0 && (
            <span style={{ minWidth: 18, height: 18, padding: '0 5px', borderRadius: 9, backgroundColor: `${colors.blue}22`, color: colors.blue, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 800 }}>
              {campaigns.length}
            </span>
          )}
        </button>

        {/* Test mode */}
        <button onClick={() => setTestMode(t => !t)} style={{
          padding: '6px 10px', borderRadius: '7px', border: `1px solid ${testMode ? colors.yellow + '66' : colors.border}`,
          backgroundColor: testMode ? colors.yellow + '22' : 'transparent',
          color: testMode ? colors.yellow : colors.textMuted,
          fontSize: '12px', fontWeight: 600, cursor: 'pointer',
        }}>
          🧪 Prueba
        </button>

        {/* Enviar */}
        <button onClick={prepareReview} disabled={sending || selectedCount === 0 || !selTpl} style={{
          display: 'flex', alignItems: 'center', gap: '6px',
          padding: '7px 16px', borderRadius: colors.radiusMd, border: 'none',
          backgroundColor: (selectedCount > 0 && selTpl) ? colors.green : colors.bgHover,
          color: (selectedCount > 0 && selTpl) ? '#fff' : colors.textMuted,
          fontSize: '13px', fontWeight: 700, cursor: (sending || selectedCount === 0 || !selTpl) ? 'not-allowed' : 'pointer',
          opacity: sending ? 0.7 : 1,
        }}>
          <Send size={14} />
          {sending ? (sendProgress.total ? `Enviando ${sendProgress.done}/${sendProgress.total}…` : 'Enviando…') : (testMode ? 'Revisar 1 mensaje de prueba' : `Revisar envío a ${selectedCount}`)}
        </button>
      </div>

      {/* Test mode banner */}
      {testMode && (
        <div style={{ backgroundColor: `${colors.yellow}18`, borderBottom: `1px solid ${colors.yellow}44`, padding: '8px 20px', display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '12px', color: colors.yellow, fontWeight: 600, flexShrink: 0 }}>🧪 Número de prueba:</span>
          <input
            value={testPhoneInput}
            onChange={e => setTestPhoneInput(e.target.value)}
            placeholder="+56912345678"
            style={{ padding: '4px 10px', borderRadius: colors.radiusSm, border: `1px solid ${colors.yellow}66`, backgroundColor: colors.bgCard, color: colors.textPrimary, fontSize: '12px', width: '160px', outline: 'none' }}
          />
          {TEST_PHONE
            ? <span style={{ fontSize: '12px', color: colors.yellow }}>Se enviará una sola muestra a <strong>{TEST_PHONE}</strong></span>
            : <span style={{ fontSize: '12px', color: colors.red, fontWeight: 600 }}>⚠️ Ingresa un número para activar el modo prueba</span>
          }
        </div>
      )}

      {/* Resultado */}
      {results && (
        <div style={{ padding: '10px 20px', backgroundColor: results.paymentBlocked ? `${colors.red}18` : (results.sent ? `${colors.green}18` : `${colors.red}14`), borderBottom: `1px solid ${results.paymentBlocked ? colors.red : (results.sent ? colors.green : colors.red)}33`, display: 'flex', gap: '16px', alignItems: 'center', flexWrap: 'wrap' }}>
          {results.paymentBlocked && <span style={{ color: colors.red, fontWeight: 850, fontSize: '13px' }}>🛑 Campaña detenida por pago de Meta</span>}
          <span style={{ color: results.sent ? colors.green : colors.red, fontWeight: 700, fontSize: '13px' }}>{results.sent ? '↗' : '⚠️'} {results.sent} recibidos inicialmente por Meta</span>
          {results.failed > 0 && <span style={{ color: colors.red, fontWeight: 600, fontSize: '13px' }}>❌ {results.failed} fallidos</span>}
          {results.skipped > 0 && <span style={{ color: colors.yellow, fontWeight: 600, fontSize: '13px' }}>⏭ {results.skipped} omitidos</span>}
          {results.pending > 0 && <span style={{ color: colors.yellow, fontWeight: 700, fontSize: '13px' }}>⏳ {results.pending} por confirmar</span>}
          {results.stopped > 0 && <span style={{ color: colors.textPrimary, fontWeight: 750, fontSize: '13px' }}>✓ {results.stopped} detenidos antes de enviar</span>}
          {results.reasons?.length > 0 && <span style={{ color: colors.textSecondary, fontSize: '12px' }}>{results.reasons.join(' · ')}</span>}
        </div>
      )}

      {/* Variables, vista previa y destinatarios comparten un único scroll. */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', overscrollBehavior: 'contain', scrollbarGutter: 'stable' }}>
      {/* El historial vive en un panel independiente para no desplazar el flujo de envío. */}
      {historyOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Historial de envíos"
          onMouseDown={event => { if (event.target === event.currentTarget) setHistoryOpen(false); }}
          style={{ position: 'fixed', inset: 0, zIndex: 10000, backgroundColor: 'rgba(3, 10, 15, 0.7)', display: 'flex', justifyContent: 'flex-end', backdropFilter: 'blur(2px)' }}
        >
          <aside style={{ width: 'min(720px, 100vw)', height: '100dvh', backgroundColor: colors.bgPanel, borderLeft: `1px solid ${colors.border}`, boxShadow: '-18px 0 55px rgba(0,0,0,0.38)', display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '18px 20px', borderBottom: `1px solid ${colors.border}`, display: 'flex', alignItems: 'center', gap: 12, backgroundColor: colors.bgPanel }}>
              <div style={{ width: 38, height: 38, borderRadius: 10, backgroundColor: `${colors.blue}18`, color: colors.blue, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <History size={19} />
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ color: colors.textPrimary, fontSize: 16, fontWeight: 850 }}>Historial de envíos</div>
                <div style={{ color: colors.textMuted, fontSize: 11, marginTop: 3 }}>Consulta el avance, los errores y los destinatarios de cada campaña.</div>
              </div>
              <button onClick={loadCampaigns} disabled={campaignsLoading} style={{ border: `1px solid ${colors.border}`, borderRadius: 8, backgroundColor: colors.bgCard, color: colors.textSecondary, padding: '7px 10px', cursor: campaignsLoading ? 'wait' : 'pointer', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 700 }}>
                <RefreshCw size={13} className={campaignsLoading ? 'spin' : ''} /> <span className="hide-mobile">Actualizar</span>
              </button>
              <button onClick={() => setHistoryOpen(false)} aria-label="Cerrar historial" style={{ width: 34, height: 34, border: `1px solid ${colors.border}`, borderRadius: 8, backgroundColor: 'transparent', color: colors.textSecondary, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <X size={17} />
              </button>
            </div>
            <div style={{ padding: '14px 20px', borderBottom: `1px solid ${colors.border}`, backgroundColor: colors.bgApp, color: colors.textSecondary, fontSize: 11, lineHeight: 1.45 }}>
              <strong style={{ color: colors.textPrimary }}>Cómo leer los estados:</strong> “Aceptado” sólo confirma que Meta recibió la solicitud; aún puede cambiar a entregado, leído o fallido.
            </div>
            <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '14px 20px 24px', backgroundColor: colors.bgApp }}>
        {!campaignsLoading && campaigns.length === 0 && (
          <div style={{ color: colors.textMuted, fontSize: 12, padding: '36px 20px', textAlign: 'center', border: `1px dashed ${colors.border}`, borderRadius: 10 }}>Las próximas campañas quedarán registradas aquí con su resultado completo.</div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {campaigns.map(campaign => {
            const accepted = Number(campaign.accepted_count || 0);
            const delivered = Number(campaign.delivered_count || 0);
            const read = Number(campaign.read_count || 0);
            const failed = Number(campaign.failed_count || 0);
            const skipped = Number(campaign.skipped_count || 0);
            const pending = Number(campaign.pending_count || 0);
            const uncertain = Number(campaign.unknown_count || 0);
            const isOpen = String(expandedCampaign) === String(campaign.id);
            return (
              <div key={campaign.id} style={{ border: `1px solid ${(failed || campaign.status === 'paused_payment') ? colors.red + '55' : colors.border}`, borderRadius: 9, backgroundColor: colors.bgCard, overflow: 'hidden' }}>
                <button onClick={() => toggleCampaignDetails(campaign)} style={{ width: '100%', border: 'none', background: 'transparent', color: colors.textPrimary, padding: '10px 12px', cursor: 'pointer', textAlign: 'left' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 8 }}>
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 800 }}>{campaign.template_name}{campaign.test_mode ? ' · 🧪 Prueba' : ''} · {campaign.sending_provider === 'evolution' ? 'Directo · Evolution' : 'Kapso'}</div>
                      <div style={{ color: colors.textMuted, fontSize: 10, marginTop: 3 }}>{new Date(campaign.created_at).toLocaleString('es-CL')} · {campaign.total_count} seleccionados</div>
                      {campaign.status === 'paused_payment' && <div style={{ color: colors.red, fontSize: 10, fontWeight: 850, marginTop: 4 }}>🛑 Detenida automáticamente por pago de Meta · código {campaign.pause_code || '131042'}</div>}
                      {String(statusCheckCampaign) === String(campaign.id) && <div style={{ color: colors.blue, fontSize: 10, fontWeight: 750, marginTop: 4 }}>↻ Verificando cada envío con Meta…</div>}
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, fontSize: 11, fontWeight: 700 }}>
                      {read > 0 && <span style={{ color: colors.green }}>👁 {read} leídos</span>}
                      {delivered > 0 && <span style={{ color: colors.green }}>✓ {delivered} entregados</span>}
                      {accepted > 0 && <span style={{ color: colors.blue }}>↗ {accepted} aceptados</span>}
                      {uncertain > 0 && <span style={{ color: colors.yellow }}>⏳ {uncertain} por confirmar</span>}
                      {pending > 0 && <span style={{ color: colors.yellow }}>◷ {pending} sin procesar</span>}
                      {skipped > 0 && <span style={{ color: colors.textMuted }}>⊘ {skipped} omitidos</span>}
                      {failed > 0 && <span style={{ color: colors.red }}>✕ {failed} fallidos</span>}
                    </div>
                  </div>
                  {(campaign.reasons || []).slice(0, 2).map((reason, idx) => (
                    <div key={`${reason.error_code || 'reason'}-${idx}`} style={{ color: reason.result_status === 'failed' ? colors.red : (reason.result_status === 'unknown' ? colors.yellow : colors.textSecondary), fontSize: 11, marginTop: 6 }}>
                      {reason.total} {reason.result_status === 'failed' ? 'fallidos' : (reason.result_status === 'unknown' ? 'por confirmar' : 'omitidos')}: {reason.error_message || 'Sin detalle'}{reason.error_code ? ` (código ${reason.error_code})` : ''}
                    </div>
                  ))}
                </button>
                {isOpen && (
                  <div style={{ borderTop: `1px solid ${colors.border}`, padding: 10, maxHeight: 240, overflowY: 'auto' }}>
                    {(campaign.reasons || []).some(reason => String(reason.error_code || '') === '131042') && (
                      <div style={{ border: `1px solid ${colors.red}66`, borderRadius: 8, padding: 9, marginBottom: 9, backgroundColor: `${colors.red}0d` }}>
                        <div style={{ color: colors.textPrimary, fontSize: 11, fontWeight: 800 }}>Envíos bloqueados por facturación de Meta</div>
                        <div style={{ color: colors.textMuted, fontSize: 10, marginTop: 3, lineHeight: 1.4 }}>
                          Corrige el método de pago en WhatsApp Manager. Después selecciona sólo estos fallidos, revisa el contenido y confirma el reenvío. Los entregados y leídos no se incluirán.
                        </div>
                        <button onClick={() => preparePaymentRetry(campaign)} disabled={followUpBusy}
                          style={{ marginTop: 7, border: 'none', borderRadius: 6, background: colors.red, color: '#fff', padding: '6px 9px', cursor: followUpBusy ? 'wait' : 'pointer', fontSize: 11, fontWeight: 800 }}>
                          {followUpBusy ? 'Preparando…' : 'Revisar y reintentar fallidos por pago'}
                        </button>
                      </div>
                    )}
                    {campaign.sending_provider !== 'evolution' && !campaign.test_mode && read > 0 && (
                      <div style={{ border: `1px solid ${colors.border}`, borderRadius: 8, padding: 9, marginBottom: 9, backgroundColor: colors.bgApp }}>
                        <div style={{ color: colors.textPrimary, fontSize: 11, fontWeight: 800 }}>Seguimiento inteligente para mañana</div>
                        <div style={{ color: colors.textMuted, fontSize: 10, marginTop: 3 }}>
                          Sólo quienes leyeron, no respondieron, no hicieron pedido, no recibieron otro template y no están dados de baja.
                        </div>
                        {String(followUpPreview?.campaignId) !== String(campaign.id) ? (
                          <button onClick={() => previewFollowUp(campaign.id)} disabled={followUpBusy}
                            style={{ marginTop: 7, border: `1px solid ${colors.blue}`, borderRadius: 6, background: 'transparent', color: colors.blue, padding: '5px 8px', cursor: 'pointer', fontSize: 11, fontWeight: 700 }}>
                            {followUpBusy ? 'Evaluando…' : 'Revisar quiénes califican'}
                          </button>
                        ) : (
                          <div style={{ marginTop: 7 }}>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, color: colors.textSecondary, fontSize: 11 }}>
                              <span>👁 {followUpPreview.summary.read} leyeron</span>
                              <span style={{ color: colors.green, fontWeight: 800 }}>✓ {followUpPreview.summary.eligible} califican</span>
                              <span>⊘ {followUpPreview.summary.excluded} excluidos</span>
                            </div>
                            {Object.entries(followUpPreview.summary.reasons || {}).length > 0 && (
                              <div style={{ color: colors.textMuted, fontSize: 10, marginTop: 4 }}>
                                {Object.entries(followUpPreview.summary.reasons).map(([reason, total]) => `${total} ${({ respondio: 'respondieron', hizo_pedido: 'hicieron pedido', recibio_otro_template: 'recibieron otro template', opt_out: 'dados de baja' })[reason] || reason}`).join(' · ')}
                              </div>
                            )}
                            {!followUpPreview.scheduled && followUpPreview.summary.eligible > 0 && (
                              <button onClick={() => scheduleFollowUp(campaign)} disabled={followUpBusy}
                                style={{ marginTop: 7, border: 'none', borderRadius: 6, background: colors.green, color: '#fff', padding: '6px 9px', cursor: 'pointer', fontSize: 11, fontWeight: 800 }}>
                                {followUpBusy ? 'Programando…' : `Programar ${followUpPreview.summary.eligible} para mañana 10:00`}
                              </button>
                            )}
                            {followUpPreview.scheduled && <div style={{ color: colors.green, fontSize: 11, fontWeight: 800, marginTop: 6 }}>✓ Seguimiento programado</div>}
                          </div>
                        )}
                      </div>
                    )}
                    {campaignRecipients.length === 0 ? (
                      <div style={{ color: colors.textMuted, fontSize: 11 }}>Cargando detalle o sin destinatarios registrados.</div>
                    ) : campaignRecipients.map(recipient => (
                      <div key={recipient.id} style={{ display: 'grid', gridTemplateColumns: 'minmax(130px, 1fr) minmax(90px, auto)', gap: 8, padding: '6px 2px', borderBottom: `1px solid ${colors.border}`, fontSize: 11 }}>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ color: colors.textPrimary, fontWeight: 650, overflow: 'hidden', textOverflow: 'ellipsis' }}>{recipient.contact_name || recipient.original_phone || recipient.destination_phone}</div>
                          {(recipient.display_error_message || recipient.error_message || recipient.delivery_error) && <div style={{ color: colors.red, marginTop: 2 }}>{recipient.display_error_message || recipient.error_message || 'WhatsApp informó un fallo de entrega'}{(recipient.display_error_code || recipient.error_code) ? ` (código ${recipient.display_error_code || recipient.error_code})` : ''}</div>}
                        </div>
                        <div style={{ color: ['read','delivered'].includes(recipient.current_status) ? colors.green : recipient.current_status === 'failed' ? colors.red : colors.textSecondary, fontWeight: 700, textAlign: 'right' }}>
                          {({ read: 'Leído', delivered: 'Entregado', sent: 'Aceptado', pending: 'Aceptado', accepted: 'Aceptado', failed: 'Fallido', skipped: 'Omitido' })[recipient.current_status] || recipient.current_status}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
            </div>
          </aside>
        </div>
      )}

      {/* Mapeo de variables del template */}
      {!loading && selTpl && tplVarCount > 0 && (
        <div style={{ padding: '8px 20px', borderBottom: `1px solid ${colors.border}`, backgroundColor: colors.bgApp, display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
          <span style={{ color: colors.textSecondary, fontSize: 12, fontWeight: 700 }}>Variables del mensaje:</span>
          {tplVars.map((number, i) => {
            const mode = varMap[i] || (i === 0 ? 'name' : 'fav');
            return (
            <span key={number} style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 4, padding: '5px 7px', border: `1px solid ${colors.border}`, borderRadius: colors.radiusMd }}>
              <span style={{ color: colors.textMuted, fontSize: 12 }}>{`{{${number}}}`}</span>
              <select value={mode}
                onChange={e => {
                  const nextMode = e.target.value;
                  setVarMap(m => { const n = [...m]; while (n.length < tplVarCount) n.push('fav'); n[i] = nextMode; return n; });
                  if (nextMode === 'text') {
                    setVarPrefix(current => { const next = [...current]; next[i] = ''; return next; });
                    setVarSuffix(current => { const next = [...current]; next[i] = ''; return next; });
                    setVarFallback(current => { const next = [...current]; next[i] = ''; return next; });
                  }
                }}
                style={{ padding: '3px 6px', borderRadius: colors.radiusSm, background: colors.bgCard, color: colors.textPrimary, border: `1px solid ${colors.border}`, fontSize: 12 }}>
                <option value="name">Primer nombre</option>
                <option value="full_name">Nombre completo</option>
                <option value="fav">Producto favorito</option>
                <option value="since_order">Tiempo sin comprar</option>
                <option value="last_order_date">Fecha última compra</option>
                <option value="orders_count">Cantidad de pedidos</option>
                <option value="city">Ciudad</option>
                <option value="phone">Teléfono</option>
                <option value="delivery_order">Pedido no entregado</option>
                <option value="delivery_reason">Motivo de no entrega</option>
                <option value="text">Texto fijo</option>
              </select>
              {mode === 'text' ? (
                <textarea value={varText[i] || ''} rows={2}
                  onChange={e => updateFixedText(i, e.target.value)}
                  placeholder="Texto, también puede tener varias líneas"
                  style={{ width: 210, minHeight: 46, resize: 'vertical', whiteSpace: 'pre-wrap', padding: '5px 7px', borderRadius: colors.radiusSm, background: colors.bgCard, color: colors.textPrimary, border: `1px solid ${colors.border}`, fontSize: 12 }} />
              ) : (
                <>
                  <input value={varPrefix[i] || ''}
                    onChange={e => setVarPrefix(t => { const n = [...t]; while (n.length < tplVarCount) n.push(''); n[i] = e.target.value; return n; })}
                    placeholder="Texto antes (opcional)"
                    title="Se agrega dentro de la misma variable, antes del dato"
                    style={{ width: 145, padding: '4px 6px', borderRadius: colors.radiusSm, background: colors.bgCard, color: colors.textPrimary, border: `1px solid ${colors.border}`, fontSize: 12 }} />
                  <input value={varSuffix[i] || ''}
                    onChange={e => setVarSuffix(t => { const n = [...t]; while (n.length < tplVarCount) n.push(''); n[i] = e.target.value; return n; })}
                    placeholder="Texto después (opcional)"
                    title="Se agrega dentro de la misma variable, después del dato"
                    style={{ width: 155, padding: '4px 6px', borderRadius: colors.radiusSm, background: colors.bgCard, color: colors.textPrimary, border: `1px solid ${colors.border}`, fontSize: 12 }} />
                  <input value={varFallback[i] || ''}
                    onChange={e => setVarFallback(t => { const n = [...t]; while (n.length < tplVarCount) n.push(''); n[i] = e.target.value; return n; })}
                    placeholder={`Si falta: ${defaultFallback(mode) || 'texto alternativo'}`}
                    title="Texto predeterminado cuando el contacto no tiene este dato"
                    style={{ width: 170, padding: '4px 6px', borderRadius: colors.radiusSm, background: colors.bgCard, color: colors.textPrimary, border: `1px solid ${colors.border}`, fontSize: 12 }} />
                </>
              )}
            </span>
          );})}
        </div>
      )}

      {/* Vista previa del mensaje */}
      {!loading && selTpl && (() => {
        const sel = audience;
        if (!sel.length) return null;
        const idx = Math.min(previewIdx, sel.length - 1);
        const c = sel[idx];
        const bodyComp = getBodyComponent(selTpl);
        const values = Object.fromEntries(tplVars.map((number, index) => [number, varValue(index, c)]));
        const text = bodyComp?.text ? renderTemplate(bodyComp.text, values) : '(Este template no tiene cuerpo de texto para previsualizar)';
        const previewParts = bodyComp?.text ? templatePreviewParts(bodyComp.text) : [];
        const variableIndexes = new Map(tplVars.map((number, index) => [number, index]));
        return (
          <div style={{ padding: '10px 20px', borderBottom: `1px solid ${colors.border}`, backgroundColor: colors.bgApp }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6, gap: 8 }}>
              <span style={{ color: colors.textSecondary, fontSize: 12, fontWeight: 700 }}>
                Vista previa{sel.length > 1 ? ` (${idx + 1}/${sel.length})` : ''} · {toTitleCase(c?.name) || c?.phone}
              </span>
              {sel.length > 1 && (
                <span style={{ display: 'flex', gap: 6 }}>
                  <button onClick={() => setPreviewIdx(i => Math.max(0, Math.min(i, sel.length - 1) - 1))} disabled={idx === 0}
                    style={{ background: 'none', border: `1px solid ${colors.border}`, borderRadius: colors.radiusSm, color: colors.textSecondary, padding: '2px 10px', cursor: idx === 0 ? 'default' : 'pointer', opacity: idx === 0 ? 0.5 : 1 }}>←</button>
                  <button onClick={() => setPreviewIdx(i => Math.min(sel.length - 1, Math.min(i, sel.length - 1) + 1))} disabled={idx >= sel.length - 1}
                    style={{ background: 'none', border: `1px solid ${colors.border}`, borderRadius: colors.radiusSm, color: colors.textSecondary, padding: '2px 10px', cursor: idx >= sel.length - 1 ? 'default' : 'pointer', opacity: idx >= sel.length - 1 ? 0.5 : 1 }}>→</button>
                </span>
              )}
            </div>
            <div style={{ whiteSpace: 'pre-wrap', background: colors.bgCard, border: `1px solid ${colors.border}`, borderRadius: 10, padding: '10px 12px', color: colors.textPrimary, fontSize: 13, lineHeight: 1.5 }}>
              {previewParts.length ? previewParts.map((part, partIndex) => {
                if (part.type === 'text') return <span key={`text-${partIndex}`}>{part.value}</span>;
                const variableIndex = variableIndexes.get(part.number);
                const mode = varMap[variableIndex] || (variableIndex === 0 ? 'name' : 'fav');
                if (mode === 'text') {
                  return (
                    <FixedTextPreviewEditor
                      key={`variable-${part.number}-${partIndex}`}
                      number={part.number}
                      value={varText[variableIndex] || ''}
                      onChange={value => updateFixedText(variableIndex, value)}
                      colors={colors}
                    />
                  );
                }
                return <span key={`variable-${part.number}-${partIndex}`}>{values[part.number] ?? `{{${part.number}}}`}</span>;
              }) : text}
            </div>
            <div style={{ color: colors.textMuted, fontSize: 11, marginTop: 6 }}>
              Así llega el mensaje; los campos marcados como texto fijo se pueden editar aquí y las demás variables cambian según cada cliente.{testMode && TEST_PHONE ? ` En modo prueba se enviará una sola muestra a ${TEST_PHONE}.` : ''}
            </div>
          </div>
        );
      })()}

      {/* Select all bar */}
      {!loading && filtered.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 20px', backgroundColor: colors.bgApp, borderBottom: `1px solid ${colors.border}` }}>
          <button onClick={toggleAll} style={{ display: 'flex', alignItems: 'center', gap: '6px', background: 'none', border: 'none', cursor: 'pointer', color: colors.textSecondary, fontSize: '13px', padding: 0 }}>
            <div style={{ width: '16px', height: '16px', borderRadius: '4px', border: `2px solid ${allChecked ? colors.green : colors.border}`, backgroundColor: allChecked ? colors.green : someChecked ? colors.green + '44' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              {allChecked && <Check size={10} color="#fff" strokeWidth={3} />}
              {!allChecked && someChecked && <span style={{ width: '8px', height: '2px', backgroundColor: colors.green, display: 'block' }} />}
            </div>
            {allChecked ? 'Deseleccionar todos' : 'Seleccionar todos'}
          </button>
          <span style={{ color: colors.textMuted, fontSize: '12px', marginLeft: 'auto' }}>
            {selectedCount} de {filtered.length} seleccionados
            {contacts.length > filtered.length && (
              <span style={{ marginLeft: '8px', color: colors.yellow, fontWeight: 600 }}>
                · {contacts.length - filtered.length} fuera de los filtros
              </span>
            )}
            {sources && <span style={{ marginLeft: '10px', opacity: 0.7 }}>· 💬 {sources.whatsapp} WhatsApp · 🛒 {sources.shopify} Shopify</span>}
          </span>
        </div>
      )}

      {/* Lista de contactos */}
      <div>
        {loading ? (
          <div style={{ padding: '60px', textAlign: 'center', color: colors.textMuted }}>Cargando contactos...</div>
        ) : filtered.length === 0 ? (
          <div style={{ padding: '60px', textAlign: 'center', color: colors.textMuted }}>
            {search ? 'Sin resultados para esa búsqueda' : 'No hay contactos en el sistema'}
          </div>
        ) : filtered.map(c => {
          const checked = selected.has(c.phone);
          return (
            <div key={c.phone} onClick={() => toggleOne(c.phone)}
              style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '11px 20px', cursor: 'pointer', borderBottom: `1px solid ${colors.border}`, backgroundColor: checked ? `${colors.green}06` : 'transparent', transition: 'background 0.1s' }}>
              <div style={{ width: '16px', height: '16px', borderRadius: '4px', border: `2px solid ${checked ? colors.green : colors.border}`, backgroundColor: checked ? colors.green : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'all 0.1s' }}>
                {checked && <Check size={10} color="#fff" strokeWidth={3} />}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ color: colors.textPrimary, fontWeight: 600, fontSize: '13px' }}>{toTitleCase(c.name) || 'Sin nombre'}</div>
                <div style={{ color: colors.textMuted, fontSize: '12px' }}>{c.phone}</div>
                {deliveryCases.has(normPhone(c.phone)) && (
                  <div style={{ color:'#fb923c', fontSize:'11px', marginTop:'3px', fontWeight:650 }}>
                    🚚 No entregado ayer · {deliveryCases.get(normPhone(c.phone)).orderLabels.join(', ') || 'Pedido'} · {deliveryCases.get(normPhone(c.phone)).reason}
                  </div>
                )}
              </div>
              {c.total_orders > 0 && (
                <span style={{ color: colors.green, fontSize: '11px', fontWeight: 700, backgroundColor: `${colors.green}18`, borderRadius: colors.radiusSm, padding: '2px 6px' }}>
                  {c.total_orders} pedidos
                </span>
              )}
              <span style={{ fontSize: '10px', fontWeight: 600, padding: '2px 7px', borderRadius: '5px', backgroundColor: c.contact_type === 'customer' ? `${colors.green}22` : `${colors.blue}22`, color: c.contact_type === 'customer' ? colors.green : colors.blue }}>
                {c.contact_type === 'customer' ? 'Cliente' : 'Lead'}
              </span>
              <span style={{ fontSize: '10px', fontWeight: 600, padding: '2px 7px', borderRadius: '5px', backgroundColor: c.source === 'shopify' ? '#f97316' + '22' : '#25d366' + '22', color: c.source === 'shopify' ? '#f97316' : '#25d366' }}>
                {c.source === 'shopify' ? '🛒' : '💬'}
              </span>
            </div>
          );
        })}
      </div>
      </div>

      {/* Confirmación intermedia: esta instantánea es exactamente la que se enviará. */}
      {reviewPlan && (() => {
        const idx = Math.min(reviewIdx, reviewPlan.entries.length - 1);
        const entry = reviewPlan.entries[idx];
        const reviewedCount = reviewedItems.size;
        const guidedComplete = guidedReview && reviewedCount === reviewPlan.entries.length;
        return (
          <div role="dialog" aria-modal="true" aria-label="Revisar envío masivo" style={{ position: 'fixed', inset: 0, zIndex: 10000, backgroundColor: 'rgba(0,0,0,0.72)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
            <div style={{ width: 'min(760px, 96vw)', maxHeight: '90vh', overflowY: 'auto', backgroundColor: colors.bgPanel, border: `1px solid ${colors.border}`, borderRadius: 14, boxShadow: '0 18px 60px rgba(0,0,0,0.5)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '16px 18px', borderBottom: `1px solid ${colors.border}` }}>
                <CheckSquare size={19} color={colors.green} />
                <div style={{ flex: 1 }}>
                  <div style={{ color: colors.textPrimary, fontWeight: 800, fontSize: 15 }}>Revisa antes de enviar</div>
                  <div style={{ color: colors.textSecondary, fontSize: 12, marginTop: 5 }}>
                    {reviewPlan.sendingLabel}
                    {reviewPlan.audienceLabel && <div style={{ marginTop: 4 }}>Destinatarios: {reviewPlan.audienceLabel}</div>}
                    {reviewPlan.sendingProvider === 'evolution' && <>
                      {' · '}Lotes de {reviewPlan.batchSize}, pausa de {reviewPlan.batchPauseSeconds / 60} minutos.
                      {' '}Tiempo mínimo aproximado: {Math.max(0, reviewPlan.entries.length - 1) + Math.floor(Math.max(0, reviewPlan.entries.length - 1) / reviewPlan.batchSize) * 4} minutos.
                      {' '}Sólo texto. Mantén esta pantalla abierta; los siguientes lotes continúan automáticamente.
                    </>}
                  </div>
                  {sending && <div style={{ marginTop: 8, color: colors.textPrimary }}>
                    {sendProgress.done} de {sendProgress.total} procesados
                    {waitSeconds > 0 && ` · Próximo envío en ${Math.floor(waitSeconds / 60)}:${String(waitSeconds % 60).padStart(2, '0')}`}
                    {' '}<button onClick={() => { stopSendingRef.current = true; }}>Detener pendientes</button>
                  </div>}
                  <div style={{ color: colors.textMuted, fontSize: 12, marginTop: 2 }}>Esta vista usa exactamente los mensajes preparados que se enviarán.</div>
                </div>
                <button onClick={() => setReviewPlan(null)} disabled={sending} aria-label="Cerrar revisión" style={{ border: 'none', background: 'none', color: colors.textMuted, cursor: sending ? 'not-allowed' : 'pointer', padding: 4 }}><X size={18} /></button>
              </div>

              <div style={{ padding: '14px 18px', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8 }}>
                <div style={{ padding: 10, borderRadius: 8, backgroundColor: colors.bgCard }}><div style={{ color: colors.textMuted, fontSize: 11 }}>Template</div><div style={{ color: colors.textPrimary, fontSize: 13, fontWeight: 700, wordBreak: 'break-word' }}>{reviewPlan.templateName}</div></div>
                <div style={{ padding: 10, borderRadius: 8, backgroundColor: colors.bgCard }}><div style={{ color: colors.textMuted, fontSize: 11 }}>Mensajes</div><div style={{ color: colors.textPrimary, fontSize: 13, fontWeight: 700 }}>{reviewPlan.entries.length}</div></div>
                <div style={{ padding: 10, borderRadius: 8, backgroundColor: colors.bgCard }}><div style={{ color: colors.textMuted, fontSize: 11 }}>Destino</div><div style={{ color: reviewPlan.testMode ? colors.yellow : colors.textPrimary, fontSize: 13, fontWeight: 700 }}>{reviewPlan.testMode ? `Prueba: ${reviewPlan.testPhone}` : 'Clientes seleccionados'}</div></div>
              </div>

              <div style={{ padding: '0 18px 16px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 7 }}>
                  <span style={{ color: colors.textSecondary, fontSize: 12, fontWeight: 700 }}>
                    Mensaje {idx + 1} de {reviewPlan.entries.length} · {toTitleCase(entry.contact?.name) || entry.contact?.phone}
                    {guidedReview && reviewedItems.has(idx) && <span style={{ color: colors.green, marginLeft: 7 }}>✓ Revisado</span>}
                  </span>
                  {reviewPlan.entries.length > 1 && <span style={{ display: 'flex', gap: 6 }}>
                    <button onClick={() => setReviewIdx(i => Math.max(0, i - 1))} disabled={idx === 0 || sending} style={{ background: 'none', border: `1px solid ${colors.border}`, borderRadius: colors.radiusSm, color: colors.textSecondary, padding: '3px 12px', cursor: idx === 0 ? 'default' : 'pointer', opacity: idx === 0 ? 0.5 : 1 }}>←</button>
                    <button onClick={() => setReviewIdx(i => Math.min(reviewPlan.entries.length - 1, i + 1))} disabled={idx === reviewPlan.entries.length - 1 || sending} style={{ background: 'none', border: `1px solid ${colors.border}`, borderRadius: colors.radiusSm, color: colors.textSecondary, padding: '3px 12px', cursor: idx === reviewPlan.entries.length - 1 ? 'default' : 'pointer', opacity: idx === reviewPlan.entries.length - 1 ? 0.5 : 1 }}>→</button>
                  </span>}
                </div>
                <div style={{ whiteSpace: 'pre-wrap', backgroundColor: colors.bgCard, border: `1px solid ${colors.border}`, borderRadius: 10, padding: '12px 14px', color: colors.textPrimary, fontSize: 13, lineHeight: 1.55 }}>{entry.previewText || '(Template sin cuerpo de texto)'}</div>
                <div style={{ color: colors.textMuted, fontSize: 11, marginTop: 7 }}>Destino real: {entry.item.phone} · Puedes recorrer todos los mensajes antes de confirmar.</div>
                {guidedReview && (
                  <div style={{ marginTop: 10, padding: '9px 11px', borderRadius: 8, backgroundColor: `${colors.green}12`, border: `1px solid ${colors.green}33`, color: colors.textSecondary, fontSize: 12, display: 'flex', justifyContent: 'space-between', gap: 10 }}>
                    <span>Revisión detallada</span>
                    <strong style={{ color: guidedComplete ? colors.green : colors.textPrimary }}>{reviewedCount} de {reviewPlan.entries.length} revisados</strong>
                  </div>
                )}
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 10, padding: '13px 18px', borderTop: `1px solid ${colors.border}`, backgroundColor: colors.bgApp }}>
                {!guidedReview ? (
                  <button onClick={startGuidedReview} disabled={sending} style={{ marginRight: 'auto', display: 'flex', alignItems: 'center', gap: 7, padding: '8px 15px', borderRadius: 8, border: `1px solid ${colors.green}66`, backgroundColor: `${colors.green}18`, color: colors.green, fontWeight: 750, cursor: sending ? 'not-allowed' : 'pointer' }}>
                    <CheckSquare size={14} /> Revisar uno por uno
                  </button>
                ) : (
                  <div style={{ marginRight: 'auto', display: 'flex', gap: 8 }}>
                    <button onClick={() => setReviewIdx(i => Math.max(0, i - 1))} disabled={idx === 0 || sending} style={{ padding: '8px 13px', borderRadius: 8, border: `1px solid ${colors.border}`, backgroundColor: 'transparent', color: colors.textSecondary, cursor: idx === 0 || sending ? 'not-allowed' : 'pointer', opacity: idx === 0 ? 0.5 : 1 }}>Anterior</button>
                    <button onClick={markReviewedAndContinue} disabled={sending} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 14px', borderRadius: 8, border: `1px solid ${colors.green}66`, backgroundColor: colors.green, color: '#fff', fontWeight: 750, cursor: sending ? 'not-allowed' : 'pointer' }}>
                      <Check size={14} /> {idx < reviewPlan.entries.length - 1 ? 'Revisado · siguiente' : 'Marcar último revisado'}
                    </button>
                  </div>
                )}
                <button onClick={() => setReviewPlan(null)} disabled={sending} style={{ padding: '8px 15px', borderRadius: 8, border: `1px solid ${colors.border}`, backgroundColor: 'transparent', color: colors.textSecondary, cursor: sending ? 'not-allowed' : 'pointer' }}>Volver y corregir</button>
                <button onClick={confirmSend} disabled={sending || (guidedReview && !guidedComplete)} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '8px 16px', borderRadius: 8, border: 'none', backgroundColor: guidedReview && !guidedComplete ? colors.bgHover : colors.green, color: guidedReview && !guidedComplete ? colors.textMuted : '#fff', fontWeight: 800, cursor: sending || (guidedReview && !guidedComplete) ? 'not-allowed' : 'pointer', opacity: sending ? 0.75 : 1 }}>
                  {sending ? <Loader size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Send size={14} />}
                  {sending ? `Enviando ${sendProgress.done}/${sendProgress.total}…` : guidedReview && !guidedComplete ? `Faltan ${reviewPlan.entries.length - reviewedCount} por revisar` : `Confirmar y enviar ${reviewPlan.entries.length}`}
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
