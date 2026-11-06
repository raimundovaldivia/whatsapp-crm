// Local browser fixture. Every CRM request is replaced; CSP blocks external calls.
// Run: node test/frequency-followup-preview.mjs, then http://127.0.0.1:5194
// ?scenario=disconnected|changed|error|pages|generation-error|missing|skip exercises negative cases.
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const mock = `
const scenario = new URLSearchParams(location.search).get('scenario');
const base = { purchaseCount: 4, purchaseDays: 4, sampleDays: 4, lastPurchase: '2026-10-01', daysSincePurchase: 36, intervalDays: 10, nextPurchase: '2026-10-11', daysUntilNext: -26, cadence: 'weekly', status: 'overdue', regularity: 'regular', recentDates: ['2026-10-01','2026-09-21','2026-09-11','2026-09-01'] };
const customers = [
  {...base, name:'Ana Ejemplo', phone:'56911111111'},
  {...base, name:'Bruno Ejemplo', phone:'56922222222'},
  {...base, name:'Baja Ejemplo', phone:'56933333333', optedOut:true},
  ...(scenario === 'pages' ? Array.from({length:51}, (_,i) => ({...base,name:'Cliente '+i,phone:String(56940000000+i)})) : []),
];
let reads = 0;
let generations = 0;
const posts = [];
const campaigns = [];
const log = () => { document.getElementById('requests').textContent = JSON.stringify({simulatedPosts: posts},null,2); };
log();
export const api = {
  get: async (url) => {
    if (url === '/clientes/all') {
      reads++;
      if (scenario === 'error' && reads === 2) throw new Error('Simulated read failure');
      return {data:{success:true,asOf:'2026-11-06',customers:customers.map(c => scenario === 'changed' && reads > 1 && c.phone === '56922222222' ? {...c,optedOut:true} : c)}};
    }
    if (url === '/reengagement/sending-methods') return {data:{methods:[{provider:'kapso',available:true,label:'Kapso ficticio'},{provider:'evolution',channelId:7,available:scenario !== 'disconnected',label:'Evolution ficticio'}]}};
    if (url.startsWith('/reengagement/campaigns')) return {data:{campaigns:[...campaigns],recipients:[]}};
    if (url === '/products') return {data:{products:[]}};
    if (url === '/contacts/favorite-products') return {data:{favorites:{}}};
    throw new Error('Unexpected read '+url);
  },
  post: async (url,body) => {
    posts.push({url,body}); log();
    if (url === '/reengagement/generate') {
      generations++;
      if (scenario === 'generation-error' && generations === 1) throw new Error('Fallo simulado de generación; puedes reintentar.');
      const drafts = body.phones.map(phone => {
        const first = phone === '56911111111';
        return scenario === 'skip' && !first ? {phone,name:'Bruno Ejemplo',decision:'skip',reasonCode:'opt_out',reason:'Contacto dado de baja.'} : {
          phone,name:first ? 'Ana Ejemplo':'Bruno Ejemplo',decision:'draft',reason:'Productos y frecuencia verificados en su historial.',offers:[],
          message:first ? 'Hola Ana, en tu última compra elegiste huevos XL. ¿Te gustaría volver a pedir esta semana?':'Hola Bruno, ¿te gustaría conocer las opciones para volver a pedir aceitunas?',
          evidence:{ultimaCompra:first?'2026-10-30':'2026-11-01',intervaloMedianoDias:first?7:null,regularidad:first?'regular':'insufficient',proximaCompraEstimada:first?'2026-11-06':null,pedidos:[{productos:[{producto:first?'Huevos XL':'Aceitunas',cantidad:first?2:1}]}]},
        };
      });
      return {data:{drafts:scenario === 'missing' ? drafts.slice(0,-1):drafts,requiresApproval:true,businessDate:'2026-11-06'}};
    }
    if (url === '/reengagement/campaigns') { const campaign={...body,id:1,template_name:body.templateName,created_at:new Date().toISOString(),total_count:body.total,status:'processing',sending_provider:body.sendingProvider,server_managed:true,queue_pending_count:body.total}; campaigns.push(campaign);return {data:{campaign}}; }
    if (url === '/reengagement/campaigns/1/start') return {data:{success:true}};
    throw new Error('Unexpected write '+url);
  }
};
export default api;
export const reengagementAPI = {};
export const conversationsAPI = { getByPhone:async()=>[] };
`;
const entry = `import React from 'react'; import {createRoot} from 'react-dom/client'; import PurchaseFrequencyPanel from '/src/components/PurchaseFrequencyPanel.jsx';
createRoot(document.getElementById('root')).render(React.createElement(PurchaseFrequencyPanel, {canSendFollowup:true}));`;
const server = await createServer({ root, configFile: false, cacheDir: 'node_modules/.vite-frequency-preview',
  optimizeDeps: { include: ['react', 'react-dom/client', 'react/jsx-runtime', 'lucide-react'] },
  esbuild: { jsx: 'automatic' }, plugins: [{ name: 'frequency-fixture', enforce: 'pre',
  resolveId(id) { if (/(?:^|\/)utils\/api(?:\.js)?$/.test(id)) return '\0fixture-api'; if (id === '/fixture.jsx') return '\0fixture.jsx'; },
  load(id) { if (id === '\0fixture-api') return mock; if (id === '\0fixture.jsx') return entry; },
  configureServer(server) { server.middlewares.use((req, res, next) => {
    if (req.url.split('?')[0] !== '/') return next();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', "connect-src 'self' ws://127.0.0.1:5194; img-src 'self' data:; font-src 'self'");
    res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Prueba local de seguimiento</title><style>body{margin:0;background:#111b21;color:#e9edef;font-family:Arial}#root{height:90vh;display:flex;flex-direction:column}#requests{white-space:pre-wrap;padding:12px}*{box-sizing:border-box}</style></head><body><div id="root"></div><details open><summary>Solicitudes simuladas: ninguna se envía a WhatsApp</summary><pre id="requests"></pre></details><script type="module" src="/fixture.jsx"></script></body></html>');
  }); },
}], server: { host: '127.0.0.1', port: 5194, strictPort: true } });
await server.listen();
console.log('Local fixture: http://127.0.0.1:5194');
