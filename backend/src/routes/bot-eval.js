/**
 * bot-eval.js — Evaluación objetiva del bot y ciclo de mejora.
 *
 * Tres endpoints:
 *   GET  /api/bot-eval/metrics?from&to      → métricas DURAS (sin IA) del período
 *                                             + el período anterior (tendencia).
 *   POST /api/bot-eval/grade   { from,to,sample } → nota de calidad 1-5 con IA
 *                                             sobre una muestra, errores agrupados
 *                                             y reglas propuestas para el bot.
 *   POST /api/bot-eval/apply-rules { rules } → agrega reglas a bot_improvement_rules
 *                                             (el pipeline ya las inyecta al bot).
 *
 * Idea: evaluar → detectar errores que se repiten → convertirlos en reglas →
 * aprobarlas → el bot las usa → volver a medir el período siguiente.
 */
const express = require('express');
const router  = express.Router();
const db          = require('../db/database');
const { getPool } = require('../db/database');
const { requireAuth, requireRole } = require('../middleware/auth');

router.use(requireAuth);
router.use(requireRole('owner', 'admin', 'supervisor'));

const DAY = 86400000;
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));

// Señales de confusión / fricción en el texto (cliente o bot).
const CLIENT_FRICTION = /\bno\s+(entend|es\s+eso|era\s+eso|me\s+sirve|es\s+lo\s+que)|ya\s+te\s+(dije|hab[ií]a)|te\s+pregunt[eé]|otra\s+vez|no,\s|eso\s+no\b|no\s+es\s+as[ií]/i;
const BOT_CONFUSED   = /no\s+(entiendo|entend[ií]|logro\s+entender|s[eé]\s+a\s+qu[eé])|puedes?\s+(explicar|aclarar|repetir)|no\s+estoy\s+segur/i;

/** Métricas duras de un período. Todo sale de los datos, sin IA. */
async function periodMetrics(pool, orgId, from, to) {
  // Conversaciones con al menos un mensaje entrante del cliente en el rango.
  const { rows: convs } = await pool.query(
    `SELECT c.id, c.pipeline_state, c.agent_mode, c.last_escalation_at, c.opted_out,
            c.created_at,
            (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.direction = 'inbound'
                AND m.created_at >= $2::date AND m.created_at < ($3::date + INTERVAL '1 day')) AS inbound_in,
            (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.direction = 'inbound') AS inbound_total,
            (SELECT bool_or(m.content ~* $4) FROM messages m WHERE m.conversation_id = c.id
                AND m.created_at >= $2::date AND m.created_at < ($3::date + INTERVAL '1 day')) AS client_friction,
            (SELECT bool_or(m.content ~* $5) FROM messages m WHERE m.conversation_id = c.id AND m.sent_by = 'ai'
                AND m.created_at >= $2::date AND m.created_at < ($3::date + INTERVAL '1 day')) AS bot_confused,
            (SELECT m.direction FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_dir,
            (SELECT m.sent_by  FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_by,
            (SELECT MAX(m.created_at) FROM messages m WHERE m.conversation_id = c.id) AS last_at,
            (SELECT COUNT(*) FROM orders o WHERE o.conversation_id = c.id
                AND o.status <> 'cancelled'
                AND o.created_at >= $2::date AND o.created_at < ($3::date + INTERVAL '1 day')) AS orders_in
       FROM conversations c
      WHERE c.organization_id = $1
        AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.direction = 'inbound'
                     AND m.created_at >= $2::date AND m.created_at < ($3::date + INTERVAL '1 day'))`,
    [orgId, from, to, CLIENT_FRICTION.source, BOT_CONFUSED.source]
  );

  const now = Date.now();
  const m = {
    conversaciones: convs.length,
    con_pedido: 0, escaladas: 0, con_friccion: 0, bot_confundido: 0,
    abandonadas: 0, baja: 0, mensajes_cliente_prom: 0,
  };
  let inboundSum = 0;
  for (const c of convs) {
    inboundSum += Number(c.inbound_in) || 0;
    if (Number(c.orders_in) > 0 || c.pipeline_state === 'confirmed' || c.pipeline_state === 'awaiting_payment') m.con_pedido++;
    if (c.agent_mode === 'human' || (c.last_escalation_at && new Date(c.last_escalation_at).getTime() >= new Date(from).getTime())) m.escaladas++;
    if (c.client_friction) m.con_friccion++;
    if (c.bot_confused) m.bot_confundido++;
    if (c.opted_out) m.baja++;
    // Abandonada: el último mensaje fue del bot y el cliente no volvió a escribir (>1 día) y no compró
    const lastBot = c.last_dir === 'outbound' && c.last_by === 'ai';
    const cold = c.last_at && (now - new Date(c.last_at).getTime()) > DAY;
    if (lastBot && cold && Number(c.orders_in) === 0) m.abandonadas++;
  }
  m.mensajes_cliente_prom = convs.length ? +(inboundSum / convs.length).toFixed(1) : 0;
  // Tasas (%)
  const pct = (n) => convs.length ? Math.round((n / convs.length) * 100) : 0;
  m.tasa_pedido      = pct(m.con_pedido);
  m.tasa_escalacion  = pct(m.escaladas);
  m.tasa_friccion    = pct(m.con_friccion);
  m.tasa_abandono    = pct(m.abandonadas);
  return m;
}

