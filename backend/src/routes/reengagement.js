/**
 * reengagement.js — Pronóstico de compra con IA
 *
 * GET  /api/reengagement/candidates   → Claude analiza comportamiento de cada cliente
 *                                       y predice cuándo comprará próximamente
 * POST /api/reengagement/generate     → mensaje personalizado para un cliente
 * POST /api/reengagement/send         → envía WhatsApp
 * POST /api/reengagement/send-bulk    → envía a varios clientes
 */

const express   = require('express');
const router    = express.Router();
const db             = require('../db/database');
const { getPool }    = require('../db/database');
const shopifyApi = require('../services/shopify-api');
const Anthropic = require('@anthropic-ai/sdk');
const { requireAuth } = require('../middleware/auth');
const { runBacktesting, applyCalibration } = require('../services/reengagement-calibration');

router.use(requireAuth);

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Cache en memoria: sesión actual (respaldo al cache de DB)
const analysisCache = new Map();
const CACHE_TTL = 2 * 60 * 60 * 1000;

/* ─────────────────────────────────────────────────────────────────────
   ESTADÍSTICAS POR CLIENTE
   Agrupa órdenes de Shopify por teléfono y calcula métricas de
   comportamiento para alimentar el modelo predictivo de la IA.
───────────────────────────────────────────────────────────────────── */
/** Normaliza teléfono: quita espacios, asegura formato +56XXXXXXXXX */
function normalizePhone(raw) {
  if (!raw) return null;
  let p = raw.replace(/\s+/g, '').replace(/[^+\d]/g, '');
  // Si empieza con 9 y tiene 9 dígitos → asumir Chile
  if (/^9\d{8}$/.test(p)) p = '+56' + p;
  // Si empieza con 56 sin + y tiene 11 dígitos
  if (/^56\d{9}$/.test(p)) p = '+' + p;
  return p.length >= 8 ? p : null;
}

function buildCustomerStats(orders) {
  const map = new Map();
  const DOW = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];

  for (const order of orders) {
    const rawPhone =
      order.customer?.phone ||
      order.shippingAddress?.phone ||
      order.billingAddress?.phone ||
      null;

    const phone = normalizePhone(rawPhone);
    if (!phone) continue;

    const name =
      order.customer?.displayName ||
      order.customer?.name ||
      (order.shippingAddress
        ? `${order.shippingAddress.firstName || ''} ${order.shippingAddress.lastName || ''}`.trim()
        : null) ||
      (order.billingAddress
        ? `${order.billingAddress.firstName || ''} ${order.billingAddress.lastName || ''}`.trim()
        : null) ||
      phone;

    const date  = new Date(order.createdAt);
    const price = parseFloat(order.totalPrice) || 0;
    const items = (order.lineItems || []).map(li => li.title).filter(Boolean);

    if (!map.has(phone)) {
      map.set(phone, {
        phone,
        name,
        email:     order.customer?.email || null,
        orders:    [],
        dowCounts: [0,0,0,0,0,0,0],
      });
    }
    const s = map.get(phone);
    if (name.length > s.name.length) s.name = name;
    s.orders.push({ date, price, items, orderName: order.name });
    s.dowCounts[date.getDay()]++;
    items.forEach(i => {
      if (!s.products) s.products = new Set();
      s.products.add(i);
    });
  }

  const now = Date.now();
  const stats = [];

  for (const [, s] of map) {
    if (!s.orders.length) continue;
    s.orders.sort((a, b) => a.date - b.date);

    const last         = s.orders[s.orders.length - 1];
    const daysInactive = Math.round((now - last.date.getTime()) / 86400000);
    const totalSpent   = s.orders.reduce((t, o) => t + o.price, 0);
    const avgOrderVal  = Math.round(totalSpent / s.orders.length);

    const gaps = [];
    for (let i = 1; i < s.orders.length; i++) {
      gaps.push(Math.round((s.orders[i].date - s.orders[i-1].date) / 86400000));
    }
    const avgFreqDays = gaps.length
      ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length)
      : null;

    let freqStdDev = null;
    if (gaps.length >= 2) {
      const mean = avgFreqDays;
      const variance = gaps.reduce((s, g) => s + Math.pow(g - mean, 2), 0) / gaps.length;
      freqStdDev = Math.round(Math.sqrt(variance));
    }

    const maxDow  = s.dowCounts.indexOf(Math.max(...s.dowCounts));
    const favDay  = DOW[maxDow];

    let spendTrend = 'estable';
    if (s.orders.length >= 3) {
      const first = s.orders.slice(0, Math.ceil(s.orders.length / 2)).reduce((t, o) => t + o.price, 0);
      const latter = s.orders.slice(Math.ceil(s.orders.length / 2)).reduce((t, o) => t + o.price, 0);
      const ratio = latter / (first || 1);
      if (ratio > 1.2) spendTrend = 'creciente';
      else if (ratio < 0.8) spendTrend = 'decreciente';
    }

    const recentOrders = s.orders.slice(-5).map(o => ({
      date: o.date.toISOString().slice(0,10),
      daysAgo: Math.round((now - o.date.getTime()) / 86400000),
      price: Math.round(o.price),
      items: o.items.slice(0, 2).join(', '),
    }));

    stats.push({
      phone:        s.phone,
      name:         s.name,
      email:        s.email,
      totalOrders:  s.orders.length,
      totalSpent:   Math.round(totalSpent),
      avgOrderVal,
      daysInactive,
      lastOrderDate: last.date.toISOString().slice(0, 10),
      lastProducts: (last.items || []).slice(0, 3).join(', '),
      avgFreqDays,
      freqStdDev,
      favDay,
      spendTrend,
      recentOrders,
      dowCounts: s.dowCounts,
    });
  }

  return stats;
}

