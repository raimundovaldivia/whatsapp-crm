import { formatTime } from '../utils/dates.js';
import { Bot, User, Check, CheckCheck, FileText, Image } from 'lucide-react';
import { useTheme } from '../theme.js';
import { API_BASE } from '../utils/api.js';

/** URL autenticada para media (imagen/audio) — requiere _token en query param */
function mediaUrl(mediaId) {
  const token = localStorage.getItem('crm_token') || '';
  return `${API_BASE}/conversations/media/${mediaId}?_token=${encodeURIComponent(token)}`;
}

/** Detecta si el contenido es un template y separa nombre + body */
function parseTemplateContent(content) {
  if (!content?.startsWith('[Template:')) return null;
  const nameMatch = content.match(/^\[Template:\s*([^\]]+)\]/);
  if (!nameMatch) return null;
  const name = nameMatch[1].trim();
  const rest = content.slice(nameMatch[0].length).trim();
  return { name, body: rest || null };
}

export default function MessageBubble({ message }) {
  const { colors, isDark } = useTheme();
  const isOutbound = message.direction === 'outbound';
  const isAI = message.sent_by === 'ai';

  const time = message.created_at ? formatTime(message.created_at) : '';

  const StatusIcon = ({ status }) => {
    if (status === 'read')      return <CheckCheck size={14} style={{ color: '#53bdeb' }} />;
    if (status === 'delivered') return <CheckCheck size={14} style={{ color: colors.textSecondary }} />;
    return <Check size={14} style={{ color: colors.textSecondary }} />;
  };

  const getOutboundBg = () => {
    if (isAI) return isDark ? colors.bgAccent : colors.greenTint;
    return isDark ? colors.bgAccent2 : '#dce8ff';
  };

  const templateData = parseTemplateContent(message.content);

  return (
    <div style={{
      display: 'flex',
      justifyContent: isOutbound ? 'flex-end' : 'flex-start',
      marginBottom: '2px',
    }}>
      <div style={{
        maxWidth: templateData ? '85%' : '65%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: isOutbound ? 'flex-end' : 'flex-start',
      }}>
        {/* Label del remitente */}
        {isOutbound && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '2px', paddingRight: '4px' }}>
            {isAI ? (
              <><Bot size={11} color={colors.green} /><span style={{ fontSize: '11px', color: colors.green }}>Agente IA</span></>
            ) : (
              <><User size={11} color={colors.yellow} /><span style={{ fontSize: '11px', color: colors.yellow }}>Tú</span></>
            )}
          </div>
        )}

        {/* Burbuja */}
        <div style={{
          backgroundColor: isOutbound ? getOutboundBg() : colors.bgPanel,
          color: colors.textPrimary,
          padding: templateData ? '0' : '7px 12px 6px',
          borderRadius: isOutbound ? '7px 7px 0px 7px' : '0px 7px 7px 7px',
          position: 'relative',
          boxShadow: '0 1px 2px rgba(0,0,0,0.3)',
          border: isOutbound && !templateData
            ? (isAI ? 'none' : `1px solid ${isDark ? colors.border : colors.borderStrong}`)
            : templateData ? `1px solid ${colors.purple}33` : 'none',
          overflow: 'hidden',
          minWidth: templateData ? '200px' : undefined,
        }}>

          {message.type === 'image' && message.media_id && message.content !== '📸 [Comprobante de pago]' ? (
            /* ── Imagen real ── */
            <div style={{ padding: '4px 4px 0' }}>
              <img
                src={mediaUrl(message.media_id)}
                alt="Imagen"
                style={{ maxWidth: '240px', maxHeight: '280px', borderRadius: '8px', display: 'block', cursor: 'pointer', objectFit: 'cover' }}
                onClick={() => window.open(mediaUrl(message.media_id), '_blank')}
                onError={e => { e.target.style.display='none'; }}
              />
              <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '2px 4px 4px' }}>
                <span style={{ fontSize: '11px', color: colors.textSecondary }}>{time}</span>
              </div>
            </div>
          ) : message.type === 'audio' && message.media_id ? (
            /* ── Audio con player ── */
            <div style={{ padding: '8px 10px 6px', minWidth: '220px' }}>
              <audio controls style={{ width: '100%', height: '36px', display: 'block', borderRadius: '6px' }}
                src={mediaUrl(message.media_id)} />
              {message.content && message.content !== '🎤 [Audio]' && (
                <p style={{ fontSize: '12px', margin: '5px 0 0', color: colors.textSecondary, fontStyle: 'italic', lineHeight: 1.4 }}>
                  {message.content.replace(/^🎤\s*/, '')}
                </p>
              )}
              <div style={{ display: 'flex', alignItems: 'center', gap: '3px', justifyContent: 'flex-end', marginTop: '3px' }}>
                <span style={{ fontSize: '11px', color: colors.textSecondary }}>{time}</span>
                {isOutbound && <StatusIcon status={message.status} />}
              </div>
            </div>
          ) : message.type === 'image' ? (
            /* ── Comprobante de pago ── */
            <div style={{ padding: '4px 4px 0' }}>
              {message.media_id && (
                <img
                  src={mediaUrl(message.media_id)}
                  alt="Comprobante de pago"
                  style={{ maxWidth: '240px', maxHeight: '280px', borderRadius: '8px 8px 0 0', display: 'block', cursor: 'pointer', objectFit: 'cover', width: '100%' }}
                  onClick={() => window.open(mediaUrl(message.media_id), '_blank')}
                  onError={e => { e.target.style.display='none'; }}
                />
              )}
              <div style={{
                display: 'flex', alignItems: 'center', gap: '8px',
                padding: '8px 10px',
                backgroundColor: isDark ? `${colors.yellow}18` : `${colors.yellow}15`,
                border: `1px solid ${colors.yellow}44`,
                borderRadius: message.media_id ? '0 0 6px 6px' : '8px',
                marginTop: message.media_id ? '0' : '0',
              }}>
                <Image size={16} color={colors.yellow} />
                <div>
                  <div style={{ fontSize: '12px', fontWeight: 600, color: colors.textPrimary }}>Comprobante de pago</div>
                  <div style={{ fontSize: '10px', color: colors.textSecondary }}>Ver en Pedidos → Comprobantes</div>
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '2px 4px 4px' }}>
                <span style={{ fontSize: '11px', color: colors.textSecondary }}>{time}</span>
              </div>
            </div>
          ) : templateData ? (

            /* ── Renderizado especial para templates ── */
            <>
              {/* Header del template card */}
              <div style={{
                display: 'flex', alignItems: 'center', gap: '7px',
                padding: '8px 12px 7px',
                backgroundColor: isDark ? `${colors.purple}18` : `${colors.purple}12`,
                borderBottom: `1px solid ${colors.purple}28`,
              }}>
                <FileText size={13} color={colors.purple} />
                <span style={{ fontSize: '11px', fontWeight: 700, color: colors.purple, letterSpacing: '0.3px' }}>
                  Template de WhatsApp
                </span>
                <span style={{
                  marginLeft: 'auto', fontSize: '10px', color: colors.textMuted,
                  fontFamily: 'monospace', opacity: 0.8,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  maxWidth: '120px',
                }}>
                  {templateData.name}
                </span>
              </div>

              {/* Cuerpo del template */}
              <div style={{ padding: '9px 12px 6px' }}>
                {templateData.body ? (
                  <p style={{
                    fontSize: '14px', lineHeight: '1.5', whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word', margin: 0, color: colors.textPrimary,
                  }}>
                    {templateData.body}
                  </p>
                ) : (
                  <p style={{
                    fontSize: '13px', fontStyle: 'italic', color: colors.textSecondary,
                    margin: 0, lineHeight: 1.4,
                  }}>
                    Template enviado — el cliente recibirá el mensaje aprobado por Meta.
                  </p>
                )}

                {/* Timestamp */}
                <div style={{ display: 'flex', alignItems: 'center', gap: '3px', justifyContent: 'flex-end', marginTop: '4px' }}>
                  <span style={{ fontSize: '11px', color: colors.textSecondary }}>{time}</span>
                  {isOutbound && <StatusIcon status={message.status} />}
                </div>
              </div>
            </>
          ) : (
            /* ── Mensaje normal ── */
            <>
              <p style={{
                fontSize: '14px', lineHeight: '1.5', whiteSpace: 'pre-wrap',
                wordBreak: 'break-word', margin: 0,
              }}>
                {message.content}
              </p>
              <div style={{ display: 'flex', alignItems: 'center', gap: '3px', justifyContent: 'flex-end', marginTop: '4px' }}>
                <span style={{ fontSize: '11px', color: colors.textSecondary }}>{time}</span>
                {isOutbound && <StatusIcon status={message.status} />}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
