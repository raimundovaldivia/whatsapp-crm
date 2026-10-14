const express = require('express');
const crypto = require('crypto');
const { getPool } = require('../db/database');
const meta = require('../services/meta-platform');
const socialBot = require('../services/social-bot');
const socialCrm = require('../services/social-crm');
const socialEvents = require('../services/social-events');
const { durableWebhook } = require('../services/webhook-inbox');

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
    `SELECT organization_id,page_id,instagram_account_id,page_access_token,
            auto_reply_messages,auto_reply_comments
       FROM meta_connections
      WHERE status='connected' AND (page_id=$1 OR instagram_account_id=$1) LIMIT 1`, [String(entryId)]
  );
  return rows[0] || null;
}

async function saveMessaging(connection, event) {
  const orgId = connection.organization_id;
  const { rows: [duplicate] } = await getPool().query(
    `SELECT 1 FROM meta_messages m JOIN meta_threads t ON t.id=m.thread_id
      WHERE m.external_message_id=$1 AND t.organization_id=$2 LIMIT 1`,
    [event.externalId, orgId]
  );
  if (duplicate) return null;
  const { rows: [thread] } = await getPool().query(
    `INSERT INTO meta_threads(organization_id,channel,external_user_id,contact_name,last_message_at,unread_count)
     VALUES($1,$2,$3,$3,NOW(),0)
     ON CONFLICT(organization_id,channel,external_user_id) DO UPDATE SET updated_at=NOW()
     RETURNING *`, [orgId, event.channel, event.senderId]
  );
  const { rows: [saved] } = await getPool().query(
    `INSERT INTO meta_messages(thread_id,external_message_id,direction,content,message_type,status,sent_by,raw_payload,created_at)
     VALUES($1,$2,'inbound',$3,$4,'delivered','client',$5,TO_TIMESTAMP($6/1000.0))
     ON CONFLICT(external_message_id) DO NOTHING RETURNING *`,
    [thread.id, event.externalId, event.content, event.messageType, JSON.stringify(event.raw), event.timestamp]
  );
  if (!saved) return null;
  const { rows: [updatedThread] } = await getPool().query(
    `UPDATE meta_threads SET last_message_at=TO_TIMESTAMP($1/1000.0),unread_count=unread_count+1,updated_at=NOW()
      WHERE id=$2 AND organization_id=$3 RETURNING *`, [event.timestamp, thread.id, orgId]
  );
  io?.to(`org_${orgId}`).emit(`meta_message_${orgId}`, { thread: updatedThread || thread, message: saved, recipientId: event.recipientId });
  const crm = await socialCrm.recordInbound({ orgId, thread: updatedThread || thread, event });
  if (!connection.auto_reply_messages) return saved;
  let generated = null;
  try {
    generated = await socialCrm.generateReply({ orgId, conversation: crm.conversation, content: event.content });
    if (!generated.response) return saved;
    generated.response = String(generated.response).slice(0, 1000);
    const token = meta.decryptToken(connection.page_access_token);
    const result = await meta.graphPost(socialEvents.messageEndpoint(connection, event.channel), token, {
      recipient: { id: event.senderId }, message: { text: generated.response },
    });
    const { rows: [outbound] } = await getPool().query(
      `INSERT INTO meta_messages(thread_id,external_message_id,direction,content,status,sent_by)
       VALUES($1,$2,'outbound',$3,'sent','ai') RETURNING *`,
      [thread.id, result.message_id || null, generated.response]
    );
    await getPool().query('UPDATE meta_threads SET last_message_at=NOW(),updated_at=NOW() WHERE id=$1', [thread.id]);
    await socialCrm.recordOutbound({
      orgId, thread, externalMessageId: result.message_id || null,
      content: generated.response, sentBy: 'ai', agentType: generated.agentType,
    });
    io?.to(`org_${orgId}`).emit(`meta_message_${orgId}`, { thread, message: outbound, orderCreated: generated.orderCreated || null });
  } catch (error) {
    if (generated?.response) {
      await getPool().query(
        `INSERT INTO meta_messages(thread_id,direction,content,status,sent_by)
         VALUES($1,'outbound',$2,'failed','ai')`,
        [thread.id, String(generated.response).slice(0, 1000)]
      ).catch(() => {});
      await socialCrm.recordOutbound({
        orgId, thread, externalMessageId: null, content: String(generated.response).slice(0, 1000),
        sentBy: 'ai', agentType: generated.agentType, status: 'failed',
      }).catch(() => {});
    }
    console.error('[Meta social bot/message]', meta.graphError(error));
    throw error;
  }
  return saved;
}