/* ─────────────────────────────────────────────────────────────────────
   PREDICCIÓN MATEMÁTICA DE RESPALDO
   Usada cuando la IA falla o para clientes con ciclo claro.
   Returns { predictedDays, confidence, aiReason, source }
───────────────────────────────────────────────────────────────────── */
function heuristicPredict(c) {
  if (!c.avgFreqDays) {
    // Solo 1 pedido: asumir ciclo de 14 días desde la última compra
    const d = 14 - c.daysInactive;
    return { predictedDays: d, confidence: 40, aiReason: '1 compra, ciclo est. 14d', source: 'heuristic' };
  }

  const d    = c.avgFreqDays - c.daysInactive;  // negativo = ya venció
  const cv   = c.freqStdDev != null ? c.freqStdDev / c.avgFreqDays : 1;
  // Confianza: baja si coeficiente de variación > 0.5, alta si < 0.2
  let conf = 75 - Math.round(cv * 50);
  // Más pedidos → más confianza
  conf += Math.min(15, c.totalOrders * 2);
  conf = Math.max(25, Math.min(85, conf));

  return { predictedDays: d, confidence: conf, aiReason: `ciclo ${c.avgFreqDays}d`, source: 'heuristic' };
}

/* ─────────────────────────────────────────────────────────────────────
   MODELO PREDICTIVO DE IA
   Batches pequeños (20) con max_tokens alto para evitar truncamiento.
   Si el JSON llega cortado, se recuperan las entradas completas.
───────────────────────────────────────────────────────────────────── */
async function predictWithAI(customers, todayDow) {
  const D = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];
  const now      = new Date();
  const todayISO = now.toISOString().slice(0, 10);
  const todayD   = D[todayDow];

  const T = c => c.spendTrend === 'creciente' ? '↑' : c.spendTrend === 'decreciente' ? '↓' : '=';
  const nextDate = c => c.avgFreqDays
    ? new Date(now.getTime() + (c.avgFreqDays - c.daysInactive) * 86400000).toISOString().slice(5,10)
    : '?';

  const rows = customers.map((c, i) => {
    const freq   = c.avgFreqDays ? `${c.avgFreqDays}±${c.freqStdDev ?? '?'}` : '?';
    const ov     = c.avgFreqDays && c.daysInactive > c.avgFreqDays ? `!${c.daysInactive - c.avgFreqDays}` : '';
    const dates  = c.recentOrders.slice(-3).map(o => o.date.slice(5)).join(',');
    return `${i+1}|${c.phone}|${c.daysInactive}${ov}|${freq}|${nextDate(c)}|${c.favDay}|${c.totalOrders}|${T(c)}|${dates}`;
  }).join('\n');

  const prompt =
`Analiza clientes recurrentes y predice días hasta próxima compra. HOY:${todayISO}(${todayD})
Cols: #|tel|inac(días,!vencidoDías)|freq±dev|próxEst(MM-DD)|favDía|nPedidos|trend|últ3compras(MM-DD)
${rows}
Reglas:
- d = días hasta próxima compra (negativo si ya venció el ciclo)
- inac>freq → d negativo (ya debería haber comprado)
- dev pequeño (<5) → conf alta (patrón muy regular)
- 1 pedido → usar ciclo 7-30d según categoría, conf 40-50
- trend↑ → reducir d levemente
- c = 0-100 (confianza basada en regularidad del patrón)
RESPONDER SOLO JSON (sin texto extra): [{"t":"TEL_EXACTO","d":DIAS_INT,"c":CONF_INT,"r":"razon max 6 palabras"}]
Incluir TODOS los ${customers.length} clientes. Ordenar por d ascendente.`;

  let raw = '';
  try {
    const response = await anthropic.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 8192,
      messages:   [{ role: 'user', content: prompt }],
    });
    raw = response.content[0]?.text?.trim() || '[]';
  } catch (apiErr) {
    console.error('[Reengagement] Error llamando a IA:', apiErr.message);
    return [];
  }

  // Intentar extraer JSON completo
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) {
    console.error('[Reengagement] AI no devolvió JSON válido:', raw.slice(0, 300));
    return [];
  }

  try {
    const parsed = JSON.parse(match[0]);
    console.log(`[Reengagement] IA devolvió ${parsed.length}/${customers.length} predicciones`);
    return parsed.map(r => ({
      phone:         r.t,
      predictedDays: typeof r.d === 'number' ? r.d : null,
      confidence:    typeof r.c === 'number' ? r.c : 50,
      aiReason:      r.r || null,
      source:        'ai',
    }));
  } catch {
    // JSON truncado: recuperar entradas completas con regex
    console.warn('[Reengagement] JSON truncado, recuperando entradas parciales...');
    const entries = [];
    const entryRx = /\{"t"\s*:\s*"([^"]+)"\s*,\s*"d"\s*:\s*(-?\d+)\s*,\s*"c"\s*:\s*(\d+)\s*,\s*"r"\s*:\s*"([^"]*)"\s*\}/g;
    let m;
    while ((m = entryRx.exec(raw)) !== null) {
      entries.push({ phone: m[1], predictedDays: parseInt(m[2]), confidence: parseInt(m[3]), aiReason: m[4], source: 'ai' });
    }
    console.log(`[Reengagement] Recuperadas ${entries.length} entradas de JSON truncado`);
    return entries;
  }
}

