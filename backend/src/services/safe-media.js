const axios = require('axios');
const dns = require('node:dns').promises;
const ipaddr = require('ipaddr.js');

const MAX_BYTES = 10 * 1024 * 1024;
const KEY_HOSTS = new Set(['api.kapso.ai', 'app.kapso.ai']);
// Resolve once and pin the connection to a public address, including redirects.
async function publicTarget(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) {
    throw new Error('Destino multimedia no permitido');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = await dns.lookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => {
    let ip = ipaddr.parse(address);
    if (ip.kind() === 'ipv6' && ip.isIPv4MappedAddress()) ip = ip.toIPv4Address();
    return ip.range() !== 'unicast';
  })) throw new Error('Destino multimedia no público');
  return { url, address: addresses[0] };
}

async function downloadMedia(value, config = {}) {
  for (let redirects = 0; redirects <= 5; redirects++) {
    const { url, address } = await publicTarget(value);
    const headers = KEY_HOSTS.has(url.hostname)
      ? { 'X-API-Key': config.kapso_api_key || process.env.KAPSO_API_KEY } : {};
    const resp = await axios.get(url.href, {
      headers, proxy: false, responseType: 'arraybuffer', maxRedirects: 0,
      maxContentLength: MAX_BYTES, maxBodyLength: MAX_BYTES, timeout: 20000,
      lookup: (_host, opts, cb) => {
        if (typeof opts === 'function') { cb = opts; opts = {}; }
        cb(null, opts?.all ? [address] : address.address, address.family);
      },
      validateStatus: status => status >= 200 && status < 400,
    });
    if (resp.status >= 300) {
      if (!resp.headers.location) throw new Error('Redirección multimedia inválida');
      value = new URL(resp.headers.location, url).href;
      continue;
    }
    const contentType = resp.headers['content-type'] || 'application/octet-stream';
    if (!/^(image\/(jpeg|png|gif|webp)|audio\/|video\/|application\/pdf)/i.test(contentType)) {
      throw new Error('Formato multimedia no permitido');
    }
    return { data: resp.data, contentType };
  }
  throw new Error('Demasiadas redirecciones');
}
module.exports = { downloadMedia, publicTarget, MAX_BYTES };