async function saveComment(connection, event) {
  const orgId = connection.organization_id;
  const { rows: [comment] } = await getPool().query(
    `INSERT INTO meta_comments(organization_id,channel,external_comment_id,post_id,parent_comment_id,
       author_id,author_name,content,raw_payload,created_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,TO_TIMESTAMP($10/1000.0))
     ON CONFLICT(external_comment_id) DO NOTHING RETURNING *`,
    [orgId, event.channel, event.externalId, event.postId || null, event.parentId || null,
      event.authorId, event.authorName, event.content, JSON.stringify(event.raw), event.timestamp]
  );
  if (!comment) return null;
  io?.to(`org_${orgId}`).emit(`meta_comment_${orgId}`, { comment });
  if (!connection.auto_reply_comments) return comment;
  try {
    const generated = await socialBot.generateSocialReply({
      orgId, channel: `${event.channel}_comment`, content: event.content,
      history: [], authorName: event.authorName,
    });
    if (!generated.response) return comment;
    const token = meta.decryptToken(connection.page_access_token);
    const result = await meta.graphPost(socialEvents.commentReplyEndpoint(comment), token, { message: generated.response });
    const { rows: [updated] } = await getPool().query(
      `UPDATE meta_comments SET status='replied',reply_text=$1,reply_external_id=$2,
         replied_by='ai',replied_at=NOW() WHERE id=$3 AND organization_id=$4 RETURNING *`,
      [generated.response, result.id || null, comment.id, orgId]
    );
    io?.to(`org_${orgId}`).emit(`meta_comment_${orgId}`, { comment: updated });
  } catch (error) {
    await getPool().query(
      `UPDATE meta_comments SET status='error' WHERE id=$1 AND organization_id=$2`, [comment.id, orgId]
    ).catch(() => {});
    console.error('[Meta social bot/comment]', meta.graphError(error));
  }
  return comment;
}

async function authenticateAndSplit(req, res, next) {
  if (!validSignature(req)) return res.sendStatus(401);
  try {
    req.webhookDeliveries = [];
    for (const entry of req.body.entry || []) {
      const connection = await connectionForEntry(entry.id);
      if (connection) req.webhookDeliveries.push({ orgId: connection.organization_id, body: { ...req.body, entry: [entry] } });
    }
    next();
  } catch (error) {
    console.error('[Meta webhook/auth]', error.message);
    res.sendStatus(503);
  }
}

router.post('/', authenticateAndSplit, durableWebhook('meta-social', async (req) => {
  for (const entry of req.body.entry || []) {
    const connection = await connectionForEntry(entry.id);
    if (!connection) continue;
    const body = { ...req.body, entry: [entry] };
    for (const event of socialEvents.extractSocialEvents(body, connection)) {
      if (socialEvents.isOwnActor(event, connection)) continue;
      if (event.kind === 'message') await saveMessaging(connection, event);
      if (event.kind === 'comment') await saveComment(connection, event);
    }
  }
}));

module.exports = router;
module.exports._validSignature = validSignature;
module.exports._connectionForEntry = connectionForEntry;
module.exports._authenticateAndSplit = authenticateAndSplit;
