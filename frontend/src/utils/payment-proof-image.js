import { paymentProofsAPI } from './api.js';
import { authSession } from './browser-session.js';

export async function fetchPaymentProofImage(proofId) {
  const token = authSession.getToken();
  const response = await fetch(paymentProofsAPI.imageUrl(proofId), {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.error || 'No se pudo cargar la imagen');
  }

  const blob = await response.blob();
  if (!authSession.isCurrent(token)) throw new Error('La sesión cambió');
  if (!blob.type.startsWith('image/')) {
    throw new Error('El archivo recibido no es una imagen válida');
  }
  return blob;
}
