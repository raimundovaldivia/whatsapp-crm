#!/usr/bin/env node
/**
 * audit-stale-state.js — Auditoría de estados rancios
 *
 * Busca las conversaciones donde el bot va a responder mal en su próximo
 * mensaje, porque el estado guardado dejó de ser cierto y nadie lo cerró.
 *
 * Revisa cuatro cosas:
 *   1. Agendados vencidos      → el bot dice "apartado para el X" con X ya pasado
 *   2. Pedidos estancados      → "por despachar" o "en camino" hace días
 *   3. Conversaciones colgadas → pipeline_state congelado sin respaldo en la DB
 *   4. Opt-outs con actividad  → dados de baja que volvieron a escribir pidiendo
 *
 * Uso (igual que los otros scripts del proyecto):
 *   railway run node backend/scripts/audit-stale-state.js          # solo reporta
 *   railway run node backend/scripts/audit-stale-state.js --fix    # además corrige
 *   railway run node backend/scripts/audit-stale-state.js --org 1  # limita a una org
 *
 * El modo por defecto NO escribe nada. Con --fix:
 *   - los agendados vencidos pasan a 'sent'
 *   - los pipeline_state 'scheduled' sin agendado vigente vuelven a 'exploring'
 *   - NO toca pedidos ni opt-outs: eso es decisión de negocio, no de script.
 */

require('dotenv').config();
const { getPool } = require('../src/db/database');

const FIX          = process.argv.includes('--fix');
const orgArgIndex  = process.argv.indexOf('--org');
const ORG_ID       = orgArgIndex > -1 ? parseInt(process.argv[orgArgIndex + 1], 10) : null;
const STALE_DAYS   = 3;

const orgFilter = (alias, paramIndex) =>
  ORG_ID ? `AND ${alias}.organization_id = $${paramIndex}` : '';
const orgParams = ORG_ID ? [ORG_ID] : [];

function title(text) {
  console.log(`\n${'─'.repeat(72)}\n${text}\n${'─'.repeat(72)}`);
}

function fecha(d) {
  return d ? String(d instanceof Date ? d.toISOString() : d).slice(0, 10) : '—';
}

function dias(ts) {
  if (!ts) return '?';
  return Math.floor((Date.now() - new Date(ts).getTime()) / 86400000);
}

