function resolveTrustProxy(isProduction, configuredHops) {
  if (configuredHops === undefined || configuredHops === null || configuredHops === '') {
    return isProduction ? 1 : false;
  }

  const hops = Number(configuredHops);
  if (!Number.isInteger(hops) || hops < 1 || hops > 10) {
    throw new Error('TRUST_PROXY_HOPS debe ser un entero entre 1 y 10');
  }
  return hops;
}

function configureTrustProxy(app, options = {}) {
  const trustProxy = resolveTrustProxy(options.isProduction, options.configuredHops);
  if (trustProxy !== false) app.set('trust proxy', trustProxy);
  return trustProxy;
}

module.exports = { configureTrustProxy, resolveTrustProxy };
