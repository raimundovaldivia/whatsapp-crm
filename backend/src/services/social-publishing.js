// Transporte compartido por publicación inmediata y la cola existente.
const axios = require('axios');
const meta = require('./meta-platform');
const { publicTarget } = require('./safe-media');

function validateContent(post) {
  const platform = post.platform || 'instagram_story';
  const type = post.media_type || 'image';
  if (!['instagram_story', 'instagram', 'facebook'].includes(platform)) return 'Plataforma inválida';
  if (!['text', 'image', 'video', 'reel'].includes(type) ||
      (platform === 'instagram_story' && type !== 'image') ||
      (platform !== 'facebook' && type === 'text')) return 'Formato no permitido para esta plataforma';
  if (typeof post.message !== 'undefined' && typeof post.message !== 'string') return 'El texto debe ser una cadena';
  const message = post.message || '';
  if (message.length > (platform === 'facebook' ? 63206 : 2200)) return 'El texto supera el límite de la plataforma';
  if (type === 'text') {
    if (!message.trim()) return 'Escribe el texto de la publicación';
    if (post.image_url) return 'Una publicación de texto no lleva archivo';
  } else {
    try {
      if (typeof post.image_url !== 'string') throw new Error();
      const url = new URL(post.image_url);
      if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || url.href.length > 2000) throw new Error();
    } catch { return 'Indica una URL HTTPS pública de imagen o video, sin credenciales'; }
  }
  return null;
}

async function waitUntilReady(id, token, facebook = false) {
  // Límite acotado: jamás repetir un envío cuando su aceptación sea incierta.
  const deadline = Date.now() + 120000;
  for (let attempt = 0; attempt < 60 && Date.now() < deadline; attempt++) {
    const state = await meta.graphGet(id, token, { fields: facebook ? 'status' : 'status_code,status' });
    if (facebook ? state.status?.video_status === 'ready' : state.status_code === 'FINISHED') return;
    if (facebook ? state.status?.video_status === 'error' : ['ERROR', 'EXPIRED'].includes(state.status_code)) {
      throw new Error('Meta no pudo procesar el archivo. Revisa su formato.');
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error('Meta sigue procesando el archivo. Revisa la red antes de volver a programar.');
}

async function publishContent(conn, post) {
  const invalid = validateContent(post);
  if (invalid) throw new Error(invalid);
  const platform = post.platform || 'instagram_story';
  const type = post.media_type || 'image';
  const url = post.image_url;
  if (type !== 'text') await publicTarget(url);
  const target = platform === 'facebook' ? conn.page_id : conn.instagram_account_id;
  if (!target || conn.status !== 'connected') throw new Error('Conecta la cuenta de destino en Meta');
  if (post.target_id && post.target_id !== target) throw new Error('La cuenta de destino cambió. Edita y aprueba nuevamente la publicación.');
  const token = meta.decryptToken(conn.page_access_token);
  if (!token) throw new Error('Reconecta Meta para publicar');
  const message = post.message || '';
  let result;
  if (platform === 'facebook') {
    if (type === 'reel') {
      const start = await meta.graphPost(`${target}/video_reels`, token, { upload_phase: 'start' });
      if (!/^\d+$/.test(String(start.video_id))) throw new Error('Meta no entregó un identificador de video');
      // URL construida localmente: nunca enviar el token a una URL arbitraria.
      const upload = await axios.post(`https://rupload.facebook.com/video-upload/${meta.GRAPH_VERSION}/${start.video_id}`, null, {
        headers: { Authorization: `OAuth ${token}`, file_url: url }, timeout: 30000, maxRedirects: 0,
      });
      if (!upload.data?.success) throw new Error('Meta no confirmó la carga del Reel');
      const finish = await meta.graphPost(`${target}/video_reels`, token, {
        upload_phase: 'finish', video_id: start.video_id, video_state: 'PUBLISHED', description: message,
      });
      if (!finish.success) throw new Error('Meta no confirmó la publicación. Revisa la red antes de reintentar.');
      await waitUntilReady(start.video_id, token, true);
      result = { id: start.video_id };
    } else {
      const edge = type === 'text' ? 'feed' : type === 'image' ? 'photos' : 'videos';
      result = await meta.graphPost(`${target}/${edge}`, token, type === 'text' ? { message }
        : type === 'image' ? { url, caption: message } : { file_url: url, description: message });
    }
  } else {
    const video = ['video', 'reel'].includes(type);
    const container = await meta.graphPost(`${target}/media`, token, {
      ...(video ? { video_url: url, media_type: 'REELS' } : { image_url: url }),
      ...(platform === 'instagram_story' ? { media_type: 'STORIES' } : { caption: message }),
    });
    if (!container.id) throw new Error('Meta no entregó un identificador de archivo');
    await waitUntilReady(container.id, token);
    result = await meta.graphPost(`${target}/media_publish`, token, { creation_id: container.id });
  }
  const id = result.post_id || result.id;
  if (!id) throw new Error('Meta no confirmó la publicación. Revisa la red antes de reintentar.');
  return String(id);
}

module.exports = { validateContent, publishContent };
