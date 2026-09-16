/**
 * bank-statement.js — Lector de cartolas Santander (PDF) para conciliación
 *
 * Lee el PDF con pdfjs (texto con posición), reconoce las columnas por la
 * fila de encabezado (FECHA / CARGO / ABONO / DESCRIPCIÓN / SALDO / N° DOC /
 * SUCURSAL) y arma un movimiento por cada fecha, juntando los fragmentos de
 * descripción que el banco parte en 2-3 líneas.
 *
 * Valida contra los totales del propio PDF ("Abonos: $ …", "Cargos: $ …"):
 * si no cuadran, el resultado lo dice — nunca se conciliará en silencio con
 * una lectura incompleta.
 *
 * Formatos probados: "Cartola provisoria" (diaria) y "Cartolas históricas".
 */

const HEADERS = ['FECHA', 'CARGO', 'ABONO', 'DESCRIPCIÓN', 'SALDO', 'N° DOC', 'SUCURSAL'];

function parseAmount(s) {
  const m = String(s || '').replace(/\s/g, '').match(/^\$?(-?)([\d.]+)$/);
  if (!m) return null;
  const n = parseInt(m[2].replace(/\./g, ''), 10);
  return Number.isFinite(n) ? (m[1] === '-' ? -n : n) : null;
}

function isDate(s) { return /^\d{2}\/\d{2}\/\d{4}$/.test(String(s || '').trim()); }
function toISO(d) { const [dd, mm, yy] = d.split('/'); return `${yy}-${mm}-${dd}`; }

/** Nombre de quien transfiere: "0150370620 Transf. Evelyn Maribel" → "Evelyn Maribel" */
function payerFromDescription(desc) {
  return String(desc || '')
    .replace(/^\d{6,}\s*/, '')
    .replace(/^(transf(erencia)?\.?\s*(de|a|desde)?\s*)/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function extractItems(buffer) {
  let pdfjs;
  try {
    pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  } catch (e) {
    throw new Error('Falta la librería pdfjs-dist en el servidor. En la carpeta backend ejecuta: npm install pdfjs-dist@5 — y vuelve a desplegar.');
  }
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer), useSystemFonts: true, disableFontFace: true, isEvalSupported: false,
  }).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    pages.push(tc.items
      .filter(i => i.str && i.str.trim())
      .map(i => ({ s: i.str.trim(), x: i.transform[4], y: i.transform[5], w: i.width || 0 })));
  }
  try { await doc.destroy(); } catch {}
  return pages;
}

/**
 * @param {Buffer} buffer — PDF
 * @returns {{ account, statementNumber, from, to, kind, totals:{abonos,cargos,saldoInicial,saldoFinal},
 *             movements:[{date, amount, kind:'abono'|'cargo', description, payer, docNumber, branch, balance}],
 *             sums:{abonos,cargos}, valid:boolean, warnings:string[] }}
 */
