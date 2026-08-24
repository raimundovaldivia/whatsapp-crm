/**
 * PaymentProofsPanel — Comprobantes de pago recibidos por WhatsApp
 *
 * Muestra la lista de comprobantes, permite ver la imagen y marcarlos
 * como verificados o rechazados.
 */
import { useState, useEffect, useCallback } from 'react';
import { CheckCircle, XCircle, Clock, RefreshCw, ExternalLink, X, Image } from 'lucide-react';
import { useTheme } from '../theme.js';
import { paymentProofsAPI } from '../utils/api.js';
import { formatDateTime } from '../utils/dates.js';

const STATUS_LABELS = {
  pending:       { label: 'Pendiente',      color: '#f59e0b', Icon: Clock },
  pre_verified:  { label: 'Pre-verificado', color: '#3b82f6', Icon: CheckCircle },
  verified:      { label: 'Verificado',     color: '#22c55e', Icon: CheckCircle },
  rejected:      { label: 'Rechazado',      color: '#ef4444', Icon: XCircle },
};

export default function PaymentProofsPanel({ onOpenConversation }) {
  const { colors, isDark } = useTheme();
  const [proofs, setProofs]     = useState([]);
  const [loading, setLoading]   = useState(true);
  const [filter, setFilter]     = useState('');
  const [selected, setSelected] = useState(null); // proof con imagen abierta
  const [imageUrl, setImageUrl] = useState(null);
  const [imageLoading, setImageLoading] = useState(false);
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
    setImageLoading(true);
    try {
      // Obtener imagen con el token del usuario
      const token = localStorage.getItem('crm_token');
      const url = paymentProofsAPI.imageUrl(proof.id);
      const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!resp.ok) throw new Error('No se pudo cargar la imagen');
      const blob = await resp.blob();
      setImageUrl(URL.createObjectURL(blob));
    } catch {
      setImageUrl(null);
    } finally {
      setImageLoading(false);
    }
  };

  const closeProof = () => {
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    setSelected(null);
    setImageUrl(null);
  };

  const updateStatus = async (status) => {
    if (!selected) return;
    setSaving(true);
    try {
      await paymentProofsAPI.update(selected.id, { status, notes });
      setProofs(prev => prev.map(p => p.id === selected.id ? { ...p, status, notes } : p));
      closeProof();
      load();
    } catch (err) {
      alert('Error al actualizar: ' + err.message);
    } finally {
      setSaving(false);
    }
  };

  const pendingCount = proofs.filter(p => p.status === 'pending').length;

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
        {pendingCount > 0 && (
          <div style={{
            marginLeft: 'auto',
            backgroundColor: '#f59e0b', color: 'white',
            borderRadius: '12px', padding: '3px 10px',
            fontSize: '13px', fontWeight: 700,
          }}>
            {pendingCount} pendiente{pendingCount > 1 ? 's' : ''}
          </div>
        )}
        <button onClick={load} title="Actualizar" style={{
          marginLeft: pendingCount > 0 ? '0' : 'auto',
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
                        <span style={{ color: proof.amount_matches === true ? '#22c55e' : proof.amount_matches === false ? '#ef4444' : colors.textSecondary }}>
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
                      <span style={{ color: selected.amount_matches === true ? '#22c55e' : selected.amount_matches === false ? '#ef4444' : colors.textPrimary }}>
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
                <img
                  src={imageUrl}
                  alt="Comprobante de pago"
                  style={{ maxWidth: '100%', maxHeight: '340px', borderRadius: '8px', objectFit: 'contain' }}
                />
              ) : (
                <div style={{ color: colors.textSecondary, fontSize: '13px', padding: '40px', textAlign: 'center' }}>
                  <Image size={32} style={{ opacity: 0.3, marginBottom: '8px' }} />
                  <br />No se pudo cargar la imagen
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
                disabled={saving}
                style={{
                  flex: 1, padding: '10px', borderRadius: '8px', border: 'none',
                  backgroundColor: '#22c55e', color: 'white',
                  fontWeight: 700, fontSize: '14px', cursor: saving ? 'not-allowed' : 'pointer',
                  opacity: saving ? 0.7 : 1,
                }}
              >
                ✓ Verificar pago
              </button>
              <button
                onClick={() => updateStatus('rejected')}
                disabled={saving}
                style={{
                  flex: 1, padding: '10px', borderRadius: '8px', border: 'none',
                  backgroundColor: '#ef4444', color: 'white',
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
