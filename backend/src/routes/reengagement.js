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
const db        = require('../db/database');
const { getPool } = require('../db/database');
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
   MODELO PREDICTIVO DE IA
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
`Tienda frescos Chile,ciclos~semanales. HOY:${todayISO}(${todayD})
Cols: #|tel|inac(días,!vencidoDías)|freq±dev|próxEst(MM-DD)|favDía|nPedidos|trend|últ3compras(MM-DD)
${rows}
Reglas: inac>freq→d<0; dev<3→conf alta; 1pedido→ciclo 7-14d; favDía mañana/pasado→restar días; trend↑→reducir d.
JSON SOLO:[{"t":"tel","d":int,"c":0-100,"r":"≤8palabras"}] todos,orden d asc.`;

  const response = await anthropic.messages.create({
    model:      'claude-haiku-4-5-20251001',
    max_tokens: 2500,
    messages:   [{ role: 'user', content: prompt }],
  });

  const raw   = response.content[0]?.text?.trim() || '[]';
  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) {
    console.error('[Reengagement] AI no devolvió JSON:', raw.slice(0, 200));
    return [];
  }

  try {
    const parsed = JSON.parse(match[0]);
    return parsed.map(r => ({
      phone:         r.t,
      predictedDays: r.d,
      confidence:    r.c,
      aiReason:      r.r,
    }));
  } catch {
    console.error('[Reengagement] AI parse error:', raw.slice(0, 300));
    return [];
  }
}

