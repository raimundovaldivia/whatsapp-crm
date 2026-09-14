/**
 * response-guardrail.js — Validación de frescura antes de enviar
 *
 * POR QUÉ EXISTE
 * El bot habla desde el estado que tiene en la DB. Cuando ese estado quedó
 * viejo porque nadie lo cerró (el pedido se entregó, el agendado venció, el
 * "Stop" es de otra semana), el bot no se equivoca al razonar: se equivoca
 * porque le dieron un dato rancio. Y le afirma al cliente cosas falsas con
 * total seguridad: "está apartado para el jueves 3" un día 11, o "listo para
 * despachar" un pedido entregado hace días.
 *
 * Este módulo es el último filtro antes de que el mensaje salga. No intenta
 * adivinar intenciones: toma las AFIRMACIONES CONCRETAS que hace el texto
 * sobre fechas y estados de pedido, y las contrasta con la DB. Si la DB no
 * respalda lo que el bot está a punto de decir, el mensaje no sale y se
 * escala al ejecutivo.
 *
 * PRINCIPIO DE DISEÑO: solo bloquea con evidencia positiva de contradicción.
 * La ausencia de datos nunca bloquea — un falso positivo deja al cliente sin
 * respuesta, que es peor que un mensaje genérico.
 */

const { getPool } = require('../db/database');

// Un pedido "por despachar" o "en camino" que no se mueve en este tiempo
// dejó de ser información: o se entregó sin registrarse, o se perdió.
const MAX_STALE_DAYS = 3;

const MESES = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
  julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10,
  noviembre: 11, diciembre: 12,
};

/**
 * Frases con las que el bot promete algo a futuro. Solo las fechas que
 * aparecen DESPUÉS de una de estas (y cerca) se validan como futuras.
 *
 * Esto es lo que evita el falso positivo obvio: "el pedido que te entregamos
 * el 3 de septiembre" menciona una fecha pasada y es perfectamente correcto.
 *
 * Se excluyen a propósito los verbos ambiguos en español rioplatense/chileno:
 * "entregamos", "enviamos" y "despachamos" son idénticos en presente y en
 * pasado, así que "el pedido que te entregamos el 3 de septiembre" se leería
 * como una promesa a futuro y silenciaría al bot sin motivo. Ante la duda,
 * se deja pasar: un falso positivo deja al cliente esperando.
 */
const FUTURE_CLAIM_PATTERNS = [
  /(apartad[oa]|agendad[oa]|reservad[oa]|anotad[oa])\s+(para|el|para\s+el)/gi,
  /(queda|dejamos|lo\s+dejo|te\s+lo\s+dejo|lo\s+tenemos)\s+para(\s+el)?/gi,
  /(te\s+)?(llega|llegar[aá]|llegar[ií]a|sale|saldr[aá])\s+(el|este|la)/gi,
  /para\s+el\s+(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)/gi,
];

// Ventana de texto (caracteres) en la que una fecha se considera parte de la promesa
const CLAIM_WINDOW = 70;

/**
 * Afirmaciones sobre el estado de un pedido. Cada una declara qué tiene que
 * ser verdad en la DB para que el bot pueda decirla.
 */
const STATE_CLAIMS = [
  {
    id: 'apartado',
    pattern: /(apartad[oa]|agendad[oa]|reservad[oa])\b/i,
    requires: 'scheduled_vigente',
    describe: 'le dice al cliente que tiene un pedido apartado',
  },
  {
    id: 'por_despachar',
    pattern: /(list[oa]\s+para\s+despachar|por\s+despachar|preparando\s+tu\s+pedido|en\s+preparaci[oó]n)/i,
    requires: 'order_activa',
    describe: 'le dice que su pedido está por despachar',
  },
  {
    id: 'en_camino',
    // Solo AFIRMACIONES en presente ("tu pedido va/está en camino", "salió el
    // reparto"). Se excluye la promesa a futuro "te avisamos cuando ESTÉ en
    // camino" (que aparece en el mensaje de confirmación y no afirma nada).
    pattern: /(va\s+en\s+camino|est[aá]\s+en\s+camino|en\s+ruta\b|sali[oó]\s+(a|el)\s+reparto|el\s+repartidor\s+va)/i,
    requires: 'order_activa',
    describe: 'le dice que su pedido va en camino',
  },
  {
    id: 'registrado',
    pattern: /(ya\s+tenemos\s+tu\s+pedido|pedido\s+registrado|pedido\s+confirmado)/i,
    requires: 'order_reciente',
    describe: 'le confirma un pedido registrado',
  },
];

