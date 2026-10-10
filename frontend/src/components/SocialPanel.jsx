import { useEffect, useMemo, useState } from 'react';
import { BarChart3, Facebook, Instagram, Link2, Loader, MessageCircle, RefreshCw, Send, Unplug, Upload } from 'lucide-react';
import { metaAPI } from '../utils/api.js';
import { useTheme } from '../theme.js';

const tabs = [
  ['conexion', 'Conexión', Link2],
  ['mensajes', 'Mensajes', MessageCircle],
  ['contenido', 'Contenido', Upload],
  ['ads', 'Anuncios', BarChart3],
];

function Card({ children, colors, style }) {
  return <div style={{ background: colors.bgPanel, border: `1px solid ${colors.border}`, borderRadius: 12, padding: 18, ...style }}>{children}</div>;
}

function ErrorBox({ children }) {
  if (!children) return null;
  return <div style={{ padding: 10, borderRadius: 8, color: '#fca5a5', background: '#7f1d1d33', fontSize: 13 }}>{children}</div>;
}

export default function SocialPanel() {
  const { colors } = useTheme();
  const [active, setActive] = useState('conexion');
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async () => {
    setLoading(true); setError('');
    try { setStatus(await metaAPI.status()); }
    catch (e) { setError(e.response?.data?.error || e.message); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const connect = async () => {
    try { window.location.assign(await metaAPI.authUrl()); }
    catch (e) { setError(e.response?.data?.error || e.message); }
  };

  return (
    <div style={{ flex: 1, overflow: 'auto', background: colors.bgApp, padding: '28px 32px' }}>
      <div style={{ maxWidth: 980, margin: '0 auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, marginBottom: 22 }}>
          <div>
            <h1 style={{ margin: 0, color: colors.textPrimary, fontSize: 22 }}>Facebook e Instagram</h1>
            <p style={{ color: colors.textSecondary, margin: '5px 0 0', fontSize: 13 }}>Mensajes, publicaciones y rendimiento de anuncios de Diez Ríos.</p>
          </div>
          {status?.connected && <span style={{ color: colors.green, fontSize: 12 }}>● Meta conectado</span>}
        </div>

        <div style={{ display: 'flex', gap: 5, overflowX: 'auto', marginBottom: 18 }}>
          {tabs.map(([key, label, Icon]) => <button key={key} onClick={() => setActive(key)} style={{ border: `1px solid ${active === key ? colors.green : colors.border}`, background: active === key ? `${colors.green}18` : colors.bgPanel, color: active === key ? colors.green : colors.textSecondary, borderRadius: 9, padding: '9px 13px', display: 'flex', gap: 7, alignItems: 'center', cursor: 'pointer', whiteSpace: 'nowrap' }}><Icon size={15} />{label}</button>)}
        </div>

        <ErrorBox>{error}</ErrorBox>
        {loading ? <div style={{ padding: 40, color: colors.textSecondary, textAlign: 'center' }}><Loader size={22} /> Cargando…</div> : (
          <>
            {active === 'conexion' && <ConnectionTab status={status} connect={connect} reload={load} colors={colors} setError={setError} />}
            {active === 'mensajes' && <MessagesTab connected={status?.connected} connect={connect} colors={colors} />}
            {active === 'contenido' && <ContentTab connected={status?.connected} connect={connect} colors={colors} />}
            {active === 'ads' && <AdsTab connected={status?.connected} connect={connect} colors={colors} />}
          </>
        )}
      </div>
    </div>
  );
}

function ConnectionTab({ status, connect, reload, colors, setError }) {
  const c = status?.connection;
  const [assets, setAssets] = useState(null);
  const [pageId, setPageId] = useState(c?.page_id || '');
  const [adAccountId, setAdAccountId] = useState(c?.ad_account_id || '');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (status?.connected) metaAPI.assets().then(setAssets).catch(e => setError(e.response?.data?.error || e.message));
  }, [status?.connected]);
  const saveAssets = async () => {
    setSaving(true);
    try { await metaAPI.selectAssets({ pageId, adAccountId }); await reload(); }
    catch (e) { setError(e.response?.data?.error || e.message); }
    finally { setSaving(false); }
  };
  const disconnect = async () => {
    if (!window.confirm('¿Desconectar Facebook e Instagram de este CRM?')) return;
    try { await metaAPI.disconnect(); await reload(); }
    catch (e) { setError(e.response?.data?.error || e.message); }
  };
  return <div style={{ display: 'grid', gap: 14 }}>
    <Card colors={colors}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ display: 'flex', gap: 6 }}><Facebook color="#1877f2" /><Instagram color="#e1306c" /></div>
        <div style={{ flex: 1 }}><strong style={{ color: colors.textPrimary }}>{c?.facebook_user_name || 'Meta Business'}</strong><div style={{ color: colors.textSecondary, fontSize: 12, marginTop: 3 }}>{status?.connected ? 'Autorización activa' : 'Autoriza una cuenta administradora de los activos de Diez Ríos.'}</div></div>
        <button onClick={connect} style={primary(colors)}>{status?.connected ? 'Reconectar' : 'Conectar Meta'}</button>
      </div>
    </Card>
    {status?.connected && <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 12 }}>
        <Asset colors={colors} icon={<Facebook color="#1877f2" />} title="Página de Facebook" value={c.page_name || 'No seleccionada'} />
        <Asset colors={colors} icon={<Instagram color="#e1306c" />} title="Instagram profesional" value={c.instagram_username ? `@${c.instagram_username}` : 'No vinculado a la página'} />
        <Asset colors={colors} icon={<BarChart3 color={colors.green} />} title="Cuenta publicitaria" value={c.ad_account_name || 'No seleccionada'} />
      </div>
      {assets && <Card colors={colors}>
        <strong style={{ color: colors.textPrimary, fontSize: 13 }}>Activos de Diez Ríos</strong>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(240px,1fr))', gap: 10, marginTop: 12 }}>
          <label style={label(colors)}>Página de Facebook<select value={pageId} onChange={e => setPageId(e.target.value)} style={{ ...input(colors), marginTop: 5 }}><option value="">Seleccionar…</option>{assets.pages.map(p => <option key={p.id} value={p.id}>{p.name}{p.instagram?.username ? ` · @${p.instagram.username}` : ''}</option>)}</select></label>
          <label style={label(colors)}>Cuenta publicitaria<select value={adAccountId} onChange={e => setAdAccountId(e.target.value)} style={{ ...input(colors), marginTop: 5 }}><option value="">Seleccionar…</option>{assets.adAccounts.map(a => <option key={a.id} value={a.id}>{a.name} · {a.id}</option>)}</select></label>
        </div>
        <button onClick={saveAssets} disabled={saving} style={{ ...primary(colors), marginTop: 12 }}>{saving ? 'Guardando…' : 'Guardar selección'}</button>
      </Card>}
      {c.last_error && <ErrorBox>{c.last_error}</ErrorBox>}
      <Card colors={colors} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div><strong style={{ color: colors.textPrimary, fontSize: 13 }}>Webhook de Meta</strong><div style={{ color: colors.textMuted, fontSize: 12, marginTop: 4 }}>Configura en Meta: <code>/meta-webhook</code> y suscribe messages, messaging_postbacks y feed.</div></div>
        <button onClick={disconnect} style={{ ...secondary(colors), color: '#f87171' }}><Unplug size={14} /> Desconectar</button>
      </Card>
    </>}
  </div>;
}

