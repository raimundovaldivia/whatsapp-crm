import { useEffect, useRef, useState } from 'react';
import { api } from '../utils/api.js';
import { useTheme } from '../theme.js';
import { parseReviewPhones, reviewCounts, REVIEW_LABELS } from '../utils/conversation-review.mjs';

const ROOT = '/reengagement/reviews';
const DEFAULT_INSTRUCTION = 'Preparar borradores personalizados para buscar 30 pedidos de esta tienda. Excluir empresas y cualquier persona con un pedido esta semana. Respetar rechazos, bajas y reclamos. Resolver primero las dudas reales del chat. Considerar cajas sólo si hay interés explícito por volumen. No inventar descuentos ni prometer entrega. Sólo revisión; sin enviar ni programar. Canal futuro: Evolution exclusivamente.';
const date = value => value ? new Date(value).toLocaleString('es-CL', { timeZone: 'America/Santiago' }) : 'Sin fecha';

export default function ConversationReviewPanel() {
  const { colors: c } = useTheme();
  const [phones, setPhones] = useState('');
  const [instruction, setInstruction] = useState(DEFAULT_INSTRUCTION);
  const [runs, setRuns] = useState([]);
  const [run, setRun] = useState(null);
  const [selected, setSelected] = useState(null);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [verified, setVerified] = useState(null);
  const [catalog, setCatalog] = useState([]);
  const [offer, setOffer] = useState({ productId: '', price: '', quantity: '1', expiresAt: '' });
  const stop = useRef(false);
  const mounted = useRef(true);
  const counts = reviewCounts(run?.contacts);
  const row = run?.contacts?.find(r => r.phone === selected);
  const result = row?.result;
  const base = { background: c.bgPanel, color: c.textPrimary, border: `1px solid ${c.border}`, borderRadius: 8, padding: 10 };
  const button = { ...base, cursor: 'pointer', padding: '9px 14px' };
  const field = { ...base, width: '100%', boxSizing: 'border-box' };

  const refreshList = async () => { const r = await api.get(ROOT); if (mounted.current) setRuns(r.data.runs); };
  const refresh = async id => {
    const r = await api.get(`${ROOT}/${id}`, { timeout: 30000 });
    if (mounted.current) setRun(r.data);
    return r.data;
  };
  useEffect(() => {
    mounted.current = true;
    refreshList().catch(e => setError(e.response?.data?.error || 'No se pudieron cargar las revisiones.'));
    api.get('/products').then(r => setCatalog((r.data.data || r.data.products || []).filter(p => p.active && !p.deprecated_at))).catch(() => {});
    return () => { mounted.current = false; stop.current = true; };
  }, []);

  useEffect(() => {
    setVerified(null); setOffer({ productId: '', price: '', quantity: '1', expiresAt: '' });
    if (!run?.id || !selected || row?.state !== 'done') return;
    let cancelled = false;
    const check = async () => {
      try {
        const response = await api.post(`${ROOT}/${run.id}/check`, { phone: selected }, { timeout: 30000 });
        if (cancelled) return;
        setVerified(response.data.current ? selected : null);
        if (!response.data.current) await refresh(run.id);
      } catch { if (!cancelled) setVerified(null); }
    };
    check();
    const timer = setInterval(check, 30000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [run?.id, selected, row?.state]);

  async function analyze(id) {
    stop.current = false; setRunning(true); setError('');
    try {
      while (!stop.current) {
        // Three independent customer steps at a time. Claims prevent duplicate processing.
        const responses = await Promise.all([0, 1, 2].map(() => api.post(`${ROOT}/${id}/next`, {}, { timeout: 150000 })));
        const latest = await refresh(id);
        if (responses.every(r => r.data.idle) || !latest.contacts.some(r => ['pending', 'processing'].includes(r.state))) break;
      }
      await refreshList();
    } catch (e) { if (mounted.current) setError(e.response?.data?.error || 'Se pausó la revisión. Puedes continuar desde el avance guardado.'); }
    finally { if (mounted.current) setRunning(false); }
  }
  async function create() {
    setBusy(true); setError('');
    try {
      const response = await api.post(ROOT, { phones: parseReviewPhones(phones), instruction }, { timeout: 30000 });
      await refresh(response.data.id); setSelected(null); await refreshList();
      analyze(response.data.id);
    } catch (e) { setError(e.response?.data?.error || e.message); }
    finally { setBusy(false); }
  }
  async function retry() {
    setBusy(true); setError('');
    try { await api.post(`${ROOT}/${run.id}/retry`); await refresh(run.id); analyze(run.id); }
    catch (e) { setError(e.response?.data?.error || e.message); }
    finally { setBusy(false); }
  }
  async function proposeOffer() {
    setBusy(true); setError('');
    try {
      await api.post(`${ROOT}/${run.id}/offer`, { phone: selected, ...offer }, { timeout: 30000 });
      await refresh(run.id);
    } catch (e) { setError(e.response?.data?.error || e.message); setVerified(null); }
    finally { setBusy(false); }
  }
  function download() {
    const report = { ...run, exportedAt: new Date().toISOString(), warning: 'Borradores sin autorizar. Revalidar chats, pedidos, ofertas y stock antes de cualquier uso. No es una lista de envío.' };
    const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = `revision-chats-${run.id}.json`; a.click(); URL.revokeObjectURL(url);
  }

  return <section aria-label="Revisión de chats" style={{ flex: 1, overflow: 'auto', padding: 20, color: c.textPrimary }}>
    <h2 style={{ marginTop: 0 }}>Revisión de chats y borradores</h2>
    <p>Analiza el historial comercial guardado, con evidencia por persona. Esta sección no envía, programa ni activa promociones. Canal previsto: Evolution.</p>
    <details open={!run} style={{ ...base, marginBottom: 16 }}>
      <summary style={{ cursor: 'pointer', fontWeight: 700 }}>Nueva revisión · hasta 500 contactos</summary>
      <label style={{ display: 'block', marginTop: 12 }}>Teléfonos, uno por línea
        <textarea aria-label="Teléfonos para revisar" value={phones} onChange={e => setPhones(e.target.value)} rows={5} style={field} placeholder="56912345678" disabled={running || busy} />
      </label>
      <label>Objetivo comercial
        <textarea aria-label="Objetivo de la revisión" value={instruction} onChange={e => setInstruction(e.target.value)} rows={4} style={field} disabled={running || busy} />
      </label>
      <p style={{ color: c.textSecondary }}>Se excluyen empresas, pedidos de la semana de Chile, bajas, rechazos vigentes, reclamos sin resolver y campañas recientes sin respuesta.</p>
      <button style={button} disabled={busy || running} onClick={create}>Analizar chats · sin enviar</button>
    </details>
    {error && <p role="alert" style={{ color: c.red }}>{error}</p>}
    <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 16 }}>
      <select aria-label="Revisión guardada" style={base} value={run?.id || ''} disabled={running || busy} onChange={async e => {
        if (!e.target.value) return; setSelected(null); setError('');
        try { await refresh(e.target.value); } catch (err) { setError(err.response?.data?.error || err.message); }
      }}>
        <option value="">Selecciona una revisión guardada</option>
        {runs.map(r => <option key={r.id} value={r.id}>{date(r.created_at)} · {r.total} contactos · {r.completed} revisados</option>)}
      </select>
      {run && <>
        <button style={button} disabled={busy} onClick={() => running ? (stop.current = true) : analyze(run.id)}>{running ? 'Pausar al terminar el bloque' : 'Continuar análisis'}</button>
        <button style={button} disabled={running || busy || !(counts.errors + counts.stale)} onClick={retry}>Reanalizar errores y cambios</button>
        <button style={button} disabled={running} onClick={download}>Descargar revisión</button>
      </>}
    </div>
    {run && <>
      <p role="status"><strong>{counts.completed}/{counts.total} revisados</strong> · {counts.drafts} borradores · {counts.excluded} excluidos o en pausa · {counts.manual} revisión manual · {counts.errors} errores · {counts.stale} cambiaron</p>
      <p style={{ color: c.textSecondary }}>La prioridad es cualitativa; no representa una probabilidad de compra validada. Al abrir una ficha se comprueba su vigencia. El análisis puede pausarse y continuar desde aquí.</p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-start' }}>
        <div style={{ flex: '1 1 280px', maxHeight: '65vh', overflow: 'auto' }}>
          {run.contacts.map(contact => <button key={contact.phone} onClick={() => setSelected(contact.phone)} style={{ ...button, width: '100%', textAlign: 'left', marginBottom: 5,
            borderColor: selected === contact.phone ? c.green : c.border }}>
            <strong>{contact.result?.name || contact.phone}</strong><br />
            <small>+{contact.phone} · {REVIEW_LABELS[contact.state === 'done' ? contact.result?.decision : contact.state] || contact.state}
              {contact.result?.priority && contact.result.priority !== 'unknown' ? ` · prioridad ${{ high: 'alta', medium: 'media', low: 'baja' }[contact.result.priority]}` : ''}</small>
          </button>)}
        </div>
        <article style={{ ...base, flex: '2 1 380px', minWidth: 0 }}>
          {!row ? <p>Selecciona una persona para ver su contexto, evidencia y propuesta.</p> : <>
            <h3>{result?.name || row.phone} · +{row.phone}</h3>
            {row.error && <p role="alert">{row.error}</p>}
            {result && <>
              <p><strong>{REVIEW_LABELS[row.state === 'done' ? result.decision : row.state]}</strong> · {date(result.checkedAt)}</p>
              <p>{result.reason}</p>
              <p>Historial: {result.coverage?.loaded}/{result.coverage?.available} mensajes · {result.coverage?.mediaPending || 0} adjuntos por revisar.</p>
              <p style={{ color: c.textSecondary }}>{result.coverage?.scope}</p>
              <p>Compras pagadas o entregadas: {result.purchases?.cantidadPedidos || 0} · Última: {result.purchases?.ultimaCompra || 'Sin compra registrada'}</p>
              {result.eligibility?.reasons?.map((reason, i) => <p key={i}>{reason.reason}{reason.quote && <q style={{ display: 'block' }}>{reason.quote}</q>}</p>)}
              <h4>Evidencia del chat</h4>
              {(result.facts || []).map((fact, i) => <blockquote key={i} style={{ borderLeft: `3px solid ${c.border}`, paddingLeft: 12, margin: '12px 0' }}>
                <strong>{fact.value}</strong><p style={{ whiteSpace: 'pre-wrap' }}>“{fact.quote}”</p>
                <small>{date(fact.date)} · {fact.provider} · Mensaje {fact.messageId}</small>
              </blockquote>)}
              {result.warnings?.map((warning, i) => <p key={i} style={{ color: c.yellow }}>{warning}</p>)}
              {row.state === 'done' && result.decision === 'draft' && <>
                <h4>Borrador personalizado · revisión humana pendiente</h4>
                {verified !== selected ? <p>Comprobando vigencia. No usar este borrador todavía.</p> : <>
                  <p style={{ ...base, whiteSpace: 'pre-wrap' }}>{result.offeredMessage || result.message}</p>
                  <details><summary style={{ cursor: 'pointer' }}>Preparar una oferta exclusiva para este teléfono</summary>
                    <p>Propuesta sin activar. Requiere costo, margen bruto mínimo y stock configurados. Vigencia en hora de Chile.</p>
                    <select aria-label="Producto para oferta personal" style={field} value={offer.productId} onChange={e => setOffer({ ...offer, productId: e.target.value })}>
                      <option value="">Selecciona el producto pertinente al chat</option>
                      {catalog.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}
                    </select>
                    <label>Precio por unidad <input aria-label="Precio de oferta" type="number" min="1" style={field} value={offer.price} onChange={e => setOffer({ ...offer, price: e.target.value })} /></label>
                    <label>Máximo de unidades <input aria-label="Unidades de oferta" type="number" min="1" style={field} value={offer.quantity} onChange={e => setOffer({ ...offer, quantity: e.target.value })} /></label>
                    <label>Vencimiento (Chile) <input aria-label="Vencimiento de oferta" type="datetime-local" style={field} value={offer.expiresAt} onChange={e => setOffer({ ...offer, expiresAt: e.target.value })} /></label>
                    <button style={{ ...button, marginTop: 10 }} disabled={busy || running} onClick={proposeOffer}>Validar y guardar propuesta · sin activar</button>
                  </details>
                </>}
              </>}
            </>}
          </>}
        </article>
      </div>
    </>}
  </section>;
}
