/**
 * ui.js — Estilos globales reutilizables del CRM.
 *
 * Todos los "átomos" visuales (chips, botones, tarjetas, inputs, pestañas,
 * modales, celdas de tabla, títulos de sección) viven acá para que el estilo
 * sea consistente en toda la app. Cada helper recibe `colors` (del theme) y
 * devuelve un objeto de estilo listo para `style={{ ... }}`.
 *
 * Uso:
 *   import { chip, btn, card, input, select, tabBtn, modalOverlay, modalCard,
 *            sectionTitle, tableCell, statusColor } from '../ui.js';
 *   <span style={chip(colors, colors.success)}>Entregado</span>
 *   <button style={btn(colors, 'primary')}>Guardar</button>
 */

// ── Chip / pill de estado ──────────────────────────────────────────────
// color = color de acento (ej colors.success). Fondo y borde se derivan solos.
export const chip = (colors, color) => ({
  display: 'inline-flex', alignItems: 'center', gap: '4px',
  fontSize: '11px', fontWeight: 700, lineHeight: 1.4,
  color,
  backgroundColor: color + '22',
  border: `1px solid ${color}55`,
  borderRadius: colors.radiusPill,
  padding: '2px 9px', whiteSpace: 'nowrap',
});

// ── Badge sólido (para acentos fuertes) ────────────────────────────────
export const badge = (colors, color, textColor = '#fff') => ({
  display: 'inline-flex', alignItems: 'center', gap: '4px',
  fontSize: '10px', fontWeight: 700,
  color: textColor, backgroundColor: color,
  borderRadius: colors.radiusPill, padding: '2px 8px', whiteSpace: 'nowrap',
});

// ── Botones ────────────────────────────────────────────────────────────
// variant: 'primary' | 'secondary' | 'ghost' | 'danger' | 'warning'
export const btn = (colors, variant = 'secondary', extra = {}) => {
  const base = {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px',
    fontSize: '13px', fontWeight: 700, cursor: 'pointer',
    borderRadius: colors.radiusMd, padding: '8px 14px',
    border: '1px solid transparent', transition: 'all 0.15s', whiteSpace: 'nowrap',
  };
  const variants = {
    primary:   { backgroundColor: colors.green, color: '#fff' },
    secondary: { backgroundColor: 'transparent', color: colors.textPrimary, border: `1px solid ${colors.border}` },
    ghost:     { backgroundColor: 'transparent', color: colors.textSecondary, border: 'none' },
    danger:    { backgroundColor: colors.danger, color: '#fff' },
    warning:   { backgroundColor: colors.amber, color: '#231a02' },
  };
  return { ...base, ...(variants[variant] || variants.secondary), ...extra };
};

// ── Tarjeta / superficie elevada ───────────────────────────────────────
export const card = (colors, extra = {}) => ({
  backgroundColor: colors.bgCard,
  border: `1px solid ${colors.border}`,
  borderRadius: colors.radiusLg,
  padding: '14px',
  ...extra,
});

// ── Inputs y selects ───────────────────────────────────────────────────
export const input = (colors, extra = {}) => ({
  padding: '8px 12px', borderRadius: colors.radiusMd,
  border: `1px solid ${colors.border}`, backgroundColor: colors.bgInput,
  color: colors.textPrimary, fontSize: '13px', outline: 'none',
  ...extra,
});
export const select = (colors, extra = {}) => ({
  ...input(colors), cursor: 'pointer', ...extra,
});

// ── Pestañas ───────────────────────────────────────────────────────────
export const tabBtn = (colors, active, extra = {}) => ({
  padding: '8px 16px', border: 'none', cursor: 'pointer',
  fontWeight: 600, fontSize: '13px', transition: 'all 0.15s',
  borderRadius: '8px 8px 0 0',
  backgroundColor: active ? colors.bgCard : 'transparent',
  color: active ? colors.green : colors.textSecondary,
  borderBottom: active ? `2px solid ${colors.green}` : '2px solid transparent',
  ...extra,
});

// ── Modal ──────────────────────────────────────────────────────────────
export const modalOverlay = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  zIndex: 1000, padding: 16,
};
export const modalCard = (colors, extra = {}) => ({
  background: colors.bgPanel, border: `1px solid ${colors.border}`,
  borderRadius: colors.radiusLg, padding: 18,
  width: 'min(560px, 96vw)', maxHeight: '90vh', overflowY: 'auto',
  ...extra,
});

// ── Título de sección ──────────────────────────────────────────────────
export const sectionTitle = (colors, extra = {}) => ({
  color: colors.textPrimary, fontWeight: 700, fontSize: '14px', ...extra,
});

// ── Celda de tabla ─────────────────────────────────────────────────────
export const tableCell = (colors, extra = {}) => ({
  padding: '8px 12px', fontSize: '12px', color: colors.textSecondary,
  borderBottom: `1px solid ${colors.border}`, ...extra,
});

// ── Mapa de color por estado (para pedidos/despachos) ──────────────────
export const statusColor = (colors, status) => ({
  entregado:    colors.teal,
  paid:         colors.success,
  pending:      colors.warning,
  cancelled:    colors.dangerSoft,
  postponed:    colors.purpleSoft,
  efectivo:     colors.success,
  transferencia: colors.info,
  otro:         colors.purpleSoft,
}[status] || colors.textMuted);
