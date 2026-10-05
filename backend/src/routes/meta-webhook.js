const express = require('express');
const crypto = require('crypto');
const { getPool } = require('../db/database');

const router = express.Router();
let io;
router.setSocketIO = value => { io = value; };

router.get('/', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === process.env.META_WEBHOOK_VERIFY_TOKEN) {
    return res.status(200).send(req.query['hub.challenge']);
  }
  res.sendStatus(403);
});

function validSignature(req) {
  const secret = process.env.META_APP_SECRET;
  const signature = req.get('x-hub-signature-256');
  if (!secret || !signature || !req.rawBody) return false;
  const expected = `sha256=${crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex')}`;
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function connectionForEntry(entryId) {
  const { rows } = await getPool().query(
    `SELECT organization_id,page_id,instagram_account_id FROM meta_connections
      WHERE status='connected' AND (page_id=$1 OR instagram_account_id=$1) LIMIT 1`, [String(entryId)]
  );
  return rows[0] || null;
}

async function saveMessaging(orgId, channel, event) {
  const senderId = String(event.sender?.id || '');
  const recipientId = String(event.recipient?.id || '');
  const message = event.message;
  if (!senderId || !message || message.is_echo) return;
  const content = message.text || (message.attachments?.[0]?.payload?.url ? `[Adjunto] ${message.attachments[0].payload.url}` : '[Mensaje]');
  const { rows: [thread] } = await getPool().query(
    `INSERT INTO meta_threads(organization_id,channel,external_user_id,contact_name,last_message_at,unread_count)
     VALUES($1,$2,$3,$3,NOW(),1)
     ON CONFLICT(organization_id,channel,external_user_id) DO UPDATE SET last_message_at=NOW(),unread_count=meta_threads.unread_count+1,updated_at=NOW()
     RETURNING *`, [orgId, channel, senderId]
  );
  const { rows: [saved] } = await getPool().query(
    `INSERT INTO meta_messages(thread_id,external_message_id,direction,content,message_type,status,sent_by,raw_payload,created_at)
     VALUES($1,$2,'inbound',$3,$4,'delivered','client',$5,TO_TIMESTAMP($6/1000.0))
     ON CONFLICT(external_message_id) DO NOTHING RETURNING *`,
    [thread.id, message.mid || `${senderId}:${event.timestamp}`, content, message.attachments?.[0]?.type || 'text', JSON.stringify(event), event.timestamp || Date.now()]
  );
  if (saved) io?.to(`org_${orgId}`).emit(`meta_message_${orgId}`, { thread, message: saved, recipientId });
}

router.post('/', async (req, res) => {
  if (!validSignature(req)) return res.sendStatus(401);
  res.sendStatus(200);
  try {
    for (const entry of req.body.entry || []) {
      const connection = await connectionForEntry(entry.id);
      if (!connection) continue;
      for (const event of entry.messaging || []) {
        const channel = String(req.body.object || '').includes('instagram') || entry.id === connection.instagram_account_id ? 'instagram' : 'facebook';
        await saveMessaging(connection.organization_id, channel, event);
      }
    }
  } catch (error) { console.error('[Meta webhook]', error.message); }
});

module.exports = router;
