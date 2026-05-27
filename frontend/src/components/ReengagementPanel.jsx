import { useState, useEffect, useCallback, useRef } from 'react';
import {
  UserCheck, RefreshCw, Sparkles, Send, Clock,
  ShoppingBag, TrendingUp,
  CheckSquare, Square, AlertCircle, Loader, Brain, Zap,
  FileText,
  Download,
} from 'lucide-react';
import * as XLSX from 'xlsx';
import { api, reengagementAPI } from '../utils/api.js';
import { useTheme } from '../theme.js';

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

export default function ReengagementPanel() {
  const { colors } = useTheme();
  const WINDOWS = getWINDOWS(colors);

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
  const [minConf, setMinConf]         = useState(65);
  const [testMode, setTestMode]       = useState(false);
  const TEST_PHONE = '56954565558';

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
      setTemplates(res.data || []);
    } catch (err) {
      setTemplatesError(err.response?.data?.error || err.message);
    } finally {
      setTemplatesLoading(false);
    }
  }, []);

  // Cargar templates al montar
  useEffect(() => { loadTemplates(); }, []);

  const parseTemplateVars = (tpl) => {
    if (!tpl) return [];
    const bodyComp = (tpl.components || []).find(c => c.type === 'BODY');
    if (!bodyComp?.text) return [];
    const matches = [...bodyComp.text.matchAll(/\{\{(\d+)\}\}/g)];
    return [...new Set(matches.map(m => m[1]))].sort();
  };

  // Construir components para envío usando el pick de IA
  const buildComponents = (candidate) => {
    const pick = clientPicks[candidate.phone];
    if (!pick?.vars) return [];
    const tpl = templates.find(t => t.name === pick.templateName);
    if (!tpl) return [];
    const vars = parseTemplateVars(tpl);
    if (vars.length === 0) return [];
    const parameters = vars.map(v => ({ type: 'text', text: pick.vars[v] ?? '' }));
    return [{ type: 'body', parameters }];
  };

  const getPreviewText = (candidate) => clientPicks[candidate?.phone]?.previewText || '';

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
    .filter(c => c.buyWindow === window && c.confidence >= minConf)
    .sort((a, b) => relevanceScore(b) - relevanceScore(a));

  const visible = byWindow(activeWindow);

  const toggleSelect = (phone) => setSelected(prev => {
    const n = new Set(prev);
    n.has(phone) ? n.delete(phone) : n.add(phone);
    return n;
  });

  const toggleAll = () => {
    if (selected.size === visible.length) setSelected(new Set());
    else setSelected(new Set(visible.map(c => c.phone)));
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
      showToast(testMode ? `🧪 Enviado a tu número (${TEST_PHONE})` : '✅ Template enviado');
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
      };
    });
    setSendingBulk(true);
    try {
      const res = await reengagementAPI.sendBulk(items);
      if (testMode) {
        showToast(`🧪 ${res.sent} mensajes enviados a tu número (${TEST_PHONE})`);
      } else {
        showToast(`✅ ${res.sent} enviados${res.failed > 0 ? ` · ${res.failed} fallaron` : ''}`);
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

  const exportToExcel = () => {
    if (!candidates.length) return;

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

      {/* Header */}
      <div style={{ padding: '14px 24px', backgroundColor: colors.bgPanel, borderBottom: `1px solid ${colors.border}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <UserCheck size={20} color={colors.green} />
          <h1 style={{ color: colors.textPrimary, fontSize: '17px', fontWeight: 600 }}>Re-enganche</h1>
          <span style={{ backgroundColor: colors.greenTint, color: colors.green, borderRadius: '6px', padding: '2px 8px', fontSize: '11px', fontWeight: 600, border: `1px solid ${colors.green}33`, display: 'flex', alignItems: 'center', gap: '4px' }}>
            <Brain size={11} /> Pronóstico IA
          </span>
          {!loading && totalCandidates > 0 && (
            <span style={{ backgroundColor: colors.bgHover, color: colors.textSecondary, borderRadius: '12px', padding: '2px 8px', fontSize: '12px' }}>
              {totalCandidates} clientes analizados
            </span>
          )}
          {!loading && hiddenByFilter > 0 && (
            <Tooltip text={`${hiddenByFilter} clientes ocultos por tener menos de ${minConf}% de confianza`} position="bottom">
              <span style={{ color: colors.textMuted, fontSize: '11px', cursor: 'default' }}>
                · {hiddenByFilter} ocultos &lt;{minConf}%
              </span>
            </Tooltip>
          )}
          {fromCache && !loading && (
            <span style={{ color: colors.borderStrong, fontSize: '11px' }}>
              · caché {cacheSource === 'db' ? '📅' : '💾'} {cacheDate || ''}
            </span>
          )}
          {calibration && !loading && (
            <Tooltip text={`Factor calibración: ${calibration.calibrationFactor} · Accuracy histórica: ${Math.round((calibration.accuracyRate||0)*100)}% · ${calibration.totalPredictions} predicciones simuladas`} position="bottom">
              <span style={{
                backgroundColor: calibration.accuracyRate >= 0.70 ? colors.greenTint : calibration.accuracyRate >= 0.50 ? `${colors.yellow}22` : `${colors.red}22`,
                color: calibration.accuracyRate >= 0.70 ? colors.greenLight : calibration.accuracyRate >= 0.50 ? colors.yellow : colors.red,
                border: `1px solid ${calibration.accuracyRate >= 0.70 ? `${colors.greenLight}44` : calibration.accuracyRate >= 0.50 ? `${colors.yellow}44` : `${colors.red}44`}`,
                borderRadius: '6px', padding: '2px 8px', fontSize: '11px', fontWeight: 600,
                cursor: 'default', display: 'flex', alignItems: 'center', gap: '4px',
              }}>
                ⚖️ {Math.round((calibration.accuracyRate||0)*100)}% preciso
              </span>
            </Tooltip>
          )}
        </div>

        {/* Filtro de confianza mínima */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Tooltip text="Mostrar solo predicciones con este nivel mínimo de confianza" position="bottom">
            <span style={{ color: colors.textMuted, fontSize: '11px' }}>Confianza mín.</span>
          </Tooltip>
          {[50, 65, 75, 85].map(val => (
            <button key={val} onClick={() => setMinConf(val)}
              style={{
                padding: '4px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: 700,
                cursor: 'pointer', border: 'none',
                backgroundColor: minConf === val ? colors.green : colors.bgHover,
                color: minConf === val ? '#fff' : colors.textSecondary,
                transition: 'all 0.15s',
              }}>
              {val}%+
            </button>
          ))}
        </div>

        <button onClick={() => load(true)} disabled={loading}
          style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '7px 14px', borderRadius: '8px', backgroundColor: colors.bgHover, border: `1px solid ${colors.borderStrong}`, cursor: loading ? 'not-allowed' : 'pointer', color: colors.textSecondary, fontSize: '12px', opacity: loading ? 0.5 : 1 }}>
          <RefreshCw size={13} style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }} />
          Nuevo análisis
        </button>

        <button onClick={exportToExcel} disabled={loading || !candidates.length}
          style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '7px 14px', borderRadius: '8px', backgroundColor: colors.greenTint, border: `1px solid ${colors.green}44`, cursor: (!candidates.length || loading) ? 'not-allowed' : 'pointer', color: colors.green, fontSize: '12px', opacity: (!candidates.length || loading) ? 0.5 : 1 }}>
          <Download size={13} />
          Exportar Excel
        </button>

        <Tooltip text={calibration ? `Último backtesting: ${calibration.totalPredictions} predicciones simuladas · Accuracy ${Math.round((calibration.accuracyRate||0)*100)}%` : 'Calibrar el algoritmo con historial real de Shopify'} position="bottom">
          <button
            onClick={async () => {
              setCalibrating(true);
              try {
                const res = await reengagementAPI.calibrate();
                if (res.success) {
                  setCalibration(res.data);
                  showToast(`✅ Calibración completa: ${Math.round((res.data.accuracyRate||0)*100)}% accuracy histórica · factor ${res.data.calibrationFactor}`);
                  load(true);
                }
              } catch (err) {
                showToast('Error en calibración: ' + (err.response?.data?.error || err.message), 'error');
              } finally {
                setCalibrating(false);
              }
            }}
            disabled={calibrating || loading}
            style={{
              display: 'flex', alignItems: 'center', gap: '6px', padding: '7px 14px',
              borderRadius: '8px', fontSize: '12px', border: `1px solid ${colors.purple}44`,
              backgroundColor: colors.bgAccent2,
              color: calibrating ? colors.textMuted : colors.purple,
              cursor: (calibrating || loading) ? 'not-allowed' : 'pointer',
              opacity: (calibrating || loading) ? 0.6 : 1,
            }}>
            {calibrating
              ? <><Loader size={13} style={{ animation: 'spin 1s linear infinite' }} /> Calibrando...</>
              : <>⚖️ {calibration ? 'Recalibrar' : 'Calibrar IA'}</>}
          </button>
        </Tooltip>

        {/* Toggle modo prueba */}
        <Tooltip text={testMode ? `Modo prueba activo — todos los envíos van a ${TEST_PHONE}` : 'Activar para enviar a tu número en vez de los clientes reales'} position="bottom">
          <button
            onClick={() => setTestMode(t => !t)}
            style={{
              display: 'flex', alignItems: 'center', gap: '6px', padding: '7px 14px',
              borderRadius: '8px', fontSize: '12px', fontWeight: testMode ? 600 : 400,
              border: `1px solid ${testMode ? colors.yellow : colors.borderStrong}`,
              backgroundColor: testMode ? `${colors.yellow}22` : colors.bgHover,
              color: testMode ? colors.yellow : colors.textSecondary,
              cursor: 'pointer', transition: 'all 0.15s',
            }}>
            🧪 {testMode ? 'Prueba ON' : 'Modo prueba'}
          </button>
        </Tooltip>
      </div>

      {/* Tabs de ventanas de tiempo */}
      {!loading && !error && totalCandidates > 0 && (
        <div style={{ display: 'flex', backgroundColor: colors.bgApp, borderBottom: `1px solid ${colors.border}`, padding: '0 24px' }}>
          {WINDOWS.map(w => {
            const count   = byWindow(w.key).length;
            const isActive = activeWindow === w.key;
            return (
              <button key={w.key} onClick={() => { setActiveWindow(w.key); setSelected(new Set()); }}
                style={{
                  display: 'flex', alignItems: 'center', gap: '8px',
                  padding: '12px 20px', background: 'none', border: 'none', cursor: 'pointer',
                  borderBottom: isActive ? `2px solid ${w.color}` : '2px solid transparent',
                  color: isActive ? w.color : colors.textSecondary, fontSize: '13px', fontWeight: isActive ? 600 : 400,
                  transition: 'all 0.15s',
                }}>
                {w.key === 'hoy' && <Zap size={13} />}
                {w.label}
                {count > 0 && (
                  <span style={{ backgroundColor: isActive ? w.bg : colors.bgHover, color: isActive ? w.color : colors.textSecondary, borderRadius: '10px', padding: '1px 7px', fontSize: '11px', fontWeight: 700 }}>
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
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <AlertCircle size={14} color={colors.red} />
              <span style={{ color: colors.red, fontSize: '12px' }}>{templatesError}</span>
              <button onClick={loadTemplates} style={{ color: colors.green, fontSize: '12px', background: 'none', border: 'none', cursor: 'pointer' }}>Reintentar</button>
            </div>
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
            {selected.size === visible.length && visible.length > 0
              ? <CheckSquare size={16} color={colors.green} />
              : <Square size={16} />}
            {selected.size === visible.length && visible.length > 0
              ? 'Deseleccionar todos'
              : `Seleccionar todos (${visible.length})`}
          </button>

          <div style={{ flex: 1 }} />

          {/* Botón principal: IA elige + personaliza en masa */}
          <button
            onClick={aiPickForAll}
            disabled={pickingAll || templates.length === 0}
            style={{
              display: 'flex', alignItems: 'center', gap: '6px',
              backgroundColor: colors.bgAccent2, color: colors.green,
              padding: '7px 16px', borderRadius: '8px', fontSize: '13px', fontWeight: 600,
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
              padding: '7px 14px', borderRadius: '8px', fontSize: '13px', fontWeight: 500,
              border: 'none',
              cursor: selectedWithTemplate > 0 ? 'pointer' : 'not-allowed',
              opacity: sendingBulk ? 0.7 : 1,
            }}>
            {sendingBulk ? <Loader size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Send size={14} />}
            {sendingBulk ? 'Enviando...' : `Enviar a ${selectedWithTemplate} clientes`}
          </button>
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
            <button onClick={() => load(true)} style={{ backgroundColor: `${colors.green}22`, color: colors.green, border: `1px solid ${colors.green}33`, borderRadius: '8px', padding: '8px 16px', fontSize: '13px', cursor: 'pointer' }}>
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
    </div>
  );
}

function CandidateCard({ candidate: c, isSelected, isSending, pick, onToggleSelect, onAiPick, onSend }) {
  const { colors } = useTheme();

  const conf    = c.confidence || 0;
  const isPickLoading = pick?.loading;
  const cColor  = confColor(conf, colors);
  const overdue = c.avgFreqDays && c.daysInactive > c.avgFreqDays;

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
            backgroundColor: colors.bgHover, color: cColor,
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
              backgroundColor: colors.bgAccent2, borderRadius: '8px',
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
              padding: '5px 10px', borderRadius: '6px', fontSize: '11px', fontWeight: 500,
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