function Asset({ colors, icon, title, value }) {
  return <Card colors={colors}><div style={{ display: 'flex', gap: 9, alignItems: 'center' }}>{icon}<div><div style={{ color: colors.textMuted, fontSize: 11 }}>{title}</div><strong style={{ color: colors.textPrimary, fontSize: 13 }}>{value}</strong></div></div></Card>;
}

function MessagesTab({ connected, connect, colors }) {
  const [threads, setThreads] = useState([]); const [selected, setSelected] = useState(null);
  const [messages, setMessages] = useState([]); const [text, setText] = useState(''); const [error, setError] = useState('');
  const refresh = async () => { try { setThreads(await metaAPI.threads()); } catch (e) { setError(e.response?.data?.error || e.message); } };
  useEffect(() => { if (connected) refresh(); }, [connected]);
  const open = async t => { setSelected(t); setMessages(await metaAPI.messages(t.id)); };
  const send = async () => { if (!text.trim()) return; try { const m = await metaAPI.sendMessage(selected.id, text); setMessages(v => [...v, m]); setText(''); } catch (e) { setError(e.response?.data?.error || e.message); } };
  if (!connected) return <ConnectNeeded connect={connect} colors={colors} />;
  return <Card colors={colors} style={{ padding: 0, minHeight: 520, display: 'grid', gridTemplateColumns: 'minmax(220px,32%) 1fr', overflow: 'hidden' }}>
    <div style={{ borderRight: `1px solid ${colors.border}` }}>
      <div style={{ padding: 12, borderBottom: `1px solid ${colors.border}`, display: 'flex', justifyContent: 'space-between', color: colors.textPrimary }}><strong>Conversaciones</strong><button onClick={refresh} style={iconButton(colors)}><RefreshCw size={15} /></button></div>
      {threads.length === 0 && <p style={{ color: colors.textMuted, padding: 16, fontSize: 12 }}>Los mensajes nuevos aparecerán aquí cuando el webhook esté activo.</p>}
      {threads.map(t => <button key={t.id} onClick={() => open(t)} style={{ width: '100%', textAlign: 'left', border: 0, borderBottom: `1px solid ${colors.border}`, background: selected?.id === t.id ? colors.bgHover : 'transparent', padding: 13, cursor: 'pointer' }}><strong style={{ color: colors.textPrimary, display: 'block' }}>{t.contact_name || t.external_user_id}</strong><span style={{ color: colors.textMuted, fontSize: 11 }}>{t.channel === 'instagram' ? 'Instagram' : 'Facebook'} · {t.last_message || ''}</span></button>)}
    </div>
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {!selected ? <div style={{ margin: 'auto', color: colors.textMuted }}>Selecciona una conversación</div> : <><div style={{ flex: 1, padding: 16, overflowY: 'auto' }}>{messages.map(m => <div key={m.id} style={{ maxWidth: '75%', margin: `6px ${m.direction === 'outbound' ? '0 6px auto' : 'auto 0 6px'}`, background: m.direction === 'outbound' ? colors.green : colors.bgHover, color: m.direction === 'outbound' ? '#fff' : colors.textPrimary, padding: '9px 11px', borderRadius: 10, fontSize: 13 }}>{m.content}</div>)}</div><ErrorBox>{error}</ErrorBox><div style={{ padding: 12, borderTop: `1px solid ${colors.border}`, display: 'flex', gap: 8 }}><input value={text} onChange={e => setText(e.target.value)} onKeyDown={e => e.key === 'Enter' && send()} placeholder="Responder…" style={input(colors)} /><button onClick={send} style={primary(colors)}><Send size={15} /></button></div></>}
    </div>
  </Card>;
}

