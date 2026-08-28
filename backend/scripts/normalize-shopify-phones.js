/**
 * normalize-shopify-phones.js
 *
 * Normaliza customer_phone en shopify_orders al formato 56XXXXXXXXX
 * para que el JOIN con contacts.phone funcione correctamente.
 *
 * Uso:
 *   railway run node backend/scripts/normalize-shopify-phones.js
 */

require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  console.log('🔍 Leyendo shopify_orders con customer_phone...');

  const { rows } = await pool.query(`
    SELECT id, customer_phone FROM shopify_orders
    WHERE customer_phone IS NOT NULL AND customer_phone != ''
  `);

  console.log(`📦 Total registros: ${rows.length}`);

  let updated = 0;
  let skipped = 0;

  for (const row of rows) {
    const original = row.customer_phone;
    const normalized = normalizePhone(original);

    if (!normalized || normalized === original) {
      skipped++;
      continue;
    }

    await pool.query(
      `UPDATE shopify_orders SET customer_phone = $1 WHERE id = $2`,
      [normalized, row.id]
    );
    console.log(`  ✅ ${original} → ${normalized}`);
    updated++;
  }

  console.log(`\n✅ Normalizados: ${updated} | Sin cambios: ${skipped}`);
  await pool.end();
}

function normalizePhone(phone) {
  if (!phone) return null;
  // Quitar todo excepto dígitos
  let p = String(phone).replace(/\D/g, '');
  // Móvil chileno sin código de país: 9 dígitos empezando en 9
  if (/^9\d{8}$/.test(p)) p = '56' + p;
  return p || null;
}

main().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
