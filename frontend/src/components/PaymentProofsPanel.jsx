/**
 * PaymentProofsPanel — Comprobantes de pago recibidos por WhatsApp
 *
 * Muestra la lista de comprobantes, permite ver la imagen y marcarlos
 * como verificados o rechazados.
 */
import { useState, useEffect, useCallback } from 'react';
import { CheckCircle, XCircle, Clock, RefreshCw, ExternalLink, X, Image, ZoomIn, ZoomOut, Maximize2 } from 'lucide-react';
import { useTheme } from '../theme.js';
import * as ui from '../ui.js';
import { paymentProofsAPI } from '../utils/api.js';
import { formatDateTime } from '../utils/dates.js';

const STATUS_LABELS = {
  pending:       { label: 'Pendiente',      color: '#f59e0b', Icon: Clock },
  pre_verified:  { label: 'Pre-verificado', color: '#3b82f6', Icon: CheckCircle },
  verified:      { label: 'Verificado',     color: '#22c55e', Icon: CheckCircle },
  rejected:      { label: 'Rechazado',      color: '#ef4444', Icon: XCircle },
};

export default function PaymentProofsPanel({ onOpenConversation, openProofId = null, onProofOpened, onProofUpdated }) {
  const { colors, isDark } = useTheme();
  const [proofs, setProofs]     = useState([]);
  const [loading, setLoading]   = useState(true);
  const [filter, setFilter]     = useState('');
  const [selected, setSelected] = useState(null); // proof con imagen abierta
  const [imageUrl, setImageUrl] = useState(null);
  const [imageLoading, setImageLoading] = useState(false);
  const [imageError, setImageError] = useState('');
  const [imageViewerOpen, setImageViewerOpen] = useState(false);
  const [imageZoom, setImageZoom] = useState(1);
  const [notes, setNotes]       = useState('');
  const [saving, setSaving]     = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await paymentProofsAPI.getAll(filter || null);
      setProofs(data || []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => { load(); }, [load]);

  const openProof = async (proof) => {
    setSelected(proof);
    setNotes(proof.notes || '');
    setImageUrl(null);
    setImageError('');
    setImageLoading(true);
    try {
      // Obtener imagen con el token del usuario
      const token = localStorage.getItem('crm_token');
      const url = paymentProofsAPI.imageUrl(proof.id);
      const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!resp.ok) {
        const payload = await resp.json().catch(() => null);
        throw new Error(payload?.error || 'No se pudo cargar la imagen');
      }
      const blob = await resp.blob();
      if (!blob.type.startsWith('image/')) throw new Error('El archivo recibido no es una imagen válida');
      setImageUrl(URL.createObjectURL(blob));
    } catch (err) {
      setImageUrl(null);
      setImageError(err.message || 'No se pudo cargar la imagen');
    } finally {
      setImageLoading(false);
    }
  };

  useEffect(() => {
    if (!openProofId || selected || !proofs.length) return;
    const proof = proofs.find(item => String(item.id) === String(openProofId));
    if (!proof) return;
    openProof(proof);
    onProofOpened?.();
  }, [openProofId, proofs, selected]);

  const closeProof = () => {
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    setImageViewerOpen(false);
    setImageZoom(1);
    setSelected(null);
    setImageUrl(null);
    setImageError('');
  };

  const changeZoom = delta => setImageZoom(current => Math.min(4, Math.max(0.5, Math.round((current + delta) * 100) / 100)));
  const openImageViewer = () => {
    if (!imageUrl) return;
    setImageZoom(1);
    setImageViewerOpen(true);
  };

  useEffect(() => {
    if (!imageViewerOpen) return undefined;
    const onKeyDown = event => {
      if (event.key === 'Escape') setImageViewerOpen(false);
      if (event.key === '+' || event.key === '=') changeZoom(0.25);
      if (event.key === '-') changeZoom(-0.25);
      if (event.key === '0') setImageZoom(1);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [imageViewerOpen]);

  const updateStatus = async (status) => {
    if (!selected) return;
    setSaving(true);
    try {
      await paymentProofsAPI.update(selected.id, { status, notes });
      setProofs(prev => prev.map(p => p.id === selected.id ? { ...p, status, notes } : p));
      await onProofUpdated?.();
      closeProof();
      load();
    } catch (err) {
      alert('Error al actualizar: ' + err.message);
    } finally {
      setSaving(false);
    }
  };

  const reviewCount = proofs.filter(p => ['pending', 'pre_verified'].includes(p.status)).length;

  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column',
      backgroundColor: colors.bgApp, overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        padding: '20px 24px 16px',
        borderBottom: `1px solid ${colors.border}`,
        display: 'flex', alignItems: 'center', gap: '12px', flexShrink: 0,
      }}>
        <Image size={22} color={colors.yellow} />
        <div>
          <h2 style={{ margin: 0, fontSize: '18px', fontWeight: 700, color: colors.textPrimary }}>
            Comprobantes de pago
          </h2>
          <p style={{ margin: '2px 0 0', fontSize: '13px', color: colors.textSecondary }}>
            Imágenes de transferencia recibidas por WhatsApp
          </p>
        </div>
        {reviewCount > 0 && (
          <div style={{
            marginLeft: 'auto',
            backgroundColor: colors.amberStrong, color: 'white',
            borderRadius: '12px', padding: '3px 10px',
            fontSize: '13px', fontWeight: 700,
          }}>
            {reviewCount} por revisar
          </div>
        )}
        <button onClick={load} title="Actualizar" style={{
          marginLeft: reviewCount > 0 ? '0' : 'auto',
          background: 'none', border: 'none', cursor: 'pointer',
          color: colors.textSecondary, padding: '6px',
        }}>
          <RefreshCw size={16} />
        </button>
      </div>

      {/* Filtros */}
      <div style={{
        padding: '12px 24px', borderBottom: `1px solid ${colors.border}`,
        display: 'flex', gap: '8px', flexShrink: 0,
      }}>
        {[
          { key: '',              label: 'Todos' },
          { key: 'pending',       label: 'Pendientes' },
          { key: 'pre_verified',  label: 'Pre-verificados' },
          { key: 'verified',      label: 'Verificados' },
          { key: 'rejected',      label: 'Rechazados' },
        ].map(({ key, label }) => (
          <button key={key} onClick={() => setFilter(key)} style={{
            padding: '5px 14px', borderRadius: '20px', fontSize: '13px',
            fontWeight: filter === key ? 600 : 400,
            cursor: 'pointer',
            backgroundColor: filter === key ? colors.green : 'transparent',
            color: filter === key ? 'white' : colors.textSecondary,
            border: `1px solid ${filter === key ? colors.green : colors.border}`,
          }}>
            {label}
          </button>
        ))}
      </div>

      {reviewCount > 0 && (
        <div style={{ margin: '12px 24px 0', padding: '9px 12px', borderRadius: '9px', border: `1px solid ${colors.blue}55`, background: `${colors.blue}12`, color: colors.textSecondary, fontSize: '12px' }}>
          Los comprobantes pendientes y pre-verificados todavía cuentan como <strong style={{ color: colors.textPrimary }}>Por cobrar</strong>. Abre cada uno y pulsa <strong style={{ color: colors.success }}>Verificar pago</strong> después de comprobarlo para moverlo a Pagado.
        </div>
      )}

      {/* Lista */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 24px' }}>
        {loading ? (
          <div style={{ textAlign: 'center', color: colors.textSecondary, padding: '40px' }}>
            Cargando...
          </div>
        ) : proofs.length === 0 ? (
          <div style={{ textAlign: 'center', color: colors.textSecondary, padding: '60px 0' }}>
            <Image size={40} style={{ opacity: 0.3, marginBottom: '12px' }} />
            <p style={{ margin: 0 }}>No hay comprobantes {filter ? `(${STATUS_LABELS[filter]?.label || ''})` : ''}</p>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            {proofs.map(proof => {
              const { label, color, Icon } = STATUS_LABELS[proof.status] || STATUS_LABELS.pending;
              return (
                <div key={proof.id}
                  onClick={() => openProof(proof)}
                  style={{
                    backgroundColor: colors.bgPanel,
                    border: `1px solid ${colors.border}`,
                    borderRadius: '10px', padding: '14px 16px',
                    cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '14px',
                    transition: 'border-color 0.15s, background-color 0.15s',
                  }}
                  onMouseEnter={e => {
                    e.currentTarget.style.borderColor = color;
                    e.currentTarget.style.backgroundColor = colors.bgHover;
                  }}
                  onMouseLeave={e => {
                    e.currentTarget.style.borderColor = colors.border;
                    e.currentTarget.style.backgroundColor = colors.bgPanel;
                  }}
                >
                  {/* Ícono estado */}
                  <Icon size={20} color={color} style={{ flexShrink: 0 }} />

                  {/* Info */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: '14px', color: colors.textPrimary }}>
                      {proof.customer_name || proof.customer_phone || 'Cliente desconocido'}
                    </div>
                    <div style={{ fontSize: '12px', color: colors.textSecondary, marginTop: '2px' }}>
                      {proof.order_summary
                        ? `Pedido: ${proof.order_summary}`
                        : 'Sin pedido asociado'}
                    </div>
                    {proof.extracted_amount && (
                      <div style={{ fontSize: '12px', marginTop: '3px', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                        <span style={{ color: proof.amount_matches === true ? colors.success : proof.amount_matches === false ? colors.danger : colors.textSecondary }}>
                          💵 ${Number(proof.extracted_amount).toLocaleString('es-CL')}
                          {proof.amount_matches === true && ' ✓ monto OK'}
                          {proof.amount_matches === false && ' ⚠ monto difiere'}
                        </span>
                        {proof.extracted_bank && <span style={{ color: colors.textMuted }}>🏦 {proof.extracted_bank}</span>}
                      </div>
                    )}
                    {proof.notes && (
                      <div style={{ fontSize: '12px', color: colors.textMuted, marginTop: '3px', fontStyle: 'italic' }}>
                        {proof.notes}
                      </div>
                    )}
                  </div>

                  {/* Fecha + estado */}
                  <div style={{ textAlign: 'right', flexShrink: 0 }}>
                    <div style={{
                      fontSize: '11px', color: 'white', fontWeight: 600,
                      backgroundColor: color, borderRadius: '8px', padding: '2px 8px',
                      marginBottom: '4px',
                    }}>
                      {label}
                    </div>
                    <div style={{ fontSize: '11px', color: colors.textMuted }}>
                      {proof.created_at ? formatDateTime(proof.created_at) : ''}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Modal de detalle */}
      {selected && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 1000,
          backgroundColor: 'rgba(0,0,0,0.7)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          padding: '24px',
        }} onClick={closeProof}>
          <div
            onClick={e => e.stopPropagation()}
            style={{
              backgroundColor: colors.bgPanel,
              borderRadius: '14px', padding: '24px',
              width: '100%', maxWidth: '520px',
              display: 'flex', flexDirection: 'column', gap: '16px',
              boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
            }}
          >
            {/* Header modal */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 700, color: colors.textPrimary }}>
                Comprobante de pago
              </h3>
              <button onClick={closeProof} style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: colors.textSecondary, padding: '4px',
              }}>
                <X size={18} />
              </button>
            </div>

            {/* Info cliente + datos extraídos */}
            <div style={{
              backgroundColor: colors.bgApp, borderRadius: '8px', padding: '12px 14px',
              fontSize: '13px', lineHeight: 1.7, color: colors.textPrimary,
            }}>
              <b>Cliente:</b> {selected.customer_name || selected.customer_phone}<br />
              {selected.customer_phone && selected.customer_name && (
                <><b>Teléfono:</b> {selected.customer_phone}<br /></>
              )}
              {selected.order_summary && (
                <><b>Pedido:</b> {selected.order_summary}<br /></>
              )}
              {selected.extracted_amount && (
                <>
                  <div style={{ marginTop: '6px', paddingTop: '6px', borderTop: `1px solid ${colors.border}` }}>
                    <span style={{ fontWeight: 600, color: colors.textSecondary, fontSize: '11px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                      Extraído por IA
                    </span>
                    <br />
                    {selected.extracted_amount && (
                      <span style={{ color: selected.amount_matches === true ? colors.success : selected.amount_matches === false ? colors.danger : colors.textPrimary }}>
                        <b>Monto:</b> ${Number(selected.extracted_amount).toLocaleString('es-CL')}
                        {selected.amount_matches === true && ' ✅ coincide con pedido'}
                        {selected.amount_matches === false && ' ⚠️ NO coincide con pedido'}
                      </span>
                    )}
                    {selected.extracted_bank && <><br /><b>Banco:</b> {selected.extracted_bank}</>}
                    {selected.extracted_date && <><br /><b>Fecha:</b> {selected.extracted_date}</>}
                    {selected.extracted_reference && <><br /><b>Referencia:</b> {selected.extracted_reference}</>}
                  </div>
                </>
              )}
            </div>

            {/* Imagen */}
            <div style={{
              backgroundColor: colors.bgApp, borderRadius: '10px',
              overflow: 'hidden', minHeight: '200px',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              {imageLoading ? (
                <div style={{ color: colors.textSecondary, fontSize: '14px' }}>Cargando imagen...</div>
              ) : imageUrl ? (
                <button onClick={openImageViewer} title="Ampliar comprobante" style={{ position:'relative', padding:0, border:'none', background:'transparent', cursor:'zoom-in', display:'flex', alignItems:'center', justifyContent:'center', width:'100%' }}>
                  <img
                    src={imageUrl}
                    alt="Comprobante de pago"
                    style={{ maxWidth: '100%', maxHeight: '340px', borderRadius: '8px', objectFit: 'contain' }}
                  />
                  <span style={{ position:'absolute', right:'10px', bottom:'10px', display:'inline-flex', alignItems:'center', gap:'5px', padding:'6px 9px', borderRadius:'999px', backgroundColor:'rgba(0,0,0,0.72)', color:'#fff', fontSize:'11px', fontWeight:700 }}>
                    <ZoomIn size={14} /> Ampliar
                  </span>
                </button>
              ) : (
                <div style={{ color: colors.textSecondary, fontSize: '13px', padding: '40px', textAlign: 'center' }}>
                  <Image size={32} style={{ opacity: 0.3, marginBottom: '8px' }} />
                  <br />{imageError || 'No se pudo cargar la imagen'}
                  <br />
                  <button onClick={() => openProof(selected)} style={{ marginTop:'12px', padding:'6px 11px', borderRadius:'7px', border:`1px solid ${colors.border}`, backgroundColor:colors.bgPanel, color:colors.textPrimary, cursor:'pointer', display:'inline-flex', alignItems:'center', gap:'5px' }}>
                    <RefreshCw size={12} /> Reintentar
                  </button>
                </div>
              )}
            </div>

            {/* Notas */}
            <textarea
              placeholder="Notas opcionales (ej: monto verificado, nombre del titular...)"
              value={notes}
              onChange={e => setNotes(e.target.value)}
              rows={2}
              style={{
                width: '100%', padding: '10px 12px', resize: 'vertical',
                borderRadius: '8px', border: `1px solid ${colors.border}`,
                backgroundColor: colors.bgApp, color: colors.textPrimary,
                fontSize: '13px', fontFamily: 'inherit', boxSizing: 'border-box',
              }}
            />

            {/* Acciones */}
            <div style={{ display: 'flex', gap: '10px' }}>
              <button
                onClick={() => updateStatus('verified')}
                disabled={saving || imageLoading || !imageUrl}
                title={!imageUrl ? 'Primero debe cargar la imagen del comprobante' : 'Confirmar este pago'}
                style={{
                  flex: 1, padding: '10px', borderRadius: '8px', border: 'none',
                  backgroundColor: colors.success, color: 'white',
                  fontWeight: 700, fontSize: '14px', cursor: saving || imageLoading || !imageUrl ? 'not-allowed' : 'pointer',
                  opacity: saving || imageLoading || !imageUrl ? 0.55 : 1,
                }}
              >
                ✓ Verificar pago
              </button>
              <button
                onClick={() => updateStatus('rejected')}
                disabled={saving}
                style={{
                  flex: 1, padding: '10px', borderRadius: '8px', border: 'none',
                  backgroundColor: colors.danger, color: 'white',
                  fontWeight: 700, fontSize: '14px', cursor: saving ? 'not-allowed' : 'pointer',
                  opacity: saving ? 0.7 : 1,
                }}
              >
                ✕ Rechazar
              </button>
              {onOpenConversation && selected.conversation_id && (
                <button
                  onClick={() => { closeProof(); onOpenConversation(selected.conversation_id); }}
                  title="Ver conversación"
                  style={{
                    padding: '10px', borderRadius: '8px',
                    border: `1px solid ${colors.border}`,
                    backgroundColor: 'transparent', color: colors.textSecondary,
                    cursor: 'pointer',
                  }}
                >
                  <ExternalLink size={16} />
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Visor ampliado del voucher */}
      {imageViewerOpen && imageUrl && (
        <div
          onClick={() => setImageViewerOpen(false)}
          onWheel={event => { event.preventDefault(); changeZoom(event.deltaY < 0 ? 0.25 : -0.25); }}
          style={{ position:'fixed', inset:0, zIndex:1300, backgroundColor:'rgba(2,6,23,0.96)', display:'flex', flexDirection:'column' }}
        >
          <div onClick={event => event.stopPropagation()} style={{ display:'flex', alignItems:'center', justifyContent:'center', gap:'8px', padding:'12px', backgroundColor:'rgba(15,23,42,0.96)', borderBottom:'1px solid rgba(255,255,255,0.12)', color:'#fff', flexShrink:0 }}>
            <button onClick={() => changeZoom(-0.25)} disabled={imageZoom <= 0.5} title="Alejar" style={{ padding:'8px', borderRadius:'8px', border:'1px solid rgba(255,255,255,0.18)', background:'transparent', color:'#fff', cursor:imageZoom <= 0.5 ? 'not-allowed' : 'pointer', display:'flex' }}><ZoomOut size={17} /></button>
            <span style={{ minWidth:'58px', textAlign:'center', fontSize:'13px', fontWeight:700 }}>{Math.round(imageZoom * 100)}%</span>
            <button onClick={() => changeZoom(0.25)} disabled={imageZoom >= 4} title="Acercar" style={{ padding:'8px', borderRadius:'8px', border:'1px solid rgba(255,255,255,0.18)', background:'transparent', color:'#fff', cursor:imageZoom >= 4 ? 'not-allowed' : 'pointer', display:'flex' }}><ZoomIn size={17} /></button>
            <button onClick={() => setImageZoom(1)} title="Tamaño normal" style={{ padding:'8px 11px', borderRadius:'8px', border:'1px solid rgba(255,255,255,0.18)', background:'transparent', color:'#fff', cursor:'pointer', display:'flex', alignItems:'center', gap:'5px', fontSize:'12px' }}><Maximize2 size={15} /> Ajustar</button>
            <div style={{ flex:1 }} />
            <span style={{ fontSize:'11px', color:'#94a3b8' }}>Rueda del mouse para ampliar</span>
            <button onClick={() => setImageViewerOpen(false)} title="Cerrar" style={{ padding:'8px', borderRadius:'8px', border:'1px solid rgba(255,255,255,0.18)', background:'transparent', color:'#fff', cursor:'pointer', display:'flex' }}><X size={18} /></button>
          </div>
          <div style={{ flex:1, overflow:'auto', display:'flex', alignItems:imageZoom === 1 ? 'center' : 'flex-start', justifyContent:imageZoom === 1 ? 'center' : 'flex-start', padding:'24px' }}>
            <div onClick={event => event.stopPropagation()} style={{ minWidth:imageZoom === 1 ? '100%' : `${imageZoom * 70}vw`, minHeight:imageZoom === 1 ? '100%' : `${imageZoom * 70}vh`, display:'flex', alignItems:'center', justifyContent:'center' }}>
              <img
                src={imageUrl}
                alt="Comprobante de pago ampliado"
                onClick={() => changeZoom(0.25)}
                style={imageZoom === 1
                  ? { maxWidth:'92vw', maxHeight:'calc(100vh - 110px)', objectFit:'contain', cursor:'zoom-in', boxShadow:'0 12px 40px rgba(0,0,0,0.45)' }
                  : { width:`${imageZoom * 55}vw`, maxWidth:'none', height:'auto', cursor:imageZoom < 4 ? 'zoom-in' : 'default', boxShadow:'0 12px 40px rgba(0,0,0,0.45)' }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
