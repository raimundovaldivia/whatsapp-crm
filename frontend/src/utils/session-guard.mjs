// A page must never submit an old store's form using another tab's new token.
export function createSessionGuard(storage) {
  let pageToken = storage.getItem('crm_token');
  return {
    adopt(token) { pageToken = token || null; },
    isCurrent() { return storage.getItem('crm_token') === pageToken; },
    accepts(token) { return storage.getItem('crm_token') === pageToken && token === pageToken; },
    token() {
      if (storage.getItem('crm_token') !== pageToken) {
        throw Object.assign(new Error('La tienda activa cambió. Recargando…'), { code: 'SESSION_CHANGED' });
      }
      return pageToken;
    },
  };
}
