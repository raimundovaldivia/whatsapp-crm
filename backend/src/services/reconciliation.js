/**
 * reconciliation.js — Conciliación bancaria: cartola ↔ pedidos sin pagar
 *
 * Flujo:
 *   1. importStatement()  lee el PDF (bank-statement.js), valida contra los
 *      totales del banco y guarda los ABONOS en bank_movements. Cada abono
 *      tiene una clave estable → subir la misma cartola (o una provisoria
 *      que se solapa con la de ayer) no duplica nada.
 *   2. suggest()          para cada abono pendiente busca pedidos sin pagar
 *      que calcen: mismo monto (exacto), fecha razonable, y si el nombre de
 *      quien transfiere se parece al del cliente, mejor. También combos de
 *      2-3 pedidos del mismo cliente que sumen el monto.
 *   3. confirm()          el usuario confirma → los pedidos pasan a PAGADO
 *      con referencia al movimiento. Nada se marca sin confirmación.
 *
 * Diseño: no destructivo. unmatch() revierte un cruce (guarda el estado
 * previo de cada pedido para poder volver).
 */

const db = require('../db/database');
const { getPool } = require('../db/database');
const { parseSantanderStatement, movementKey } = require('./bank-statement');

const AMOUNT_TOLERANCE = 1;      // pesos
const DAYS_BEFORE = 45;          // el pedido puede ser hasta 45 días anterior al abono
const DAYS_AFTER  = 2;           // …o hasta 2 días posterior (pagó antes de que se creara el pedido)

// ─── Importar ────────────────────────────────────────────────────────────────