async function parseSantanderStatement(buffer) {
  const pages = await extractItems(buffer);
  const all = pages.flat();
  const warnings = [];

  // ── Metadatos del encabezado ────────────────────────────────────────────
  const text = all.map(i => i.s).join('\n');
  const grab = re => { const m = text.match(re); return m ? m[1].trim() : null; };
  const account = grab(/Cuenta:\s*(?:N°\s*)?([\d-]+)/i);
  const statementNumber = grab(/N[uú]mero cartola:\s*(\d+)/i);
  const from = grab(/Fecha desde:\s*(\d{2}\/\d{2}\/\d{4})/i);
  const to   = grab(/Fecha hasta:\s*(\d{2}\/\d{2}\/\d{4})/i);
  const kind = /provisoria/i.test(text) ? 'provisoria' : 'historica';

  // Totales: los valores vienen como ítems separados justo después de la etiqueta
  const totalAfter = label => {
    const idx = all.findIndex(i => new RegExp(`^${label}:?$`, 'i').test(i.s.replace(/\s+/g, ' ')));
    if (idx < 0) {
      // etiqueta y valor en el mismo ítem ("Abonos: $ 5.250.425")
      const it = all.find(i => new RegExp(`^${label}:\\s*\\$`, 'i').test(i.s));
      return it ? parseAmount(it.s.replace(/^[^$]*/, '')) : null;
    }
    const next = all.slice(idx + 1, idx + 3).find(i => /^\$/.test(i.s));
    return next ? parseAmount(next.s) : null;
  };
  const totals = {
    saldoInicial: totalAfter('Saldo inicial'),
    saldoFinal:   totalAfter('Saldo final'),
    abonos:       totalAfter('Abonos') ?? totalAfter('Otros abonos'),
    cargos:       totalAfter('Cargos') ?? totalAfter('Otros cargos'),
  };

  // ── Columnas por la fila de encabezado ──────────────────────────────────
  let header = null;
  for (const items of pages) {
    const fecha = items.find(i => i.s === 'FECHA');
    if (!fecha) continue;
    const row = items.filter(i => Math.abs(i.y - fecha.y) < 3);
    const cols = {};
    for (const h of HEADERS) {
      const it = row.find(i => i.s.replace(/\s+/g, ' ').toUpperCase() === h);
      if (it) cols[h] = it.x + it.w / 2;
    }
    if (cols['CARGO'] && cols['ABONO'] && cols['SALDO']) { header = cols; break; }
  }
  if (!header) {
    return { account, statementNumber, from, to, kind, totals, movements: [], sums: { abonos: 0, cargos: 0 }, valid: false,
      warnings: ['No se encontró la tabla de movimientos (FECHA / CARGO / ABONO / SALDO). ¿Es una cartola Santander?'] };
  }
  const mid = (a, b) => (a + b) / 2;
  const B = {
    cargoMax: mid(header['CARGO'], header['ABONO']),
    abonoMax: mid(header['ABONO'], header['DESCRIPCIÓN'] || header['ABONO'] + 40),
    descMax:  mid(header['DESCRIPCIÓN'] || header['ABONO'] + 40, header['SALDO']),
    saldoMax: mid(header['SALDO'], header['N° DOC'] || header['SALDO'] + 50),
    docMax:   mid(header['N° DOC'] || header['SALDO'] + 50, header['SUCURSAL'] || header['SALDO'] + 100),
  };
  const colOf = it => {
    const cx = it.x + it.w / 2;
    if (cx < B.cargoMax) return 'cargo';
    if (cx < B.abonoMax) return 'abono';
    if (cx < B.descMax)  return 'desc';
    if (cx < B.saldoMax) return 'saldo';
    if (cx < B.docMax)   return 'doc';
    return 'branch';
  };

  // ── Movimientos: cada fecha ancla un grupo; cada ítem va a la fecha más cercana ──
  const movements = [];
  for (const items of pages) {
    const fechaHdr = items.find(i => i.s === 'FECHA' && i.x < header['CARGO'] - 30);
    let body = fechaHdr ? items.filter(i => i.y < fechaHdr.y - 2) : items;
    // Secciones de resumen al final ("Saldos diarios", "Resumen comisiones"):
    // repiten datos que ya están en el detalle. Todo lo que esté debajo se ignora.
    const cuts = body.filter(i => /^(Saldos diarios|Resumen comisiones|Resumen de comisiones|Resumen)\b/i.test(i.s) && i.x < header['CARGO']);
    if (cuts.length) { const topCut = Math.max(...cuts.map(c => c.y)); body = body.filter(i => i.y > topCut); }

    const anchors = body
      .filter(i => isDate(i.s) && i.x < header['CARGO'] - 30)
      .map(i => ({ date: toISO(i.s), y: i.y, cargo: null, abono: null, descParts: [], balance: null, docNumber: null, branch: null }));
    if (!anchors.length) continue;
    const nearest = y => {
      let best = null, bd = Infinity;
      for (const a of anchors) { const d = Math.abs(a.y - y); if (d < bd) { bd = d; best = a; } }
      return bd <= 10 ? best : null;   // fragmentos de descripción están a ±4 pt de su fecha
    };

    for (const it of body) {
      if (isDate(it.s) && it.x < header['CARGO'] - 30) continue;
      const cur = nearest(it.y);
      if (!cur) continue;
      const col = colOf(it);
      if (col === 'cargo' || col === 'abono') {
        const n = parseAmount(it.s);
        if (n == null) continue;
        if (n < 0 || col === 'cargo') cur.cargo = Math.abs(n); else cur.abono = n;
      } else if (col === 'desc') {
        cur.descParts.push({ y: it.y, s: it.s });
      } else if (col === 'saldo') {
        const n = parseAmount(it.s); if (n != null) cur.balance = n;
      } else if (col === 'doc') {
        if (/^[\dA-Z]{6,}$/.test(it.s)) cur.docNumber = it.s;
      } else if (col === 'branch') {
        cur.branch = it.s;
      }
    }
    // Orden cronológico de lectura (arriba → abajo)
    anchors.sort((a, b) => b.y - a.y);
    movements.push(...anchors);
  }

  // ── Normalizar ──────────────────────────────────────────────────────────
  const out = [];
  for (const m of movements) {
    if (m.cargo == null && m.abono == null) continue;          // sin monto: no es movimiento
    if (m.balance == null) continue;                           // sin columna SALDO: fila de resumen, no movimiento
    const description = m.descParts.sort((a, b) => b.y - a.y).map(p => p.s).join(' ').replace(/\s+/g, ' ').trim();
    const amount = m.abono != null ? m.abono : m.cargo;
    out.push({
      date: m.date,
      kind: m.abono != null ? 'abono' : 'cargo',
      amount,
      description,
      payer: payerFromDescription(description),
      docNumber: m.docNumber,
      branch: m.branch,
      balance: m.balance,
    });
  }

  const sums = {
    abonos: out.filter(x => x.kind === 'abono').reduce((s, x) => s + x.amount, 0),
    cargos: out.filter(x => x.kind === 'cargo').reduce((s, x) => s + x.amount, 0),
  };
  let valid = true;
  if (totals.abonos != null && totals.abonos !== sums.abonos) {
    valid = false;
    warnings.push(`Abonos leídos $${sums.abonos.toLocaleString('es-CL')} ≠ total del banco $${totals.abonos.toLocaleString('es-CL')}`);
  }
  if (totals.cargos != null && totals.cargos !== sums.cargos) {
    valid = false;
    warnings.push(`Cargos leídos $${sums.cargos.toLocaleString('es-CL')} ≠ total del banco $${totals.cargos.toLocaleString('es-CL')}`);
  }
  if (!out.length) { valid = false; warnings.push('No se leyó ningún movimiento'); }

  return { account, statementNumber, from: from ? toISO(from) : null, to: to ? toISO(to) : null, kind, totals, movements: out, sums, valid, warnings };
}

/** Clave estable de un movimiento para no importarlo dos veces (cartolas provisorias se solapan a diario). */
function movementKey(m) {
  return [m.date, m.kind, m.amount, m.docNumber || '', m.description.toLowerCase().replace(/\s+/g, ' ').slice(0, 80)].join('|');
}

module.exports = { parseSantanderStatement, movementKey, payerFromDescription, parseAmount };
