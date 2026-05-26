import { useState } from 'react';
import { MessageSquare, Bot, ShoppingBag, Eye, EyeOff, Zap, TrendingUp, Users, ArrowRight, CheckCircle } from 'lucide-react';
import { authAPI } from '../utils/api.js';
import { useTheme } from '../theme.js';

export default function AuthPage({ onAuth }) {
  const { colors, isDark } = useTheme();
  const [mode, setMode] = useState('login');
  const [form, setForm] = useState({ businessName: '', name: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPass, setShowPass] = useState(false);

  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(''); setLoading(true);
    try {
      const data = mode === 'login'
        ? await authAPI.login({ email: form.email, password: form.password })
        : await authAPI.register(form);
      localStorage.setItem('crm_token', data.token);
      localStorage.setItem('crm_user',  JSON.stringify(data.user));
      localStorage.setItem('crm_org',   JSON.stringify(data.organization));
      onAuth(data);
    } catch (err) {
      setError(err.response?.data?.error || 'Error de conexión. Intenta de nuevo.');
    } finally { setLoading(false); }
  };

  const features = [
    { icon: <Bot size={18} />, title: 'Agente IA con Claude', desc: 'Responde clientes, sugiere productos y cierra ventas automáticamente' },
    { icon: <ShoppingBag size={18} />, title: 'Integración Shopify', desc: 'Sincroniza pedidos, catálogo y clientes en tiempo real' },
    { icon: <TrendingUp size={18} />, title: 'Re-enganche predictivo', desc: 'La IA predice cuándo un cliente volverá a comprar' },
    { icon: <Zap size={18} />, title: 'Pipeline automatizado', desc: 'Recopila datos del pedido y lo gestiona sin intervención' },
  ];

  const inp = {
    width: '100%', backgroundColor: isDark ? '#0f1820' : colors.bgInput,
    border: `1.5px solid ${colors.border}`,
    borderRadius: '10px', padding: '12px 14px', color: colors.textPrimary, fontSize: '14px',
    outline: 'none', boxSizing: 'border-box', transition: 'border-color 0.2s',
  };

  return (
    <div style={{
      minHeight: '100vh', backgroundColor: colors.bgApp,
      display: 'flex', overflow: 'hidden',
    }}>

      {/* ── Panel izquierdo: Branding ── */}
      <div style={{
        display: 'none',
        // visible solo en pantallas >= 900px (simulado con flex)
        flex: '0 0 45%',
        background: isDark
          ? 'linear-gradient(135deg, #0b1e2d 0%, #0d2e25 50%, #0b1e2d 100%)'
          : 'linear-gradient(135deg, #00a88415 0%, #00c85310 50%, #00a88408 100%)',
        borderRight: `1px solid ${colors.border}`,
        flexDirection: 'column',
        justifyContent: 'center',
        padding: '60px 52px',
        position: 'relative',
        overflow: 'hidden',
      }} className="auth-left-panel">

        {/* Decoración de fondo */}
        <div style={{
          position: 'absolute', top: '-80px', right: '-80px',
          width: '300px', height: '300px', borderRadius: '50%',
          background: `radial-gradient(circle, ${colors.green}18 0%, transparent 70%)`,
          pointerEvents: 'none',
        }} />
        <div style={{
          position: 'absolute', bottom: '-60px', left: '-60px',
          width: '240px', height: '240px', borderRadius: '50%',
          background: `radial-gradient(circle, ${colors.greenLight}10 0%, transparent 70%)`,
          pointerEvents: 'none',
        }} />

        {/* Logo */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '48px' }}>
          <div style={{
            width: '48px', height: '48px', borderRadius: '14px',
            backgroundColor: colors.green,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            boxShadow: `0 8px 24px ${colors.green}44`,
          }}>
            <MessageSquare size={24} color="white" />
          </div>
          <div>
            <div style={{ color: colors.textPrimary, fontSize: '18px', fontWeight: 700 }}>WhatsApp CRM</div>
            <div style={{ color: colors.green, fontSize: '12px', fontWeight: 500 }}>powered by Claude AI</div>
          </div>
        </div>

        {/* Tagline */}
        <h2 style={{
          color: colors.textPrimary, fontSize: '32px', fontWeight: 700,
          lineHeight: 1.25, marginBottom: '16px', margin: '0 0 16px',
        }}>
          Convierte chats en<br />
          <span style={{ color: colors.green }}>ventas automáticas</span>
        </h2>
        <p style={{ color: colors.textSecondary, fontSize: '15px', lineHeight: 1.6, marginBottom: '40px' }}>
          Tu tienda Shopify conectada a un agente de IA que atiende, vende y gestiona pedidos por WhatsApp — sin intervención humana.
        </p>

        {/* Features */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
          {features.map(f => (
            <div key={f.title} style={{ display: 'flex', alignItems: 'flex-start', gap: '14px' }}>
              <div style={{
                width: '38px', height: '38px', borderRadius: '10px', flexShrink: 0,
                backgroundColor: `${colors.green}18`,
                border: `1px solid ${colors.green}33`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                color: colors.green,
              }}>
                {f.icon}
              </div>
              <div>
                <div style={{ color: colors.textPrimary, fontSize: '14px', fontWeight: 600, marginBottom: '2px' }}>{f.title}</div>
                <div style={{ color: colors.textSecondary, fontSize: '13px', lineHeight: 1.5 }}>{f.desc}</div>
              </div>
            </div>
          ))}
        </div>

        {/* Social proof */}
        <div style={{
          marginTop: '44px', padding: '14px 18px',
          backgroundColor: `${colors.green}12`,
          border: `1px solid ${colors.green}28`,
          borderRadius: '12px',
          display: 'flex', alignItems: 'center', gap: '10px',
        }}>
          <Users size={16} color={colors.green} />
          <span style={{ color: colors.textSecondary, fontSize: '13px' }}>
            Tiendas Shopify usando el agente IA en <strong style={{ color: colors.green }}>Chile, México y Argentina</strong>
          </span>
        </div>
      </div>

      {/* ── Panel derecho: Formulario ── */}
      <div style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '40px 24px',
      }}>
        <div style={{ width: '100%', maxWidth: '400px' }}>

          {/* Logo móvil (visible cuando el panel izquierdo está oculto) */}
          <div style={{ textAlign: 'center', marginBottom: '32px' }} className="auth-mobile-logo">
            <div style={{
              width: '56px', height: '56px', borderRadius: '16px',
              backgroundColor: colors.green,
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              marginBottom: '14px',
              boxShadow: `0 8px 24px ${colors.green}44`,
            }}>
              <MessageSquare size={28} color="white" />
            </div>
            <h1 style={{ color: colors.textPrimary, fontSize: '22px', fontWeight: 700, margin: '0 0 4px' }}>
              WhatsApp CRM
            </h1>
            <p style={{ color: colors.textSecondary, fontSize: '13px', margin: 0 }}>
              Agente IA para tu tienda Shopify
            </p>
          </div>

          {/* Título contextual */}
          <div style={{ marginBottom: '28px' }}>
            <h2 style={{ color: colors.textPrimary, fontSize: '22px', fontWeight: 700, margin: '0 0 6px' }}>
              {mode === 'login' ? 'Bienvenido de vuelta' : 'Empieza gratis hoy'}
            </h2>
            <p style={{ color: colors.textSecondary, fontSize: '14px', margin: 0 }}>
              {mode === 'login'
                ? 'Ingresa tus credenciales para continuar'
                : 'Crea tu cuenta y conecta tu tienda en minutos'}
            </p>
          </div>

          {/* Tabs */}
          <div style={{
            display: 'flex', marginBottom: '24px',
            backgroundColor: isDark ? '#0f1820' : colors.bgInput,
            borderRadius: '10px', padding: '4px',
            border: `1px solid ${colors.border}`,
          }}>
            {['login', 'register'].map(m => (
              <button key={m} onClick={() => { setMode(m); setError(''); }}
                style={{
                  flex: 1, padding: '9px', borderRadius: '7px', fontSize: '13.5px', fontWeight: 500,
                  border: 'none', transition: 'all 0.2s', cursor: 'pointer',
                  backgroundColor: mode === m ? colors.bgPanel : 'transparent',
                  color: mode === m ? colors.textPrimary : colors.textSecondary,
                  boxShadow: mode === m ? '0 1px 4px rgba(0,0,0,0.12)' : 'none',
                }}>
                {m === 'login' ? 'Iniciar sesión' : 'Crear cuenta'}
              </button>
            ))}
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            {mode === 'register' && (
              <>
                <div>
                  <label style={{ fontSize: '13px', fontWeight: 500, color: colors.textSecondary, marginBottom: '7px', display: 'block' }}>
                    Nombre de tu negocio
                  </label>
                  <input style={inp} value={form.businessName} onChange={set('businessName')}
                    placeholder="Ej: Mi Tienda Online" required
                    onFocus={e => e.target.style.borderColor = colors.green}
                    onBlur={e => e.target.style.borderColor = colors.border} />
                </div>
                <div>
                  <label style={{ fontSize: '13px', fontWeight: 500, color: colors.textSecondary, marginBottom: '7px', display: 'block' }}>
                    Tu nombre
                  </label>
                  <input style={inp} value={form.name} onChange={set('name')}
                    placeholder="Ej: María García"
                    onFocus={e => e.target.style.borderColor = colors.green}
                    onBlur={e => e.target.style.borderColor = colors.border} />
                </div>
              </>
            )}

            <div>
              <label style={{ fontSize: '13px', fontWeight: 500, color: colors.textSecondary, marginBottom: '7px', display: 'block' }}>
                Email
              </label>
              <input style={inp} type="email" value={form.email} onChange={set('email')}
                placeholder="tu@email.com" required
                onFocus={e => e.target.style.borderColor = colors.green}
                onBlur={e => e.target.style.borderColor = colors.border} />
            </div>

            <div>
              <label style={{ fontSize: '13px', fontWeight: 500, color: colors.textSecondary, marginBottom: '7px', display: 'block' }}>
                Contraseña
              </label>
              <div style={{ position: 'relative' }}>
                <input
                  style={{ ...inp, paddingRight: '44px' }}
                  type={showPass ? 'text' : 'password'}
                  value={form.password}
                  onChange={set('password')}
                  placeholder={mode === 'register' ? 'Mínimo 8 caracteres' : '••••••••'}
                  required
                  onFocus={e => e.target.style.borderColor = colors.green}
                  onBlur={e => e.target.style.borderColor = colors.border}
                />
                <button type="button" onClick={() => setShowPass(!showPass)}
                  style={{
                    position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)',
                    background: 'none', border: 'none', color: colors.textSecondary,
                    display: 'flex', alignItems: 'center', cursor: 'pointer', padding: 0,
                  }}>
                  {showPass ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>

            {error && (
              <div style={{
                backgroundColor: `${colors.red}14`,
                border: `1px solid ${colors.red}55`,
                borderRadius: '9px', padding: '10px 14px',
                color: colors.red, fontSize: '13px',
                display: 'flex', alignItems: 'center', gap: '8px',
              }}>
                <span style={{ fontSize: '15px' }}>⚠</span> {error}
              </div>
            )}

            <button type="submit" disabled={loading}
              style={{
                backgroundColor: colors.green,
                color: 'white',
                padding: '13px', borderRadius: '10px', fontSize: '15px', fontWeight: 600,
                marginTop: '6px', border: 'none',
                cursor: loading ? 'not-allowed' : 'pointer',
                opacity: loading ? 0.75 : 1,
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
                boxShadow: loading ? 'none' : `0 4px 16px ${colors.green}44`,
                transition: 'all 0.2s',
              }}>
              {loading ? (
                <>
                  <span style={{ width: '16px', height: '16px', border: '2px solid rgba(255,255,255,0.3)', borderTop: '2px solid white', borderRadius: '50%', animation: 'spin 0.8s linear infinite', display: 'inline-block' }} />
                  Procesando...
                </>
              ) : (
                <>
                  {mode === 'login' ? 'Entrar' : 'Crear cuenta gratis'}
                  <ArrowRight size={16} />
                </>
              )}
            </button>
          </form>

          {/* Beneficios registro */}
          {mode === 'register' && (
            <div style={{ marginTop: '20px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {['Sin tarjeta de crédito', 'Configuración en 5 minutos', 'Soporte incluido'].map(b => (
                <div key={b} style={{ display: 'flex', alignItems: 'center', gap: '8px', color: colors.textSecondary, fontSize: '12.5px' }}>
                  <CheckCircle size={13} color={colors.green} />
                  {b}
                </div>
              ))}
            </div>
          )}

          {/* Features móvil */}
          <div style={{ display: 'flex', gap: '16px', marginTop: '28px', justifyContent: 'center', flexWrap: 'wrap' }} className="auth-mobile-features">
            {[
              { icon: <Bot size={14} color={colors.green} />, text: 'Agente IA Claude' },
              { icon: <ShoppingBag size={14} color={colors.green} />, text: 'Shopify sync' },
              { icon: <MessageSquare size={14} color={colors.green} />, text: 'CRM real-time' },
            ].map(({ icon, text }) => (
              <div key={text} style={{ display: 'flex', alignItems: 'center', gap: '5px', color: colors.textSecondary, fontSize: '12px' }}>
                {icon} {text}
              </div>
            ))}
          </div>
        </div>
      </div>

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

        @media (min-width: 900px) {
          .auth-left-panel { display: flex !important; }
          .auth-mobile-logo { display: none !important; }
          .auth-mobile-features { display: none !important; }
        }
      `}</style>
    </div>
  );
}
