import { Platform } from 'react-native';

// Sistema visual compartido de la app de terreno. Los contrastes están
// pensados para pantallas usadas al aire libre y los acentos comunican estado
// sin depender únicamente del color.
export const C = {
  bg: '#07111F',
  bgSoft: '#0A1626',
  card: '#0F1E30',
  cardHigh: '#14263B',
  border: '#20344D',
  borderSoft: '#172A40',
  green: '#2DD4BF',
  greenStrong: '#14B8A6',
  orange: '#F59E0B',
  blue: '#38BDF8',
  red: '#FB7185',
  purple: '#A78BFA',
  text: '#F8FAFC',
  textSoft: '#D7E2F0',
  muted: '#8EA3BA',
  dim: '#627991',
  white: '#FFFFFF',
  inkOnAccent: '#032B2A',
};

export const R = { sm: 10, md: 14, lg: 18, xl: 24, pill: 999 };

export const shadow = Platform.select({
  ios: {
    shadowColor: '#000', shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.22, shadowRadius: 18,
  },
  android: { elevation: 5 },
  default: {},
});

export const shadowSoft = Platform.select({
  ios: {
    shadowColor: '#000', shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.16, shadowRadius: 10,
  },
  android: { elevation: 2 },
  default: {},
});
