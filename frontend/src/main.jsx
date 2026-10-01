import React from 'react'
import ReactDOM from 'react-dom/client'
const App = React.lazy(() => import('./App.jsx'))
const Tienda = React.lazy(() => import('./components/Tienda.jsx'))
import './index.css'

const ASSET_RELOAD_KEY = 'resel_asset_reload_at'

function isChunkLoadError(error) {
  const text = String(error?.message || error || '').toLowerCase()
  return text.includes('dynamically imported module')
    || text.includes('failed to fetch')
    || text.includes('chunkloaderror')
    || text.includes('importing a module script failed')
}

// Al publicar una versión nueva, una pestaña abierta puede intentar pedir un
// chunk de la versión anterior. Vite avisa este caso con `vite:preloadError`.
// Recargamos una sola vez; el límite evita un ciclo si realmente no hay red.
function reloadFreshAssets() {
  const lastReload = Number(sessionStorage.getItem(ASSET_RELOAD_KEY) || 0)
  if (Date.now() - lastReload < 30000) return false
  sessionStorage.setItem(ASSET_RELOAD_KEY, String(Date.now()))
  window.location.reload()
  return true
}

window.addEventListener('vite:preloadError', event => {
  event.preventDefault()
  reloadFreshAssets()
})

function AppLoader({ stalled = false }) {
  const light = localStorage.getItem('crm_theme') === 'light'
  const palette = light
    ? { bg: '#f4f7f8', card: '#ffffff', text: '#17252b', muted: '#667b84', border: '#dce6e9' }
    : { bg: '#0c1a20', card: '#13262e', text: '#eef7f8', muted: '#8ea6af', border: '#25404a' }

  return (
    <div role={stalled ? 'alert' : 'status'} aria-live="polite" style={{
      minHeight: '100dvh', width: '100%', display: 'grid', placeItems: 'center',
      padding: 24, boxSizing: 'border-box', background: palette.bg, color: palette.text,
      fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    }}>
      <div style={{ width: 'min(360px, 100%)', textAlign: 'center' }}>
        <div style={{
          width: 68, height: 68, margin: '0 auto 20px', borderRadius: 22,
          display: 'grid', placeItems: 'center', color: '#fff', fontSize: 28,
          fontWeight: 900, letterSpacing: '-1px',
          background: 'linear-gradient(145deg, #18c7a2, #079a82)',
          boxShadow: '0 14px 36px rgba(10, 184, 151, .28)',
        }}>R</div>
        <div style={{ fontSize: 20, fontWeight: 850, letterSpacing: '-.3px' }}>
          {stalled ? 'No pudimos terminar de cargar' : 'Preparando Resel'}
        </div>
        <div style={{ color: palette.muted, fontSize: 13, lineHeight: 1.55, marginTop: 7 }}>
          {stalled
            ? 'Puede ser una actualización reciente o una interrupción momentánea de internet.'
            : 'Estamos cargando tu operación y las conversaciones más recientes.'}
        </div>

        {!stalled ? (
          <div style={{ height: 5, marginTop: 24, borderRadius: 999, overflow: 'hidden', background: palette.border }}>
            <div style={{ width: '42%', height: '100%', borderRadius: 999, background: '#12b99a', animation: 'resel-loading 1.35s ease-in-out infinite' }} />
          </div>
        ) : (
          <button onClick={() => window.location.reload()} style={{
            marginTop: 22, border: 0, borderRadius: 10, padding: '10px 18px',
            background: '#0bb697', color: '#fff', fontSize: 13, fontWeight: 800,
            cursor: 'pointer', boxShadow: '0 8px 22px rgba(10, 184, 151, .22)',
          }}>Volver a cargar</button>
        )}
        <style>{`
          @keyframes resel-loading {
            0% { transform: translateX(-115%); }
            55% { transform: translateX(115%); }
            100% { transform: translateX(255%); }
          }
          @media (prefers-reduced-motion: reduce) {
            [role="status"] div { animation-duration: 2.8s !important; }
          }
        `}</style>
      </div>
    </div>
  )
}

class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error) {
    if (isChunkLoadError(error)) reloadFreshAssets()
    console.error('[Resel] No se pudo iniciar la interfaz:', error)
  }

  render() {
    return this.state.error ? <AppLoader stalled /> : this.props.children
  }
}

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
    <AppErrorBoundary>
      <React.Suspense fallback={<AppLoader />}>
        {isTienda ? <Tienda slug={domainSlug || pathParts[1]} /> : <App />}
      </React.Suspense>
    </AppErrorBoundary>
  </React.StrictMode>,
)
