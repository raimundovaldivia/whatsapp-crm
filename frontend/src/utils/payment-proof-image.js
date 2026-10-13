import { paymentProofsAPI } from './api.js';

export async function fetchPaymentProofImage(proofId) {
  const token = localStorage.getItem('crm_token');
  const response = await fetch(paymentProofsAPI.imageUrl(proofId), {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.error || 'No se pudo cargar la imagen');
  }

  const blob = await response.blob();
  if (!blob.type.startsWith('image/')) {
    throw new Error('El archivo recibido no es una imagen válida');
  }
  return blob;
}