/* ─────────────────────────────────────────────────────────────────────
   Set de orgs cuyo análisis corre en segundo plano
───────────────────────────────────────────────────────────────────── */
const bgProcessing = new Set();

/* ─────────────────────────────────────────────────────────────────────
   ANÁLISIS COMPLETO — función standalone reutilizable
   Devuelve { enriched, diagnostico } o null si no hay datos.
───────────────────────────────────────────────────────────────────── */
async function runFullAnalysis(orgId, ds) {
  const today = new Date().toISOString().slice(0, 10);
  const { shop, token } = shopifyApi.credentialsFrom(ds);
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  console.log(`[Reengagement] Descargando órdenes de ${shop}...`);
  let allOrders = [];
  let cursor = null; let page = 0;
  while (true) {
    page++;
    const result = await shopifyApi.getOrders(shop, token, { limit: 250, cursor, status: 'any' });
    const validas = (result.orders || []).filter(o => {
      const fs = (o.financialStatus || '').toUpperCase();
      return fs !== 'VOIDED' && fs !== 'REFUNDED';
    });
    allOrders = allOrders.concat(validas);
    if (!result.hasNextPage || !result.endCursor || page >= 50) break;
    cursor = result.endCursor;
    await sleep(300);
  }
  console.log(`[Reengagement] Total órdenes: ${allOrders.length}`);
  if (!allOrders.length) return null;

  const conCustomerPhone = allOrders.filter(o => normalizePhone(o.customer?.phone)).length;
  const sinPhone         = allOrders.length - conCustomerPhone;
  const conShippingPhone = allOrders.filter(o =>
    !normalizePhone(o.customer?.phone) &&
    (normalizePhone(o.shippingAddress?.phone) || normalizePhone(o.billingAddress?.phone))
  ).length;
  console.log(`[Reengagement] Teléfonos — customer: ${conCustomerPhone} | shipping/billing: ${conShippingPhone} | sin phone: ${sinPhone - conShippingPhone}`);

  const toNumericId = (id) => String(id || '').replace(/[^0-9]/g, '');
  const ordenesSinPhoneConId = allOrders.filter(o => !normalizePhone(o.customer?.phone) && o.customer?.id);
  console.log(`[Reengagement] Órdenes sin teléfono con customerId: ${ordenesSinPhoneConId.length}`);

  if (ordenesSinPhoneConId.length > 0) {
    try {
      const phoneMap = new Map();
      let cur2 = undefined; let pg2 = 0;
      while (true) {
        pg2++;
        const result = await shopifyApi.getCustomers(shop, token, { limit: 100, cursor: cur2 });
        for (const c of (result.customers || [])) {
          const phone = normalizePhone(c.phone);
          if (!phone) continue;
          const entry  = { phone, name: c.name || phone, email: c.email };
          const numId  = toNumericId(c.id);
          const fullId = String(c.id || '');
          if (numId)   phoneMap.set(numId, entry);
          if (fullId)  phoneMap.set(fullId, entry);
          if (c.email) phoneMap.set(c.email.toLowerCase(), entry);
        }
        if (!result.hasNextPage || !result.endCursor || pg2 >= 50) break;
        cur2 = result.endCursor;
        await sleep(300);
      }
      let enriquecidas = 0;
      for (const order of allOrders) {
        if (normalizePhone(order.customer?.phone)) continue;
        if (!order.customer) continue;
        const rawId = String(order.customer.id || '');
        const email = (order.customer.email || '').toLowerCase();
        const ed = phoneMap.get(rawId) || phoneMap.get(toNumericId(rawId)) || (email ? phoneMap.get(email) : null);
        if (ed) { order.customer.phone = ed.phone; if (!order.customer.name) order.customer.name = ed.name; enriquecidas++; }
      }
      console.log(`[Reengagement] Órdenes enriquecidas con catálogo: ${enriquecidas}`);
    } catch (err) {
      console.warn('[Reengagement] No se pudo enriquecer con catálogo:', err.message);
    }
  }

  const allStats = buildCustomerStats(allOrders);
  console.log(`[Reengagement] Clientes únicos con teléfono: ${allStats.length}`);
  if (!allStats.length) return null;

  const todayDow = new Date().getDay();
  let aiResults  = [];
  const BATCH = 20;
  for (let i = 0; i < allStats.length; i += BATCH) {
    const batch  = allStats.slice(i, i + BATCH);
    const result = await predictWithAI(batch, todayDow);
    aiResults = aiResults.concat(result);
    console.log(`[Reengagement] Batch ${Math.floor(i/BATCH)+1}/${Math.ceil(allStats.length/BATCH)}: ${result.length}/${batch.length}`);
    if (i + BATCH < allStats.length) await sleep(400);
  }
  console.log(`[Reengagement] AI: ${aiResults.length}/${allStats.length} predicciones`);

  const aiMap = new Map(aiResults.map(r => [r.phone, r]));

  let calibration = await db.getCalibration(orgId);
  if (!calibration && allOrders.length > 0) {
    try {
      const bt = runBacktesting(allOrders, normalizePhone);
      await db.saveCalibration(orgId, bt);
      console.log(`[Reengagement] Backtesting: factor=${bt.calibrationFactor}, accuracy=${Math.round(bt.accuracyRate*100)}%`);
      calibration = await db.getCalibration(orgId);
    } catch (e) { console.warn('[Reengagement] Backtesting error:', e.message); }
  }

  let aiHits = 0, heuristicHits = 0;

  const enriched = allStats.map(c => {
    const aiEntry = aiMap.get(c.phone);
    let predictedDays, confidenceRaw, aiReason, predSource;

    if (aiEntry && aiEntry.predictedDays !== null && aiEntry.predictedDays !== undefined) {
      predictedDays = aiEntry.predictedDays;
      confidenceRaw = aiEntry.confidence || 50;
      aiReason      = aiEntry.aiReason || null;
      predSource    = 'ai';
      aiHits++;
    } else {
      const h       = heuristicPredict(c);
      predictedDays = h.predictedDays;
      confidenceRaw = h.confidence;
      aiReason      = h.aiReason;
      predSource    = 'heuristic';
      heuristicHits++;
    }

    const confidence = applyCalibration(confidenceRaw, calibration);

    let buyWindow, urgency;
    if      (predictedDays <= 1)   { buyWindow = 'hoy';    urgency = 4; }
    else if (predictedDays <= 7)   { buyWindow = 'semana'; urgency = 3; }
    else if (predictedDays <= 30)  { buyWindow = 'mes';    urgency = 2; }
    else                           { buyWindow = 'lejano'; urgency = 1; }

    return { ...c, predictedDays, confidenceRaw, confidence, aiReason, predSource, buyWindow, urgency };
  })
  .filter(c => c.predictedDays <= 365)   // mostrar hasta 1 año
  .sort((a, b) => a.predictedDays - b.predictedDays);

  console.log(`[Reengagement] Resultado: IA=${aiHits} | heurística=${heuristicHits} | total=${enriched.length}`);

  // Guardar caché del día
  try {
    await db.saveDailyCache(orgId, today, enriched);
    await db.savePredictions(orgId, enriched, today);
    console.log(`[Reengagement] Cache guardado: ${today} (${enriched.length} candidatos)`);
  } catch (e) { console.warn('[Reengagement] Error guardando cache:', e.message); }

  analysisCache.set(orgId, { data: enriched, ts: Date.now() });

  // Log resumen en consola
  ['hoy','semana','mes','lejano'].forEach(w => {
    const g = enriched.filter(c => c.buyWindow === w);
    if (g.length) console.log(`  ${w.toUpperCase()}: ${g.length} clientes`);
  });

  const diagnostico = {
    totalOrdenes:      allOrders.length,
    clientesConTel:    allStats.length,
    sinTelefono:       sinPhone - conShippingPhone,
    conShippingPhone,
    conPrediccionAI:   aiHits,
    conPrediccionHeur: heuristicHits,
    enVentana:         enriched.length,
  };
  console.log(`[Reengagement] Diag: ${JSON.stringify(diagnostico)}`);

  return { enriched, diagnostico };
}

