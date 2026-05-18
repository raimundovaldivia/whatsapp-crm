import { formatTime } from '../utils/dates.js';
import { Bot, User, Check, CheckCheck } from 'lucide-react';

export default function MessageBubble({ message }) {
  const isOutbound = message.direction === 'outbound';
  const isAI = message.sent_by === 'ai';
  const isHuman = message.sent_by === 'human';

  const time = message.created_at
    ? formatTime(message.created_at)
    : '';

  const StatusIcon = ({ status }) => {
    if (status === 'read') return <CheckCheck size={14} style={{ color: '#53bdeb' }} />;
    if (status === 'delivered') return <CheckCheck size={14} style={{ color: '#8696a0' }} />;
    return <Check size={14} style={{ color: '#8696a0' }} />;
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
                <Bot size={11} color="#00a884" />
                <span style={{ fontSize: '11px', color: '#00a884' }}>Agente IA</span>
              </>
            ) : (
              <>
                <User size={11} color="#f0b429" />
                <span style={{ fontSize: '11px', color: '#f0b429' }}>Tú</span>
              </>
            )}
          </div>
        )}

        {/* Burbuja del mensaje */}
        <div style={{
          backgroundColor: isOutbound
            ? (isAI ? '#005c4b' : '#1d3557')
            : '#202c33',
          color: '#e9edef',
          padding: '7px 12px 6px',
          borderRadius: isOutbound
            ? '7px 7px 0px 7px'
            : '0px 7px 7px 7px',
          position: 'relative',
          boxShadow: '0 1px 2px rgba(0,0,0,0.3)',
          border: isOutbound && !isAI ? '1px solid #2d4a6e' : 'none',
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
            <span style={{ fontSize: '11px', color: '#8696a0' }}>{time}</span>
            {isOutbound && <StatusIcon status={message.status} />}
          </div>
        </div>
      </div>
    </div>
  );
}
