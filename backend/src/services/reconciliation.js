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
 *      y Santander queda asociado al contacto para próximos cruces.
 *   4. autoMatchPending() reutiliza esa asociación solo cuando identidad,
 *      contacto, monto y una única combinación de pedidos coinciden.
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

  // Después de importar, reutilizar únicamente asociaciones Santander que ya
  // fueron confirmadas manualmente. Los casos ambiguos permanecen pendientes.
  const automatic = await autoMatchPending(orgId);

  return { ok: true, statementId: st.id, total: abonos.length, inserted, duplicates: abonos.length - inserted, autoMatched: automatic.matched, parsed: summary(parsed) };
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
              CASE WHEN o.payment_method = 'mixto' THEN o.payment_transfer_amount ELSE o.total_price::numeric END AS total_price,
              o.created_at, COALESCE(o.updated_at, o.created_at) AS touched_at, o.payment_method, c.contact_name
         FROM orders o LEFT JOIN conversations c ON c.id = o.conversation_id
        WHERE o.organization_id = $1 AND o.status NOT IN ('paid', 'cancelled')
          AND COALESCE(o.total_price::numeric, 0) > 0
          AND o.created_at > NOW() - INTERVAL '120 days'`,
      [orgId]),
    pool.query(
      `SELECT shopify_order_id AS id, 'shopify' AS source, COALESCE(shopify_name, '#' || shopify_order_id) AS label,
              crm_status AS status, customer_name, customer_phone AS phone,
              CASE WHEN payment_method = 'mixto' THEN payment_transfer_amount ELSE total_price::numeric END AS total_price,
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

function normalizedPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits ? digits.slice(-8) : '';
}

// ─── Sugerencias ────────────────────────────────────────────────────────────

function daysBetween(a, b) { return (new Date(a) - new Date(b)) / 86400000; }

function parsePaymentDate(value) {
  if (!value) return null;
  const raw = String(value).trim();
  let match = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (match) return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  match = raw.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  if (match) return new Date(Date.UTC(Number(match[3]), Number(match[2]) - 1, Number(match[1])));
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function confidenceForScore(score) {
  if (score >= 90) return 'muy_alta';
  if (score >= 75) return 'alta';
  if (score >= 60) return 'media';
  return 'baja';
}

/**
 * Puntaje explicable 0..100 para la relación voucher ↔ abono ↔ pedido.
 * Es un grado de coincidencia, no una probabilidad estadística calibrada.
 */
function scoreProofEvidence(mov, orders, proof) {
  if (!proof) return null;
  let score = 0;
  const reasons = [];
  const add = (key, label, points, detail = null) => {
    score += points;
    reasons.push({ key, label, points, detail });
  };
  const extractedAmount = Number(proof.extracted_amount);
  const amountExact = Number.isFinite(extractedAmount) && Math.abs(extractedAmount - Number(mov.amount)) <= AMOUNT_TOLERANCE;
  if (amountExact) add('amount', 'Monto del voucher coincide con el abono', 40, `$${Math.round(extractedAmount)}`);
  else if (Number.isFinite(extractedAmount)) reasons.push({ key: 'amount_mismatch', label: 'El monto del voucher no coincide con el abono', points: 0, detail: `$${Math.round(extractedAmount)} vs $${Math.round(Number(mov.amount))}` });

  const botOrderIds = new Set(orders.filter(o => o.source === 'bot').map(o => String(o.id)));
  const orderLinked = proof.order_id != null && botOrderIds.has(String(proof.order_id));
  if (orderLinked) add('order', 'Voucher asociado al mismo pedido', 25, `#BOT-${proof.order_id}`);

  const proofPhone = normalizedPhone(proof.customer_phone);
  const orderPhoneMatch = !!proofPhone && orders.some(o => normalizedPhone(o.phone) === proofPhone);
  if (orderPhoneMatch) add('phone', 'Teléfono del voucher coincide con el pedido', 10);

  const paymentDate = parsePaymentDate(proof.extracted_date);
  if (paymentDate) {
    const delta = Math.abs(daysBetween(mov.date, paymentDate));
    if (delta < 0.5) add('date', 'Fecha del voucher coincide con la cartola', 15, proof.extracted_date);
    else if (delta <= 1.5) add('date', 'Fecha del voucher está a un día del abono', 10, proof.extracted_date);
    else if (delta <= 3.5) add('date', 'Fecha del voucher está dentro de tres días', 5, proof.extracted_date);
  }

  const refA = norm(proof.extracted_reference).replace(/\s/g, '');
  const refB = norm(mov.doc_number || mov.description).replace(/\s/g, '');
  if (refA.length >= 4 && refB.length >= 4 && (refA.includes(refB) || refB.includes(refA))) {
    add('reference', 'Referencia del voucher coincide con la cartola', 15, proof.extracted_reference);
  }

  const personSimilarity = Math.max(0, ...orders.map(o => nameSimilarity(mov.payer, proof.customer_name || o.customer_name)));
  if (personSimilarity >= 0.5) add('name', 'Nombre del ordenante coincide con el cliente', 10, `${Math.round(personSimilarity * 100)}%`);
  else if (personSimilarity > 0) add('name', 'Coincidencia parcial del nombre', 5, `${Math.round(personSimilarity * 100)}%`);

  if (proof.ai_confidence === 'high') add('ai', 'Lectura del voucher con alta confianza', 5);
  else if (proof.ai_confidence === 'medium') add('ai', 'Lectura del voucher con confianza media', 2);

  score = Math.min(100, score);
  return {
    proofId: proof.id,
    score,
    confidence: confidenceForScore(score),
    reasons,
    amountExact,
    orderLinked,
    qualifies: amountExact && orderLinked,
  };
}

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
  if (orders.every(o => ['transferencia', 'mixto'].includes(o.payment_method))) score += 3;
  const confidence = sim >= 0.5 && orders.length === 1 ? 'alta' : orders.length === 1 ? 'media' : sim >= 0.5 ? 'media' : 'baja';
  return { score: Math.min(100, score), similarity: Math.round(sim * 100), confidence, orders };
}

