/**
 * PaymentProofsPanel — Comprobantes de pago recibidos por WhatsApp
 *
 * Muestra la lista de comprobantes, permite ver la imagen y marcarlos
 * como verificados o rechazados.
 */
import { useState, useEffect, useCallback } from 'react';
import { CheckCircle, XCircle, Clock, RefreshCw, ExternalLink, X, Image } from 'lucide-react';
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

const ORDER_STATUS_LABELS = {
  draft: 'Borrador', nuevo: 'Nuevo', sent: 'Confirmado', payment_received: 'Pago recibido',
  por_despachar: 'Por despachar', en_camino: 'En camino', entregado: 'Entregado', paid: 'Pagado',
  cancelado: 'Cancelado', cancelled: 'Cancelado',
};

function linkedOrderReference(proof) {
  const id = proof?.linked_order_id || proof?.order_id;
  return id ? `#BOT-${id}` : null;
}

function linkedOrderItems(proof) {
  let items = proof?.linked_order_items;
  if (typeof items === 'string') {
    try { items = JSON.parse(items); } catch { items = []; }
  }
  return Array.isArray(items)
    ? items.map(item => ({
        name: String(item?.name || item?.title || item?.product_name || '').trim(),
        quantity: Math.max(0, Number(item?.quantity) || 0),
      })).filter(item => item.name && item.quantity > 0)
    : [];
}

function money(value) {
  return `$${Math.round(Number(value) || 0).toLocaleString('es-CL')}`;
}

export default function PaymentProofsPanel({ onOpenConversation, openProofId = null, onProofOpened, onProofUpdated }) {
  const { colors, isDark } = useTheme();
  const [proofs, setProofs]     = useState([]);
  const [loading, setLoading]   = useState(true);
  const [filter, setFilter]     = useState('');
  const [selected, setSelected] = useState(null); // proof con imagen abierta
  const [imageUrl, setImageUrl] = useState(null);
  const [imageLoading, setImageLoading] = useState(false);
  const [imageError, setImageError] = useState('');
  const [magnifier, setMagnifier] = useState(null);
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
    setMagnifier(null);
    setSelected(null);
    setImageUrl(null);
    setImageError('');
  };

  const updateMagnifier = event => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = Math.min(rect.width, Math.max(0, event.clientX - rect.left));
    const y = Math.min(rect.height, Math.max(0, event.clientY - rect.top));
    const size = 190;
    const zoom = 3.2;
    const backgroundWidth = rect.width * zoom;
    const backgroundHeight = rect.height * zoom;
    const backgroundX = Math.max(Math.min(0, size - backgroundWidth), Math.min(0, size / 2 - x * zoom));
    const backgroundY = Math.max(Math.min(0, size - backgroundHeight), Math.min(0, size / 2 - y * zoom));
    setMagnifier({
      size,
      left: x - size / 2,
      top: y - size / 2,
      backgroundSize: `${backgroundWidth}px ${backgroundHeight}px`,
      backgroundPosition: `${backgroundX}px ${backgroundY}px`,
    });
  };

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
              const orderReference = linkedOrderReference(proof);
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
                      {orderReference
                        ? `Pedido asociado: ${orderReference}${proof.linked_order_total != null ? ` · ${money(proof.linked_order_total)}` : ''}`
                        : proof.order_summary
                          ? `Pedido asociado: ${proof.order_summary}`
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

            {/* Pedido asociado */}
            {(() => {
              const reference = linkedOrderReference(selected);
              const items = linkedOrderItems(selected);
              if (!reference) {
                return (
                  <div style={{
                    border: `1px solid ${colors.amberStrong}66`, backgroundColor: `${colors.amberStrong}12`,
                    borderRadius: '8px', padding: '11px 13px', color: colors.textSecondary, fontSize: '12px',
                  }}>
                    <b style={{ color: colors.amberStrong }}>Sin pedido asociado.</b>{' '}
                    Este comprobante debe revisarse manualmente antes de verificarlo.
                  </div>
                );
              }
              return (
                <div style={{
                  border: `1px solid ${colors.green}66`, backgroundColor: `${colors.green}10`,
                  borderRadius: '8px', padding: '11px 13px', color: colors.textPrimary, fontSize: '12px',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', marginBottom: items.length ? '7px' : 0 }}>
                    <span><b>Pedido asociado:</b> <strong style={{ color: colors.green, fontSize: '14px' }}>{reference}</strong></span>
                    {selected.linked_order_total != null && <strong>{money(selected.linked_order_total)}</strong>}
                  </div>
                  {items.length > 0 && (
                    <div style={{ color: colors.textSecondary, marginBottom: '5px' }}>
                      {items.map(item => `${item.quantity}x ${item.name}`).join(' · ')}
                    </div>
                  )}
                  <div style={{ color: colors.textMuted, display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                    {selected.linked_order_status && <span>Estado: {ORDER_STATUS_LABELS[selected.linked_order_status] || selected.linked_order_status}</span>}
                    {selected.linked_order_delivery_date && <span>Entrega: {new Date(selected.linked_order_delivery_date).toLocaleDateString('es-CL', { timeZone: 'UTC' })}</span>}
                  </div>
                </div>
              );
            })()}

            {/* Imagen */}
            <div style={{
              backgroundColor: colors.bgApp, borderRadius: '10px',
              overflow: 'visible', minHeight: '200px', position:'relative',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              {imageLoading ? (
                <div style={{ color: colors.textSecondary, fontSize: '14px' }}>Cargando imagen...</div>
              ) : imageUrl ? (
                <div
                  onMouseEnter={updateMagnifier}
                  onMouseMove={updateMagnifier}
                  onMouseLeave={() => setMagnifier(null)}
                  style={{ position:'relative', display:'inline-flex', lineHeight:0, cursor:'zoom-in' }}
                >
                  <img
                    src={imageUrl}
                    alt="Comprobante de pago"
                    style={{ maxWidth: '100%', maxHeight: '340px', borderRadius: '8px', objectFit: 'contain' }}
                  />
                  {magnifier && (
                    <span style={{
                      position:'absolute', pointerEvents:'none', zIndex:5,
                      width:`${magnifier.size}px`, height:`${magnifier.size}px`,
                      left:`${magnifier.left}px`, top:`${magnifier.top}px`,
                      borderRadius:'50%', border:'3px solid #fff',
                      backgroundImage:`url(${imageUrl})`, backgroundRepeat:'no-repeat',
                      backgroundSize:magnifier.backgroundSize, backgroundPosition:magnifier.backgroundPosition,
                      boxShadow:'0 10px 30px rgba(0,0,0,0.58), inset 0 0 0 1px rgba(0,0,0,0.18)',
                    }} />
                  )}
                </div>
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

    </div>
  );
}
