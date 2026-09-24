import React from 'react'
import ReactDOM from 'react-dom/client'
const App = React.lazy(() => import('./App.jsx'))
const Tienda = React.lazy(() => import('./components/Tienda.jsx'))
import './index.css'

// Dominios propios de tiendas → mapeo hostname → slug
const STORE_DOMAINS = {
  'www.diezrios.com': 'diez-rios-mrs96z69',
  'diezrios.com':     'diez-rios-mrs96z69',
};

// Detectar si la URL es /tienda/:slug O si el hostname es un dominio de tienda
const pathParts  = window.location.pathname.split('/').filter(Boolean);
const domainSlug = STORE_DOMAINS[window.location.hostname];
const isTienda   = domainSlug || (pathParts[0] === 'tienda' && pathParts[1]);

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <React.Suspense fallback={<div role="status" style={{ padding: 24 }}>Cargando…</div>}>
    {isTienda ? <Tienda slug={domainSlug || pathParts[1]} /> : <App />}
    </React.Suspense>
  </React.StrictMode>,
)
