// Historias de Instagram programadas.
// Flujo: draft → (chequeos OK) review → (aprobación humana) approved → published
// Ninguna historia se publica sin pasar por chequeo previo y aprobación explícita.
const axios = require('axios');
const { getPool } = require('../db/database');
const meta = require('./meta-platform');

const MIN_LEAD_MS = 5 * 60 * 1000;          // no se programa para dentro de menos de 5 min
const STALE_PUBLISHING_MS = 15 * 60 * 1000; // publishing colgado → failed (nunca reintentar: evita duplicados)
const DEFAULT_INTERVAL_MS = 60 * 1000;
const EDITABLE = ['draft', 'review', 'approved'];
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

let timer = null;
let running = false;

// ---------- utilidades ----------

function sizeFromImage(buffer, contentType) {
  // PNG: IHDR en bytes 16..24
  if (contentType === 'image/png' && buffer.length >= 24 && buffer.toString('ascii', 1, 4) === 'PNG') {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  // JPEG: buscar marcador SOF0/SOF2
  if (contentType === 'image/jpeg') {
    let i = 2;
    while (i < buffer.length) {
      if (buffer[i] !== 0xFF) { i++; continue; }
      const marker = buffer[i + 1];
      const len = buffer.readUInt16BE(i + 2);
      if (marker === 0xC0 || marker === 0xC2) {
        return { height: buffer.readUInt16BE(i + 5), width: buffer.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  }
  return null;
}

async function logEvent(client, postId, orgId, action, actor, detail = {}) {
  await client.query(
    `INSERT INTO social_post_events (post_id, organization_id, action, actor, detail)
     VALUES ($1,$2,$3,$4,$5)`,
    [postId, orgId, action, actor || null, JSON.stringify(detail)]
  );
}

// ---------- chequeo previo ----------

// Devuelve { ok, items: [{ name, ok, detail }] }. No muta nada.
async function runChecks(orgId, post, { requireFuture = true } = {}) {
  const items = [];
  const add = (name, ok, detail = '') => items.push({ name, ok: !!ok, detail });

  // 1. cuenta de Instagram conectada
  const { rows } = await getPool().query(
    `SELECT status, instagram_account_id, instagram_username FROM meta_connections WHERE organization_id = $1`,
    [orgId]
  );
  const conn = rows[0];
  add('cuenta_instagram', conn && conn.status === 'connected' && conn.instagram_account_id,
    conn?.instagram_username ? `@${conn.instagram_username}` : 'Meta no conectado o sin cuenta de Instagram profesional');

  // 2. URL pública HTTPS que responde
  let url = null;
  try { url = new URL(post.image_url); } catch (_) { /* invalida */ }
  add('url_https', url && url.protocol === 'https:', url ? url.hostname : 'URL inválida');

  if (url && url.protocol === 'https:') {
    try {
      const res = await axios.get(post.image_url, { responseType: 'arraybuffer', timeout: 15000, maxContentLength: MAX_IMAGE_BYTES, validateStatus: () => true });
      const type = String(res.headers['content-type'] || '').split(';')[0].trim();
      add('imagen_disponible', res.status === 200, `HTTP ${res.status}`);
      add('formato_imagen', ['image/png', 'image/jpeg'].includes(type), type || 'sin tipo');
      const size = res.status === 200 ? sizeFromImage(Buffer.from(res.data), type) : null;
      if (size) {
        // Historia 9:16. Se acepta 1080x1920 o cualquier 9:16 exacto.
        const ratioOk = size.width * 16 === size.height * 9;
        add('formato_9x16', ratioOk && size.width >= 720, `${size.width}x${size.height}`);
      } else {
        add('formato_9x16', false, 'no se pudieron leer las dimensiones');
      }
    } catch (error) {
      add('imagen_disponible', false, error.code || error.message);
    }
  }

  // 3. fecha futura con margen
  const when = new Date(post.scheduled_for);
  const validDate = !Number.isNaN(when.getTime());
  add('fecha_valida', validDate, validDate ? when.toISOString() : 'fecha inválida');
  if (requireFuture && validDate) {
    add('fecha_futura', when.getTime() - Date.now() >= MIN_LEAD_MS, 'mínimo 5 minutos desde ahora');
  }

  return { ok: items.every(i => i.ok), checked_at: new Date().toISOString(), items };
}

// ---------- operaciones (todas filtradas por organización) ----------

async function listPosts(orgId, { status } = {}) {
  const params = [orgId];
  let where = 'organization_id = $1';
  if (status) { params.push(status); where += ` AND status = $2`; }
  const { rows } = await getPool().query(
    `SELECT * FROM social_scheduled_posts WHERE ${where} ORDER BY scheduled_for ASC LIMIT 200`, params
  );
  return rows;
}

async function getPost(orgId, id) {
  const { rows } = await getPool().query(
    `SELECT * FROM social_scheduled_posts WHERE id = $1 AND organization_id = $2`, [id, orgId]
  );
  return rows[0] || null;
}

async function getEvents(orgId, id) {
  const { rows } = await getPool().query(
    `SELECT action, actor, detail, created_at FROM social_post_events
     WHERE post_id = $1 AND organization_id = $2 ORDER BY created_at ASC`, [id, orgId]
  );
  return rows;
}

async function createPost(orgId, { title = '', image_url, scheduled_for }, actor) {
  const draft = { image_url, scheduled_for };
  const checks = await runChecks(orgId, draft);
  const status = checks.ok ? 'review' : 'draft';
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO social_scheduled_posts (organization_id, title, image_url, scheduled_for, status, checks, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [orgId, String(title).slice(0, 120), image_url, scheduled_for, status, JSON.stringify(checks), actor]
    );
    await logEvent(client, rows[0].id, orgId, 'created', actor, { status, checks_ok: checks.ok });
    await client.query('COMMIT');
    return rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

// Editar invalida la aprobación: el contenido aprobado debe ser el que se publica.
async function updatePost(orgId, id, patch, actor) {
  const current = await getPost(orgId, id);
  if (!current) return { error: 'not_found' };
  if (!EDITABLE.includes(current.status)) return { error: 'not_editable', status: current.status };

  const next = {
    title: patch.title !== undefined ? String(patch.title).slice(0, 120) : current.title,
    image_url: patch.image_url !== undefined ? patch.image_url : current.image_url,
    scheduled_for: patch.scheduled_for !== undefined ? patch.scheduled_for : current.scheduled_for,
  };
  const checks = await runChecks(orgId, next);
  const status = checks.ok ? 'review' : 'draft';

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE social_scheduled_posts
          SET title=$3, image_url=$4, scheduled_for=$5, status=$6, checks=$7,
              approved_by=NULL, approved_at=NULL, last_error=NULL, updated_at=NOW()
        WHERE id=$1 AND organization_id=$2 RETURNING *`,
      [id, orgId, next.title, next.image_url, next.scheduled_for, status, JSON.stringify(checks)]
    );
    await logEvent(client, id, orgId, 'edited', actor, {
      changed: Object.keys(patch), previous_status: current.status, status,
    });
    await client.query('COMMIT');
    return { post: rows[0] };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

async function approvePost(orgId, id, actor) {
  const current = await getPost(orgId, id);
  if (!current) return { error: 'not_found' };
  if (current.status !== 'review') return { error: 'not_reviewable', status: current.status };

  const checks = await runChecks(orgId, current);
  if (!checks.ok) {
    await getPool().query(
      `UPDATE social_scheduled_posts SET status='draft', checks=$3, updated_at=NOW() WHERE id=$1 AND organization_id=$2`,
      [id, orgId, JSON.stringify(checks)]
    );
    return { error: 'checks_failed', checks };
  }

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE social_scheduled_posts
          SET status='approved', checks=$3, approved_by=$4, approved_at=NOW(), updated_at=NOW()
        WHERE id=$1 AND organization_id=$2 AND status='review' RETURNING *`,
      [id, orgId, JSON.stringify(checks), actor]
    );
    if (!rows[0]) { await client.query('ROLLBACK'); return { error: 'not_reviewable' }; }
    await logEvent(client, id, orgId, 'approved', actor, { scheduled_for: rows[0].scheduled_for });
    await client.query('COMMIT');
    return { post: rows[0] };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

async function cancelPost(orgId, id, actor) {
  const current = await getPost(orgId, id);
  if (!current) return { error: 'not_found' };
  if (!EDITABLE.includes(current.status)) return { error: 'not_cancellable', status: current.status };
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE social_scheduled_posts SET status='cancelled', updated_at=NOW()
        WHERE id=$1 AND organization_id=$2 AND status IN ('draft','review','approved') RETURNING *`,
      [id, orgId]
    );
    if (!rows[0]) { await client.query('ROLLBACK'); return { error: 'not_cancellable' }; }
    await logEvent(client, id, orgId, 'cancelled', actor, { previous_status: current.status });
    await client.query('COMMIT');
    return { post: rows[0] };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

// ---------- publicación ----------

async function publishStory(conn, imageUrl) {
  const token = meta.decryptToken(conn.page_access_token);
  const container = await meta.graphPost(`${conn.instagram_account_id}/media`, token, {
    image_url: imageUrl,
    media_type: 'STORIES',
  });
  const result = await meta.graphPost(`${conn.instagram_account_id}/media_publish`, token, {
    creation_id: container.id,
  });
  return result.id;
}

// Toma historias vencidas de forma atómica (SKIP LOCKED) y las publica una a una.
async function runDuePosts(now = new Date()) {
  const pool = getPool();
  // Una historia colgada en publishing no se reintenta (podría duplicarse): queda failed.
  await pool.query(
    `UPDATE social_scheduled_posts SET status='failed', last_error='Publicación interrumpida; revisar en Instagram antes de reprogramar', updated_at=NOW()
      WHERE status='publishing' AND updated_at < $1`,
    [new Date(now.getTime() - STALE_PUBLISHING_MS)]
  );
  const { rows: due } = await pool.query(
    `UPDATE social_scheduled_posts SET status='publishing', updated_at=NOW()
      WHERE id IN (
        SELECT id FROM social_scheduled_posts
         WHERE status='approved' AND scheduled_for <= $1
         ORDER BY scheduled_for ASC LIMIT 5
         FOR UPDATE SKIP LOCKED)
     RETURNING *`,
    [now]
  );

  for (const post of due) {
    const client = await pool.connect();
    try {
      // Revalidar justo antes de publicar: la imagen puede haber dejado de existir.
      const checks = await runChecks(post.organization_id, post, { requireFuture: false });
      if (!checks.ok) {
        const failed = checks.items.filter(i => !i.ok).map(i => `${i.name}: ${i.detail}`).join('; ');
        await client.query(`UPDATE social_scheduled_posts SET status='failed', checks=$2, last_error=$3, updated_at=NOW() WHERE id=$1`,
          [post.id, JSON.stringify(checks), `Chequeo previo falló al publicar: ${failed}`]);
        await logEvent(client, post.id, post.organization_id, 'failed', 'worker', { reason: 'checks' });
        continue;
      }
      const { rows: [conn] } = await client.query(
        `SELECT page_access_token, instagram_account_id, status FROM meta_connections WHERE organization_id = $1`,
        [post.organization_id]
      );
      if (!conn || conn.status !== 'connected' || !conn.instagram_account_id) throw new Error('Meta desconectado al momento de publicar');
      const externalId = await publishStory(conn, post.image_url);
      await client.query(
        `UPDATE social_scheduled_posts SET status='published', external_id=$2, published_at=NOW(), last_error=NULL, updated_at=NOW() WHERE id=$1`,
        [post.id, String(externalId)]
      );
      await logEvent(client, post.id, post.organization_id, 'published', 'worker', { external_id: String(externalId) });
    } catch (error) {
      const message = meta.graphError ? meta.graphError(error) : (error.message || 'Error al publicar');
      await client.query(`UPDATE social_scheduled_posts SET status='failed', last_error=$2, updated_at=NOW() WHERE id=$1`,
        [post.id, String(message).slice(0, 500)]);
      await logEvent(client, post.id, post.organization_id, 'failed', 'worker', { reason: 'publish_error' });
    } finally { client.release(); }
  }
  return due.length;
}

function startSocialStoriesJob(intervalMs = DEFAULT_INTERVAL_MS) {
  if (timer) return;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await runDuePosts(); }
    catch (error) { console.warn('[SocialStories] tick:', error.message); }
    finally { running = false; }
  };
  timer = setInterval(tick, intervalMs);
  timer.unref?.();
}

function stopSocialStoriesJob() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = {
  runChecks,
  listPosts,
  getPost,
  getEvents,
  createPost,
  updatePost,
  approvePost,
  cancelPost,
  runDuePosts,
  startSocialStoriesJob,
  stopSocialStoriesJob,
  sizeFromImage,
};
