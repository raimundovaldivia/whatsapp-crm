import { Bot, User, Pause, Play } from 'lucide-react';
import { useState } from 'react';

export default function AgentToggle({ mode, onToggle }) {
  const [loading, setLoading] = useState(false);
  const isAI = mode === 'ai';

  const handleClick = async () => {
    setLoading(true);
    try {
      await onToggle();
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
      {/* Status badge */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: '5px',
        backgroundColor: isAI ? '#0d2e25' : '#2e2100',
        border: `1px solid ${isAI ? '#00a884' : '#f0b429'}`,
        borderRadius: '20px',
        padding: '4px 10px',
        fontSize: '12px',
        color: isAI ? '#00a884' : '#f0b429',
        fontWeight: 500,
      }}>
        {isAI
          ? <><Bot size={13} /> IA activa</>
          : <><User size={13} /> Modo manual</>
        }
      </div>

      {/* Toggle button */}
      <button
        onClick={handleClick}
        disabled={loading}
        title={isAI ? 'Pausar IA y tomar control' : 'Reactivar agente IA'}
        style={{
          backgroundColor: isAI ? '#2a3942' : '#00a884',
          color: isAI ? '#8696a0' : 'white',
          padding: '7px 14px',
          borderRadius: '20px',
          fontSize: '13px',
          fontWeight: 500,
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          transition: 'all 0.2s',
          opacity: loading ? 0.7 : 1,
        }}
        onMouseEnter={e => {
          if (!loading) e.currentTarget.style.opacity = '0.85';
        }}
        onMouseLeave={e => {
          e.currentTarget.style.opacity = '1';
        }}
      >
        {isAI
          ? <><Pause size={13} /> Tomar control</>
          : <><Play size={13} /> Activar IA</>
        }
      </button>
    </div>
  );
}
