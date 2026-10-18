import React from 'react'
import ReactDOM from 'react-dom/client'
const App = React.lazy(() => import('./App.jsx'))
const Tienda = React.lazy(() => import('./components/Tienda.jsx'))
const JustoCaseroLanding = React.lazy(() => import('./components/JustoCaseroLanding.jsx'))
import './index.css'

const ASSET_RELOAD_KEY = 'resel_asset_reload_at'

// La marca del primer render se resuelve antes de cargar cada aplicación.
// Así una tienda pública nunca muestra la identidad interna de Resel.
const STORE_DOMAINS = {
  'www.diezrios.com': 'diez-rios-mrs96z69',
  'diezrios.com':     'diez-rios-mrs96z69',
}
const JUSTO_CASERO_DOMAINS = new Set([
  'justocasero.com',
  'www.justocasero.com',
  'justocasero.cl',
  'www.justocasero.cl',
])

const pathParts = window.location.pathname.split('/').filter(Boolean)
const domainSlug = STORE_DOMAINS[window.location.hostname]
const isAdmin = pathParts[0] === 'admin'
const isJustoCasero = !isAdmin && (JUSTO_CASERO_DOMAINS.has(window.location.hostname) || pathParts[0] === 'justo-casero')
const isTienda = !isAdmin && (domainSlug || (pathParts[0] === 'tienda' && pathParts[1]))

function applyInitialPageIdentity() {
  const identity = isJustoCasero
    ? { title: 'Justo Casero | Huevos café XL y Jumbo por caja', icon: '/store-assets/justo-casero/logo.png', color: '#f2644b' }
    : domainSlug
      ? { title: 'Diez Ríos · Del campo a tu mesa', icon: '/store-assets/diez-rios/icono-diez-rios-oficial-v1.png', color: '#173b2b' }
      : isTienda
        ? { title: 'Tienda', icon: null, color: '#173b2b' }
        : { title: 'Resel', icon: null, color: '#0c1a20' }

  document.title = identity.title
  const favicon = document.querySelector('link[rel="icon"]')
  if (favicon && identity.icon) {
    favicon.setAttribute('href', identity.icon)
    favicon.setAttribute('type', 'image/png')
  }
  let theme = document.querySelector('meta[name="theme-color"]')
  if (!theme) {
    theme = document.createElement('meta')
    theme.setAttribute('name', 'theme-color')
    document.head.appendChild(theme)
  }
  theme.setAttribute('content', identity.color)
}

applyInitialPageIdentity()

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
  const brand = isJustoCasero
    ? {
        name: 'Justo Casero', logo: '/store-assets/justo-casero/logo.png',
        bg: 'radial-gradient(circle at 50% 12%, #fffef9 0, #fff8ec 48%, #f9eedc 100%)',
        text: '#173249', muted: '#71685c', border: '#efdcbf', accent: '#f2644b',
        shadow: 'rgba(242, 100, 75, .20)',
        loading: 'Estamos preparando nuestras cajas de huevos café XL y Jumbo.',
      }
    : isTienda
      ? {
          name: domainSlug ? 'Diez Ríos' : 'tu tienda',
          logo: domainSlug ? '/store-assets/diez-rios/icono-diez-rios-oficial-v1.png' : null,
          mark: 'T', bg: 'linear-gradient(145deg, #f8f6ef, #edf2e9)',
          text: '#173b2b', muted: '#657269', border: '#d5dfd3', accent: '#b58943',
          shadow: 'rgba(23, 59, 43, .18)',
          loading: 'Estamos preparando los productos y tu experiencia de compra.',
        }
      : {
          name: 'Resel', mark: 'R',
          bg: light ? '#f4f7f8' : '#0c1a20',
          text: light ? '#17252b' : '#eef7f8',
          muted: light ? '#667b84' : '#8ea6af',
          border: light ? '#dce6e9' : '#25404a',
          accent: '#12b99a', shadow: 'rgba(10, 184, 151, .28)',
          loading: 'Estamos cargando tu operación y las conversaciones más recientes.',
        }

  return (
    <div role={stalled ? 'alert' : 'status'} aria-live="polite" style={{
      minHeight: '100dvh', width: '100%', display: 'grid', placeItems: 'center',
      padding: 24, boxSizing: 'border-box', background: brand.bg, color: brand.text,
      fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    }}>
      <div style={{ width: 'min(360px, 100%)', textAlign: 'center' }}>
        <div style={{
          width: isJustoCasero ? 92 : 68, height: isJustoCasero ? 92 : 68,
          margin: '0 auto 20px', borderRadius: isJustoCasero ? 28 : 22,
          display: 'grid', placeItems: 'center', color: '#fff', fontSize: 28,
          fontWeight: 900, letterSpacing: '-1px',
          background: brand.logo ? '#fff' : `linear-gradient(145deg, ${brand.accent}, ${brand.accent}cc)`,
          border: brand.logo ? `1px solid ${brand.border}` : 0,
          boxShadow: `0 14px 36px ${brand.shadow}`,
        }}>
          {brand.logo
            ? <img src={brand.logo} alt={brand.name} style={{ width: '76%', height: '76%', objectFit: 'contain' }} />
            : brand.mark}
        </div>
        <div style={{ fontSize: 20, fontWeight: 850, letterSpacing: '-.3px' }}>
          {stalled ? `No pudimos abrir ${brand.name}` : `Preparando ${brand.name}`}
        </div>
        <div style={{ color: brand.muted, fontSize: 13, lineHeight: 1.55, marginTop: 7 }}>
          {stalled
            ? 'Puede ser una actualización reciente o una interrupción momentánea de internet.'
            : brand.loading}
        </div>

        {!stalled ? (
          <div style={{ height: 5, marginTop: 24, borderRadius: 999, overflow: 'hidden', background: brand.border }}>
            <div style={{ width: '42%', height: '100%', borderRadius: 999, background: brand.accent, animation: 'resel-loading 1.35s ease-in-out infinite' }} />
          </div>
        ) : (
          <button onClick={() => window.location.reload()} style={{
            marginTop: 22, border: 0, borderRadius: 10, padding: '10px 18px',
            background: brand.accent, color: '#fff', fontSize: 13, fontWeight: 800,
            cursor: 'pointer', boxShadow: `0 8px 22px ${brand.shadow}`,
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

// En dominios de tienda, /admin reserva el acceso al CRM. El resto del
// dominio sigue mostrando la tienda publica.
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <React.Suspense fallback={<AppLoader />}>
        {isJustoCasero ? <JustoCaseroLanding /> : isTienda ? <Tienda slug={domainSlug || pathParts[1]} /> : <App />}
      </React.Suspense>
    </AppErrorBoundary>
  </React.StrictMode>,
)
