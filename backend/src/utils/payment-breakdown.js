function paymentBreakdown(method, totalValue, cashValue, transferValue) {
  const total = Math.max(0, Math.round(Number(totalValue) || 0));
  if (method === 'mixto') {
    const cash = Math.round(Number(cashValue));
    const transfer = Math.round(Number(transferValue));
    if (!Number.isFinite(cash) || !Number.isFinite(transfer) || cash <= 0 || transfer <= 0 || cash + transfer !== total) {
      const error = new Error(`Los montos de efectivo y transferencia deben sumar exactamente $${total.toLocaleString('es-CL')}`);
      error.status = 400;
      throw error;
    }
    return { cash, transfer };
  }
  if (method === 'efectivo') return { cash: total, transfer: 0 };
  if (method === 'transferencia') return { cash: 0, transfer: total };
  if (method) return { cash: 0, transfer: 0 };
  return { cash: null, transfer: null };
}

module.exports = { paymentBreakdown };
