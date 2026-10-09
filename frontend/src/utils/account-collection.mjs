export function collectionDate(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(new Date(value));
}

// El detalle debe usar el mismo cierre mensual que la cuenta, incluso si se pagó después.
export function collectionOrders(accounts, month, { query = '', onlyDebtors = false, from = '', to = '' } = {}) {
  const [year, number] = month.split('-').map(Number);
  const end = Date.UTC(year, number, 1);
  const q = query.trim().toLowerCase();
  return accounts.flatMap(account => account.orders.map(order => {
    const beforeClose = value => value && new Date(value).getTime() < end;
    const payments = (beforeClose(order.cash_payment_date) ? Number(order.cash_amount) || 0 : 0)
      + (beforeClose(order.transfer_payment_date) ? Number(order.transfer_amount) || 0 : 0);
    return { ...order, customer_name: account.customer_name, customer_phone: account.customer_phone,
      account_key: account.key, date: collectionDate(order.charge_date),
      closing_paid: payments, closing_due: Math.max(0, Number(order.amount) - payments) };
  })).filter(order => (!onlyDebtors || order.closing_due > 0)
    && (!from || order.date >= from) && (!to || order.date <= to)
    && (!q || [order.label, order.customer_name, order.customer_phone].some(v => String(v || '').toLowerCase().includes(q))))
    .sort((a, b) => a.date.localeCompare(b.date) || String(a.label).localeCompare(String(b.label)));
}
