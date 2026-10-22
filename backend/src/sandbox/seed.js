const bcrypt = require('bcryptjs');
const { KEYS } = require('../services/solution-catalog');

// Only called by the validated sandbox runtime, after schema preparation.
async function seed(pool, password) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(712345)");
    const hash = await bcrypt.hash(password, 12);
    for (const [label, phone] of [['a', '15550100101'], ['b', '15550100102']]) {
      const slug = `sandbox-${label}`;
      const { rows: [org] } = await client.query(`INSERT INTO organizations(name,slug,setup_done)
        VALUES($1,$2,1) ON CONFLICT(slug) DO UPDATE SET setup_done=1 RETURNING id`, [`Sandbox ${label.toUpperCase()} · ficticio`, slug]);
      await client.query(`INSERT INTO users(organization_id,email,password_hash,name,role)
        VALUES($1,$2,$3,$4,'owner') ON CONFLICT(organization_id,email) DO NOTHING`,
      [org.id, `owner-${label}@sandbox.invalid`, hash, `Owner ficticio ${label.toUpperCase()}`]);
      await client.query(`INSERT INTO commercial_contracts(organization_id,status,modules,limits)
        VALUES($1,'active',$2::jsonb,'{"bot_turns":100,"seats":10}') ON CONFLICT(organization_id) DO NOTHING`, [org.id, JSON.stringify(KEYS)]);
      await client.query(`INSERT INTO whatsapp_configs(organization_id,provider,phone_number_id,access_token,status)
        VALUES($1,'meta',$2,'sandbox-not-a-real-token','connected') ON CONFLICT(organization_id) DO NOTHING`, [org.id, `sandbox-phone-${label}`]);
      await client.query(`INSERT INTO settings(organization_id,key,value) VALUES
        ($1,'ai_enabled_global','false'),($1,'catalog_source','local'),($1,'store_context','Catálogo ficticio de pruebas. Ningún dato es real.')
        ON CONFLICT(organization_id,key) DO NOTHING`, [org.id]);
      await client.query(`INSERT INTO conversations(organization_id,phone_number,contact_name,agent_mode,last_message)
        VALUES($1,$2,'Cliente ficticio','human','Consulta ficticia de prueba') ON CONFLICT DO NOTHING`, [org.id, phone]);
      const { rows: [conversation] } = await client.query('SELECT id FROM conversations WHERE organization_id=$1 AND phone_number=$2 AND whatsapp_channel_id IS NULL', [org.id, phone]);
      await client.query(`INSERT INTO messages(conversation_id,direction,content,type,sent_by,whatsapp_message_id)
        SELECT $1,'inbound','Consulta ficticia de prueba','text','client',$2
        WHERE NOT EXISTS(SELECT 1 FROM messages WHERE conversation_id=$1)`, [conversation.id, `sandbox-inbound-${label}`]);
      await client.query(`INSERT INTO products(organization_id,title,description,price,sku,stock)
        SELECT $1,'Producto de prueba','Producto ficticio sin venta real',1000,$2,100
        WHERE NOT EXISTS(SELECT 1 FROM products WHERE organization_id=$1 AND sku=$2)`, [org.id, `SANDBOX-${label}`]);
      await client.query(`INSERT INTO orders(organization_id,conversation_id,items,customer_name,customer_phone,total_price,status)
        SELECT $1,$2,'[{"name":"Producto de prueba","quantity":1,"price":1000}]','Cliente ficticio',$3,'1000','draft'
        WHERE NOT EXISTS(SELECT 1 FROM orders WHERE organization_id=$1)`, [org.id, conversation.id, phone]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}
module.exports = { seed };
