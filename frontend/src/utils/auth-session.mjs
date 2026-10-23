// Una pestaña conserva su identidad hasta recargarse. Nunca adopta el token de
// otra tienda mientras todavía muestra datos de la sesión anterior.
export function createAuthSession(storage, reload) {
  let token = storage.getItem('crm_token');
  let reloading = false;
  const refresh = () => {
    if (!reloading) { reloading = true; reload(); }
  };
  const isCurrent = value => value === token && storage.getItem('crm_token') === token;
  const changed = () => Object.assign(new Error('La sesión cambió. Recarga la página.'), { code: 'SESSION_CHANGED' });
  return {
    get token() { return token; },
    isCurrent,
    getToken() {
      if (!isCurrent(token) || reloading) { refresh(); throw changed(); }
      return token;
    },
    save(data, { switchStore = false } = {}) {
      if (!isCurrent(token) || reloading) { refresh(); throw changed(); }
      if (typeof data?.token !== 'string' || !data.token || !data.user?.id || !data.organization?.id
          || data.user.organization_id !== data.organization.id) throw new Error('Respuesta de acceso inválida');
      const keys = ['crm_user', 'crm_org', 'crm_token'];
      const previous = keys.map(key => storage.getItem(key));
      try {
        storage.setItem('crm_user', JSON.stringify(data.user));
        storage.setItem('crm_org', JSON.stringify(data.organization));
        // El token se publica al final: las otras pestañas ya pueden recargar.
        storage.setItem('crm_token', data.token);
      } catch (error) {
        keys.forEach((key, index) => {
          try { previous[index] === null ? storage.removeItem(key) : storage.setItem(key, previous[index]); } catch { /* storage no disponible */ }
        });
        throw error;
      }
      if (switchStore) refresh();
      else token = data.token;
    },
    clear(value = token, { reload: shouldReload = false } = {}) {
      if (!isCurrent(value)) return false;
      storage.removeItem('crm_user');
      storage.removeItem('crm_org');
      storage.removeItem('crm_token');
      token = null;
      if (shouldReload) refresh();
      return true;
    },
    onStorage(event) {
      if (event.storageArea === storage && (event.key === 'crm_token' || event.key === null) && !isCurrent(token)) refresh();
    },
  };
}

export function installSessionInterceptors(api, session, staleError) {
  api.interceptors.request.use(config => {
    const token = session.getToken();
    config.crmSessionToken = token;
    if (token) config.headers.Authorization = `Bearer ${token}`;
    return config;
  });
  api.interceptors.response.use(
    response => {
      if (!session.isCurrent(response.config.crmSessionToken)) throw staleError();
      return response;
    },
    error => {
      if (error.config && !session.isCurrent(error.config.crmSessionToken)) return Promise.reject(staleError());
      const url = String(error.config?.url || '');
      const isAuthAttempt = url.endsWith('/auth/login') || url.endsWith('/auth/register');
      if (error.response?.status === 401 && !isAuthAttempt) session.clear(error.config.crmSessionToken, { reload: true });
      return Promise.reject(error);
    },
  );
}
