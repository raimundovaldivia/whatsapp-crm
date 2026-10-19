import { useEffect, useState } from 'react';
import { Check, Loader, Pencil, RefreshCw, X } from 'lucide-react';
import { api } from '../utils/api.js';

// Historias de Instagram programadas: chequeo previo, aprobación humana, edición y cancelación.
const STATUS = {
  draft: ['Borrador', '#f59e0b', 'Corrige los chequeos antes de aprobar'],
  review: ['En revisión', '#60a5fa', 'Chequeos OK: revisa y aprueba'],
  approved: ['Programada', '#34d399', 'Se publicará a la hora indicada'],
  publishing: ['Publicando', '#a78bfa', 'En curso'],
  published: ['Publicada', '#10b981', 'Ya está en Instagram'],
  failed: ['Fallida', '#f87171', 'Revisa el error antes de reprogramar'],
  cancelled: ['Cancelada', '#9ca3af', 'No se publicará'],
};
const EDITABLE = ['draft', 'review', 'approved'];

const toLocalInput = iso => {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const fmt = iso => new Date(iso).toLocaleString('es-CL', { dateStyle: 'short', timeStyle: 'short' });
const errText = e => e.response?.data?.error || e.message;

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

function PostForm({ initial, onSave, onCancel, colors, saveLabel }) {
  const [title, setTitle] = useState(initial?.title || '');
  const [imageUrl, setImageUrl] = useState(initial?.image_url || '');
  const [when, setWhen] = useState(toLocalInput(initial?.scheduled_for));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const submit = async () => {
    setSaving(true); setError('');
    try {
      await onSave({ title, image_url: imageUrl, scheduled_for: new Date(when).toISOString() });
    } catch (e) { setError(errText(e)); }
    finally { setSaving(false); }
  };
  const field = { width: '100%', boxSizing: 'border-box', padding: '9px 10px', borderRadius: 8, border: `1px solid ${colors.border}`, background: colors.bgApp, color: colors.textPrimary, fontSize: 13 };
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <input style={field} placeholder="Título interno (ej. Lunes 19 - despachos)" value={title} onChange={e => setTitle(e.target.value)} />
      <input style={field} placeholder="URL pública HTTPS de la imagen 1080x1920" value={imageUrl} onChange={e => setImageUrl(e.target.value)} />
      <input style={field} type="datetime-local" value={when} onChange={e => setWhen(e.target.value)} />
      {error && <div style={{ color: '#fca5a5', fontSize: 12 }}>{error}</div>}
      <div style={{ display: 'flex', gap: 8 }}>
        <button disabled={saving || !imageUrl || !when} onClick={submit} style={btn(colors, true)}>{saving ? <Loader size={14} /> : null} {saveLabel}</button>
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
    const { data } = await api.get(`/social-stories/${post.id}`);
    setEvents(data.events);
  };
  const canEdit = EDITABLE.includes(post.status);
  return (
    <div style={{ border: `1px solid ${colors.border}`, borderRadius: 10, padding: 14, background: colors.bgPanel }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}>
        <div>
          <strong style={{ color: colors.textPrimary, fontSize: 14 }}>{post.title || 'Sin título'}</strong>
          <div style={{ color: colors.textSecondary, fontSize: 12, marginTop: 3 }}>Programada: {fmt(post.scheduled_for)}{post.approved_by ? ` · aprobada por ${post.approved_by}` : ''}</div>
        </div>
        <Badge status={post.status} />
      </div>

      {post.last_error && <div style={{ color: '#fca5a5', fontSize: 12, marginTop: 8 }}>{post.last_error}</div>}
      {post.external_id && <div style={{ color: colors.textSecondary, fontSize: 12, marginTop: 6 }}>ID en Instagram: {post.external_id}</div>}

      {editing ? (
        <div style={{ marginTop: 12 }}>
          <PostForm colors={colors} saveLabel="Guardar y volver a revisar" initial={post} onCancel={() => setEditing(false)}
            onSave={async body => { await api.patch(`/social-stories/${post.id}`, body); setEditing(false); await reload(); }} />
        </div>
      ) : (
        <>
          {EDITABLE.includes(post.status) && post.status !== 'approved' && <Checks checks={post.checks} colors={colors} />}
          {error && <div style={{ color: '#fca5a5', fontSize: 12, marginTop: 8 }}>{error}</div>}
          <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            {post.status === 'review' && <button disabled={busy} onClick={() => act(() => api.post(`/social-stories/${post.id}/approve`))} style={btn(colors, true)}><Check size={14} /> Aprobar y programar</button>}
            {canEdit && <button disabled={busy} onClick={() => setEditing(true)} style={btn(colors, false)}><Pencil size={14} /> Editar</button>}
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

export default function StoriesTab({ connected, colors }) {
  const [posts, setPosts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [lastChecks, setLastChecks] = useState(null);

  const load = async () => {
    try {
      const { data } = await api.get('/social-stories');
      setPosts(data.posts);
      setError('');
    } catch (e) { setError(errText(e)); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const create = async body => {
    const { data } = await api.post('/social-stories', body);
    setLastChecks(data.checks);
    setCreating(false);
    await load();
  };

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      {!connected && <div style={{ color: '#fbbf24', fontSize: 13 }}>Conecta Meta e Instagram profesional para poder publicar historias.</div>}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
        <p style={{ color: colors.textSecondary, fontSize: 13, margin: 0 }}>Cada historia pasa chequeos automáticos y tu aprobación antes de publicarse. Puedes editarla o cancelarla hasta el momento de publicación.</p>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={load} style={btn(colors, false)}><RefreshCw size={14} /></button>
          <button onClick={() => setCreating(c => !c)} style={btn(colors, true)}>{creating ? 'Cerrar' : 'Nueva historia'}</button>
        </div>
      </div>

      {creating && (
        <div style={{ border: `1px solid ${colors.border}`, borderRadius: 10, padding: 14, background: colors.bgPanel }}>
          <PostForm colors={colors} saveLabel="Revisar chequeos" onCancel={() => setCreating(false)} onSave={create} />
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
        : posts.length === 0 ? <div style={{ color: colors.textSecondary, fontSize: 13 }}>Aún no hay historias programadas.</div>
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
