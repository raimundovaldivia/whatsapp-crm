const { test } = require('node:test');
const assert = require('node:assert/strict');
const utils = import('../../frontend/src/utils/account-collection.mjs');
const accounts = [{ key:'a', customer_name:'Maxima', customer_phone:'56912345678', orders:[
  { source:'bot', id:1, label:'#BOT-1', amount:10000, charge_date:'2026-09-12T15:00:00Z', cash_amount:2000, cash_payment_date:'2026-09-12T15:00:00Z', transfer_amount:8000, transfer_payment_date:'2026-11-02T15:00:00Z' },
  { source:'shopify', id:'2', label:'#1002', amount:5000, charge_date:'2026-10-05T15:00:00Z', cash_amount:5000, cash_payment_date:'2026-10-05T15:00:00Z' },
]}];
test('collection retains carried debt and excludes payments after the selected close', async () => {
  const { collectionOrders } = await utils;
  const rows = collectionOrders(accounts,'2026-10');
  assert.equal(rows[0].closing_due,8000);
  assert.equal(rows[0].closing_paid,2000);
  assert.equal(rows[1].closing_due,0);
  assert.equal(collectionOrders(accounts,'2026-11')[0].closing_due,0);
  assert.equal(collectionOrders(accounts,'2026-10',{onlyDebtors:true}).length,1);
});
test('collection filters by order, client, phone and inclusive Chilean charge dates', async () => {
  const { collectionOrders, collectionDate } = await utils;
  assert.equal(collectionOrders(accounts,'2026-10',{query:'1002'})[0].id,'2');
  assert.equal(collectionOrders(accounts,'2026-10',{query:'MAXIMA'}).length,2);
  assert.equal(collectionOrders(accounts,'2026-10',{query:'12345678'}).length,2);
  assert.equal(collectionOrders(accounts,'2026-10',{from:'2026-10-05',to:'2026-10-05'}).length,1);
  assert.equal(collectionDate('2026-10-06T01:00:00Z'),'2026-10-05');
});
