const db = require('../db/database');
const collection = require('./payment-collection');

function clean(value) {
  return String(value || '').replace(/\r\n/g, '\n').trim();
}

function composePaymentOptions({ paymentMethods = '', paymentInfo = '', bankDetails = '' } = {}) {
  const methods = clean(paymentMethods);
  const details = clean(paymentInfo) || clean(bankDetails);
  if (!methods && !details) return '';

  const sections = ['💳 *Opciones de pago*'];
  if (methods) sections.push(`Puedes pagar con: ${methods.replace(/[.\s]+$/, '')}.`);
  if (details) sections.push(details);
  return sections.join('\n\n');
}

async function buildPaymentOptionsMessage(orgId) {
  const [paymentInfo, deliveryRaw, chargeSettings] = await Promise.all([
    db.getSetting(orgId, 'payment_info'),
    db.getSetting(orgId, 'delivery_info'),
    collection.getChargeSettings(orgId),
  ]);
  let paymentMethods = '';
  try { paymentMethods = JSON.parse(deliveryRaw || '{}')?.paymentMethods || ''; } catch {}
  return composePaymentOptions({
    paymentMethods,
    paymentInfo,
    bankDetails: chargeSettings?.bankDetails,
  });
}

module.exports = { composePaymentOptions, buildPaymentOptionsMessage };