async function suggest(orgId) {
  const pool = getPool();
  const [{ rows: movements }, { rows: proofs }] = await Promise.all([pool.query(
    `SELECT id, date, amount, description, payer, doc_number, balance, status
       FROM bank_movements WHERE organization_id = $1 AND kind = 'abono' AND status = 'pending'
      ORDER BY date DESC, id DESC`, [orgId]), pool.query(
    `SELECT id, order_id, customer_phone, customer_name, extracted_amount, extracted_date,
            extracted_reference, ai_confidence, amount_matches, status, created_at
       FROM payment_proofs
      WHERE organization_id = $1 AND status IN ('pending','pre_verified')
        AND created_at > NOW() - INTERVAL '120 days'`, [orgId])]);
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
      const evidence = proofs.map(p => scoreProofEvidence(mov, c.orders, p)).filter(e => e?.qualifies).sort((a, b) => b.score - a.score)[0] || null;
      if (evidence) {
        c.proofEvidence = evidence;
        c.score = Math.max(c.score, evidence.score);
        if (evidence.score >= 75) c.confidence = 'alta';
      }
    }
    cands.sort((a, b) => b.score - a.score);
    const top = cands.slice(0, 4).map(c => ({
      reused: !!c.reused,
      score: c.score, similarity: c.similarity, confidence: c.confidence,
      proofEvidence: c.proofEvidence || null,
      orders: c.orders.map(o => ({ source: o.source, id: o.id, label: o.label, customer_name: o.customer_name, phone: o.phone, total: o.total, status: o.status, created_at: o.created_at, payment_method: o.payment_method,
        already_suggested: usedOrders.has(`${o.source}_${o.id}`) })),
    }));
    if (top[0]?.confidence === 'alta') top[0].orders.forEach(o => usedOrders.add(`${o.source}_${o.id}`));
    out.push({ ...mov, amount: Number(mov.amount), candidates: top });
  }
  return { movements: out, unpaidCount: unpaid.length };
}

// ─── Confirmar / ignorar / revertir ─────────────────────────────────────────

async function learnSantanderIdentity(client, orgId, mov, contacts, userId) {
  const phones = [...new Set(contacts.map(c => normalizedPhone(c.phone)).filter(Boolean))];
  const payerNormalized = norm(mov.payer || mov.description);
  if (phones.length !== 1 || payerNormalized.length < 3) return null;
  const contact = contacts.find(c => normalizedPhone(c.phone) === phones[0]) || {};
  const { rows: [savedContact] } = await client.query(
    `SELECT id FROM contacts
      WHERE organization_id = $1
        AND RIGHT(regexp_replace(phone, '[^0-9]', '', 'g'), 8) = $2
      ORDER BY updated_at DESC NULLS LAST, id DESC LIMIT 1`,
    [orgId, phones[0]]
  );
  const { rows: [identity] } = await client.query(
    `INSERT INTO bank_contact_identities
       (organization_id, bank_name, payer_normalized, payer_display, contact_id, contact_phone, contact_name, created_by)
     VALUES ($1, 'santander', $2, $3, $4, $5, $6, $7)
     ON CONFLICT (organization_id, bank_name, payer_normalized, contact_phone)
     DO UPDATE SET payer_display = EXCLUDED.payer_display,
                   contact_id = COALESCE(EXCLUDED.contact_id, bank_contact_identities.contact_id),
                   contact_name = COALESCE(EXCLUDED.contact_name, bank_contact_identities.contact_name),
                   confirmations = bank_contact_identities.confirmations + 1,
                   active = TRUE,
                   last_confirmed_at = NOW(), updated_at = NOW()
     RETURNING id, contact_phone, contact_name, confirmations`,
    [orgId, payerNormalized, mov.payer || mov.description, savedContact?.id || null, phones[0], contact.name || null, userId || null]
  );
  return identity || null;
}

