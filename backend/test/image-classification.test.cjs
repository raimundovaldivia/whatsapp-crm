const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizePaymentProofAnalysis } = require('../src/services/analyzePaymentProof');

test('una foto común nunca se convierte en comprobante por valores ambiguos', () => {
  assert.equal(normalizePaymentProofAnalysis({
    is_payment_proof: 'false', confidence: 'high', amount: null,
  }).is_payment_proof, false);
  assert.equal(normalizePaymentProofAnalysis({
    is_payment_proof: true, confidence: 'low', amount: 45000,
  }).is_payment_proof, false);
  assert.equal(normalizePaymentProofAnalysis({
    is_payment_proof: true, confidence: 'high', amount: null, bank: null, reference: null,
  }).is_payment_proof, false);
});

test('un comprobante explícito conserva únicamente datos financieros válidos', () => {
  const result = normalizePaymentProofAnalysis({
    is_payment_proof: true,
    confidence: 'high',
    amount: '$45.000',
    currency: 'CLP',
    bank: 'Banco Santander',
    reference: '123456',
    date: '2026-10-01',
  });
  assert.equal(result.is_payment_proof, true);
  assert.equal(result.amount, 45000);
  assert.equal(result.bank, 'Banco Santander');
  assert.equal(result.reference, '123456');
});