function ContentTab({ connected, connect, colors }) {
  const [platform, setPlatform] = useState('facebook'); const [message, setMessage] = useState('');
  const [mediaUrl, setMediaUrl] = useState(''); const [mediaType, setMediaType] = useState('image');
  const [working, setWorking] = useState(false); const [notice, setNotice] = useState('');
  if (!connected) return <ConnectNeeded connect={connect} colors={colors} />;
  const publish = async () => { setWorking(true); setNotice(''); try { const r = await metaAPI.publish({ platform, message, mediaUrl, mediaType }); setNotice(`Publicado correctamente (${r.id})`); setMessage(''); setMediaUrl(''); } catch (e) { setNotice(e.response?.data?.error || e.message); } finally { setWorking(false); } };
  return <Card colors={colors} style={{ display: 'grid', gap: 13 }}>
    <div style={{ display: 'flex', gap: 8 }}><button onClick={() => setPlatform('facebook')} style={platformButton(platform === 'facebook', colors)}><Facebook size={16} /> Facebook</button><button onClick={() => setPlatform('instagram')} style={platformButton(platform === 'instagram', colors)}><Instagram size={16} /> Instagram</button></div>
    <label style={label(colors)}>Texto<textarea value={message} onChange={e => setMessage(e.target.value)} rows={5} style={{ ...input(colors), resize: 'vertical', marginTop: 5 }} placeholder="Escribe la publicación…" /></label>
    <label style={label(colors)}>URL pública de imagen o video<input value={mediaUrl} onChange={e => setMediaUrl(e.target.value)} style={{ ...input(colors), marginTop: 5 }} placeholder="https://…" /></label>
    {platform === 'instagram' && <label style={label(colors)}>Formato<select value={mediaType} onChange={e => setMediaType(e.target.value)} style={{ ...input(colors), marginTop: 5 }}><option value="image">Imagen</option><option value="video">Video</option><option value="reel">Reel</option></select></label>}
    <p style={{ color: colors.textMuted, fontSize: 11, margin: 0 }}>Meta debe poder descargar el archivo desde una URL HTTPS pública. Instagram requiere contenido multimedia.</p>
    {notice && <div style={{ color: notice.startsWith('Publicado') ? colors.green : '#fca5a5', fontSize: 13 }}>{notice}</div>}
    <button disabled={working || (!message.trim() && !mediaUrl.trim()) || (platform === 'instagram' && !mediaUrl.trim())} onClick={publish} style={primary(colors)}>{working ? <Loader size={15} /> : <Upload size={15} />} Publicar ahora</button>
  </Card>;
}