async function main() {
  const pool = getPool();
  if (!process.env.DATABASE_URL) {
    console.error('Falta DATABASE_URL. Corre el script desde la carpeta backend/ o exporta la variable.');
    process.exit(1);
  }

  console.log(`\n🔍 Auditoría de estados rancios${ORG_ID ? ` — org ${ORG_ID}` : ' — todas las orgs'}`);
  console.log(`   Modo: ${FIX ? '⚠️  CORRIGIENDO' : 'solo lectura'}`);

  let totalProblemas = 0;

  // ── 1. Agendados vencidos ──────────────────────────────────────────────────
  title('1. Pedidos agendados vencidos (el bot los ofrece como futuros)');
  const { rows: vencidos } = await pool.query(
    `SELECT so.id, so.conversation_id, so.phone, so.customer_name,
            so.product_notes, so.desired_date, c.pipeline_state
       FROM scheduled_orders so
       JOIN conversations c ON c.id = so.conversation_id
      WHERE so.status = 'pending'
        AND so.desired_date < CURRENT_DATE
        ${orgFilter('so', 1)}
      ORDER BY so.desired_date ASC`,
    orgParams
  );

  if (vencidos.length === 0) {
    console.log('   ✓ Ninguno');
  } else {
    totalProblemas += vencidos.length;
    for (const r of vencidos) {
      const critico = r.pipeline_state === 'scheduled';
      console.log(
        `   ${critico ? '🔴' : '🟡'} ${(r.customer_name || r.phone).padEnd(22)} ` +
        `fecha ${fecha(r.desired_date)} (hace ${dias(r.desired_date)} días) · ` +
        `${r.product_notes || 'sin detalle'} · estado conv: ${r.pipeline_state}`
      );
    }
    console.log(`\n   🔴 = la conversación está en 'scheduled': el próximo mensaje del cliente`);
    console.log(`        recibe una respuesta con esa fecha vieja.`);

    if (FIX) {
      const { rowCount } = await pool.query(
        `UPDATE scheduled_orders SET status = 'sent', sent_at = COALESCE(sent_at, NOW())
          WHERE id = ANY($1::int[])`,
        [vencidos.map(r => r.id)]
      );
      console.log(`\n   ✅ ${rowCount} agendado(s) cerrado(s)`);
    }
  }

  // ── 2. Pedidos estancados ──────────────────────────────────────────────────
  title(`2. Pedidos sin movimiento hace más de ${STALE_DAYS} días`);
  const { rows: estancados } = await pool.query(
    `SELECT o.id, o.customer_name, o.customer_phone, o.status, o.total_price,
            COALESCE(o.updated_at, o.created_at) AS touched_at,
            o.payment_method
       FROM orders o
      WHERE o.status IN ('nuevo','sent','payment_received','por_despachar','en_camino')
        AND COALESCE(o.updated_at, o.created_at) < NOW() - INTERVAL '${STALE_DAYS} days'
        ${orgFilter('o', 1)}
      ORDER BY touched_at ASC`,
    orgParams
  );

  if (estancados.length === 0) {
    console.log('   ✓ Ninguno');
  } else {
    totalProblemas += estancados.length;
    for (const r of estancados) {
      console.log(
        `   🟡 #${String(r.id).padEnd(5)} ${(r.customer_name || r.customer_phone || '—').padEnd(22)} ` +
        `${r.status.padEnd(16)} ${dias(r.touched_at)} días quieto · $${Math.round(r.total_price || 0).toLocaleString('es-CL')}`
      );
    }
    console.log(`\n   Probablemente ya se entregaron y nadie los marcó. Mientras sigan así,`);
    console.log(`   el bot los va a mencionar como pedidos en curso.`);
    console.log(`   No los toco automáticamente: hay que saber si se entregaron o se perdieron.`);
  }

  // ── 3. Conversaciones con estado colgado ───────────────────────────────────
  title("3. Conversaciones en 'scheduled' sin ningún agendado vigente");
  const { rows: colgadas } = await pool.query(
    `SELECT c.id, c.phone_number, c.contact_name, c.pipeline_state, c.updated_at
       FROM conversations c
      WHERE c.pipeline_state = 'scheduled'
        AND NOT EXISTS (
          SELECT 1 FROM scheduled_orders so
           WHERE so.conversation_id = c.id
             AND so.status = 'pending'
             AND so.desired_date >= CURRENT_DATE
        )
        ${orgFilter('c', 1)}
      ORDER BY c.updated_at DESC`,
    orgParams
  );

  if (colgadas.length === 0) {
    console.log('   ✓ Ninguna');
  } else {
    totalProblemas += colgadas.length;
    for (const r of colgadas) {
      console.log(`   🔴 conv #${String(r.id).padEnd(5)} ${(r.contact_name || r.phone_number).padEnd(22)} última actividad hace ${dias(r.updated_at)} días`);
    }

    if (FIX) {
      const { rowCount } = await pool.query(
        `UPDATE conversations SET pipeline_state = 'exploring', updated_at = NOW()
          WHERE id = ANY($1::int[])`,
        [colgadas.map(r => r.id)]
      );
      console.log(`\n   ✅ ${rowCount} conversación(es) devuelta(s) a 'exploring'`);
    }
  }

  // ── 4. Opt-outs que volvieron a escribir ───────────────────────────────────
  title('4. Clientes dados de baja que siguen escribiendo');
  const { rows: optOuts } = await pool.query(
    `SELECT co.phone, co.name, co.updated_at,
            c.id AS conversation_id, c.last_message_at, c.pipeline_state,
            (SELECT m.content FROM messages m
              WHERE m.conversation_id = c.id AND m.direction = 'inbound'
              ORDER BY m.created_at DESC LIMIT 1) AS ultimo_mensaje
       FROM contacts co
       JOIN conversations c
         ON c.organization_id = co.organization_id
        AND c.phone_number = co.phone
      WHERE co.opt_out = TRUE
        AND c.last_message_at > co.updated_at
        ${orgFilter('co', 1)}
      ORDER BY c.last_message_at DESC`,
    orgParams
  );

  if (optOuts.length === 0) {
    console.log('   ✓ Ninguno');
  } else {
    totalProblemas += optOuts.length;
    for (const r of optOuts) {
      const msg = (r.ultimo_mensaje || '').replace(/\s+/g, ' ').slice(0, 52);
      console.log(`   🟠 ${(r.name || r.phone).padEnd(22)} escribió hace ${dias(r.last_message_at)} días: "${msg}"`);
    }
    console.log(`\n   Estos están con opt_out = TRUE. Si el mensaje es un pedido, es una venta`);
    console.log(`   perdida y hay que reactivarlos a mano desde el CRM.`);
    console.log(`   No los reactivo automáticamente: dar de baja fue una decisión del cliente.`);
  }

  // ── Resumen ────────────────────────────────────────────────────────────────
  title('Resumen');
  console.log(`   Agendados vencidos:        ${vencidos.length}`);
  console.log(`   Pedidos estancados:        ${estancados.length}`);
  console.log(`   Conversaciones colgadas:   ${colgadas.length}`);
  console.log(`   Opt-outs con actividad:    ${optOuts.length}`);
  console.log(`   ${'─'.repeat(38)}`);
  console.log(`   Total a revisar:           ${totalProblemas}`);

  if (!FIX && (vencidos.length || colgadas.length)) {
    console.log(`\n   Corré con --fix para cerrar los agendados vencidos y destrabar`);
    console.log(`   las conversaciones colgadas.`);
  }
  console.log('');

  await pool.end();
}

main().catch(err => {
  console.error('\n❌ Error en la auditoría:', err.message);
  process.exit(1);
});