async function importStatement(orgId, buffer, filename, userId) {
  const parsed = await parseSantanderStatement(buffer);
  if (!parsed.valid) {
    return { ok: false, error: 'La cartola no se pudo leer completa', warnings: parsed.warnings, parsed: summary(parsed) };
  }
  const pool = getPool();
  const abonos = parsed.movements.filter(m => m.kind === 'abono');

  const { rows: [st] } = await pool.query(
    `INSERT INTO bank_statements (organization_id, account, statement_number, kind, period_from, period_to, filename,
                                  total_abonos, total_cargos, movements_count, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [orgId, parsed.account, parsed.statementNumber, parsed.kind, parsed.from, parsed.to, filename,
     parsed.totals.abonos, parsed.totals.cargos, abonos.length, userId || null]
  );

  let inserted = 0;
  for (const m of abonos) {
    const { rowCount } = await pool.query(
      `INSERT INTO bank_movements (organization_id, statement_id, movement_key, date, kind, amount, description, payer, doc_number, branch, balance)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (organization_id, movement_key) DO NOTHING`,
      [orgId, st.id, movementKey(m), m.date, m.kind, m.amount, m.description, m.payer, m.docNumber, m.branch, m.balance]
    );
    inserted += rowCount;
  }
  await pool.query('UPDATE bank_statements SET new_movements = $1 WHERE id = $2', [inserted, st.id]);

  return { ok: true, statementId: st.id, total: abonos.length, inserted, duplicates: abonos.length - inserted, parsed: summary(parsed) };
}

function summary(p) {
  return { account: p.account, statementNumber: p.statementNumber, kind: p.kind, from: p.from, to: p.to, totals: p.totals, sums: p.sums, warnings: p.warnings };
}

// ─── Pedidos sin pagar (bot + Shopify) ──────────────────────────────────────

async function getUnpaidOrders(orgId) {
  const pool = getPool();
  const [bot, shop] = await Promise.all([
    pool.query(
      `SELECT o.id::text AS id, 'bot' AS source, '#BOT-' || o.id AS label, o.status, o.customer_name, o.customer_phone AS phone,
              o.total_price, o.created_at, COALESCE(o.updated_at, o.created_at) AS touched_at, o.payment_method, c.contact_name
         FROM orders o LEFT JOIN conversations c ON c.id = o.conversation_id
        WHERE o.organization_id = $1 AND o.status NOT IN ('paid', 'cancelled')
          AND COALESCE(o.total_price::numeric, 0) > 0
          AND o.created_at > NOW() - INTERVAL '120 days'`,
      [orgId]),
    pool.query(
      `SELECT shopify_order_id AS id, 'shopify' AS source, COALESCE(shopify_name, '#' || shopify_order_id) AS label,
              crm_status AS status, customer_name, customer_phone AS phone, total_price,
              COALESCE(shopify_created_at, synced_at) AS created_at, COALESCE(shopify_created_at, synced_at) AS touched_at,
              payment_method, NULL AS contact_name
         FROM shopify_orders
        WHERE organization_id = $1 AND UPPER(COALESCE(financial_status, '')) <> 'PAID'
          AND COALESCE(crm_status, '') <> 'cancelled'
          AND COALESCE(total_price::numeric, 0) > 0
          AND COALESCE(shopify_created_at, synced_at) > NOW() - INTERVAL '120 days'`,
      [orgId]),
  ]);
  return [...bot.rows, ...shop.rows].map(o => ({
    ...o,
    total: Math.round(parseFloat(o.total_price) || 0),
    customer_name: o.customer_name && !/^(cliente|sin nombre)$/i.test(o.customer_name.trim()) ? o.customer_name : (o.contact_name || o.customer_name || ''),
  }));
}

// ─── Similitud de nombres ───────────────────────────────────────────────────

function norm(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9ñ\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
const NAME_STOP = new Set(['de', 'del', 'la', 'los', 'las', 'y', 'e', 'transf', 'transferencia', 'internet', 'a']);
function nameTokens(s) { return norm(s).split(' ').filter(t => t.length >= 2 && !NAME_STOP.has(t)); }

/**
 * 0..1 — qué tanto se parece "MUNOZ DONOSO PA" (banco, a veces truncado) a
 * "Paola Muñoz" (cliente). Tolera tokens truncados por el banco ("PA" ~ "paola").
 */
function nameSimilarity(payer, customer) {
  const a = nameTokens(payer), b = nameTokens(customer);
  if (!a.length || !b.length) return 0;
  let hits = 0;
  for (const t of a) {
    if (b.some(u => u === t || (t.length >= 3 && u.startsWith(t)) || (u.length >= 3 && t.startsWith(u)))) hits++;
  }
  return hits / Math.min(a.length, b.length);
}

// ─── Sugerencias ────────────────────────────────────────────────────────────

function daysBetween(a, b) { return (new Date(a) - new Date(b)) / 86400000; }

function scoreCandidate(mov, orders) {
  // orders: 1..3 pedidos que juntos calzan el monto
  const total = orders.reduce((s, o) => s + o.total, 0);
  if (Math.abs(total - mov.amount) > AMOUNT_TOLERANCE) return null;
  let score = 60;
  const sim = Math.max(...orders.map(o => nameSimilarity(mov.payer, o.customer_name)));
  score += Math.round(sim * 30);
  // fecha: pedido creado hasta 45 días antes del abono o 2 después
  const d = Math.max(...orders.map(o => daysBetween(mov.date, o.created_at)));
  if (d < -DAYS_AFTER || d > DAYS_BEFORE) return null;
  score += d <= 7 ? 10 : d <= 20 ? 6 : 2;
  if (orders.length > 1) score -= 8;                       // combos: un poco menos seguros
  if (orders.every(o => o.payment_method === 'transferencia')) score += 3;
  const confidence = sim >= 0.5 && orders.length === 1 ? 'alta' : orders.length === 1 ? 'media' : sim >= 0.5 ? 'media' : 'baja';
  return { score: Math.min(100, score), similarity: Math.round(sim * 100), confidence, orders };
}

async function suggest(orgId) {
  const pool = getPool();
  const { rows: movements } = await pool.query(
    `SELECT id, date, amount, description, payer, doc_number, balance, status
       FROM bank_movements WHERE organization_id = $1 AND kind = 'abono' AND status = 'pending'
      ORDER BY date DESC, id DESC`, [orgId]);
  const unpaid = await getUnpaidOrders(orgId);

  // agrupar pedidos por cliente (teléfono normalizado) para combos
  const byPhone = new Map();
  for (const o of unpaid) {
    const k = (o.phone || '').replace(/\D/g, '').slice(-8) || `n_${norm(o.customer_name)}`;
    if (!byPhone.has(k)) byPhone.set(k, []);
    byPhone.get(k).push(o);
  }

  const usedOrders = new Set();   // un pedido no puede sugerirse para dos abonos distintos con confianza alta
  const out = [];
  for (const mov of movements) {
    const cands = [];
    for (const o of unpaid) {
      const c = scoreCandidate(mov, [o]);
      if (c) cands.push(c);
    }
    // combos 2-3 pedidos del mismo cliente
    for (const group of byPhone.values()) {
      if (group.length < 2 || group.length > 8) continue;
      const g = [...group].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
      for (let i = 0; i < g.length; i++) {
        for (let j = i + 1; j < g.length; j++) {
          const c2 = scoreCandidate(mov, [g[i], g[j]]); if (c2) cands.push(c2);
          for (let k = j + 1; k < g.length; k++) { const c3 = scoreCandidate(mov, [g[i], g[j], g[k]]); if (c3) cands.push(c3); }
        }
      }
    }
    // Un pedido ya reclamado con confianza alta por otro abono no puede ser "alta" de nuevo
    for (const c of cands) {
      if (c.orders.every(o => usedOrders.has(`${o.source}_${o.id}`))) { c.score = Math.max(0, c.score - 35); c.confidence = 'baja'; c.reused = true; }
    }
    cands.sort((a, b) => b.score - a.score);
    const top = cands.slice(0, 4).map(c => ({
      reused: !!c.reused,
      score: c.score, similarity: c.similarity, confidence: c.confidence,
      orders: c.orders.map(o => ({ source: o.source, id: o.id, label: o.label, customer_name: o.customer_name, phone: o.phone, total: o.total, status: o.status, created_at: o.created_at, payment_method: o.payment_method,
        already_suggested: usedOrders.has(`${o.source}_${o.id}`) })),
    }));
    if (top[0]?.confidence === 'alta') top[0].orders.forEach(o => usedOrders.add(`${o.source}_${o.id}`));
    out.push({ ...mov, amount: Number(mov.amount), candidates: top });
  }
  return { movements: out, unpaidCount: unpaid.length };
}

// ─── Confirmar / ignorar / revertir ─────────────────────────────────────────

async function confirm(orgId, movementId, orders, userId, note = null) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [mov] } = await client.query(
      `SELECT * FROM bank_movements WHERE id = $1 AND organization_id = $2 FOR UPDATE`, [movementId, orgId]);
    if (!mov) throw Object.assign(new Error('Movimiento no encontrado'), { status: 404 });
    if (mov.status === 'matched') throw Object.assign(new Error('Este abono ya está conciliado'), { status: 409 });

    const matched = [];
    for (const o of orders) {
      if (o.source === 'bot') {
        const { rows: [prev] } = await client.query(`SELECT status, payment_method FROM orders WHERE id = $1 AND organization_id = $2 FOR UPDATE`, [parseInt(o.id), orgId]);
        if (!prev) throw Object.assign(new Error(`Pedido #BOT-${o.id} no encontrado`), { status: 404 });
        await client.query(
          `UPDATE orders SET status = 'paid', payment_method = 'transferencia', payment_marked_at = NOW(), updated_at = NOW(),
                  notes = COALESCE(notes, '') || $3
            WHERE id = $1 AND organization_id = $2`,
          [parseInt(o.id), orgId, `\n[conciliación] Pagado con transferencia ${mov.date.toISOString?.().slice(0, 10) || mov.date} $${mov.amount} (${mov.payer || mov.description})`]);
        matched.push({ source: 'bot', id: String(o.id), prev_status: prev.status, prev_payment_method: prev.payment_method });
      } else if (o.source === 'shopify') {
        const { rows: [prev] } = await client.query(`SELECT financial_status, payment_method FROM shopify_orders WHERE shopify_order_id = $1 AND organization_id = $2 FOR UPDATE`, [String(o.id), orgId]);
        if (!prev) throw Object.assign(new Error(`Pedido Shopify ${o.id} no encontrado`), { status: 404 });
        await client.query(
          `UPDATE shopify_orders SET financial_status = 'paid', payment_method = 'transferencia', payment_marked_at = NOW()
            WHERE shopify_order_id = $1 AND organization_id = $2`, [String(o.id), orgId]);
        matched.push({ source: 'shopify', id: String(o.id), prev_status: prev.financial_status, prev_payment_method: prev.payment_method });
      }
    }
    await client.query(
      `UPDATE bank_movements SET status = 'matched', matched_orders = $3, matched_at = NOW(), matched_by = $4, note = $5
        WHERE id = $1 AND organization_id = $2`,
      [movementId, orgId, JSON.stringify(matched), userId || null, note]);
    await client.query('COMMIT');
    return { ok: true, matched };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function ignore(orgId, movementId, note, userId) {
  const { rowCount } = await getPool().query(
    `UPDATE bank_movements SET status = 'ignored', note = $3, matched_at = NOW(), matched_by = $4
      WHERE id = $1 AND organization_id = $2 AND status = 'pending'`, [movementId, orgId, note || null, userId || null]);
  return { ok: rowCount > 0 };
}

