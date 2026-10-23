export const PURCHASE_FREQUENCY_KEY = 'justo_casero_purchase_frequency_v1';

export const PURCHASE_FREQUENCIES = [
  { value: '1', label: '1 vez al mes' },
  { value: '2', label: '2 veces al mes' },
  { value: '3', label: '3 veces al mes' },
  { value: '4', label: '4 veces al mes' },
  { value: '5+', label: '5 o más veces al mes' },
  { value: 'occasional', label: 'Compro de forma ocasional' },
];

export function normalizePurchaseFrequency(value) {
  return PURCHASE_FREQUENCIES.some(option => option.value === value) ? value : '';
}

export function purchaseFrequencyLabel(value) {
  return PURCHASE_FREQUENCIES.find(option => option.value === value)?.label || '';
}

export function withPurchaseFrequency(message, frequency) {
  const label = purchaseFrequencyLabel(frequency);
  return label ? `${message}\n\nMi frecuencia de compra de huevos: ${label.toLowerCase()}.` : message;
}