// ─── Fechas ──────────────────────────────────────────────────────────────────

function todayStart() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Resuelve "3 de septiembre" a una fecha concreta.
 *
 * El año no viene en el texto, así que se asume el actual; si eso cae más de
 * 6 meses en el pasado, se asume el año siguiente (para que en enero un
 * "20 de diciembre" se lea como futuro, no como pasado).
 */
function resolveDayMonth(day, monthName) {
  const month = MESES[monthName.toLowerCase()];
  if (!month || day < 1 || day > 31) return null;

  const now = todayStart();
  let candidate = new Date(now.getFullYear(), month - 1, day);
  const sixMonthsMs = 182 * 24 * 3600 * 1000;
  if (now - candidate > sixMonthsMs) {
    candidate = new Date(now.getFullYear() + 1, month - 1, day);
  }
  return candidate;
}

/**
 * Encuentra fechas explícitas (día + mes) dentro de una promesa a futuro y
 * devuelve las que ya pasaron.
 */
function findPastDatesInFutureClaims(text) {
  const found = [];

  // Ubicar todas las promesas a futuro del texto
  const claimSpans = [];
  for (const re of FUTURE_CLAIM_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      claimSpans.push([m.index, m.index + m[0].length + CLAIM_WINDOW]);
      if (m.index === re.lastIndex) re.lastIndex++; // guardia anti-bucle
    }
  }
  if (claimSpans.length === 0) return found;

  const dateRe = /(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)/gi;
  let d;
  while ((d = dateRe.exec(text)) !== null) {
    const insideClaim = claimSpans.some(([start, end]) => d.index >= start && d.index <= end);
    if (!insideClaim) continue;

    const resolved = resolveDayMonth(parseInt(d[1], 10), d[2]);
    if (resolved && resolved < todayStart()) {
      found.push({ text: d[0], date: resolved });
    }
  }
  return found;
}

// ─── Estado en la DB ─────────────────────────────────────────────────────────

async function loadConversationFacts(conversationId) {
  const pool = getPool();

  const [scheduled, orders] = await Promise.all([
    pool.query(
      `SELECT id, desired_date FROM scheduled_orders
        WHERE conversation_id = $1 AND status = 'pending'
        ORDER BY desired_date DESC LIMIT 1`,
      [conversationId]
    ),
    pool.query(
      `SELECT id, status, created_at,
              COALESCE(updated_at, created_at) AS touched_at
         FROM orders
        WHERE conversation_id = $1
        ORDER BY COALESCE(updated_at, created_at) DESC LIMIT 1`,
      [conversationId]
    ),
  ]);

  const sched = scheduled.rows[0] || null;
  const order = orders.rows[0] || null;
  // 'draft' incluido: un pedido recién creado por el bot nace como 'draft'
  // y el mensaje de confirmación sale en el mismo turno. Sin esto, la
  // afirmación "pedido confirmado" no encontraba un pedido activo y el
  // guardrail escalaba al ejecutivo justo al confirmar.
  const ACTIVE = ['draft', 'nuevo', 'sent', 'payment_received', 'por_despachar', 'en_camino'];

  const ageDays = ts => ts ? (Date.now() - new Date(ts).getTime()) / 86400000 : null;

  return {
    scheduledVigente: !!sched && new Date(sched.desired_date) >= todayStart(),
    scheduledVencido: !!sched && new Date(sched.desired_date) <  todayStart(),
    scheduledFecha:   sched?.desired_date || null,
    orderActiva:      !!order && ACTIVE.includes(order.status),
    orderStatus:      order?.status || null,
    orderEdadDias:    ageDays(order?.touched_at),
    orderCreadaDias:  ageDays(order?.created_at),
    hayOrder:         !!order,
  };
}

