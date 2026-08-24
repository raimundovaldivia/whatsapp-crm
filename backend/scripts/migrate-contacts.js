/**
 * Migración one-time: poblar tabla contacts desde órdenes históricas.
 * Correr desde backend/ con DATABASE_URL en el entorno.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function migrate() {
  const client = await pool.connect();
  try {
    // Un solo registro por (org, phone) — el más reciente
    const { rows } = await client.query(`
      SELECT DISTINCT ON (o.organization_id, c.phone_number)
        o.organization_id,
        c.phone_number      AS phone,
        o.customer_name     AS name,
        o.customer_phone,
        o.shipping_address,
        o.created_at
      FROM orders o
      JOIN conversations c ON o.conversation_id = c.id
      WHERE o.status NOT IN ('cancelled')
        AND c.phone_number IS NOT NULL
      ORDER BY o.organization_id, c.phone_number, o.created_at DESC
    `);

    console.log(`Contactos únicos encontrados: ${rows.length}`);
    let ok = 0, skip = 0;

    for (const row of rows) {
      let address = null, city = null;
      try {
        const addr = JSON.parse(row.shipping_address || '{}');
        // shipping_address puede ser { address, city } o un objeto Shopify
        address = addr.address || addr.address1 || null;
        city    = addr.city    || null;
      } catch { skip++; continue; }

      await client.query(`
        INSERT INTO contacts (organization_id, phone, name, address, city, updated_at)
        VALUES ($1, $2, $3, $4, $5, NOW())
        ON CONFLICT (organization_id, phone) DO UPDATE SET
          name    = COALESCE(EXCLUDED.name,    contacts.name),
          address = COALESCE(EXCLUDED.address, contacts.address),
          city    = COALESCE(EXCLUDED.city,    contacts.city),
          updated_at = NOW()
      `, [row.organization_id, row.phone, row.name || null, address, city]);
      ok++;
    }

    console.log(`✅ Migración completa: ${ok} insertados, ${skip} saltados (sin dirección).`);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch(err => { console.error('❌ Error:', err.message); process.exit(1); });
