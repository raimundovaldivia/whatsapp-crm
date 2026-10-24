const conflict = message => Object.assign(new Error(message), { status: 409 });

// Resume the durable queue; never rebuild recipients from today's audience filters.
// Lock the same campaign row as the worker so simultaneous clicks cannot reset work.
async function resumeCampaign({ pool, orgId, campaignId, excludeOrdersThisWeek = true, resolveSender }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const campaign = (await client.query(`SELECT * FROM broadcast_campaigns
      WHERE id = $1 AND organization_id = $2 FOR UPDATE`, [campaignId, orgId])).rows[0];
    if (!campaign) throw Object.assign(new Error('Campaña no encontrada'), { status: 404 });
    if (!campaign.server_managed) throw conflict('Esta campaña antigua no conserva una cola de pendientes. Debes preparar un nuevo envío.');
    if (!['kapso', 'evolution'].includes(campaign.sending_provider)) throw conflict('Proveedor no compatible con reanudación');
    if (!['interrupted', 'processing'].includes(campaign.status)) {
      throw conflict(campaign.status === 'paused_payment'
        ? 'Primero resuelve el problema de pago de Meta y revisa los fallidos.'
        : 'Solo se puede reanudar un envío detenido');
    }
    if (campaign.status === 'processing') {
      await client.query('COMMIT');
      return { campaign, alreadyRunning: true };
    }
    const counts = (await client.query(`SELECT
      COUNT(*) FILTER (WHERE state = 'pending')::int AS pending,
      COUNT(*) FILTER (WHERE state = 'processing')::int AS processing,
      COUNT(*) FILTER (WHERE state = 'unknown')::int AS unknown,
      COUNT(*) FILTER (WHERE state = 'pending' AND COALESCE(item->>'templateName', '') = '')::int AS missing_template
      FROM broadcast_jobs WHERE campaign_id = $1 AND organization_id = $2`, [campaignId, orgId])).rows[0];
    if (counts.processing) throw conflict('Espera a que termine el mensaje que estaba en envío');
    if (counts.unknown) throw conflict('Hay envíos por confirmar. Revisa su estado antes de reanudar para evitar duplicados.');
    if (!counts.pending) throw conflict('No quedan destinatarios pendientes para reanudar');
    if (campaign.sending_provider === 'kapso' && counts.missing_template) {
      throw conflict('La cola antigua de Kapso no conserva la plantilla y sus variables. Prepara un nuevo envío con los pendientes.');
    }
    await resolveSender(orgId, campaign.sending_provider, campaign.sending_channel_id);
    const updated = (await client.query(`UPDATE broadcast_campaigns
      SET status = 'processing', completed_at = NULL,
          pacing_settings = COALESCE(pacing_settings, '{}'::jsonb) || $3::jsonb
      WHERE id = $1 AND organization_id = $2 RETURNING *`,
    [campaignId, orgId, JSON.stringify({ excludeOrdersThisWeek })])).rows[0];
    // Keep available_at and scheduled_for: resumption must respect existing waits.
    // Failed, accepted, skipped and uncertain jobs are never reset to pending.
    await client.query('COMMIT');
    return { campaign: updated, pending: counts.pending };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

async function hasOrderThisWeek(pool, orgId, phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  const numbers = [digits];
  if (/^569\d{8}$/.test(digits)) numbers.push(digits.slice(2));
  if (/^9\d{8}$/.test(digits)) numbers.push(`56${digits}`);
  // A placed, unpaid order counts too. Draft carts, cancelled and refunded orders do not.
  // Compute Monday in Chile at execution time, including daylight-saving transitions.
  const { rows } = await pool.query(`WITH week AS (
    SELECT date_trunc('week', NOW() AT TIME ZONE 'America/Santiago') AT TIME ZONE 'America/Santiago' AS starts
  ) SELECT EXISTS (
    SELECT 1 FROM orders o LEFT JOIN conversations c
      ON c.id = o.conversation_id AND c.organization_id = o.organization_id
    CROSS JOIN week w
    WHERE o.organization_id = $1 AND o.created_at >= w.starts AND o.created_at <= NOW()
      AND LOWER(COALESCE(o.status, '')) NOT IN ('draft', 'cancelled', 'canceled', 'refunded', 'voided')
      AND regexp_replace(COALESCE(NULLIF(o.customer_phone, ''), c.phone_number, ''), '[^0-9]', '', 'g') = ANY($2::text[])
    UNION ALL
    SELECT 1 FROM shopify_orders o CROSS JOIN week w
    WHERE o.organization_id = $1 AND o.shopify_created_at >= w.starts AND o.shopify_created_at <= NOW()
      AND LOWER(COALESCE(o.crm_status, '')) NOT IN ('draft', 'cancelled', 'canceled')
      AND LOWER(COALESCE(o.financial_status, '')) NOT IN ('refunded', 'voided')
      AND regexp_replace(COALESCE(o.customer_phone, ''), '[^0-9]', '', 'g') = ANY($2::text[])
  ) AS ordered`, [orgId, numbers]);
  return rows[0]?.ordered === true;
}

module.exports = { resumeCampaign, hasOrderThisWeek };