router.get('/metrics', async (req, res) => {
  const pool = getPool();
  const to   = isDate(req.query.to)   ? req.query.to   : new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Santiago' });
  const from = isDate(req.query.from) ? req.query.from : new Date(Date.now() - 6 * DAY).toLocaleDateString('sv-SE', { timeZone: 'America/Santiago' });
  try {
    // Período anterior de igual duración (para la tendencia)
    const days = Math.max(1, Math.round((new Date(to) - new Date(from)) / DAY) + 1);
    const prevTo   = new Date(new Date(from).getTime() - DAY).toISOString().slice(0, 10);
    const prevFrom = new Date(new Date(from).getTime() - days * DAY).toISOString().slice(0, 10);
    const [current, previous] = await Promise.all([
      periodMetrics(pool, req.orgId, from, to),
      periodMetrics(pool, req.orgId, prevFrom, prevTo),
    ]);
    res.json({ success: true, from, to, days, current, previous, prev_range: { from: prevFrom, to: prevTo } });
  } catch (err) {
    console.error('[BotEval/metrics]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Rúbrica de calidad (misma idea que /:id/analyze, en lote) ──────────────
const GRADE_SYSTEM = `Eres un analista de calidad de un bot de ventas por WhatsApp (huevos y aceitunas, Chile).
Evalúa la conversación de forma OBJETIVA. Devuelve SOLO JSON:
{
  "puntaje": 1-5,                       // 5 = impecable, 1 = malo
  "estado_final": "compró | agendó | interesado | exploró | insatisfecho | se dio de baja | otro",
  "resuelto_por": "bot | humano | nadie",
  "errores": ["errores concretos del bot, frases cortas"],
  "resumen": "1 oración"
}
Criterios: entendió al cliente, dio datos correctos (precios/horarios), no inventó, no repitió preguntas, cerró o escaló bien, tono cálido y breve.
Un pedido agendado a fecha futura NO es error aunque no pida dirección/pago. Sin texto fuera del JSON.`;

async function gradeConversation(client, conv, messages) {
  const transcript = messages.map(mm => {
    const who = mm.direction === 'inbound' ? 'Cliente' : (mm.sent_by === 'human' ? 'Humano' : 'Bot');
    return `${who}: ${mm.content}`;
  }).join('\n').slice(0, 6000);
  const resp = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 400,
    system: GRADE_SYSTEM,
    messages: [{ role: 'user', content: `Cliente: ${conv.contact_name || conv.phone_number}\n\n${transcript}\n\nEvalúa y devuelve el JSON.` }],
  });
  const raw = (resp.content[0]?.text || '{}').replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(raw); } catch { return { puntaje: null, errores: [], estado_final: 'otro', resumen: '(no se pudo evaluar)' }; }
}

/** Normaliza un error para agruparlo (minúsculas, sin tildes, recortado). */
function errKey(s) {
  return String(s || '').toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 50);
}

