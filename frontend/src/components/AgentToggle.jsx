import { Bot, User, Pause, Play, MessagesSquare } from 'lucide-react';
import { useState } from 'react';
import { useTheme } from '../theme.js';

export default function AgentToggle({ mode, onToggle, isMobile }) {
  const { colors, isDark } = useTheme();
  const [loading, setLoading] = useState(false);
  const isAI = mode === 'ai';
  const isCoordinating = mode === 'coordinating';
  const accent = isAI ? colors.green : isCoordinating ? colors.purpleSoft : colors.yellow;
  const surface = isAI ? colors.bgAccent : (isDark ? '#211b36' : '#f5f0ff');

  const handleClick = async () => {
    if (isAI && !window.confirm('¿Tomar control manual?\n\nEl bot dejará de responder hasta que lo reactives.')) return;
    setLoading(true);
    try {
      await onToggle();
    } finally {
      setLoading(false);
    }
  };

  /* ── Versión móvil: badge compacto clickeable ── */
  if (isMobile) {
    return (
      <button
        onClick={handleClick}
        disabled={loading}
        title={isAI ? 'Pausar a Diva y tomar control' : isCoordinating ? 'Tomar control de la coordinación' : 'Reactivar a Diva'}
        style={{
          display: 'flex', alignItems: 'center', gap: '4px',
          backgroundColor: surface,
          border: `1px solid ${accent}`,
          borderRadius: '16px', padding: '5px 8px',
          fontSize: '11px', fontWeight: 600,
          color: accent,
          cursor: loading ? 'not-allowed' : 'pointer',
          opacity: loading ? 0.7 : 1,
          transition: 'all 0.2s', flexShrink: 0,
        }}
      >
        {isAI ? <><Bot size={12} /> Diva</> : isCoordinating ? <><MessagesSquare size={12} /> Coordinando</> : <><User size={12} /> Humano</>}
      </button>
    );
  }

  /* ── Versión desktop ── */
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
      {/* Status badge */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '5px',
        backgroundColor: surface,
        border: `1px solid ${accent}`,
        borderRadius: '20px', padding: '4px 10px',
        fontSize: '12px', color: accent, fontWeight: 500,
      }}>
        {isAI ? <><Bot size={13} /> Diva activa</> : isCoordinating ? <><MessagesSquare size={13} /> Diva coordinando</> : <><User size={13} /> Modo humano</>}
      </div>

      {/* Toggle button */}
      <button
        onClick={handleClick}
        disabled={loading}
        title={isAI ? 'Pausar a Diva y tomar control' : isCoordinating ? 'Tomar control de la coordinación' : 'Reactivar a Diva'}
        style={{
          backgroundColor: isAI ? colors.bgHover : colors.green,
          color: isAI ? colors.textSecondary : 'white',
          padding: '7px 14px', borderRadius: '20px',
          fontSize: '13px', fontWeight: 500,
          display: 'flex', alignItems: 'center', gap: '6px',
          transition: 'all 0.2s', opacity: loading ? 0.7 : 1,
          border: 'none', cursor: loading ? 'not-allowed' : 'pointer',
        }}
        onMouseEnter={e => { if (!loading) e.currentTarget.style.opacity = '0.85'; }}
        onMouseLeave={e => { e.currentTarget.style.opacity = '1'; }}
      >
        {isAI ? <><Pause size={13} /> Tomar control</> : isCoordinating ? <><User size={13} /> Tomar control</> : <><Play size={13} /> Activar Diva</>}
      </button>
    </div>
  );
}