/* ─────────────────────────────────────────────────────────────────────
   GET /api/reengagement/candidates?refresh=false
───────────────────────────────────────────────────────────────────── */
router.get('/candidates', async (req, res) => {
  try {
    const ds = await db.getPrimaryDataSource(req.orgId);
    if (!ds) return res.json({ success: true, data: [], total: 0 });

    const refresh = req.query.refresh === 'true';
    const today   = new Date().toISOString().slice(0, 10);

    // ── 1. Cache en memoria ──────────────────────────────────────────
    const memCached = analysisCache.get(req.orgId);
    if (!refresh && memCached && Date.now() - memCached.ts < CACHE_TTL) {
      return res.json({ success: true, data: memCached.data, total: memCached.data.length, fromCache: true, cacheSource: 'memory' });
    }

    // ── 2. Refresh solicitado → iniciar en SEGUNDO PLANO y retornar ──
    if (refresh) {
      if (bgProcessing.has(req.orgId)) {
        // Ya está corriendo — devolver caché anterior si existe
        const dbCached = await db.getDailyCache(req.orgId, today);
        if (dbCached) {
          const data = Array.isArray(dbCached) ? dbCached : JSON.parse(dbCached);
          return res.json({ success: true, data, total: data.length, fromCache: true, cacheSource: 'db_stale', refreshing: true });
        }
        return res.json({ success: true, data: [], total: 0, refreshing: true, message: 'Análisis en progreso...' });
      }

      // Limpiar caché y arrancar
      try { await db.saveDailyCache(req.orgId, today, null); } catch {}
      analysisCache.delete(req.orgId);
      bgProcessing.add(req.orgId);
      runFullAnalysis(req.orgId, ds).finally(() => bgProcessing.delete(req.orgId));

      // Retornar inmediatamente sin esperar
      return res.json({
        success: true, data: [], total: 0, refreshing: true,
        message: 'Análisis iniciado en segundo plano. Recarga la página en 3-5 minutos.',
      });
    }

    // ── 3. Cache en DB (mismo día) ───────────────────────────────────
    const dbCached = await db.getDailyCache(req.orgId, today);
    if (dbCached && (Array.isArray(dbCached) ? dbCached.length > 0 : JSON.parse(dbCached).length > 0)) {
      const candidates = Array.isArray(dbCached) ? dbCached : JSON.parse(dbCached);
      analysisCache.set(req.orgId, { data: candidates, ts: Date.now() });
      return res.json({ success: true, data: candidates, total: candidates.length, fromCache: true, cacheSource: 'db', cacheDate: today });
    }

    // ── 4. Análisis completo (primera carga del día) ─────────────────
    bgProcessing.add(req.orgId);
    const result = await runFullAnalysis(req.orgId, ds).finally(() => bgProcessing.delete(req.orgId));

    if (!result) return res.json({ success: true, data: [], total: 0, message: 'Sin órdenes o teléfonos en Shopify' });

    res.json({
      success:     true,
      data:        result.enriched,
      total:       result.enriched.length,
      fromCache:   false,
      diagnostico: result.diagnostico,
    });

  } catch (err) {
    console.error('[Reengagement] error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ─────────────────────────────────────────────────────────────────────
   POST /api/reengagement/generate
───────────────────────────────────────────────────────────────────── */
router.post('/generate', async (req, res) => {
  try {
    const { phone } = req.body;
    const cached    = analysisCache.get(req.orgId);
    const c         = cached?.data?.find(x => x.phone === phone) || {};

    const prompt = `Eres el asistente de ventas de una tienda de productos frescos del campo (huevos, aceitunas, quesos, miel y más).

Cliente: ${c.name || phone}
Última compra: hace ${c.daysInactive || '?'} días (${c.lastOrderDate || '—'})
Productos que compra: ${c.lastProducts || 'productos frescos'}
${c.avgFreqDays ? `Compra habitualmente cada ~${c.avgFreqDays} días` : ''}
${c.predictedDays <= 1 ? 'La IA predice que comprará HOY o MAÑANA.' : c.predictedDays <= 7 ? `La IA predice que comprará en ~${c.predictedDays} días.` : ''}
${c.aiReason ? `Contexto: ${c.aiReason}` : ''}

Escribe un mensaje de WhatsApp CORTO (máximo 3 líneas) y cálido.
- Tono cercano, como si fuera de un amigo que le recuerda los productos frescos
- Menciona su producto habitual si es relevante
- Si está próximo a su ciclo de compra, puedes insinuarlo sutilmente
- Máximo 2 emojis
- Termina con una pregunta o invitación suave
- Escribe SOLO el mensaje, nada más`;

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 200,
      messages: [{ role: 'user', content: prompt }],
    });

    res.json({ success: true, message: response.content[0]?.text?.trim() || '', phone });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ─────────────────────────────────────────────────────────────────────
   POST /api/reengagement/fill-template-vars
   La IA lee el texto del template, identifica las variables {{N}}, y las
   rellena con los datos del cliente de forma natural.

   Body: { phone, templateBody }
   Response: { vars: { "1": "Juan", "2": "huevos", ... } }
───────────────────────────────────────────────────────────────────── */
router.post('/fill-template-vars', async (req, res) => {
  try {
    const { phone, templateBody } = req.body;
    if (!phone || !templateBody) {
      return res.status(400).json({ success: false, error: 'phone y templateBody requeridos' });
    }

    // Buscar datos del cliente en el caché de análisis
    const cached = analysisCache.get(req.orgId);
    const c = cached?.data?.find(x => x.phone === phone) || {};

    // Extraer variables del template
    const varNums = [...new Set([...templateBody.matchAll(/\{\{(\d+)\}\}/g)].map(m => m[1]))].sort();
    if (varNums.length === 0) {
      return res.json({ success: true, vars: {} });
    }

    const daysLabel = c.daysInactive != null
      ? `${c.daysInactive} días`
      : 'unos días';

    const prompt =
`Eres un asistente de ventas. Debes rellenar las variables de un template de WhatsApp con los datos reales de un cliente.

TEMPLATE:
"${templateBody}"

DATOS DEL CLIENTE:
- Nombre: ${c.name || phone}
- Teléfono: ${phone}
- Última compra: hace ${daysLabel} (${c.lastOrderDate || '—'})
- Productos habituales: ${c.lastProducts || 'productos frescos'}
- Frecuencia de compra: ${c.avgFreqDays ? `cada ~${c.avgFreqDays} días` : 'variable'}
- La IA predice que compraría: ${c.predictedDays != null ? `en ~${c.predictedDays} días` : 'pronto'}
${c.aiReason ? `- Contexto IA: ${c.aiReason}` : ''}

Variables a rellenar: ${varNums.map(v => `{{${v}}}`).join(', ')}

Reglas:
- {{1}} normalmente es el nombre del cliente (usa solo su primer nombre)
- Usa los datos del cliente de forma natural, sin inventar información
- Textos cortos (máximo 1-3 palabras por variable, a menos que sea claramente un texto largo)
- Si no hay dato, usa un valor genérico apropiado

Responde SOLO con un objeto JSON, sin explicaciones:
{${varNums.map(v => `"${v}": "..."`).join(', ')}}`;

    const response = await anthropic.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages:   [{ role: 'user', content: prompt }],
    });

    const raw   = response.content[0]?.text?.trim() || '{}';
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) {
      console.error('[Reengagement/fill-vars] No JSON en respuesta:', raw);
      return res.json({ success: true, vars: {} });
    }

    const vars = JSON.parse(match[0]);
    res.json({ success: true, vars });
  } catch (err) {
    console.error('[Reengagement/fill-vars]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ─────────────────────────────────────────────────────────────────────
   GET /api/reengagement/templates
   Lista los templates aprobados de WhatsApp Business para esta org.
───────────────────────────────────────────────────────────────────── */
router.get('/templates', async (req, res) => {
  try {
    const wc = await db.getWhatsappConfig(req.orgId);
    if (!wc) return res.status(400).json({ success: false, error: 'WhatsApp no configurado' });

    if (wc.provider !== 'kapso' && wc.provider !== 'meta') {
      return res.json({ success: true, data: [], message: 'Templates solo disponibles para Kapso o Meta' });
    }

    const kapsoService = require('../services/kapso-whatsapp');
    const templates = await kapsoService.getTemplates(wc);

    // Normalizar y filtrar solo APPROVED
    const normalized = (Array.isArray(templates) ? templates : []).filter(t =>
      !t.status || t.status === 'APPROVED' || t.status === 'approved'
    ).map(t => ({
      name:       t.name,
      language:   t.language,
      status:     t.status,
      category:   t.category,
      components: t.components || [],
    }));

    res.json({ success: true, data: normalized, total: normalized.length });
  } catch (err) {
    console.error('[Reengagement/templates]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/reengagement/generate-templates
 * Usa IA para generar 5 templates de re-engagement personalizados para la tienda.
 */
router.post('/generate-templates', async (req, res) => {
  try {
    const orgId = req.user.orgId;
    const db    = require('../db/database.js');
    const shopifyApi = require('../services/shopify-api.js');
    const Anthropic  = require('@anthropic-ai/sdk');

    // Obtener datos de la tienda
    const ds = await db.getPrimaryDataSource(orgId);
    let storeContext = 'Tienda online';
    let shopName = 'la tienda';

    if (ds) {
      try {
        const { shop } = shopifyApi.credentialsFrom(ds);
        shopName = shop.replace('.myshopify.com', '').replace(/-/g, ' ');

        // Obtener productos top
        const products = await shopifyApi.getProducts(ds, { first: 15 });
        const productNames = (products || []).slice(0, 10).map(p => p.title).filter(Boolean);

        // Obtener org name
        const org = await db.getOrgById(orgId);
        const orgName = org?.name || shopName;

        storeContext = `
Nombre de la tienda: ${orgName}
Dominio Shopify: ${shop}
Productos principales: ${productNames.join(', ') || 'varios productos'}
        `.trim();
      } catch (e) {
        console.warn('[generate-templates] Error obteniendo datos Shopify:', e.message);
      }
    }

    const client = new Anthropic();
    const prompt = `Eres un experto en marketing de WhatsApp para e-commerce latinoamericano.

Datos de la tienda:
${storeContext}

Genera exactamente 5 templates de WhatsApp Business para re-engagement de clientes (clientes que compraron antes pero no han vuelto). Los templates se envían a Meta para aprobación.

REGLAS ESTRICTAS:
- name: solo minúsculas, números y guiones bajos (ej: "reenganche_general")
- category: siempre "MARKETING"
- language: "es"
- El BODY debe tener máximo 1024 caracteres
- Usa {{1}} para nombre del cliente (siempre la primera variable)
- Usa {{2}} para un dato de la tienda si aplica
- El footer siempre: "Responde STOP para no recibir mensajes"
- NO incluir URLs ni emojis en el header
- El tono debe ser cálido, cercano y latinoamericano

Los 5 templates deben ser:
1. Re-engagement general (hace tiempo sin comprar)
2. Novedad de productos (hay cosas nuevas)
3. Carrito o producto abandonado (interés previo detectado)
4. Oferta exclusiva para clientes anteriores
5. Seguimiento post-compra (¿cómo quedaste?)

Responde SOLO con JSON válido (sin markdown):
{
  "templates": [
    {
      "name": "nombre_snake_case",
      "displayName": "Nombre legible",
      "category": "MARKETING",
      "language": "es",
      "headerText": "Texto del header (sin variables, max 60 chars)",
      "body": "Cuerpo del mensaje con {{1}} para nombre...",
      "footer": "Responde STOP para no recibir mensajes",
      "variables": ["nombre del cliente", "descripción de variable 2 si existe"],
      "useCase": "Descripción breve del cuándo usar este template"
    }
  ]
}`;

    const msg = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 3000,
      messages:   [{ role: 'user', content: prompt }],
    });

    const raw = msg.content[0]?.text || '';
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const match = raw.match(/\{[\s\S]*\}/);
      parsed = match ? JSON.parse(match[0]) : { templates: [] };
    }

    return res.json({ success: true, templates: parsed.templates || [] });
  } catch (err) {
    console.error('[generate-templates]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/reengagement/submit-templates
 * Envía templates a Meta via Kapso para revisión.
 * Body: { templates: [{name, category, language, headerText, body, footer}] }
 */
router.post('/submit-templates', async (req, res) => {
  try {
    const orgId    = req.user.orgId;
    const { templates } = req.body;
    if (!Array.isArray(templates) || templates.length === 0) {
      return res.status(400).json({ success: false, error: 'templates array requerido' });
    }

    const db           = require('../db/database.js');
    const kapsoService = require('../services/kapso-whatsapp.js');

    const wc = await db.getWhatsAppConfig(orgId);
    if (!wc || (wc.provider !== 'kapso' && wc.provider !== 'meta')) {
      return res.status(400).json({ success: false, error: 'Requiere proveedor Kapso o Meta' });
    }

    const results = [];
    for (const t of templates) {
      try {
        // Construir componentes Meta
        const components = [];
        if (t.headerText) {
          components.push({ type: 'HEADER', format: 'TEXT', text: t.headerText });
        }
        const bodyComp = { type: 'BODY', text: t.body };
        // Agregar ejemplos de variables si las hay
        const varMatches = [...(t.body || '').matchAll(/\{\{(\d+)\}\}/g)];
        if (varMatches.length > 0) {
          const exampleValues = (t.variables || []).map((v, i) => v || `Ejemplo ${i+1}`);
          bodyComp.example = { body_text: [exampleValues.slice(0, varMatches.length)] };
        }
        components.push(bodyComp);
        if (t.footer) {
          components.push({ type: 'FOOTER', text: t.footer });
        }

        const payload = {
          name:       t.name,
          language:   t.language || 'es',
          category:   t.category || 'MARKETING',
          components,
        };

        const apiResult = await kapsoService.createTemplate(payload, wc);
        results.push({ name: t.name, status: 'submitted', id: apiResult?.id });
      } catch (err) {
        const errMsg = err.response?.data ? JSON.stringify(err.response.data) : err.message;
        results.push({ name: t.name, status: 'error', error: errMsg });
      }
    }

    const allOk    = results.every(r => r.status === 'submitted');
    const someOk   = results.some(r => r.status === 'submitted');
    res.json({
      success: someOk,
      results,
      message: allOk
        ? `${results.length} templates enviados a Meta. Revisión en 1-3 días hábiles.`
        : `${results.filter(r => r.status === 'submitted').length}/${results.length} templates enviados. Algunos fallaron.`,
    });
  } catch (err) {
    console.error('[submit-templates]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ─────────────────────────────────────────────────────────────────────
   POST /api/reengagement/send
   Soporta dos modos:
     A) Texto libre:  { phone, message }
     B) Template:     { phone, templateName, languageCode?, components? }
───────────────────────────────────────────────────────────────────── */
router.post('/send', async (req, res) => {
  try {
    const { phone, message, templateName, languageCode, components } = req.body;
    if (!phone) return res.status(400).json({ success: false, error: 'phone requerido' });

    const isTemplate = !!templateName;
    if (!isTemplate && !message) {
      return res.status(400).json({ success: false, error: 'message o templateName requerido' });
    }

    const wc = await db.getWhatsappConfig(req.orgId);
    if (!wc) return res.status(400).json({ success: false, error: 'WhatsApp no configurado' });

    let sentResult;
    let savedContent;

    if (isTemplate) {
      // ── Modo Template ───────────────────────────────────────────
      if (wc.provider !== 'kapso' && wc.provider !== 'meta') {
        return res.status(400).json({ success: false, error: 'Templates solo disponibles con Kapso o Meta' });
      }
      const kapsoService = require('../services/kapso-whatsapp');
      sentResult = await kapsoService.sendTemplate(
        phone, templateName, languageCode || 'es', components || [], wc
      );
      savedContent = `[Template: ${templateName}]`;
    } else {
      // ── Modo Texto libre ─────────────────────────────────────────
      if (wc.provider === 'twilio') {
        sentResult = await require('../services/twilio-whatsapp').sendTextMessage(phone, message, wc);
      } else if (wc.provider === 'kapso') {
        sentResult = await require('../services/kapso-whatsapp').sendTextMessage(phone, message, wc);
      } else {
        sentResult = await require('../services/whatsapp').sendTextMessage(phone, message, wc);
      }
      savedContent = message;
    }

    // Guardar en conversación si existe
    const { rows } = await getPool().query(
      'SELECT id FROM conversations WHERE phone_number = $1 AND organization_id = $2 LIMIT 1',
      [phone, req.orgId]
    );
    const convId = rows[0]?.id;

    if (convId) {
      await db.saveMessage({
        conversationId:    convId,
        whatsappMessageId: sentResult?.messages?.[0]?.id || `reeng_${Date.now()}`,
        content:           savedContent,
        direction:         'outbound',
        type:              isTemplate ? 'template' : 'text',
        sentBy:            'ai',
      });
    }

    res.json({ success: true, phone });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ─────────────────────────────────────────────────────────────────────
   POST /api/reengagement/send-bulk
   Soporta dos modos por ítem:
     A) Texto libre:  { phone, message }
     B) Template:     { phone, templateName, languageCode?, components? }
───────────────────────────────────────────────────────────────────── */
router.post('/send-bulk', async (req, res) => {
  const { items } = req.body;
  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ success: false, error: 'items[] requerido' });
  }

  const wc = await db.getWhatsappConfig(req.orgId);
  if (!wc) return res.status(400).json({ success: false, error: 'WhatsApp no configurado' });

  const results = [];
  for (const item of items) {
    try {
      const isTemplate = !!item.templateName;
      let sentResult;
      let savedContent;

      if (isTemplate) {
        const kapsoService = require('../services/kapso-whatsapp');
        sentResult = await kapsoService.sendTemplate(
          item.phone, item.templateName, item.languageCode || 'es', item.components || [], wc
        );
        savedContent = `[Template: ${item.templateName}]`;
      } else {
        if (wc.provider === 'twilio') {
          sentResult = await require('../services/twilio-whatsapp').sendTextMessage(item.phone, item.message, wc);
        } else if (wc.provider === 'kapso') {
          sentResult = await require('../services/kapso-whatsapp').sendTextMessage(item.phone, item.message, wc);
        } else {
          sentResult = await require('../services/whatsapp').sendTextMessage(item.phone, item.message, wc);
        }
        savedContent = item.message;
      }

      const { rows } = await getPool().query(
        'SELECT id FROM conversations WHERE phone_number = $1 AND organization_id = $2 LIMIT 1',
        [item.phone, req.orgId]
      );
      const convId = rows[0]?.id;

      if (convId) {
        await db.saveMessage({
          conversationId:    convId,
          whatsappMessageId: sentResult?.messages?.[0]?.id || `reeng_${Date.now()}`,
          content:           savedContent,
          direction:         'outbound',
          type:              isTemplate ? 'template' : 'text',
          sentBy:            'ai',
        });
      }

      results.push({ phone: item.phone, success: true });
    } catch (err) {
      results.push({ phone: item.phone, success: false, error: err.message });
    }

    if (items.indexOf(item) < items.length - 1) {
      await new Promise(r => setTimeout(r, 1200));
    }
  }

  const sent   = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  res.json({ success: true, sent, failed, results });
});

/* ─────────────────────────────────────────────────────────────────────
   POST /api/reengagement/calibrate
   Corre backtesting completo con historial de Shopify y guarda
   el factor de calibración en DB. Se puede llamar manualmente
   o automáticamente cuando no existe calibración previa.
───────────────────────────────────────────────────────────────────── */
router.post('/calibrate', async (req, res) => {
  try {
    const ds = await db.getPrimaryDataSource(req.orgId);
    if (!ds) return res.status(400).json({ success: false, error: 'Sin fuente de datos configurada' });

    const { shop, token } = shopifyApi.credentialsFrom(ds);

    console.log(`[Calibration] Org ${req.orgId}: descargando historial para backtesting...`);

    // Descargar todas las órdenes (mismo flujo que /candidates)
    const sleepCal = ms => new Promise(r => setTimeout(r, ms));
    let calibOrders = [];
    let calibCursor = null;
    let calibPage   = 0;
    while (true) {
      calibPage++;
      const page = await shopifyApi.getOrders(shop, token, { limit: 250, cursor: calibCursor, status: 'any' });
      const validas = (page.orders || []).filter(o => {
        const fs = (o.financialStatus || '').toUpperCase();
        return fs !== 'VOIDED' && fs !== 'REFUNDED';
      });
      calibOrders = calibOrders.concat(validas);
      if (!page.hasNextPage || !page.endCursor || calibPage >= 50) break;
      calibCursor = page.endCursor;
      await sleepCal(300);
    }

    console.log(`[Calibration] Órdenes descargadas: ${calibOrders.length}`);

    if (calibOrders.length < 20) {
      return res.status(400).json({
        success: false,
        error: 'Historial insuficiente para calibración (necesitas al menos 20 órdenes)',
      });
    }

    // Correr backtesting
    const btResult = runBacktesting(calibOrders, normalizePhone);

    // Guardar en DB
    await db.saveCalibration(req.orgId, btResult);

    // Invalidar cache para que la próxima carga use la nueva calibración
    analysisCache.delete(req.orgId);

    console.log(`[Calibration] Org ${req.orgId}: factor=${btResult.calibrationFactor}, accuracy=${Math.round(btResult.accuracyRate*100)}%, simuladas=${btResult.totalPredictions}`);

    res.json({ success: true, data: btResult });
  } catch (err) {
    console.error('[Calibration]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ─────────────────────────────────────────────────────────────────────
   GET /api/reengagement/calibration
   Devuelve el estado actual de la calibración sin recalcular.
───────────────────────────────────────────────────────────────────── */
router.get('/calibration', async (req, res) => {
  try {
    const calibration = await db.getCalibration(req.orgId);
    res.json({ success: true, data: calibration });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ─────────────────────────────────────────────────────────────────────
   GET /api/reengagement/accuracy
   Estadísticas de accuracy de predicciones pasadas (outcomes reales).
───────────────────────────────────────────────────────────────────── */
router.get('/accuracy', async (req, res) => {
  try {
    const stats = await db.getAccuracyStats(req.orgId);
    const calibration = await db.getCalibration(req.orgId);
    res.json({ success: true, data: { outcomes: stats, calibration } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
