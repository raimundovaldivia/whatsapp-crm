/**
 * EvaluacionPanel.jsx — Evaluación objetiva del bot + ciclo de mejora.
 *
 * 1) Métricas duras del período (sin IA) con tendencia vs período anterior.
 * 2) Nota de calidad 1-5 con IA sobre una muestra, errores frecuentes y las
 *    peores conversaciones.
 * 3) Reglas propuestas a partir de esos errores → aprobar → se guardan en
 *    bot_improvement_rules y el bot las aplica. Se vuelve a medir el período
 *    siguiente para ver si mejoró.
 *
 * Usa el axios compartido en ../utils/api (mismo patrón que los otros paneles).
 */
import React, { useState, useCallback, useEffect } from 'react';
import { api } from '../utils/api.js';
import { useTheme } from '../theme.js';

const isoDay = d => new Date(d).toLocaleDateString('sv-SE', { timeZone: 'America/Santiago' });

export default function EvaluacionPanel() {
  const { colors } = useTheme();
  const c = colors || {};
  const [from, setFrom] = useState(isoDay(Date.now() - 6 * 86400000));
  const [to, setTo] = useState(isoDay(Date.now()));
  const [metrics, setMetrics] = useState(null);
  const [grade, setGrade] = useState(null);
  const [loadingM, setLoadingM] = useState(false);
  const [loadingG, setLoadingG] = useState(false);
  const [error, setError] = useState(null);
  const [selRules, setSelRules] = useState({});
  const [applied, setApplied] = useState(null);

  const loadMetrics = useCallback(async () => {
    setLoadingM(true); setError(null);
    try {
      const { data } = await api.get(`/bot-eval/metrics?from=${from}&to=${to}`);
      setMetrics(data);
    } catch (e) { setError(e.response?.data?.error || e.message); }
    finally { setLoadingM(false); }
  }, [from, to]);

  useEffect(() => { loadMetrics(); }, []); // primera carga

  async function runGrade() {
    setLoadingG(true); setError(null); setApplied(null);
    try {
      const { data } = await api.post('/bot-eval/grade', { from, to, sample: 15 });
      setGrade(data);
      const pre = {}; (data.reglas || []).forEach((r, i) => { pre[i] = true; });
      setSelRules(pre);
    } catch (e) { setError(e.response?.data?.error || e.message); }
    finally { setLoadingG(false); }
  }

  async function applyRules() {
    const rules = (grade?.reglas || []).filter((_, i) => selRules[i]);
    if (!rules.length) return;
    try {
      const { data } = await api.post('/bot-eval/apply-rules', { rules });
      setApplied(`✅ ${data.added} regla(s) agregadas. El bot ya las está usando (total: ${data.total}).`);
    } catch (e) { setApplied(e.response?.data?.error || e.message); }
  }

  const card = (label, value, sub, color) => (
    <div style={{ backgroundColor: c.bgCard, border: `1px solid ${c.border}`, borderRadius: 12, padding: 14, minWidth: 150, flex: 1 }}>
      <div style={{ color: c.textMuted, fontSize: 12 }}>{label}</div>
      <div style={{ color: color || c.textPrimary, fontSize: 24, fontWeight: 800, marginTop: 4 }}>{value}</div>
      {sub != null && <div style={{ fontSize: 11, marginTop: 2 }}>{sub}</div>}
    </div>
  );

  // Flecha de tendencia: para tasas donde MENOS es mejor (escalación, fricción, abandono) invertimos el color.
  const trend = (cur, prev, lowerIsBetter) => {
    if (prev == null || cur == null) return null;
    const diff = cur - prev;
    if (diff === 0) return <span style={{ color: c.textMuted }}>= igual</span>;
    const good = lowerIsBetter ? diff < 0 : diff > 0;
    const arrow = diff > 0 ? '▲' : '▼';
    return <span style={{ color: good ? c.success : c.dangerSoft }}>{arrow} {Math.abs(diff)} vs antes</span>;
  };

  const inp = { backgroundColor: c.bgCard, border: `1px solid ${c.border}`, borderRadius: 8, padding: '8px 10px', color: c.textPrimary, fontSize: 13 };
  const btn = (bg) => ({ backgroundColor: bg, color: '#04210f', border: 'none', borderRadius: 8, padding: '9px 14px', fontWeight: 700, cursor: 'pointer', fontSize: 13 });

  const m = metrics?.current, p = metrics?.previous;

  return (
    <div style={{ padding: 16, overflowY: 'auto', height: '100%' }}>
      <h2 style={{ color: c.textPrimary, margin: '0 0 4px', fontSize: 18 }}>Evaluación del bot</h2>
      <p style={{ color: c.textMuted, fontSize: 13, marginTop: 0 }}>Mide cómo funcionó el bot, detecta errores que se repiten y conviértelos en reglas que el bot aplica. Vuelve a medir para ver si mejoró.</p>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', margin: '12px 0' }}>
        <span style={{ color: c.textMuted, fontSize: 12 }}>Desde</span>
        <input type="date" value={from} onChange={e => setFrom(e.target.value)} style={inp} />
        <span style={{ color: c.textMuted, fontSize: 12 }}>Hasta</span>
        <input type="date" value={to} onChange={e => setTo(e.target.value)} style={inp} />
        <button onClick={loadMetrics} disabled={loadingM} style={btn(c.blue || '#38bdf8')}>{loadingM ? 'Calculando…' : 'Calcular métricas'}</button>
        <button onClick={runGrade} disabled={loadingG} style={btn(c.green || '#22c55e')}>{loadingG ? 'Evaluando con IA…' : 'Evaluar calidad (IA)'}</button>
      </div>

      {error && <div style={{ color: c.red || '#f87171', fontSize: 13, marginBottom: 10 }}>{error}</div>}

      {/* Métricas duras */}
      {m && (
        <>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
            {card('Conversaciones', m.conversaciones, trend(m.conversaciones, p?.conversaciones, false))}
            {card('Terminó en pedido', `${m.tasa_pedido}%`, trend(m.tasa_pedido, p?.tasa_pedido, false), c.success)}
            {card('Escaló a humano', `${m.tasa_escalacion}%`, trend(m.tasa_escalacion, p?.tasa_escalacion, true), c.warning)}
            {card('Con fricción', `${m.tasa_friccion}%`, trend(m.tasa_friccion, p?.tasa_friccion, true), c.dangerSoft)}
            {card('Abandonadas', `${m.tasa_abandono}%`, trend(m.tasa_abandono, p?.tasa_abandono, true), c.dangerSoft)}
            {card('Msgs cliente prom.', m.mensajes_cliente_prom, null)}
          </div>
          <p style={{ color: c.textMuted, fontSize: 11, marginTop: 0 }}>
            "Con fricción" = el cliente mostró confusión o corrigió al bot ("no era eso", "ya te dije"). "Abandonadas" = el bot habló último y el cliente no volvió. Comparado con los {metrics.days} días anteriores.
          </p>
        </>
      )}

      {/* Nota de calidad IA */}
      {grade && (
        <div style={{ marginTop: 18, borderTop: `1px solid ${c.border}`, paddingTop: 16 }}>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
            {card('Nota promedio', grade.promedio != null ? `${grade.promedio} / 5` : '—', `${grade.evaluadas} evaluadas`, grade.promedio >= 4 ? c.success : grade.promedio >= 3 ? c.amber : c.dangerSoft)}
            <div style={{ flex: 2, minWidth: 220 }}>
              <div style={{ color: c.textMuted, fontSize: 12, marginBottom: 6 }}>Distribución de notas</div>
              {[5, 4, 3, 2, 1].map(k => {
                const n = grade.distribucion?.[k] || 0;
                const max = Math.max(1, ...Object.values(grade.distribucion || {}));
                const col = k >= 4 ? c.success : k === 3 ? c.amber : c.dangerSoft;
                return (
                  <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                    <span style={{ color: c.textMuted, width: 14, fontSize: 12 }}>{k}</span>
                    <div style={{ flex: 1, background: c.bgSub, borderRadius: 4, height: 14 }}>
                      <div style={{ width: `${(n / max) * 100}%`, background: col, height: 14, borderRadius: 4 }} />
                    </div>
                    <span style={{ color: c.textSecondary, width: 20, fontSize: 12 }}>{n}</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Errores frecuentes */}
          {grade.errores?.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <div style={{ color: c.textPrimary, fontWeight: 700, fontSize: 14, marginBottom: 6 }}>Errores más frecuentes</div>
              {grade.errores.map((e, i) => (
                <div key={i} style={{ color: c.textSecondary, fontSize: 13, padding: '3px 0' }}>
                  <span style={{ color: c.warning, fontWeight: 700 }}>×{e.count}</span> {e.text}
                </div>
              ))}
            </div>
          )}

          {/* Reglas propuestas → aplicar */}
          {grade.reglas?.length > 0 && (
            <div style={{ backgroundColor: c.bgCard, border: `1px solid ${c.border}`, borderRadius: 12, padding: 14, marginBottom: 14 }}>
              <div style={{ color: c.textPrimary, fontWeight: 700, fontSize: 14, marginBottom: 8 }}>Reglas propuestas para el bot</div>
              {grade.reglas.map((r, i) => (
                <label key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '5px 0', cursor: 'pointer' }}>
                  <input type="checkbox" checked={!!selRules[i]} onChange={() => setSelRules(s => ({ ...s, [i]: !s[i] }))} />
                  <span style={{ color: c.textSecondary, fontSize: 13 }}>{r}</span>
                </label>
              ))}
              <button onClick={applyRules} style={{ ...btn(c.green || '#22c55e'), marginTop: 10 }}>Aplicar reglas seleccionadas</button>
              {applied && <div style={{ color: c.textSecondary, fontSize: 13, marginTop: 8 }}>{applied}</div>}
            </div>
          )}

          {/* Peores conversaciones */}
          {grade.peores?.length > 0 && (
            <div>
              <div style={{ color: c.textPrimary, fontWeight: 700, fontSize: 14, marginBottom: 6 }}>Peores conversaciones (revisar a mano)</div>
              {grade.peores.map(g => (
                <div key={g.id} style={{ borderBottom: `1px solid ${c.border}`, padding: '8px 0' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <span style={{ color: c.textPrimary, fontWeight: 600, fontSize: 13 }}>{g.name}</span>
                    <span style={{ color: c.dangerSoft, fontWeight: 800, fontSize: 13 }}>{g.puntaje}/5</span>
                  </div>
                  <div style={{ color: c.textMuted, fontSize: 12, marginTop: 2 }}>{g.resumen}</div>
                  {(g.errores || []).length > 0 && <div style={{ color: c.warning, fontSize: 12, marginTop: 2 }}>⚠️ {g.errores.join(' · ')}</div>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
