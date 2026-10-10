function text(value, max = 1000) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized ? normalized.slice(0, max) : null;
}

function first(...values) {
  return values.find(value => value !== undefined && value !== null && String(value).trim() !== '') ?? null;
}

function normalize(raw, extra = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const sourceId = first(raw.source_id, raw.sourceId, raw.ad_id, raw.adId, extra.sourceId);
  const sourceUrl = first(raw.source_url, raw.sourceUrl, raw.url, extra.sourceUrl);
  const ctwaClid = first(raw.ctwa_clid, raw.ctwaClid, extra.ctwaClid);
  const headline = first(raw.headline, raw.title, raw.ad_name, raw.adName, extra.headline);
  const body = first(raw.body, raw.description, raw.content, extra.body);
  const campaignId = first(raw.campaign_id, raw.campaignId, raw.campaign?.id, extra.campaignId);
  const campaignName = first(raw.campaign_name, raw.campaignName, raw.campaign?.name, extra.campaignName);
  const adsetId = first(raw.adset_id, raw.adSetId, raw.adsetId, raw.adset?.id, extra.adsetId);
  const adsetName = first(raw.adset_name, raw.adSetName, raw.adsetName, raw.adset?.name, extra.adsetName);
  const adId = first(raw.ad_id, raw.adId, raw.source_id, raw.sourceId, extra.adId);
  const adName = first(raw.ad_name, raw.adName, extra.adName);

  if (![sourceId, sourceUrl, ctwaClid, headline, campaignId, adId].some(Boolean)) return null;
  return {
    sourceType: text(first(raw.source_type, raw.sourceType, extra.sourceType, 'ad'), 80),
    sourceId: text(sourceId, 255),
    sourceUrl: text(sourceUrl, 2000),
    ctwaClid: text(ctwaClid, 500),
    headline: text(headline, 500),
    body: text(body, 2000),
    mediaType: text(first(raw.media_type, raw.mediaType, extra.mediaType), 80),
    mediaUrl: text(first(raw.image_url, raw.imageUrl, raw.video_url, raw.videoUrl,
      raw.thumbnail_url, raw.thumbnailUrl, extra.mediaUrl), 2000),
    campaignId: text(campaignId, 255),
    campaignName: text(campaignName, 500),
    adsetId: text(adsetId, 255),
    adsetName: text(adsetName, 500),
    adId: text(adId, 255),
    adName: text(adName, 500),
    raw,
  };
}

function fromEvolution(message = {}, data = {}, body = {}) {
  const context = message.extendedTextMessage?.contextInfo
    || message.imageMessage?.contextInfo
    || message.videoMessage?.contextInfo
    || message.documentMessage?.contextInfo
    || message.contextInfo
    || data.contextInfo
    || {};
  const raw = context.externalAdReply
    || context.external_ad_reply
    || message.referral
    || data.referral
    || body.referral;
  return normalize(raw, {
    ctwaClid: context.ctwaClid || context.ctwa_clid || data.ctwaClid,
    sourceType: raw ? 'click_to_whatsapp' : null,
  });
}

function fromKapso(body = {}, message = {}, conversation = {}) {
  const context = message.contextInfo || message.context || message.kapso?.context || {};
  const raw = message.referral
    || message.kapso?.referral
    || context.externalAdReply
    || context.external_ad_reply
    || body.referral
    || body.kapso?.referral
    || conversation.referral;
  return normalize(raw, {
    ctwaClid: message.kapso?.ctwa_clid || message.ctwa_clid || body.ctwa_clid,
    sourceType: raw ? 'click_to_whatsapp' : null,
  });
}

function fromMeta(message = {}) {
  return normalize(message.referral, {
    ctwaClid: message.referral?.ctwa_clid,
    sourceType: message.referral ? 'click_to_whatsapp' : null,
  });
}

module.exports = { normalize, fromEvolution, fromKapso, fromMeta };
