import { useEffect, useState } from 'react';
import { Check, Loader, Pencil, RefreshCw, X } from 'lucide-react';
import { api } from '../utils/api.js';
import { toChileInput, fromChileInput, formatChile } from '../utils/social-schedule.mjs';

// Historias de Instagram programadas: chequeo previo, aprobación humana, edición y cancelación.
const STATUS = {
  draft: ['Borrador', '#f59e0b', 'Corrige los chequeos antes de aprobar'],
  review: ['En revisión', '#60a5fa', 'Chequeos OK: revisa y aprueba'],
  approved: ['Programada', '#34d399', 'Se publicará a la hora indicada'],
  publishing: ['Publicando', '#a78bfa', 'En curso'],
  published: ['Publicada', '#10b981', 'Enviada a la red de destino'],
  failed: ['Fallida', '#f87171', 'Revisa el error antes de reprogramar'],
  cancelled: ['Cancelada', '#9ca3af', 'No se publicará'],
};
const EDITABLE = ['draft', 'review', 'approved'];

const fmt = formatChile;
const errText = e => e.response?.data?.error || e.message;
const safePreviewUrl = value => {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; }
  catch { return null; }
};

function Badge({ status }) {
  const [label, color, hint] = STATUS[status] || [status, '#9ca3af', ''];
  return <span title={hint} style={{ fontSize: 11, color, border: `1px solid ${color}`, borderRadius: 999, padding: '2px 9px', whiteSpace: 'nowrap' }}>{label}</span>;
}

function Checks({ checks, colors }) {
  if (!checks?.items?.length) return null;
  return (
    <ul style={{ listStyle: 'none', padding: 0, margin: '8px 0 0', fontSize: 12 }}>
      {checks.items.map(i => (
        <li key={i.name} style={{ color: i.ok ? colors.green : '#f87171', display: 'flex', gap: 6 }}>
          {i.ok ? <Check size={13} /> : <X size={13} />} <span>{i.name.replace(/_/g, ' ')}</span>
          {i.detail && <span style={{ color: colors.textSecondary }}>· {i.detail}</span>}
        </li>
      ))}
    </ul>
  );
}

function PostForm({ initial, onSave, onCancel, colors, saveLabel, scope = 'stories' }) {
  const [platform, setPlatform] = useState(initial?.platform || (scope === 'stories' ? 'instagram_story' : 'facebook'));
  const [mediaType, setMediaType] = useState(initial?.media_type || 'image');
  const [message, setMessage] = useState(initial?.message || '');
  const [title, setTitle] = useState(initial?.title || '');
  const [imageUrl, setImageUrl] = useState(initial?.image_url || '');
  const [when, setWhen] = useState(toChileInput(initial?.scheduled_for));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const submit = async () => {
    setSaving(true); setError('');
    try {
      const scheduled = fromChileInput(when);
      if (new Date(scheduled).getTime() - Date.now() < 5 * 60000) throw new Error('Elige una hora con al menos 5 minutos de anticipación');
      await onSave({ title, image_url: mediaType === 'text' ? '' : imageUrl, scheduled_for: scheduled, platform, media_type: mediaType, message });
    } catch (e) { setError(errText(e)); }
    finally { setSaving(false); }
  };
  const field = { width: '100%', boxSizing: 'border-box', padding: '9px 10px', borderRadius: 8, border: `1px solid ${colors.border}`, background: colors.bgApp, color: colors.textPrimary, fontSize: 13 };
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {scope !== 'stories' && <>
        <label style={{ color: colors.textSecondary }}>Red social
          <select aria-label="Red social" style={field} value={platform} onChange={e => { setPlatform(e.target.value); if (e.target.value === 'instagram' && mediaType === 'text') setMediaType('image'); }}>
            <option value="facebook">Facebook</option><option value="instagram">Instagram</option>
          </select>
        </label>
        <label style={{ color: colors.textSecondary }}>Formato
          <select aria-label="Formato" style={field} value={mediaType} onChange={e => setMediaType(e.target.value)}>
            {platform === 'facebook' && <option value="text">Solo texto</option>}
            <option value="image">Imagen</option><option value="video">Video</option><option value="reel">Reel</option>
          </select>
        </label>
        <textarea aria-label="Texto de la publicación" style={field} value={message} maxLength={platform === 'facebook' ? 63206 : 2200} rows={4} placeholder="Texto de la publicación" onChange={e => setMessage(e.target.value)} />
        {platform === 'instagram' && ['video', 'reel'].includes(mediaType) && <p style={{ color: colors.textSecondary, margin: 0, fontSize: 12 }}>Instagram publica los videos como Reels.</p>}
      </>}
      <input aria-label="Título interno" maxLength={120} style={field} placeholder="Título interno (ej. Lunes 19 - despachos)" value={title} onChange={e => setTitle(e.target.value)} />
      {mediaType !== 'text' && <input aria-label="URL del archivo" style={field} placeholder={scope === 'stories' ? 'URL pública HTTPS de la imagen 1080x1920' : 'URL pública HTTPS de la imagen o video'} value={imageUrl} onChange={e => setImageUrl(e.target.value)} />}
      <label style={{ color: colors.textSecondary, fontSize: 12 }}>Fecha y hora de Chile (America/Santiago), mínimo 5 minutos de anticipación
      <input aria-label="Fecha y hora de Chile" style={field} type="datetime-local" value={when} onChange={e => setWhen(e.target.value)} /></label>
      {error && <div style={{ color: '#fca5a5', fontSize: 12 }}>{error}</div>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button disabled={saving || (mediaType !== 'text' && !imageUrl) || (mediaType === 'text' && !message.trim()) || !when} onClick={submit} style={btn(colors, true)}>{saving ? <Loader size={14} /> : null} {saveLabel}</button>
        {onCancel && <button onClick={onCancel} style={btn(colors, false)}>Cerrar</button>}
      </div>
    </div>
  );
}

