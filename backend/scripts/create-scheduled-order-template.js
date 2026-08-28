/**
 * create-scheduled-order-template.js
 *
 * Crea el template de WhatsApp para el follow-up de pedidos agendados
 * y guarda el nombre en la tabla de settings de cada org.
 *
 * Uso (en Railway console o local con .env):
 *   node backend/scripts/create-scheduled-order-template.js
 *
 * Requiere: DATABASE_URL en el entorno.
 */

require('dotenv').config();
const axios = require('axios');
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const TEMPLATE_NAME = 'pedido_agendado_seguimiento';
const TEMPLATE_BODY = 'Hola {{1}}, ¡llegó el día! 📅 Habías quedado de pedir {{2}}. ¿Lo confirmamos ahora?';
const TEMPLATE_FOOTER = 'Responde STOP para no recibir más mensajes';

async function main() {
  let orgs;
  try {
    const { rows } = await pool.query(`
      SELECT wc.organization_id AS org_id, wc.kapso_api_key, wc.business_account_id AS waba_id,
             o.name AS org_name
      FROM whatsapp_configs wc
      JOIN organizations o ON o.id = wc.organization_id
      WHERE wc.provider = 'kapso'
        AND wc.kapso_api_key IS NOT NULL
        AND wc.business_account_id IS NOT NULL
    `);
    orgs = rows;
  } catch (err) {
    console.error('Error consultando DB:', err.message);
    process.exit(1);
  }

  if (!orgs.length) {
    console.error('No se encontraron orgs con configuración Kapso completa.');
    process.exit(1);
  }

  for (const org of orgs) {
    console.log(`\n── Org: ${org.org_name} (id: ${org.org_id}) ──`);

    // 1. Crear el template en Meta/Kapso
    try {
      const response = await axios.post(
        `https://api.kapso.ai/meta/whatsapp/v24.0/${org.waba_id}/message_templates`,
        {
          name:     TEMPLATE_NAME,
          language: 'es',
          category: 'UTILITY',
          components: [
            {
              type: 'BODY',
              text: TEMPLATE_BODY,
              example: {
                body_text: [['María', 'la caja de huevos Jumbo']],
              },
            },
            {
              type: 'FOOTER',
              text: TEMPLATE_FOOTER,
            },
          ],
        },
        {
          headers: {
            'X-API-Key':    org.kapso_api_key,
            'Content-Type': 'application/json',
          },
        }
      );

      const status = response.data?.status || 'PENDING';
      console.log(`✅ Template creado — status: ${status}`);
      console.log(`   Nombre: ${TEMPLATE_NAME}`);
      console.log(`   Body:   ${TEMPLATE_BODY}`);

    } catch (err) {
      const detail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
      if (detail.includes('duplicate') || detail.includes('already exists') || detail.includes('DUPLICATED')) {
        console.log(`ℹ️  Template ya existe — continuando con guardado de setting`);
      } else {
        console.error(`❌ Error creando template:`, detail);
        continue;
      }
    }

    // 2. Guardar el nombre del template en settings
    try {
      await pool.query(
        `INSERT INTO settings (organization_id, key, value)
         VALUES ($1, 'scheduled_order_template', $2)
         ON CONFLICT (organization_id, key) DO UPDATE SET value = EXCLUDED.value`,
        [org.org_id, TEMPLATE_NAME]
      );
      console.log(`✅ Setting 'scheduled_order_template' = '${TEMPLATE_NAME}' guardado`);
    } catch (err) {
      console.error(`❌ Error guardando setting:`, err.message);
    }
  }

  await pool.end();
  console.log('\n✅ Listo.');
}

main().catch(err => {
  console.error('Error fatal:', err.message);
  process.exit(1);
});