async function verifyUniqueProofForMovement(client, orgId, mov, selectedOrders, automatic) {
  const botIds = selectedOrders.filter(o => o.source === 'bot').map(o => parseInt(o.id)).filter(Number.isInteger);
  if (!botIds.length) return { verified: null, candidates: 0 };
  const { rows: proofs } = await client.query(
    `SELECT id, order_id, customer_phone, customer_name, extracted_amount, extracted_date,
            extracted_reference, ai_confidence, amount_matches, status, created_at
       FROM payment_proofs
      WHERE organization_id = $1 AND order_id = ANY($2::int[])
        AND status IN ('pending','pre_verified')
        AND bank_movement_id IS NULL
      ORDER BY created_at DESC FOR UPDATE`,
    [orgId, botIds]
  );
  const eligible = proofs
    .map(proof => ({ proof, evidence: scoreProofEvidence(mov, selectedOrders, proof) }))
    .filter(item => item.evidence?.qualifies && item.evidence.score >= 60)
    .sort((a, b) => b.evidence.score - a.evidence.score);
  // Dos vouchers compatibles para el mismo abono pueden ser un duplicado o
  // dos pagos distintos. Nunca elegir uno silenciosamente.
  if (eligible.length !== 1) return { verified: null, candidates: eligible.length };
  const { proof, evidence } = eligible[0];
  const method = automatic ? 'bank_reconciliation_automatic' : 'bank_reconciliation_manual';
  const { rows: [verified] } = await client.query(
    `UPDATE payment_proofs
        SET status = 'verified', bank_movement_id = $1, reconciliation_score = $2,
            reconciliation_confidence = $3, reconciliation_reasons = $4::jsonb,
            bank_verified_at = NOW(), verification_method = $5,
            notes = CONCAT_WS(E'\n', NULLIF(notes, ''), $6::text)
      WHERE id = $7 AND organization_id = $8
      RETURNING id, order_id, status, reconciliation_score, reconciliation_confidence, bank_movement_id`,
    [mov.id, evidence.score, evidence.confidence, JSON.stringify(evidence.reasons), method,
     `Verificado con cartola Santander: abono #${mov.id} por $${Number(mov.amount).toLocaleString('es-CL')}`,
     proof.id, orgId]
  );
  return { verified: verified || null, candidates: 1, evidence };
}