// ─── Validación ──────────────────────────────────────────────────────────────

/**
 * Valida un mensaje antes de enviarlo.
 *
 * @param {number} orgId
 * @param {number} conversationId
 * @param {string} response - el texto que el bot quiere enviar
 * @returns {Promise<{ok: boolean, reason?: string, detail?: string}>}
 *   ok:false significa NO ENVIAR y escalar al ejecutivo.
 */
async function checkResponseFreshness(orgId, conversationId, response) {
  if (!response || typeof response !== 'string') return { ok: true };

  try {
    // 1. Fechas ya pasadas dentro de una promesa a futuro.
    //    No necesita DB: el texto se contradice con el calendario.
    const pastDates = findPastDatesInFutureClaims(response);
    if (pastDates.length > 0) {
      return {
        ok: false,
        reason: 'fecha_pasada',
        detail: `El mensaje promete una fecha que ya pasó ("${pastDates[0].text}").`,
      };
    }

    // 2. Afirmaciones de estado: ¿las respalda la DB?
    const claims = STATE_CLAIMS.filter(c => c.pattern.test(response));
    if (claims.length === 0) return { ok: true };

    const facts = await loadConversationFacts(conversationId);

    for (const claim of claims) {
      if (claim.requires === 'scheduled_vigente') {
        if (facts.scheduledVencido && !facts.scheduledVigente) {
          return {
            ok: false,
            reason: 'agendado_vencido',
            detail: `El bot ${claim.describe}, pero el único pedido agendado tiene fecha ${String(facts.scheduledFecha).slice(0, 10)}, que ya pasó.`,
          };
        }
      }

      if (claim.requires === 'order_activa') {
        // Sin pedido en la DB no se bloquea: puede venir de Shopify o del CRM.
        if (facts.hayOrder && !facts.orderActiva) {
          return {
            ok: false,
            reason: 'pedido_cerrado',
            detail: `El bot ${claim.describe}, pero el último pedido está en estado "${facts.orderStatus}".`,
          };
        }
        if (facts.orderActiva && facts.orderEdadDias > MAX_STALE_DAYS) {
          return {
            ok: false,
            reason: 'pedido_estancado',
            detail: `El bot ${claim.describe}, pero ese pedido lleva ${Math.floor(facts.orderEdadDias)} días sin moverse en estado "${facts.orderStatus}". Puede estar entregado sin registrarse.`,
          };
        }
      }

      if (claim.requires === 'order_reciente') {
        if (facts.hayOrder && !facts.orderActiva && facts.orderCreadaDias > MAX_STALE_DAYS) {
          return {
            ok: false,
            reason: 'pedido_viejo',
            detail: `El bot ${claim.describe}, pero el último pedido es de hace ${Math.floor(facts.orderCreadaDias)} días y está en estado "${facts.orderStatus}".`,
          };
        }
      }
    }

    return { ok: true };
  } catch (err) {
    // El guardrail nunca debe ser el motivo de que el cliente quede sin
    // respuesta: si la validación falla, se deja pasar el mensaje.
    console.error('[Guardrail] Error validando frescura:', err.message);
    return { ok: true };
  }
}

module.exports = {
  checkResponseFreshness,
  // exportados para pruebas
  findPastDatesInFutureClaims,
  resolveDayMonth,
  MAX_STALE_DAYS,
};