router.post('/grade', async (req, res) => {
  const pool = getPool();
  const { from, to } = req.body || {};
  const f = isDate(from) ? from : new Date(Date.now() - 6 * DAY).toLocaleDateString('sv-SE');
  const t = isDate(to)   ? to   : new Date().toLocaleDateString('sv-SE');
  const sample = Math.min(40, Math.max(3, parseInt(req.body?.sample) || 15));
  try {
    // Priorizar conversaciones que valen la pena revisar: escaladas o largas sin pedido.
    const { rows: candidates } = await pool.query(
      `SELECT c.id, c.contact_name, c.phone_number, c.agent_mode, c.pipeline_state,
              (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS msgs,
              (SELECT COUNT(*) FROM orders o WHERE o.conversation_id = c.id AND o.status <> 'cancelled') AS orders
         FROM conversations c
        WHERE c.organization_id = $1
          AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.direction='inbound'
                       AND m.created_at >= $2::date AND m.created_at < ($3::date + INTERVAL '1 day'))
        ORDER BY (c.agent_mode = 'human') DESC,
                 (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) DESC
        LIMIT $4`,
      [req.orgId, f, t, sample]
    );
    if (!candidates.length) return res.json({ success: true, from: f, to: t, graded: [], distribucion: {}, errores: [], reglas: [] });

    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const graded = [];
    for (const c of candidates) {
      try {
        const msgs = await db.getMessagesByConversation(c.id, 120);
        if (!msgs.length) continue;
        const g = await gradeConversation(client, c, msgs);
        graded.push({ id: c.id, name: c.contact_name || c.phone_number, msgs: Number(c.msgs), ...g });
      } catch (e) { /* saltar la que falle */ }
    }

    // Distribución de puntajes
    const distribucion = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    let sum = 0, n = 0;
    for (const g of graded) { if (g.puntaje >= 1 && g.puntaje <= 5) { distribucion[g.puntaje]++; sum += g.puntaje; n++; } }
    const promedio = n ? +(sum / n).toFixed(2) : null;

    // Errores agrupados por frecuencia
    const errMap = {};
    for (const g of graded) for (const e of (g.errores || [])) {
      const k = errKey(e); if (!k) continue;
      if (!errMap[k]) errMap[k] = { text: e, count: 0 };
      errMap[k].count++;
    }
    const errores = Object.values(errMap).sort((a, b) => b.count - a.count).slice(0, 12);

    // Proponer reglas a partir de los errores más frecuentes
    let reglas = [];
    if (errores.length) {
      try {
        const top = errores.slice(0, 8).map(e => `${e.text} (x${e.count})`);
        const rResp = await client.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 400,
          system: `Convierte estos errores recurrentes de un bot de ventas por WhatsApp en REGLAS concretas para que no vuelvan a pasar.
Reglas en imperativo, específicas, máximo 15 palabras, en español. Responde SOLO un array JSON de strings.`,
          messages: [{ role: 'user', content: `Errores frecuentes:\n${top.join('\n')}\n\nGenera entre 3 y 6 reglas.` }],
        });
        const raw = (rResp.content[0]?.text || '[]').replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
        reglas = JSON.parse(raw);
        if (!Array.isArray(reglas)) reglas = [];
      } catch { reglas = []; }
    }

    // Peores conversaciones (para revisar a mano)
    const peores = graded.filter(g => g.puntaje && g.puntaje <= 2).sort((a, b) => a.puntaje - b.puntaje).slice(0, 10);

    res.json({ success: true, from: f, to: t, evaluadas: graded.length, promedio, distribucion, errores, reglas, peores, graded });
  } catch (err) {
    console.error('[BotEval/grade]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/** Agrega reglas aprobadas a bot_improvement_rules (dedup). El pipeline ya las lee. */
router.post('/apply-rules', async (req, res) => {
  const { rules } = req.body || {};
  if (!Array.isArray(rules) || !rules.length) return res.status(400).json({ success: false, error: 'Sin reglas' });
  try {
    const raw = await db.getSetting(req.orgId, 'bot_improvement_rules').catch(() => null);
    let current = [];
    try { current = raw ? JSON.parse(raw) : []; } catch { current = []; }
    const set = new Set(current.map(r => String(r).toLowerCase().trim()));
    const added = [];
    for (const r of rules) {
      const clean = String(r).trim();
      if (clean && !set.has(clean.toLowerCase())) { current.push(clean); set.add(clean.toLowerCase()); added.push(clean); }
    }
    await db.setSetting(req.orgId, 'bot_improvement_rules', JSON.stringify(current));
    res.json({ success: true, added: added.length, total: current.length, rules: current });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
