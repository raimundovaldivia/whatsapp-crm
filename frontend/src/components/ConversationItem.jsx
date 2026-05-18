import { timeAgo } from '../utils/dates.js';
import { Bot, User } from 'lucide-react';

export default function ConversationItem({ conversation, selected, onClick }) {
  const { contact_name, phone_number, last_message, last_message_at, unread_count, agent_mode } = conversation;

  const timeAgoStr = timeAgo(last_message_at);

  const initials = (contact_name || phone_number || '?')
    .split(' ')
    .map(w => w[0])
    .join('')
    .substring(0, 2)
    .toUpperCase();

  const avatarColor = stringToColor(phone_number || contact_name || '');

  return (
    <div
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        padding: '10px 16px',
        gap: '12px',
        cursor: 'pointer',
        backgroundColor: selected ? '#2a3942' : 'transparent',
        borderBottom: '1px solid #1f2c33',
        transition: 'background 0.15s',
        position: 'relative',
      }}
      onMouseEnter={e => { if (!selected) e.currentTarget.style.backgroundColor = '#202c33'; }}
      onMouseLeave={e => { if (!selected) e.currentTarget.style.backgroundColor = 'transparent'; }}
    >
      {/* Avatar */}
      <div style={{
        width: '46px',
        height: '46px',
        borderRadius: '50%',
        backgroundColor: avatarColor,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        fontSize: '16px',
        fontWeight: 600,
        color: 'white',
        position: 'relative',
      }}>
        {initials}
        {/* Indicador modo agente */}
        <div style={{
          position: 'absolute',
          bottom: 0,
          right: 0,
          width: '16px',
          height: '16px',
          borderRadius: '50%',
          backgroundColor: agent_mode === 'ai' ? '#00a884' : '#f0b429',
          border: '2px solid #111b21',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}>
          {agent_mode === 'ai'
            ? <Bot size={8} color="white" />
            : <User size={8} color="white" />
          }
        </div>
      </div>

      {/* Info */}
      <div style={{ flex: 1, overflow: 'hidden' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <span style={{
            fontSize: '15px',
            fontWeight: unread_count > 0 ? 600 : 400,
            color: '#e9edef',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            maxWidth: '180px',
          }}>
            {contact_name || phone_number}
          </span>
          <span style={{ fontSize: '11px', color: unread_count > 0 ? '#00a884' : '#8696a0', flexShrink: 0 }}>
            {timeAgoStr}
          </span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '2px' }}>
          <span style={{
            fontSize: '13px',
            color: '#8696a0',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            flex: 1,
          }}>
            {last_message || 'Sin mensajes'}
          </span>
          {unread_count > 0 && (
            <span style={{
              backgroundColor: '#00a884',
              color: 'white',
              borderRadius: '50%',
              minWidth: '20px',
              height: '20px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '11px',
              fontWeight: 700,
              flexShrink: 0,
              marginLeft: '8px',
            }}>
              {unread_count > 99 ? '99+' : unread_count}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function stringToColor(str) {
  const colors = [
    '#e57373', '#f06292', '#ba68c8', '#9575cd',
    '#7986cb', '#64b5f6', '#4dd0e1', '#4db6ac',
    '#81c784', '#dce775', '#ffb74d', '#ff8a65',
  ];
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}
