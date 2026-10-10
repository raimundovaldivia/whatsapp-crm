function firstValue(source, keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') return String(value).trim();
  }
  return null;
}

function normalizeAdReferral(value, provider = 'meta') {
  if (!value || typeof value !== 'object') return null;
  const sourceId = firstValue(value, ['source_id', 'sourceId', 'ad_id', 'adId']);
  const ctwaClid = firstValue(value, ['ctwa_clid', 'ctwaClid']);
  const sourceUrl = firstValue(value, ['source_url', 'sourceUrl']);
  const sourceType = firstValue(value, ['source_type', 'sourceType']) || (sourceId || ctwaClid ? 'ad' : null);
  if (!sourceId && !ctwaClid && !sourceUrl) return null;
  return {
    provider: String(provider || 'meta'),
    sourceType,
    sourceId,
    ctwaClid,
    sourceUrl,
    headline: firstValue(value, ['headline', 'title']),
    body: firstValue(value, ['body', 'description']),
    mediaType: firstValue(value, ['media_type', 'mediaType']),
    raw: value,
  };
}

function evolutionReferral(message = {}, data = {}) {
  const candidates = [
    data.referral,
    data.contextInfo?.externalAdReply,
    message.extendedTextMessage?.contextInfo?.externalAdReply,
    message.imageMessage?.contextInfo?.externalAdReply,
    message.videoMessage?.contextInfo?.externalAdReply,
    message.documentMessage?.contextInfo?.externalAdReply,
    message.buttonsResponseMessage?.contextInfo?.externalAdReply,
    message.listResponseMessage?.contextInfo?.externalAdReply,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeAdReferral(candidate, 'evolution');
    if (normalized) return normalized;
  }
  return null;
}

function actionNumber(actions, predicate) {
  const values = (Array.isArray(actions) ? actions : [])
    .filter(action => predicate(String(action?.action_type || '').toLowerCase()))
    .map(action => Number(action?.value || 0))
    .filter(Number.isFinite);
  // Meta can return aliases for the same result. Taking the maximum avoids
  // counting the same conversation twice.
  return values.length ? Math.max(...values) : 0;
}

function summarizeInsights(row = {}) {
  const spend = Number(row.spend || 0);
  const conversations = actionNumber(row.actions, type => type.includes('messaging_conversation_started'));
  const newContacts = actionNumber(row.actions, type => type.includes('messaging_first_reply'));
  const purchases = actionNumber(row.actions, type => type === 'purchase' || type.endsWith('.purchase'));
  return {
    spend,
    impressions: Number(row.impressions || 0),
    reach: Number(row.reach || 0),
    clicks: Number(row.clicks || 0),
    linkClicks: Number(row.inline_link_clicks || 0),
    ctr: Number(row.ctr || 0),
    cpc: Number(row.cpc || 0),
    cpm: Number(row.cpm || 0),
    conversations,
    newContacts,
    purchases,
    costPerConversation: conversations > 0 ? spend / conversations : null,
    dateStart: row.date_start || null,
    dateStop: row.date_stop || null,
  };
}

module.exports = { normalizeAdReferral, evolutionReferral, summarizeInsights };