function AdsTab({ connected, connect, colors }) {
  const [data, setData] = useState(null); const [error, setError] = useState(''); const [loading, setLoading] = useState(false); const [days, setDays] = useState(30);
  const dateRange = useMemo(() => {
    const until = new Date();
    const since = new Date(); since.setDate(since.getDate() - days + 1);
    const iso = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    return { since: iso(since), until: iso(until) };
  }, [days]);
  const load = async () => { setLoading(true); setError(''); try { setData(await metaAPI.adsAnalytics(dateRange)); } catch (e) { setError(e.response?.data?.error || e.message); } finally { setLoading(false); } };
  useEffect(() => { if (connected) load(); }, [connected, dateRange.since, dateRange.until]);
  if (!connected) return <ConnectNeeded connect={connect} colors={colors} />;
  const currency = data?.account?.currency || 'CLP';
  const money = value => new Intl.NumberFormat('es-CL', { style: 'currency', currency, maximumFractionDigits: currency === 'CLP' ? 0 : 2 }).format(Number(value || 0));
  const number = value => Number(value || 0).toLocaleString('es-CL');
  const pct = value => `${Number(value || 0).toFixed(1).replace('.', ',')}%`;
  const status = value => ({ ACTIVE: 'Activa', PAUSED: 'Pausada', ARCHIVED: 'Archivada', DELETED: 'Eliminada' }[value] || value || '—');
  const summary = data?.summary || {};
  const crm = data?.crm || {};
  const roas = summary.spend > 0 ? Number(crm.revenue || 0) / Number(summary.spend) : 0;
  const metric = (label, value, help) => <Card key={label} colors={colors}><div style={{ color: colors.textMuted, fontSize: 11 }}>{label}</div><strong style={{ color: colors.textPrimary, fontSize: 21, display: 'block', marginTop: 5 }}>{value}</strong>{help && <div style={{ color: colors.textMuted, fontSize: 10, marginTop: 5, lineHeight: 1.35 }}>{help}</div>}</Card>;
  return <div style={{ display: 'grid', gap: 14 }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap', color: colors.textSecondary, fontSize: 12 }}>
      <div><strong style={{ color: colors.textPrimary }}>{data?.account?.name || 'Cuenta publicitaria'}</strong>{data?.account?.accountId && ` · ${data.account.accountId}`}<div style={{ color: colors.textMuted, marginTop: 3 }}>{data ? `${data.since} al ${data.until} · ${currency}` : 'Cargando período…'}</div></div>
      <div style={{ display: 'flex', gap: 6 }}>{[7, 30, 90].map(value => <button key={value} onClick={() => setDays(value)} style={{ ...secondary(colors), borderColor: days === value ? colors.green : colors.border, color: days === value ? colors.green : colors.textSecondary }}>{value} días</button>)}<button onClick={load} style={secondary(colors)}><RefreshCw size={14} /> Actualizar</button></div>
    </div>
    <ErrorBox>{error}</ErrorBox>
    {loading ? <div style={{ color: colors.textMuted }}>Cargando resultados de Meta y del CRM…</div> : data && <>
      <div>
        <div style={{ color: colors.textPrimary, fontSize: 13, fontWeight: 700, marginBottom: 9 }}>Resultados informados por Meta</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 10 }}>
          {metric('Inversión', money(summary.spend))}
          {metric('Conversaciones iniciadas', number(summary.conversations), 'Resultado atribuido por Meta; no equivale necesariamente a personas únicas.')}
          {metric('Costo por conversación', summary.costPerConversation == null ? '—' : money(summary.costPerConversation))}
          {metric('Clics', number(summary.clicks))}
          {metric('CTR', pct(summary.ctr))}
          {metric('Alcance', number(summary.reach))}
        </div>
      </div>
      <div>
        <div style={{ color: colors.textPrimary, fontSize: 13, fontWeight: 700, marginBottom: 9 }}>Conversión comprobada dentro del CRM</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 10 }}>
          {metric('Chats identificados', number(crm.conversations), 'Contactos cuyo primer mensaje incluyó la referencia del anuncio.')}
          {metric('Pedidos atribuidos', number(crm.orders))}
          {metric('Conversión a pedido', pct(crm.conversionRate))}
          {metric('Ventas atribuidas', money(crm.revenue))}
          {metric('Retorno observado', `${roas.toFixed(2).replace('.', ',')}x`, 'Ventas atribuidas / inversión. No incluye pedidos sin referencia de anuncio.')}
        </div>
        {!crm.trackingSince && <div style={{ color: colors.textMuted, fontSize: 11, marginTop: 8, lineHeight: 1.45 }}>La identificación individual comienza con esta actualización. Las conversaciones históricas siguen visibles en el total de Meta, pero Meta no entrega retroactivamente sus nombres.</div>}
      </div>
      <Card colors={colors} style={{ overflowX: 'auto' }}>
        <strong style={{ color: colors.textPrimary, fontSize: 13 }}>Rendimiento por campaña</strong>
        <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 10, fontSize: 12 }}><thead><tr>{['Campaña','Estado','Inversión','Conversaciones','Costo / conversación','Clics','CTR'].map(h => <th key={h} style={{ textAlign: 'left', color: colors.textMuted, padding: 8, borderBottom: `1px solid ${colors.border}` }}>{h}</th>)}</tr></thead><tbody>{(data.campaigns || []).map(c => <tr key={c.id}><td style={{ ...cell(colors), color: colors.textPrimary, whiteSpace: 'normal', minWidth: 220 }}>{c.name}</td><td style={cell(colors)}>{status(c.effectiveStatus || c.status)}</td><td style={cell(colors)}>{money(c.metrics?.spend)}</td><td style={cell(colors)}>{number(c.metrics?.conversations)}</td><td style={cell(colors)}>{c.metrics?.costPerConversation == null ? '—' : money(c.metrics.costPerConversation)}</td><td style={cell(colors)}>{number(c.metrics?.clicks)}</td><td style={cell(colors)}>{pct(c.metrics?.ctr)}</td></tr>)}{(data.campaigns || []).length === 0 && <tr><td colSpan="7" style={{ ...cell(colors), color: colors.textMuted }}>Sin actividad de campañas en este período.</td></tr>}</tbody></table>
      </Card>
      <Card colors={colors} style={{ overflowX: 'auto' }}>
        <strong style={{ color: colors.textPrimary, fontSize: 13 }}>Conversaciones identificadas</strong>
        <div style={{ color: colors.textMuted, fontSize: 11, marginTop: 4 }}>Este listado permite revisar qué chat y qué pedido provino de cada anuncio.</div>
        <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 10, fontSize: 12 }}><thead><tr>{['Fecha','Contacto','Campaña / anuncio','Primer mensaje','Pedido'].map(h => <th key={h} style={{ textAlign: 'left', color: colors.textMuted, padding: 8, borderBottom: `1px solid ${colors.border}` }}>{h}</th>)}</tr></thead><tbody>{(crm.rows || []).map(row => <tr key={`${row.conversationId}-${row.attributedAt}`}><td style={cell(colors)}>{new Date(row.attributedAt).toLocaleString('es-CL')}</td><td style={{ ...cell(colors), color: colors.textPrimary }}>{row.contactName || row.phoneNumber}<div style={{ color: colors.textMuted, fontSize: 10 }}>{row.phoneNumber}</div></td><td style={{ ...cell(colors), whiteSpace: 'normal', minWidth: 180 }}>{row.campaignName || 'Campaña no resuelta'}<div style={{ color: colors.textMuted, fontSize: 10 }}>{row.adName || row.sourceId || '—'}</div></td><td style={{ ...cell(colors), whiteSpace: 'normal', minWidth: 180 }}>{row.firstMessage || '—'}</td><td style={cell(colors)}>{row.orderId ? `#${row.orderId} · ${money(row.orderTotal)}` : 'Sin pedido'}</td></tr>)}{(crm.rows || []).length === 0 && <tr><td colSpan="5" style={{ ...cell(colors), color: colors.textMuted }}>Aún no hay conversaciones con atribución individual guardada en este período.</td></tr>}</tbody></table>
      </Card>
    </>}
  </div>;
}