/* ─────────────────────────────────────────────────────────────────────
   GET /api/reengagement/candidates?refresh=false
───────────────────────────────────────────────────────────────────── */
router.get('/candidates', async (req, res) => {
  try {
    const ds = await db.getPrimaryDataSource(req.orgId);
    if (!ds) return res.json({ success: true, data: [], total: 0 });

    const refresh = req.query.refresh === 'true';

    // ── 1. Cache en memoria (misma sesión) ────────────────────────────
    const memCached = analysisCache.get(req.orgId);
    if (!refresh && memCached && Date.now() - memCached.ts < CACHE_TTL) {
      return res.json({ success: true, data: memCached.data, total: memCached.data.length, fromCache: true, cacheSource: 'memory' });
    }

    // ── 2. Cache en DB (mismo día) ────────────────────────────────────
    const today = new Date().toISOString().slice(0, 10);
    if (!refresh) {
      const dbCached = await db.getDailyCache(req.orgId, today);
      if (dbCached) {
        const candidates = Array.isArray(dbCached) ? dbCached : JSON.parse(dbCached);
        analysisCache.set(req.orgId, { data: candidates, ts: Date.now() });
        console.log(`[Reengagement] Cache DB hit para org ${req.orgId} (${today})`);
        return res.json({ success: true, data: candidates, total: candidates.length, fromCache: true, cacheSource: 'db', cacheDate: today });
      }
    }

    const { shop, token } = shopifyApi.credentialsFrom(ds);

    console.log(`[Reengagement] Descargando órdenes de ${shop}...`);
    let allOrders;
    try {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      let cursor = null; let page = 0;
      allOrders = [];
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
    } catch (err) {
      throw err;
    }
    console.log(`[Reengagement] Total órdenes: ${allOrders.length}`);

    if (!allOrders.length) {
      return res.json({ success: true, data: [], total: 0, message: 'Sin órdenes en Shopify' });
    }

    const conCustomerPhone = allOrders.filter(o => o.customer?.phone).length;
    const sinPhone         = allOrders.filter(o => !o.customer?.phone).length;
    console.log(`[Reengagement] Teléfonos en órdenes — con phone: ${conCustomerPhone} | sin phone: ${sinPhone}`);

    const toNumericId = (id) => String(id || '').replace(/[^0-9]/g, '');

    const ordenesSinPhone    = allOrders.filter(o => !normalizePhone(o.customer?.phone));
    const ordenesSinPhoneConId = ordenesSinPhone.filter(o => o.customer?.id);
    const ordenesSinCliente  = ordenesSinPhone.filter(o => !o.customer?.id);

    console.log(`[Reengagement] Órdenes sin teléfono — con customerId: ${ordenesSinPhoneConId.length} | sin customer (guest): ${ordenesSinCliente.length}`);

    if (ordenesSinPhoneConId.length > 0) {
      const muestraOrden = ordenesSinPhoneConId.slice(0, 3).map(o => o.customer?.id);
      console.log(`[Reengagement] Muestra IDs de órdenes: ${JSON.stringify(muestraOrden)}`);
    }

    if (ordenesSinPhoneConId.length > 0) {
      console.log(`[Reengagement] Intentando enriquecer ${ordenesSinPhoneConId.length} órdenes con customerId...`);
      try {
        const sleep = ms => new Promise(r => setTimeout(r, ms));
        const phoneMap = new Map();
        let cursor = undefined;
        let page = 0;

        while (true) {
          page++;
          const result = await shopifyApi.getCustomers(shop, token, { limit: 100, cursor });

          if (page === 1 && result.customers?.length > 0) {
            const muestraCatalogo = result.customers.slice(0, 3).map(c => c.id);
            console.log(`[Reengagement] Muestra IDs catálogo: ${JSON.stringify(muestraCatalogo)}`);
          }

          for (const c of (result.customers || [])) {
            const phone  = normalizePhone(c.phone);
            if (!phone) continue;
            const entry  = { phone, name: c.name || phone, email: c.email };
            const numId  = toNumericId(c.id);
            const fullId = String(c.id || '');
            if (numId)  phoneMap.set(numId, entry);
            if (fullId) phoneMap.set(fullId, entry);
            if (c.email) phoneMap.set(c.email.toLowerCase(), entry);
          }

          if (!result.hasNextPage || !result.endCursor) break;
          cursor = result.endCursor;
          await sleep(300);
          if (page >= 50) break;
        }

        console.log(`[Reengagement] Clientes con teléfono en catálogo: ${phoneMap.size / 2} (indexados por ID numérico y GID)`);

        let enriquecidas = 0;
        let porId = 0, porEmail = 0;
        for (const order of allOrders) {
          if (normalizePhone(order.customer?.phone)) continue;
          if (!order.customer) continue;

          const rawId  = String(order.customer.id || '');
          const numId  = toNumericId(rawId);
          const email  = (order.customer.email || '').toLowerCase();

          const enrichData =
            phoneMap.get(rawId)   ||
            phoneMap.get(numId)   ||
            (email ? phoneMap.get(email) : null);

          if (enrichData) {
            order.customer.phone = enrichData.phone;
            if (!order.customer.name) order.customer.name = enrichData.name;
            if (!order.customer.email) order.customer.email = enrichData.email;
            enriquecidas++;
            if (phoneMap.get(rawId) || phoneMap.get(numId)) porId++;
            else porEmail++;
          }
        }
        console.log(`[Reengagement] Órdenes enriquecidas: ${enriquecidas} (por ID: ${porId} | por email: ${porEmail})`);
      } catch (err) {
        console.warn('[Reengagement] No se pudo enriquecer con catálogo:', err.message);
      }
    }

    const allStats = buildCustomerStats(allOrders);
    console.log(`[Reengagement] Clientes únicos con teléfono: ${allStats.length}`);
    console.log(`[Reengagement] Clientes únicos con teléfono tras enriquecimiento: ${allStats.length}`);

    if (!allStats.length) {
      return res.json({ success: true, data: [], total: 0, message: 'Clientes sin número de teléfono en Shopify' });
    }

    const todayDow = new Date().getDay();
    let aiResults  = [];

    const BATCH = 40;
    for (let i = 0; i < allStats.length; i += BATCH) {
      const batch       = allStats.slice(i, i + BATCH);
      const batchResult = await predictWithAI(batch, todayDow);
      aiResults = aiResults.concat(batchResult);
      console.log(`[Reengagement] Batch ${Math.floor(i/BATCH)+1}/${Math.ceil(allStats.length/BATCH)}: ${batchResult.length} predicciones`);
      if (i + BATCH < allStats.length) {
        await new Promise(r => setTimeout(r, 600));
      }
    }
    console.log(`[Reengagement] Total predicciones AI recibidas: ${aiResults.length} / ${allStats.length} clientes`);

    const aiMap = new Map(aiResults.map(r => [r.phone, r]));

    // ── Cargar calibración existente ──────────────────────────────────
    const calibration = await db.getCalibration(req.orgId);
    if (calibration) {
      console.log(`[Reengagement] Calibración activa: factor=${calibration.calibrationFactor}, accuracy=${Math.round(calibration.accuracyRate*100)}%`);
    }

    // ── Correr backtesting si no existe calibración (primera vez) ─────
    if (!calibration && allOrders.length > 0) {
      try {
        console.log(`[Reengagement] Primera vez — corriendo backtesting inicial...`);
        const btResult = runBacktesting(allOrders, normalizePhone);
        await db.saveCalibration(req.orgId, btResult);
        console.log(`[Reengagement] Backtesting inicial: factor=${btResult.calibrationFactor}, accuracy=${Math.round(btResult.accuracyRate*100)}%, predicciones=${btResult.totalPredictions}`);
      } catch (btErr) {
        console.warn('[Reengagement] Error en backtesting inicial:', btErr.message);
      }
    }

    // Recargar calibración (puede haberse creado recién)
    const activeCalibration = calibration || await db.getCalibration(req.orgId);

    const enriched = allStats.map(c => {
      const ai = aiMap.get(c.phone) || {};
      const predictedDays   = ai.predictedDays ?? null;
      const confidenceRaw   = ai.confidence || 0;
      const confidenceCalib = applyCalibration(confidenceRaw, activeCalibration);

      let buyWindow, urgency;
      if (predictedDays === null) {
        buyWindow = 'desconocido'; urgency = 0;
      } else if (predictedDays <= 1) {
        buyWindow = 'hoy'; urgency = 4;
      } else if (predictedDays <= 7) {
        buyWindow = 'semana'; urgency = 3;
      } else if (predictedDays <= 30) {
        buyWindow = 'mes'; urgency = 2;
      } else {
        buyWindow = 'lejano'; urgency = 1;
      }

      return {
        ...c,
        predictedDays,
        confidenceRaw,
        confidence:   confidenceCalib,   // confianza calibrada (la que ve el usuario)
        aiReason:     ai.aiReason || null,
        buyWindow,
        urgency,
      };
    })
    .filter(c => c.predictedDays !== null && c.predictedDays <= 90)
    .sort((a, b) => a.predictedDays - b.predictedDays);

    // ── Guardar en cache DB (único por día) ───────────────────────────
    try {
      await db.saveDailyCache(req.orgId, today, enriched);
      await db.savePredictions(req.orgId, enriched, today);
      console.log(`[Reengagement] Cache guardado en DB para ${today} (${enriched.length} candidatos)`);
    } catch (cacheErr) {
      console.warn('[Reengagement] Error guardando cache:', cacheErr.message);
    }

    analysisCache.set(req.orgId, { data: enriched, ts: Date.now() });

    const windows = [
      { key: 'hoy',    label: '🟢 HOY / MAÑANA',  max: 1  },
      { key: 'semana', label: '🔵 ESTA SEMANA',    max: 7  },
      { key: 'mes',    label: '🟡 ESTE MES',       max: 30 },
      { key: 'lejano', label: '⚪ LEJANO (31-90d)', max: 90 },
    ];
    console.log('\n' + '═'.repeat(60));
    console.log(`  📋 LISTA DE CONTACTOS — ${new Date().toLocaleString('es-CL')}`);
    console.log('═'.repeat(60));
    for (const w of windows) {
      const grupo = enriched.filter(c => c.buyWindow === w.key);
      if (!grupo.length) continue;
      console.log(`\n${w.label} (${grupo.length} clientes)`);
      console.log('─'.repeat(60));
      grupo.forEach(c => {
        const dias    = c.predictedDays <= 0 ? `vencido ${Math.abs(c.predictedDays)}d` : `en ${c.predictedDays}d`;
        const conf    = `${c.confidence}%`.padStart(4);
        const nombre  = (c.name || '—').slice(0, 20).padEnd(20);
        const razon   = c.aiReason ? `  "${c.aiReason}"` : '';
        console.log(`  ${nombre}  ${c.phone}  [${conf}]  ${dias}${razon}`);
      });
    }
    console.log('\n' + '═'.repeat(60));
    console.log(`  TOTAL: ${enriched.length} clientes | HOY/MAÑANA: ${enriched.filter(c=>c.buyWindow==='hoy').length} | SEMANA: ${enriched.filter(c=>c.buyWindow==='semana').length} | MES: ${enriched.filter(c=>c.buyWindow==='mes').length}`);
    console.log('═'.repeat(60) + '\n');

    res.json({ success: true, data: enriched, total: enriched.length, fromCache: false });

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
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    let allOrders = [];
    let cursor = null;
    let page = 0;
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

    console.log(`[Calibration] Órdenes descargadas: ${allOrders.length}`);

    if (allOrders.length < 20) {
      return res.status(400).json({
        success: false,
        error: 'Historial insuficiente para calibración (necesitas al menos 20 órdenes)',
      });
    }

    // Correr backtesting
    const result = runBacktesting(allOrders, normalizePhone);

    // Guardar en DB
    await db.saveCalibration(req.orgId, result);

    // Invalidar cache de memoria y DB para forzar recálculo con nueva calibración
    analysisCache.delete(req.orgId);
    const today = new Date().toISOString().slice(0, 10);
    // El próximo acceso a /candidates regenerará con la nueva calibración

    console.log(`[Calibration] Org ${req.orgId}: factor=${result.calibrationFactor}, accuracy=${Math.round(result.accuracyRate*100)}%, predicciones simuladas=${result.totalPredictions}`);

    res.json({ success: true, data: result });
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
