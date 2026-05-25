import { formatTime } from '../utils/dates.js';
import { Bot, User, Check, CheckCheck } from 'lucide-react';
import { useTheme } from '../theme.js';

export default function MessageBubble({ message }) {
  const { colors, isDark } = useTheme();
  const isOutbound = message.direction === 'outbound';
  const isAI = message.sent_by === 'ai';
  const isHuman = message.sent_by === 'human';

  const time = message.created_at
    ? formatTime(message.created_at)
    : '';

  const StatusIcon = ({ status }) => {
    if (status === 'read') return <CheckCheck size={14} style={{ color: '#53bdeb' }} />;
    if (status === 'delivered') return <CheckCheck size={14} style={{ color: colors.textSecondary }} />;
    return <Check size={14} style={{ color: colors.textSecondary }} />;
  };

  const getOutboundBg = () => {
    if (isAI) return isDark ? colors.bgAccent : colors.greenTint;
    return isDark ? colors.bgAccent2 : '#dce8ff';
  };

  const getOutboundBorder = () => {
    if (isAI) return 'none';
    return `1px solid ${isDark ? colors.border : colors.borderStrong}`;
  };

  return (
    <div style={{
      display: 'flex',
      justifyContent: isOutbound ? 'flex-end' : 'flex-start',
      marginBottom: '2px',
    }}>
      <div style={{
        maxWidth: '65%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: isOutbound ? 'flex-end' : 'flex-start',
      }}>
        {/* Label del remitente (solo para mensajes salientes) */}
        {isOutbound && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            marginBottom: '2px',
            paddingRight: '4px',
          }}>
            {isAI ? (
              <>
                <Bot size={11} color={colors.green} />
                <span style={{ fontSize: '11px', color: colors.green }}>Agente IA</span>
              </>
            ) : (
              <>
                <User size={11} color={colors.yellow} />
                <span style={{ fontSize: '11px', color: colors.yellow }}>Tú</span>
              </>
            )}
          </div>
        )}

        {/* Burbuja del mensaje */}
        <div style={{
          backgroundColor: isOutbound ? getOutboundBg() : colors.bgPanel,
          color: colors.textPrimary,
          padding: '7px 12px 6px',
          borderRadius: isOutbound
            ? '7px 7px 0px 7px'
            : '0px 7px 7px 7px',
          position: 'relative',
          boxShadow: '0 1px 2px rgba(0,0,0,0.3)',
          border: isOutbound ? getOutboundBorder() : 'none',
        }}>
          <p style={{
            fontSize: '14px',
            lineHeight: '1.5',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            margin: 0,
          }}>
            {message.content}
          </p>

          {/* Timestamp + status */}
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '3px',
            justifyContent: 'flex-end',
            marginTop: '4px',
          }}>
            <span style={{ fontSize: '11px', color: colors.textSecondary }}>{time}</span>
            {isOutbound && <StatusIcon status={message.status} />}
          </div>
        </div>
      </div>
    </div>
  );
}