function PostCard({ post, colors, reload }) {
  const [editing, setEditing] = useState(false);
  const [events, setEvents] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const act = async (fn) => {
    setBusy(true); setError('');
    try { await fn(); await reload(); }
    catch (e) { setError(errText(e)); }
    finally { setBusy(false); }
  };
  const toggleHistory = async () => {
    if (events) return setEvents(null);
    try { const { data } = await api.get(`/social-stories/${post.id}`); setEvents(data.events); }
    catch (e) { setError(errText(e)); }
  };
  const canEdit = EDITABLE.includes(post.status);
  const previewUrl = safePreviewUrl(post.image_url);
  return (
    <div style={{ border: `1px solid ${colors.border}`, borderRadius: 10, padding: 14, background: colors.bgPanel }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}>
        <div>
          <strong style={{ color: colors.textPrimary, fontSize: 14 }}>{post.title || 'Sin título'} · {post.platform === 'facebook' ? 'Facebook' : post.platform === 'instagram' ? 'Instagram' : 'Historia de Instagram'}{post.platform !== 'instagram_story' ? ` · ${{ text: 'Texto', image: 'Imagen', video: 'Video', reel: 'Reel' }[post.media_type]}` : ''}</strong>
          <div style={{ color: colors.textSecondary, fontSize: 12, marginTop: 3 }}>Programada: {fmt(post.scheduled_for)} (Chile){post.approved_by ? ` · aprobada por ${post.approved_by}` : ''}</div>
        </div>
        <Badge status={post.status} />
      </div>

      {post.message && <p style={{ color: colors.textPrimary, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 13 }}>{post.message}</p>}
      {previewUrl && <a href={previewUrl} target="_blank" rel="noopener noreferrer" style={{ color: colors.green, fontSize: 12 }}>Ver archivo adjunto</a>}
      {post.last_error && <div style={{ color: '#fca5a5', fontSize: 12, marginTop: 8 }}>{post.last_error}</div>}
      {post.external_id && <div style={{ color: colors.textSecondary, fontSize: 12, marginTop: 6 }}>ID en la red: {post.external_id}</div>}

      {editing ? (
        <div style={{ marginTop: 12 }}>
          <PostForm scope={editing.platform === 'instagram_story' ? 'stories' : 'content'} colors={colors} saveLabel="Guardar y volver a revisar" initial={editing} onCancel={() => setEditing(false)}
            onSave={async body => { await api.patch(`/social-stories/${post.id}`, { ...body, revision: editing.revision }); setEditing(false); await reload(); }} />
        </div>
      ) : (
        <>
          {EDITABLE.includes(post.status) && post.status !== 'approved' && <Checks checks={post.checks} colors={colors} />}
          {error && <div style={{ color: '#fca5a5', fontSize: 12, marginTop: 8 }}>{error}</div>}
          <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            {post.status === 'review' && <button disabled={busy} onClick={() => act(() => api.post(`/social-stories/${post.id}/approve`, { revision: post.revision }))} style={btn(colors, true)}><Check size={14} /> Aprobar y programar</button>}
            {canEdit && <button disabled={busy} onClick={() => setEditing(post)} style={btn(colors, false)}><Pencil size={14} /> Editar</button>}
            {canEdit && <button disabled={busy} onClick={() => act(() => api.post(`/social-stories/${post.id}/cancel`))} style={btn(colors, false)}><X size={14} /> Cancelar</button>}
            <button onClick={toggleHistory} style={btn(colors, false)}>{events ? 'Ocultar historial' : 'Ver historial'}</button>
          </div>
          {events && (
            <ul style={{ listStyle: 'none', padding: 0, margin: '10px 0 0', fontSize: 12, color: colors.textSecondary }}>
              {events.map((e, idx) => <li key={idx}>{fmt(e.created_at)} · {e.action} · {e.actor || 'sistema'}{e.detail?.status ? ` → ${e.detail.status}` : ''}</li>)}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

export default function StoriesTab({ connected, colors, scope = 'stories' }) {
  const [posts, setPosts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [lastChecks, setLastChecks] = useState(null);

  const load = async () => {
    try {
      const { data } = await api.get('/social-stories', { params: { scope } });
      setPosts(data.posts.filter(post => scope === 'stories' ? post.platform === 'instagram_story' : post.platform !== 'instagram_story'));
      setError('');
    } catch (e) { setError(errText(e)); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); const timer = setInterval(load, 30000); return () => clearInterval(timer); }, [scope]);

  const create = async body => {
    const { data } = await api.post('/social-stories', body);
    setLastChecks(data.checks);
    setCreating(false);
    await load();
  };

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      {!connected && <div style={{ color: '#fbbf24', fontSize: 13 }}>Conecta la cuenta de destino en Meta para poder publicar.</div>}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
        <p style={{ color: colors.textSecondary, fontSize: 13, margin: 0 }}>Cada publicación pasa por revisión y tu aprobación antes de programarse. Meta comprueba el formato del archivo al publicarlo. Puedes editarla o cancelarla hasta el momento de publicación.</p>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={load} style={btn(colors, false)}><RefreshCw size={14} /></button>
          <button onClick={() => setCreating(c => !c)} style={btn(colors, true)}>{creating ? 'Cerrar' : scope === 'stories' ? 'Nueva historia' : 'Nueva publicación'}</button>
        </div>
      </div>

      {creating && (
        <div style={{ border: `1px solid ${colors.border}`, borderRadius: 10, padding: 14, background: colors.bgPanel }}>
          <PostForm scope={scope} colors={colors} saveLabel="Revisar programación" onCancel={() => setCreating(false)} onSave={create} />
        </div>
      )}

      {lastChecks && !creating && (
        <div style={{ border: `1px solid ${colors.border}`, borderRadius: 10, padding: 12, background: colors.bgPanel, fontSize: 12 }}>
          <strong style={{ color: colors.textPrimary }}>{lastChecks.ok ? 'Chequeos OK: lista para aprobar' : 'Chequeos con errores: corrígelos antes de aprobar'}</strong>
          <Checks checks={lastChecks} colors={colors} />
        </div>
      )}

      {error && <div style={{ color: '#fca5a5', fontSize: 13 }}>{error}</div>}
      {loading ? <div style={{ color: colors.textSecondary }}><Loader size={16} /> Cargando…</div>
        : posts.length === 0 ? <div style={{ color: colors.textSecondary, fontSize: 13 }}>Aún no hay publicaciones en esta lista.</div>
        : posts.map(post => <PostCard key={post.id} post={post} colors={colors} reload={load} />)}
    </div>
  );
}

function btn(colors, primary) {
  return {
    border: primary ? 0 : `1px solid ${colors.border}`, borderRadius: 8, padding: '8px 12px', fontSize: 13, cursor: 'pointer',
    background: primary ? colors.green : colors.bgPanel, color: primary ? '#fff' : colors.textPrimary,
    display: 'inline-flex', alignItems: 'center', gap: 6,
  };
}
