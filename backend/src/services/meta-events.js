function splitMetaPayload(body) {
  const events = [];
  for (const entry of body?.entry || []) for (const change of entry.changes || []) {
    const value = change.value || {};
    for (const [field, items] of [['messages', value.messages || []], ['statuses', value.statuses || []]]) for (const item of items) {
      events.push({ phoneNumberId: value.metadata?.phone_number_id,
        body: { ...body, entry: [{ ...entry, changes: [{ ...change, value: { ...value, messages: [], statuses: [], [field]: [item] } }] }] } });
    }
  }
  return events;
}
module.exports = { splitMetaPayload };
