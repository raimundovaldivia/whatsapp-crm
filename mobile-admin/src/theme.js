/**
 * theme.js — Paleta oscura de la app Central (coherente con el CRM web).
 */
export const colors = {
  bg:           '#0b1220',
  bgPanel:      '#0f172a',
  bgCard:       '#111c30',
  bgSub:        '#1e293b',
  border:       '#243044',
  textPrimary:  '#e6edf6',
  textSecondary:'#9fb0c3',
  textMuted:    '#64748b',
  green:        '#22c55e',
  blue:         '#38bdf8',
  yellow:       '#fbbf24',
  orange:       '#fb923c',
  red:          '#f87171',
  purple:       '#a78bfa',
};

export const CLP = n => `$${Math.round(Number(n) || 0).toLocaleString('es-CL')}`;
