/**
 * AdminAlertsBanner — Control de alertas al admin en el CRM.
 *
 * Tarjeta flotante (esquina inferior derecha) que aparece SOLO cuando hay
 * alertas que no se pudieron entregar al admin por WhatsApp (ventana de 24h
 * cerrada) y quedaron en cola. Oculta cuando no hay nada, para no molestar.
 *
 * Es flotante a propósito: el layout del CRM es flex lateral y un banner de
 * ancho completo obligaría a reestructurarlo. Así no interfiere con ninguna
 * vista y se ve en todas.
 *
 * Da control: ver qué clientes quedaron sin aviso, reenviar la cola (si el
 * canal ya se reabrió) y descartar lo que no aplica.
 */
import { useState, useEffect, useCallback } from 'react';
import { AlertTriangle, X, RefreshCw, ChevronDown, ChevronUp, Send } from 'lucide-react';
import { useTheme } from '../theme.js';
import { adminAlertsAPI } from '../utils/api.js';

const POLL_MS = 60000; // refrescar cada minuto
const AMBER   = '#f59e0b';
const DELIVERY_LABELS = { sending: 'Enviando; sin confirmación', accepted: 'Aceptado; entrega sin confirmar',
  sent: 'Enviado; entrega sin confirmar', delivered: 'Entregado', read: 'Leído',
  queued: 'En cola por ventana cerrada', failed: 'Falló el aviso' };

