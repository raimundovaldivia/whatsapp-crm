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
const purchaseProbability = require('../services/purchase-probability');
const { client: aiClient, modelFor, responseText } = require('../services/ai-provider');

router.use(requireAuth);
router.use(requireRole('owner', 'admin', 'supervisor'));

const DAY = 86400000;
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const localDay = (date = new Date()) => date.toLocaleDateString('sv-SE', { timeZone: 'America/Santiago' });

// Señales de confusión / fricción en el texto (cliente o bot).
const CLIENT_FRICTION = /\bno\s+(entend|es\s+eso|era\s+eso|me\s+sirve|es\s+lo\s+que)|ya\s+te\s+(dije|hab[ií]a)|te\s+pregunt[eé]|otra\s+vez|no,\s|eso\s+no\b|no\s+es\s+as[ií]/i;
const BOT_CONFUSED   = /no\s+(entiendo|entend[ií]|logro\s+entender|s[eé]\s+a\s+qu[eé])|puedes?\s+(explicar|aclarar|repetir)|no\s+estoy\s+segur/i;

/** Métricas duras de un período. Todo sale de los datos, sin IA. */
async function periodMetrics(pool, orgId, from, to) {
  // Conversaciones con al menos un mensaje entrante del cliente en el rango.
  const { rows: convs } = await pool.query(
    `SELECT c.id, c.pipeline_state, c.agent_mode, c.last_escalation_at,
            COALESCE(contact.opt_out, FALSE) AS opted_out,
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
       LEFT JOIN LATERAL (
         SELECT ct.opt_out
           FROM contacts ct
          WHERE ct.organization_id = c.organization_id
            AND ct.phone = c.phone_number
          LIMIT 1
       ) contact ON TRUE
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
    model: modelFor('fast'),
    max_tokens: 400,
    system: GRADE_SYSTEM,
    messages: [{ role: 'user', content: `Cliente: ${conv.contact_name || conv.phone_number}\n\n${transcript}\n\nEvalúa y devuelve el JSON.` }],
  });
  const raw = responseText(resp, '{}').replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
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

    const client = aiClient;

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
          model: modelFor('fast'),
          max_tokens: 400,
          system: `Convierte estos errores recurrentes de un bot de ventas por WhatsApp en REGLAS concretas para que no vuelvan a pasar.
Reglas en imperativo, específicas, máximo 15 palabras, en español. Responde SOLO un array JSON de strings.`,
          messages: [{ role: 'user', content: `Errores frecuentes:\n${top.join('\n')}\n\nGenera entre 3 y 6 reglas.` }],
        });
        const raw = responseText(rResp, '[]').replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
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

function validateRange(from, to) {
  if (!isDate(from) || !isDate(to)) return 'Las fechas deben usar formato YYYY-MM-DD';
  const start = new Date(`${from}T12:00:00Z`);
  const end = new Date(`${to}T12:00:00Z`);
  const days = Math.round((end - start) / DAY) + 1;
  if (!Number.isFinite(days) || days < 1) return 'La fecha inicial debe ser anterior a la final';
  if (days > 62) return 'El período máximo de evaluación es de 62 días';
  return null;
}

async function reconcilePurchaseOutcomes(pool, orgId) {
  await pool.query(
    `UPDATE conversation_purchase_scores s
        SET actual_bought_24h = EXISTS (
              SELECT 1 FROM orders o
               WHERE o.organization_id = s.organization_id
                 AND o.conversation_id = s.conversation_id
                 AND o.status <> 'cancelled'
                 AND o.created_at > s.evaluated_at
                 AND o.created_at <= s.evaluated_at + INTERVAL '24 hours'
            ) OR EXISTS (
              SELECT 1
                FROM conversations c
                JOIN shopify_orders so
                  ON so.organization_id = c.organization_id
                 AND RIGHT(regexp_replace(COALESCE(so.customer_phone, ''), '[^0-9]', '', 'g'), 9)
                     = RIGHT(regexp_replace(COALESCE(c.phone_number, ''), '[^0-9]', '', 'g'), 9)
               WHERE c.id = s.conversation_id
                 AND c.organization_id = s.organization_id
                 AND COALESCE(so.shopify_created_at, so.synced_at) > s.evaluated_at
                 AND COALESCE(so.shopify_created_at, so.synced_at) <= s.evaluated_at + INTERVAL '24 hours'
                 AND LOWER(COALESCE(so.financial_status, '')) NOT IN ('voided','refunded')
            ),
            outcome_checked_at = NOW(), updated_at = NOW()
      WHERE s.organization_id = $1
        AND s.evaluated_at <= NOW() - INTERVAL '24 hours'
        AND s.actual_bought_24h IS NULL`,
    [orgId]
  );
  await pool.query(
    `UPDATE conversation_purchase_scores s
        SET actual_bought_48h = EXISTS (
              SELECT 1 FROM orders o
               WHERE o.organization_id = s.organization_id
                 AND o.conversation_id = s.conversation_id
                 AND o.status <> 'cancelled'
                 AND o.created_at > s.evaluated_at
                 AND o.created_at <= s.evaluated_at + INTERVAL '48 hours'
            ) OR EXISTS (
              SELECT 1
                FROM conversations c
                JOIN shopify_orders so
                  ON so.organization_id = c.organization_id
                 AND RIGHT(regexp_replace(COALESCE(so.customer_phone, ''), '[^0-9]', '', 'g'), 9)
                     = RIGHT(regexp_replace(COALESCE(c.phone_number, ''), '[^0-9]', '', 'g'), 9)
               WHERE c.id = s.conversation_id
                 AND c.organization_id = s.organization_id
                 AND COALESCE(so.shopify_created_at, so.synced_at) > s.evaluated_at
                 AND COALESCE(so.shopify_created_at, so.synced_at) <= s.evaluated_at + INTERVAL '48 hours'
                 AND LOWER(COALESCE(so.financial_status, '')) NOT IN ('voided','refunded')
            ),
            outcome_checked_at = NOW(), updated_at = NOW()
      WHERE s.organization_id = $1
        AND s.evaluated_at <= NOW() - INTERVAL '48 hours'
        AND s.actual_bought_48h IS NULL`,
    [orgId]
  );
}

async function purchaseScoreResponse(pool, orgId, from, to, evaluationDate) {
  const params = [orgId, evaluationDate, purchaseProbability.MODEL_VERSION, from, to];
  const { rows } = await pool.query(
    `SELECT s.*, c.contact_name, c.phone_number, c.pipeline_state,
            COALESCE(contact.opt_out, FALSE) AS opt_out
       FROM conversation_purchase_scores s
       JOIN conversations c
         ON c.id = s.conversation_id AND c.organization_id = s.organization_id
       LEFT JOIN LATERAL (
         SELECT ct.opt_out FROM contacts ct
          WHERE ct.organization_id = s.organization_id AND ct.phone = c.phone_number
          LIMIT 1
       ) contact ON TRUE
      WHERE s.organization_id = $1
        AND s.evaluation_date = $2::date
        AND s.model_version = $3
        AND s.source_from = $4::date
        AND s.source_to = $5::date
      ORDER BY s.expected_eggs_48h DESC, s.probability_48h DESC
      LIMIT 250`,
    params
  );
  const { rows: [totals] } = await pool.query(
    `SELECT COUNT(*)::int AS evaluated,
            COUNT(*) FILTER (WHERE probability_48h >= 60)::int AS high_probability,
            ROUND(COALESCE(SUM(expected_eggs_24h), 0))::int AS expected_eggs_24h,
            ROUND(COALESCE(SUM(expected_eggs_48h), 0))::int AS expected_eggs_48h,
            ROUND(COALESCE(AVG(probability_48h), 0))::int AS average_probability_48h,
            COUNT(actual_bought_48h)::int AS outcomes_checked,
            ROUND(AVG(POWER(probability_48h / 100.0 - CASE WHEN actual_bought_48h THEN 1 ELSE 0 END, 2))
              FILTER (WHERE actual_bought_48h IS NOT NULL), 3) AS brier_score_48h
       FROM conversation_purchase_scores
      WHERE organization_id = $1 AND evaluation_date = $2::date
        AND model_version = $3 AND source_from = $4::date AND source_to = $5::date`,
    params
  );
  const summary = {
    evaluated: Number(totals.evaluated) || 0,
    highProbability: Number(totals.high_probability) || 0,
    expectedEggs24h: Number(totals.expected_eggs_24h) || 0,
    expectedEggs48h: Number(totals.expected_eggs_48h) || 0,
    averageProbability48h: Number(totals.average_probability_48h) || 0,
    outcomesChecked: Number(totals.outcomes_checked) || 0,
    brierScore48h: totals.brier_score_48h == null ? null : Number(totals.brier_score_48h),
  };
  return { summary, prospects: rows };
}

/**
 * GET /api/bot-eval/purchase-probability?from&to
 * Devuelve el último snapshot diario del rango, con resultados ya observables.
 */
router.get('/purchase-probability', async (req, res) => {
  const pool = getPool();
  const from = isDate(req.query.from) ? req.query.from : localDay(new Date(Date.now() - 6 * DAY));
  const to = isDate(req.query.to) ? req.query.to : localDay();
  const rangeError = validateRange(from, to);
  if (rangeError) return res.status(400).json({ success: false, error: rangeError });
  try {
    await reconcilePurchaseOutcomes(pool, req.orgId);
    const { rows: [latest] } = await pool.query(
      `SELECT MAX(evaluation_date)::text AS evaluation_date
         FROM conversation_purchase_scores
        WHERE organization_id = $1 AND model_version = $2
          AND source_from = $3::date AND source_to = $4::date`,
      [req.orgId, purchaseProbability.MODEL_VERSION, from, to]
    );
    if (!latest?.evaluation_date) {
      return res.json({ success: true, from, to, modelVersion: purchaseProbability.MODEL_VERSION, summary: null, prospects: [] });
    }
    const data = await purchaseScoreResponse(pool, req.orgId, from, to, latest.evaluation_date);
    res.json({ success: true, from, to, evaluationDate: latest.evaluation_date, modelVersion: purchaseProbability.MODEL_VERSION, ...data });
  } catch (err) {
    console.error('[BotEval/purchase-probability GET]', err.message);
    res.status(500).json({ success: false, error: 'No se pudo cargar la probabilidad de compra' });
  }
});

/**
 * POST /api/bot-eval/purchase-probability/recalculate { from, to }
 * Recalcula señales conversacionales sin enviar mensajes ni llamar servicios externos.
 */
router.post('/purchase-probability/recalculate', async (req, res) => {
  const pool = getPool();
  const from = req.body?.from;
  const to = req.body?.to;
  const rangeError = validateRange(from, to);
  if (rangeError) return res.status(400).json({ success: false, error: rangeError });
  const limit = Math.min(2000, Math.max(1, Number.parseInt(req.body?.limit, 10) || 1500));
  const evaluatedAt = new Date();
  const evaluationDate = localDay(evaluatedAt);

  try {
    const { rows: conversations } = await pool.query(
      `SELECT c.id, c.phone_number, c.contact_name, c.pipeline_state, c.last_message_at,
              COALESCE(contact.total_orders, 0)::int AS total_orders,
              contact.last_order_at,
              COALESCE(contact.opt_out, FALSE) AS opt_out
         FROM conversations c
         LEFT JOIN LATERAL (
           SELECT ct.total_orders, ct.last_order_at, ct.opt_out
             FROM contacts ct
            WHERE ct.organization_id = c.organization_id AND ct.phone = c.phone_number
            LIMIT 1
         ) contact ON TRUE
        WHERE c.organization_id = $1
          AND EXISTS (
            SELECT 1 FROM messages m
             WHERE m.conversation_id = c.id
               AND m.direction = 'inbound'
               AND m.created_at >= $2::date
               AND m.created_at < ($3::date + INTERVAL '1 day')
          )
        ORDER BY c.last_message_at DESC
        LIMIT $4`,
      [req.orgId, from, to, limit]
    );

    if (!conversations.length) {
      return res.json({ success: true, from, to, evaluationDate, modelVersion: purchaseProbability.MODEL_VERSION, summary: { evaluated: 0 }, prospects: [] });
    }

    const ids = conversations.map(conversation => conversation.id);
    const { rows: messages } = await pool.query(
      `SELECT m.id, m.conversation_id, m.direction, m.content, m.sent_by, m.created_at
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
        WHERE c.organization_id = $1
          AND m.conversation_id = ANY($2::int[])
          AND m.created_at >= $3::date
          AND m.created_at < ($4::date + INTERVAL '1 day')
        ORDER BY m.conversation_id, m.created_at`,
      [req.orgId, ids, from, to]
    );
    const messagesByConversation = new Map();
    for (const message of messages) {
      const list = messagesByConversation.get(message.conversation_id) || [];
      list.push(message);
      messagesByConversation.set(message.conversation_id, list);
    }

    const { rows: orderRows } = await pool.query(
      `SELECT customer_phone AS phone, items, created_at
         FROM orders
        WHERE organization_id = $1 AND status <> 'cancelled'
          AND created_at >= $2::date - INTERVAL '365 days'
       UNION ALL
       SELECT customer_phone AS phone, items::text,
              COALESCE(shopify_created_at, synced_at) AS created_at
         FROM shopify_orders
        WHERE organization_id = $1
          AND LOWER(COALESCE(financial_status, '')) NOT IN ('voided','refunded')
          AND COALESCE(shopify_created_at, synced_at) >= $2::date - INTERVAL '365 days'`,
      [req.orgId, from]
    );
    const historyByPhone = new Map();
    for (const order of orderRows) {
      const phone = purchaseProbability.canonicalPhone(order.phone);
      if (!phone) continue;
      const eggs = purchaseProbability.eggsFromOrderItems(order.items);
      if (!eggs) continue;
      const list = historyByPhone.get(phone) || [];
      list.push({ eggs, createdAt: order.created_at });
      historyByPhone.set(phone, list);
    }

    const snapshots = conversations.map(conversation => {
      const phone = purchaseProbability.canonicalPhone(conversation.phone_number);
      const history = historyByPhone.get(phone) || [];
      const score = purchaseProbability.scoreConversation({
        messages: messagesByConversation.get(conversation.id) || [],
        pipelineState: conversation.opt_out ? 'opted_out' : conversation.pipeline_state,
        priorOrders: conversation.total_orders,
        lastOrderAt: conversation.last_order_at || history.map(item => item.createdAt).sort().at(-1) || null,
        historicalEggs: history.map(item => item.eggs),
        now: evaluatedAt,
      });
      return {
        conversation_id: conversation.id,
        evaluation_date: evaluationDate,
        evaluated_at: evaluatedAt.toISOString(),
        source_from: from,
        source_to: to,
        model_version: score.modelVersion,
        probability_24h: score.probability24h,
        probability_48h: score.probability48h,
        estimated_eggs: score.estimatedEggs,
        expected_eggs_24h: score.expectedEggs24h,
        expected_eggs_48h: score.expectedEggs48h,
        estimate_source: score.estimateSource,
        stage: score.stage,
        blocker: score.blocker,
        signals: score.signals,
        recommended_action: score.recommendedAction,
        explanation: score.explanation,
        score_inputs: {
          rawPoints: score.rawPoints,
          lastInboundAt: score.lastInboundAt,
          priorOrders: conversation.total_orders,
          lastOrderAt: conversation.last_order_at,
        },
      };
    });

    await pool.query(
      `INSERT INTO conversation_purchase_scores
        (organization_id, conversation_id, evaluation_date, evaluated_at, source_from, source_to,
         model_version, probability_24h, probability_48h, estimated_eggs,
         expected_eggs_24h, expected_eggs_48h, estimate_source, stage, blocker,
         signals, recommended_action, explanation, score_inputs)
       SELECT $1, x.conversation_id, x.evaluation_date, x.evaluated_at, x.source_from, x.source_to,
              x.model_version, x.probability_24h, x.probability_48h, x.estimated_eggs,
              x.expected_eggs_24h, x.expected_eggs_48h, x.estimate_source, x.stage, x.blocker,
              x.signals, x.recommended_action, x.explanation, x.score_inputs
         FROM jsonb_to_recordset($2::jsonb) AS x(
           conversation_id INTEGER, evaluation_date DATE, evaluated_at TIMESTAMPTZ,
           source_from DATE, source_to DATE, model_version TEXT,
           probability_24h NUMERIC, probability_48h NUMERIC, estimated_eggs INTEGER,
           expected_eggs_24h NUMERIC, expected_eggs_48h NUMERIC, estimate_source TEXT,
           stage TEXT, blocker TEXT, signals JSONB, recommended_action TEXT,
           explanation TEXT, score_inputs JSONB
         )
       ON CONFLICT (organization_id, conversation_id, evaluation_date, model_version, source_from, source_to)
       DO UPDATE SET
         evaluated_at = EXCLUDED.evaluated_at, source_from = EXCLUDED.source_from,
         source_to = EXCLUDED.source_to, probability_24h = EXCLUDED.probability_24h,
         probability_48h = EXCLUDED.probability_48h, estimated_eggs = EXCLUDED.estimated_eggs,
         expected_eggs_24h = EXCLUDED.expected_eggs_24h,
         expected_eggs_48h = EXCLUDED.expected_eggs_48h,
         estimate_source = EXCLUDED.estimate_source, stage = EXCLUDED.stage,
         blocker = EXCLUDED.blocker, signals = EXCLUDED.signals,
         recommended_action = EXCLUDED.recommended_action,
         explanation = EXCLUDED.explanation, score_inputs = EXCLUDED.score_inputs,
         actual_bought_24h = NULL, actual_bought_48h = NULL,
         actual_order_id = NULL, actual_eggs = NULL, outcome_checked_at = NULL,
         updated_at = NOW()`,
      [req.orgId, JSON.stringify(snapshots)]
    );

    const data = await purchaseScoreResponse(pool, req.orgId, from, to, evaluationDate);
    res.json({ success: true, from, to, evaluationDate, modelVersion: purchaseProbability.MODEL_VERSION, ...data });
  } catch (err) {
    console.error('[BotEval/purchase-probability recalculate]', err.message);
    res.status(500).json({ success: false, error: 'No se pudo recalcular la probabilidad de compra' });
  }
});

module.exports = router;
