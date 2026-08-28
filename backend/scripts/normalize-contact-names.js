/**
 * normalize-contact-names.js
 *
 * Normaliza los nombres históricos en contacts y shopify_orders a Title Case.
 * - "JUAN PÉREZ" → "Juan Pérez"
 * - "juan de la vega" → "Juan de la Vega"
 * - Nombres ya con mezcla de mayúsculas/minúsculas no se tocan.
 *
 * Uso:
 *   railway run node backend/scripts/normalize-contact-names.js
 */

require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const LOWERCASE_PARTICLES = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'e', 'van', 'von', 'di', 'da', 'do']);

function normalizeName(name) {
  if (!name) return null;
  const clean = String(name).trim().replace(/\s+/g, ' ');
  if (!clean) return null;
  const upper = clean === clean.toUpperCase();
  const lower = clean === clean.toLowerCase();
  if (!upper && !lower) return clean;
  return clean
    .toLowerCase()
    .split(' ')
    .map((word, i) => {
      if (i > 0 && LOWERCASE_PARTICLES.has(word)) return word;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(' ');
}

async function main() {
  let updatedContacts = 0, updatedOrders = 0;

  // ── contacts ──────────────────────────────────────────────────────
  console.log('🔍 Leyendo contacts...');
  const { rows: contacts } = await pool.query(`SELECT id, name FROM contacts WHERE name IS NOT NULL`);
  console.log(`   ${contacts.length} registros`);

  for (const c of contacts) {
    const normalized = normalizeName(c.name);
    if (normalized && normalized !== c.name) {
      await pool.query(`UPDATE contacts SET name = $1, updated_at = NOW() WHERE id = $2`, [normalized, c.id]);
      console.log(`  contacts: "${c.name}" → "${normalized}"`);
      updatedContacts++;
    }
  }

  // ── shopify_orders ────────────────────────────────────────────────
  console.log('\n🔍 Leyendo shopify_orders...');
  const { rows: orders } = await pool.query(`SELECT id, customer_name FROM shopify_orders WHERE customer_name IS NOT NULL`);
  console.log(`   ${orders.length} registros`);

  for (const o of orders) {
    const normalized = normalizeName(o.customer_name);
    if (normalized && normalized !== o.customer_name) {
      await pool.query(`UPDATE shopify_orders SET customer_name = $1 WHERE id = $2`, [normalized, o.id]);
      console.log(`  orders: "${o.customer_name}" → "${normalized}"`);
      updatedOrders++;
    }
  }

  console.log(`\n✅ contacts actualizados: ${updatedContacts}`);
  console.log(`✅ shopify_orders actualizados: ${updatedOrders}`);
  await pool.end();
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
