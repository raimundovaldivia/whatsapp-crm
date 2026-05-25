// theme.js — Color palettes for dark and light modes
import { createContext, useContext } from 'react';

export const DARK = {
  bgApp:         '#111b21',
  bgPanel:       '#202c33',
  bgSub:         '#1a2428',
  bgInput:       '#111b21',
  bgHover:       '#2a3942',
  bgAccent:      '#0d2e25',
  bgAccent2:     '#1a2030',
  border:        '#2a3942',
  borderStrong:  '#374045',
  borderAccent:  '#00a884',
  textPrimary:   '#e9edef',
  textSecondary: '#8696a0',
  textMuted:     '#556169',
  green:         '#00a884',
  greenLight:    '#00c853',
  greenTint:     '#0d2e25',
  red:           '#e57373',
  yellow:        '#f0b429',
  purple:        '#b8a9ff',
  navBg:         '#202c33',
};

export const LIGHT = {
  bgApp:         '#f0f2f5',
  bgPanel:       '#ffffff',
  bgSub:         '#f7f8fa',
  bgInput:       '#f5f6f7',
  bgHover:       '#e8eaed',
  bgAccent:      '#d9fdd3',
  bgAccent2:     '#eef1f6',
  border:        '#e9edef',
  borderStrong:  '#d1d7db',
  borderAccent:  '#00a884',
  textPrimary:   '#111b21',
  textSecondary: '#54656f',
  textMuted:     '#8696a0',
  green:         '#00a884',
  greenLight:    '#00c853',
  greenTint:     '#d9fdd3',
  red:           '#c0392b',
  yellow:        '#e08b00',
  purple:        '#6c3dd8',
  navBg:         '#ffffff',
};

export const ThemeCtx = createContext({ colors: DARK, isDark: true, toggle: () => {} });
export const useTheme = () => useContext(ThemeCtx);