async function unmatch(orgId, movementId) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [mov] } = await client.query(`SELECT * FROM bank_movements WHERE id = $1 AND organization_id = $2 FOR UPDATE`, [movementId, orgId]);
    if (!mov) throw Object.assign(new Error('Movimiento no encontrado'), { status: 404 });
    const matched = Array.isArray(mov.matched_orders) ? mov.matched_orders : [];
    for (const m of matched) {
      if (m.source === 'bot') {
        await client.query(`UPDATE orders SET status = $3, payment_method = $4, updated_at = NOW() WHERE id = $1 AND organization_id = $2`,
          [parseInt(m.id), orgId, m.prev_status || 'entregado', m.prev_payment_method || null]);
      } else {
        await client.query(`UPDATE shopify_orders SET financial_status = $3, payment_method = $4 WHERE shopify_order_id = $1 AND organization_id = $2`,
          [String(m.id), orgId, m.prev_status || 'pending', m.prev_payment_method || null]);
      }
    }
    await client.query(`UPDATE bank_movements SET status = 'pending', matched_orders = NULL, matched_at = NULL, matched_by = NULL, note = NULL WHERE id = $1`, [movementId]);
    await client.query('COMMIT');
    return { ok: true, reverted: matched.length };
  } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
}

async function listMovements(orgId, { status = null, from = null, to = null, limit = 300 } = {}) {
  const params = [orgId]; const conds = ['organization_id = $1', `kind = 'abono'`];
  if (status) { params.push(status); conds.push(`status = $${params.length}`); }
  if (from)   { params.push(from);   conds.push(`date >= $${params.length}`); }
  if (to)     { params.push(to);     conds.push(`date <= $${params.length}`); }
  params.push(limit);
  const { rows } = await getPool().query(
    `SELECT id, date, amount, description, payer, doc_number, balance, status, matched_orders, matched_at, note, statement_id
       FROM bank_movements WHERE ${conds.join(' AND ')} ORDER BY date DESC, id DESC LIMIT $${params.length}`, params);
  return rows.map(r => ({ ...r, amount: Number(r.amount) }));
}

async function listStatements(orgId) {
  const { rows } = await getPool().query(
    `SELECT id, account, statement_number, kind, period_from, period_to, filename, total_abonos, total_cargos, movements_count, new_movements, created_at
       FROM bank_statements WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 60`, [orgId]);
  return rows;
}

async function stats(orgId) {
  const { rows: [r] } = await getPool().query(
    `SELECT COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
            COALESCE(SUM(amount) FILTER (WHERE status = 'pending'), 0)::bigint AS pending_amount,
            COUNT(*) FILTER (WHERE status = 'matched')::int AS matched,
            COUNT(*) FILTER (WHERE status = 'ignored')::int AS ignored
       FROM bank_movements WHERE organization_id = $1 AND kind = 'abono'`, [orgId]);
  return { ...r, pending_amount: Number(r.pending_amount) };
}

module.exports = { importStatement, suggest, confirm, ignore, unmatch, listMovements, listStatements, stats, getUnpaidOrders, nameSimilarity };