function ConnectNeeded({ connect, colors }) { return <Card colors={colors} style={{ textAlign: 'center', padding: 42 }}><p style={{ color: colors.textSecondary }}>Conecta Meta para habilitar esta función.</p><button onClick={connect} style={primary(colors)}><Link2 size={15} /> Conectar Meta</button></Card>; }
const primary = colors => ({ border: 0, borderRadius: 8, padding: '9px 13px', background: colors.green, color: '#fff', cursor: 'pointer', display: 'inline-flex', gap: 7, alignItems: 'center', justifyContent: 'center', fontWeight: 600 });
const secondary = colors => ({ border: `1px solid ${colors.border}`, borderRadius: 8, padding: '8px 11px', background: colors.bgApp, color: colors.textSecondary, cursor: 'pointer', display: 'inline-flex', gap: 7, alignItems: 'center' });
const iconButton = colors => ({ border: 0, background: 'transparent', color: colors.textSecondary, cursor: 'pointer' });
const input = colors => ({ width: '100%', boxSizing: 'border-box', padding: '10px 11px', borderRadius: 8, border: `1px solid ${colors.border}`, background: colors.bgApp, color: colors.textPrimary, outline: 'none' });
const label = colors => ({ color: colors.textSecondary, fontSize: 12 });
const platformButton = (active, colors) => ({ ...secondary(colors), color: active ? colors.green : colors.textSecondary, borderColor: active ? colors.green : colors.border });
const cell = colors => ({ padding: 8, borderBottom: `1px solid ${colors.border}`, color: colors.textSecondary, whiteSpace: 'nowrap' });