export default function AdminAlertsBanner({ onOpenConversation }) {
  const { colors } = useTheme();
  const [data,     setData]     = useState(null);   // { count, windowOpen, alerts, adminConfigured }
  const [expanded, setExpanded] = useState(false);
  const [flushing, setFlushing] = useState(false);
  const [msg,      setMsg]      = useState(null);

  const load = useCallback(async () => {
    try {
      const d = await adminAlertsAPI.list();
      setData(d);
    } catch { /* silencioso: no romper el CRM por esto */ }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  // Nada en cola → no mostrar nada
  if (!data || (!data.count && !data.deliveries?.length && !data.attention?.length)) return null;

  const flush = async () => {
    setFlushing(true); setMsg(null);
    try {
      const r = await adminAlertsAPI.flush();
      setMsg(r.success
        ? { ok: true,  text: `${r.drained || 0} alerta(s) reenviada(s)` }
        : { ok: false, text: r.error || 'No se pudieron reenviar' });
      await load();
    } catch (e) {
      setMsg({ ok: false, text: e.response?.data?.error || 'Error al reenviar' });
    } finally {
      setFlushing(false);
    }
  };

  const dismiss = async (id) => {
    try { await adminAlertsAPI.dismiss(id); await load(); } catch { /* noop */ }
  };

  return (
    <div style={{
      position: 'fixed', zIndex: 2000,
      right: '16px', bottom: '76px',              // 76px: deja aire sobre la navbar móvil
      width: 'min(380px, calc(100vw - 32px))',
      backgroundColor: '#2a1f08', border: '1px solid #78350f', borderRadius: '12px',
      boxShadow: '0 8px 28px rgba(0,0,0,0.45)', overflow: 'hidden',
    }}>
      {/* Encabezado */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px', padding: '12px 14px' }}>
        <AlertTriangle size={18} color={AMBER} style={{ flexShrink: 0, marginTop: '1px' }} />
        <div style={{ flex: 1, minWidth: 0, color: '#fde68a', fontSize: '13px', lineHeight: 1.45 }}>
          <strong>{data.attention?.length ? `${data.attention.length} chat(s) pendientes de respuesta` : data.count ? `${data.count} aviso(s) al encargado en espera` : 'Avisos al encargado'}</strong>
          <div style={{ fontSize: '12px', marginTop: '2px', color: '#fcd9a0' }}>
            {!data.count ? 'Verifica si los avisos fueron entregados o siguen sin confirmación.' : data.windowOpen
              ? 'El canal está abierto — puedes reenviarlos ahora.'
              : 'El canal de WhatsApp del admin está cerrado; llegan solos cuando el admin escriba al número del negocio.'}
          </div>
        </div>
        <button onClick={() => setExpanded(v => !v)}
          title={expanded ? 'Ocultar' : 'Ver detalle'}
          style={{ background: 'none', border: 'none', color: '#fde68a', cursor: 'pointer', display: 'flex', flexShrink: 0 }}>
          {expanded ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
        </button>
      </div>

      {/* Acciones */}
      <div style={{ display: 'flex', gap: '8px', padding: '0 14px 12px' }}>
        {data.windowOpen && data.count > 0 && (
          <button onClick={flush} disabled={flushing}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', flex: 1,
              backgroundColor: AMBER, color: '#1c1206', border: 'none', borderRadius: '8px', padding: '8px',
              fontSize: '12px', fontWeight: 700, cursor: flushing ? 'default' : 'pointer' }}>
            {flushing ? <RefreshCw size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Send size={13} />}
            {flushing ? 'Reenviando...' : 'Reenviar ahora'}
          </button>
        )}
        <button onClick={() => setExpanded(v => !v)}
          style={{ flex: data.windowOpen ? 'none' : 1, backgroundColor: 'transparent', color: '#fde68a',
            border: '1px solid #78350f', borderRadius: '8px', padding: '8px 14px', fontSize: '12px',
            fontWeight: 600, cursor: 'pointer' }}>
          {expanded ? 'Ocultar' : 'Ver detalle'}
        </button>
      </div>

      {msg && (
        <div style={{ padding: '0 14px 10px', fontSize: '12px', color: msg.ok ? colors.successSoft : '#fca5a5' }}>
          {msg.text}
        </div>
      )}

      {/* Detalle */}
      {expanded && (
        <div style={{ maxHeight: '46vh', overflowY: 'auto', padding: '0 14px 12px', display: 'flex', flexDirection: 'column', gap: '6px', borderTop: '1px solid #78350f' }}>
          {!data.adminConfigured && (
            <div style={{ fontSize: '12px', color: '#fca5a5', padding: '8px 0 2px' }}>
              ⚠️ No hay número de admin configurado en Ajustes → los avisos no tienen a quién llegar.
            </div>
          )}
          {(data.attention || []).map(c => (
            <button key={`attention-${c.id}`} onClick={() => onOpenConversation?.(c.id)}
              style={{ textAlign: 'left', padding: '10px', border: `1px solid ${colors.border}`, borderRadius: '8px', background: colors.bgPanel, color: colors.textPrimary, cursor: 'pointer' }}>
              <strong>{c.contact_name || c.phone_number} · #{c.id}</strong>
              <div>{c.admin_phone ? `Encargado: +${c.admin_phone}` : 'Sin encargado · Atención del administrador'}</div>
              <div style={{color: colors.textMuted}}>{(c.preview || '[Archivo recibido]').slice(0,120)}</div>
              <div style={{color: colors.textMuted}}>Pendiente desde {new Date(c.pending_since).toLocaleString('es-CL')}</div>
              <span>Abrir conversación</span>
            </button>
          ))}
          {(data.deliveries || []).map(d => (
            <div key={`delivery-${d.id}`} style={{ color: colors.textPrimary, fontSize: '12px', padding: '8px 0', borderBottom: `1px solid ${colors.border}` }}>
              <strong>{d.client_name}{d.conversation_id ? ` (#${d.conversation_id})` : ''}</strong>
              <div>{DELIVERY_LABELS[d.status] || 'Sin confirmación'}</div>
              <div style={{ color: colors.textMuted }}>{new Date(d.created_at).toLocaleString('es-CL')}</div>
              {d.status === 'failed' && <div style={{ color: '#fca5a5' }}>Revisa la configuración y el registro del aviso.</div>}
            </div>
          ))}
          {data.alerts.map(a => (
            <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', marginTop: '6px',
              backgroundColor: colors.bgPanel, border: `1px solid ${colors.border}`, borderRadius: '8px', padding: '8px 10px' }}>
              <span style={{ fontSize: '9px', fontWeight: 700, textTransform: 'uppercase', color: AMBER, flexShrink: 0, letterSpacing: '0.03em' }}>
                {a.kindLabel}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ color: colors.textPrimary, fontSize: '13px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {a.clientName}
                </div>
                <div style={{ color: colors.textMuted, fontSize: '11px' }}>
                  {new Date(a.createdAt).toLocaleString('es-CL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                </div>
              </div>
              <button onClick={() => dismiss(a.id)} title="Descartar este aviso"
                style={{ background: 'none', border: 'none', color: colors.textMuted, cursor: 'pointer', display: 'flex', flexShrink: 0 }}>
                <X size={15} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