async function confirm(orgId, movementId, orders, userId, note = null, options = {}) {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [mov] } = await client.query(
      `SELECT * FROM bank_movements WHERE id = $1 AND organization_id = $2 FOR UPDATE`, [movementId, orgId]);
    if (!mov) throw Object.assign(new Error('Movimiento no encontrado'), { status: 404 });
    if (mov.status === 'matched') throw Object.assign(new Error('Este abono ya está conciliado'), { status: 409 });

    const matched = [];
    const contacts = [];
    const selectedOrderRecords = [];
    for (const o of orders) {
      if (o.source === 'bot') {
        const { rows: [prev] } = await client.query(`SELECT status, payment_method, customer_phone, customer_name, total_price, created_at FROM orders WHERE id = $1 AND organization_id = $2 FOR UPDATE`, [parseInt(o.id), orgId]);
        if (!prev) throw Object.assign(new Error(`Pedido #BOT-${o.id} no encontrado`), { status: 404 });
        await client.query(
          `UPDATE orders SET status = 'paid', payment_method = CASE WHEN payment_method = 'mixto' THEN 'mixto' ELSE 'transferencia' END, payment_marked_at = NOW(), updated_at = NOW(),
                  notes = COALESCE(notes, '') || $3
            WHERE id = $1 AND organization_id = $2`,
          [parseInt(o.id), orgId, `\n[conciliación] Pagado con transferencia ${mov.date.toISOString?.().slice(0, 10) || mov.date} $${mov.amount} (${mov.payer || mov.description})`]);
        matched.push({ source: 'bot', id: String(o.id), prev_status: prev.status, prev_payment_method: prev.payment_method });
        contacts.push({ phone: prev.customer_phone, name: prev.customer_name });
        selectedOrderRecords.push({ source: 'bot', id: String(o.id), phone: prev.customer_phone, customer_name: prev.customer_name, total: Math.round(Number(prev.total_price) || 0), created_at: prev.created_at });
      } else if (o.source === 'shopify') {
        const { rows: [prev] } = await client.query(`SELECT financial_status, payment_method, customer_phone, customer_name, total_price, COALESCE(shopify_created_at, synced_at) AS created_at FROM shopify_orders WHERE shopify_order_id = $1 AND organization_id = $2 FOR UPDATE`, [String(o.id), orgId]);
        if (!prev) throw Object.assign(new Error(`Pedido Shopify ${o.id} no encontrado`), { status: 404 });
        await client.query(
          `UPDATE shopify_orders SET financial_status = 'paid', payment_method = CASE WHEN payment_method = 'mixto' THEN 'mixto' ELSE 'transferencia' END, payment_marked_at = NOW()
            WHERE shopify_order_id = $1 AND organization_id = $2`, [String(o.id), orgId]);
        matched.push({ source: 'shopify', id: String(o.id), prev_status: prev.financial_status, prev_payment_method: prev.payment_method });
        contacts.push({ phone: prev.customer_phone, name: prev.customer_name });
        selectedOrderRecords.push({ source: 'shopify', id: String(o.id), phone: prev.customer_phone, customer_name: prev.customer_name, total: Math.round(Number(prev.total_price) || 0), created_at: prev.created_at });
      }
    }
    const learned = options.automatic
      ? null
      : await learnSantanderIdentity(client, orgId, mov, contacts, userId);
    const identityId = options.bankIdentityId || learned?.id || null;
    await client.query(
      `UPDATE bank_movements SET status = 'matched', matched_orders = $3, matched_at = NOW(), matched_by = $4, note = $5,
                                 match_method = $6, bank_identity_id = $7
        WHERE id = $1 AND organization_id = $2`,
      [movementId, orgId, JSON.stringify(matched), userId || null, note,
       options.automatic ? 'automatic_identity' : 'manual', identityId]);
    const proofVerification = await verifyUniqueProofForMovement(client, orgId, mov, selectedOrderRecords, !!options.automatic);
    await client.query('COMMIT');
    return { ok: true, matched, learnedIdentity: learned, automatic: !!options.automatic, proofVerification };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

function uniqueOrderCombination(mov, orders) {
  const eligible = orders.filter(o => {
    const d = daysBetween(mov.date, o.created_at);
    return d >= -DAYS_AFTER && d <= DAYS_BEFORE;
  });
  const matches = [];
  for (let i = 0; i < eligible.length; i++) {
    if (Math.abs(eligible[i].total - Number(mov.amount)) <= AMOUNT_TOLERANCE) matches.push([eligible[i]]);
    for (let j = i + 1; j < eligible.length; j++) {
      if (Math.abs(eligible[i].total + eligible[j].total - Number(mov.amount)) <= AMOUNT_TOLERANCE) matches.push([eligible[i], eligible[j]]);
      for (let k = j + 1; k < eligible.length; k++) {
        if (Math.abs(eligible[i].total + eligible[j].total + eligible[k].total - Number(mov.amount)) <= AMOUNT_TOLERANCE) matches.push([eligible[i], eligible[j], eligible[k]]);
      }
    }
  }
  const unique = new Map(matches.map(set => [set.map(o => `${o.source}:${o.id}`).sort().join('|'), set]));
  return unique.size === 1 ? [...unique.values()][0] : null;
}

async function autoMatchPending(orgId) {
  const pool = getPool();
  const { rows: movements } = await pool.query(
    `SELECT id, date, amount, description, payer
       FROM bank_movements
      WHERE organization_id = $1 AND kind = 'abono' AND status = 'pending'
      ORDER BY date, id`, [orgId]);
  let unpaid = await getUnpaidOrders(orgId);
  let matched = 0;
  const details = [];

  for (const mov of movements) {
    const payerNormalized = norm(mov.payer || mov.description);
    if (payerNormalized.length < 3) continue;
    const { rows: identities } = await pool.query(
      `SELECT id, contact_phone, contact_name, confirmations
         FROM bank_contact_identities
        WHERE organization_id = $1 AND bank_name = 'santander'
          AND payer_normalized = $2 AND active = TRUE
        ORDER BY confirmations DESC, last_confirmed_at DESC`,
      [orgId, payerNormalized]);
    const phones = [...new Set(identities.map(i => normalizedPhone(i.contact_phone)).filter(Boolean))];
    if (phones.length !== 1) continue; // identidad bancaria conflictiva o incompleta
    const contactOrders = unpaid.filter(o => normalizedPhone(o.phone) === phones[0]);
    const selected = uniqueOrderCombination(mov, contactOrders);
    if (!selected) continue; // monto sin pedido o más de una combinación posible
    const identity = identities.find(i => normalizedPhone(i.contact_phone) === phones[0]);
    try {
      await confirm(orgId, mov.id, selected, null,
        'Conciliado automáticamente con identidad Santander confirmada anteriormente',
        { automatic: true, bankIdentityId: identity.id });
      const used = new Set(selected.map(o => `${o.source}:${o.id}`));
      unpaid = unpaid.filter(o => !used.has(`${o.source}:${o.id}`));
      matched++;
      details.push({ movementId: mov.id, identityId: identity.id, orders: selected.map(o => ({ source: o.source, id: o.id })) });
    } catch (err) {
      console.error(`[Conciliación] No se pudo aplicar identidad Santander al movimiento ${mov.id}:`, err.message);
    }
  }
  return { matched, details };
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
    if (mov.bank_identity_id) {
      await client.query(`UPDATE bank_contact_identities SET active = FALSE, updated_at = NOW() WHERE id = $1 AND organization_id = $2`, [mov.bank_identity_id, orgId]);
    }
    await client.query(
      `UPDATE payment_proofs
          SET status = CASE WHEN amount_matches IS TRUE THEN 'pre_verified' ELSE 'pending' END,
              bank_movement_id = NULL, reconciliation_score = NULL, reconciliation_confidence = NULL,
              reconciliation_reasons = NULL, bank_verified_at = NULL, verification_method = NULL,
              notes = CONCAT_WS(E'\n', NULLIF(notes, ''), 'Conciliación bancaria revertida; requiere revisión nuevamente')
        WHERE organization_id = $1 AND bank_movement_id = $2
          AND verification_method LIKE 'bank_reconciliation_%'`,
      [orgId, movementId]
    );
    await client.query(`UPDATE bank_movements SET status = 'pending', matched_orders = NULL, matched_at = NULL, matched_by = NULL, note = NULL, match_method = NULL, bank_identity_id = NULL WHERE id = $1 AND organization_id = $2`, [movementId, orgId]);
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
    `SELECT bm.id, bm.date, bm.amount, bm.description, bm.payer, bm.doc_number, bm.balance, bm.status,
            bm.matched_orders, bm.matched_at, bm.note, bm.statement_id, bm.match_method, bm.bank_identity_id,
            pp.id AS verified_proof_id, pp.reconciliation_score, pp.reconciliation_confidence
       FROM bank_movements bm
       LEFT JOIN payment_proofs pp ON pp.organization_id=bm.organization_id AND pp.bank_movement_id=bm.id
      WHERE ${conds.map(c => c.replace(/^organization_id/, 'bm.organization_id').replace(/^kind/, 'bm.kind').replace(/^status/, 'bm.status').replace(/^date/, 'bm.date')).join(' AND ')}
      ORDER BY bm.date DESC, bm.id DESC LIMIT $${params.length}`, params);
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
            COUNT(*) FILTER (WHERE status = 'matched' AND match_method = 'automatic_identity')::int AS automatic_matched,
            (SELECT COUNT(*)::int FROM payment_proofs pp
              WHERE pp.organization_id = $1 AND pp.bank_movement_id IS NOT NULL AND pp.status='verified') AS bank_verified_proofs,
            COUNT(*) FILTER (WHERE status = 'ignored')::int AS ignored,
            (SELECT COUNT(*)::int FROM bank_contact_identities bi
              WHERE bi.organization_id = $1 AND bi.bank_name = 'santander' AND bi.active = TRUE) AS learned_identities
       FROM bank_movements WHERE organization_id = $1 AND kind = 'abono'`, [orgId]);
  return { ...r, pending_amount: Number(r.pending_amount) };
}

module.exports = { importStatement, suggest, confirm, autoMatchPending, ignore, unmatch, listMovements, listStatements, stats, getUnpaidOrders, nameSimilarity, normalizedPhone, uniqueOrderCombination, scoreProofEvidence, confidenceForScore };
