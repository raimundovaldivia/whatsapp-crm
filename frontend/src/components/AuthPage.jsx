import { useState } from 'react';
import { MessageSquare, Bot, ShoppingBag, Eye, EyeOff } from 'lucide-react';
import { authAPI } from '../utils/api.js';

export default function AuthPage({ onAuth }) {
  const [mode, setMode] = useState('login'); // 'login' | 'register'
  const [form, setForm] = useState({ businessName: '', name: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPass, setShowPass] = useState(false);

  const set = (k) => (e) => setForm(f => ({ ...f, [k]: e.target.value }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const data = mode === 'login'
        ? await authAPI.login({ email: form.email, password: form.password })
        : await authAPI.register(form);

      localStorage.setItem('crm_token', data.token);
      localStorage.setItem('crm_user', JSON.stringify(data.user));
      localStorage.setItem('crm_org',  JSON.stringify(data.organization));
      onAuth(data);
    } catch (err) {
      setError(err.response?.data?.error || 'Error de conexión. Intenta de nuevo.');
    } finally {
      setLoading(false);
    }
  };

  const inputStyle = {
    width: '100%', backgroundColor: '#2a3942', border: '1px solid #374045',
    borderRadius: '8px', padding: '12px 14px', color: '#e9edef', fontSize: '14px',
    outline: 'none', boxSizing: 'border-box', transition: 'border-color 0.2s',
  };

  const labelStyle = { fontSize: '13px', color: '#8696a0', marginBottom: '6px', display: 'block' };

  return (
    <div style={{
      minHeight: '100vh', backgroundColor: '#111b21',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: '20px',
    }}>
      <div style={{ width: '100%', maxWidth: '420px' }}>
        {/* Logo */}
        <div style={{ textAlign: 'center', marginBottom: '32px' }}>
          <div style={{
            width: '64px', height: '64px', borderRadius: '16px',
            backgroundColor: '#00a884', display: 'inline-flex',
            alignItems: 'center', justifyContent: 'center', marginBottom: '16px',
          }}>
            <MessageSquare size={32} color="white" />
          </div>
          <h1 style={{ color: '#e9edef', fontSize: '24px', fontWeight: 600, margin: 0 }}>
            WhatsApp CRM
          </h1>
          <p style={{ color: '#8696a0', fontSize: '14px', marginTop: '6px' }}>
            Agente IA para tu tienda Shopify
          </p>
        </div>

        {/* Card */}
        <div style={{
          backgroundColor: '#202c33', borderRadius: '16px',
          padding: '32px', border: '1px solid #2a3942',
        }}>
          {/* Tabs */}
          <div style={{ display: 'flex', marginBottom: '28px', backgroundColor: '#111b21', borderRadius: '8px', padding: '4px' }}>
            {['login', 'register'].map(m => (
              <button key={m} onClick={() => { setMode(m); setError(''); }}
                style={{
                  flex: 1, padding: '8px', borderRadius: '6px', fontSize: '14px',
                  fontWeight: 500, transition: 'all 0.2s',
                  backgroundColor: mode === m ? '#2a3942' : 'transparent',
                  color: mode === m ? '#e9edef' : '#8696a0',
                }}>
                {m === 'login' ? 'Iniciar sesión' : 'Crear cuenta'}
              </button>
            ))}
          </div>

          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {mode === 'register' && (
              <>
                <div>
                  <label style={labelStyle}>Nombre de tu negocio</label>
                  <input style={inputStyle} value={form.businessName} onChange={set('businessName')}
                    placeholder="Ej: Mi Tienda Online" required />
                </div>
                <div>
                  <label style={labelStyle}>Tu nombre</label>
                  <input style={inputStyle} value={form.name} onChange={set('name')}
                    placeholder="Ej: María García" />
                </div>
              </>
            )}

            <div>
              <label style={labelStyle}>Email</label>
              <input style={inputStyle} type="email" value={form.email} onChange={set('email')}
                placeholder="tu@email.com" required />
            </div>

            <div>
              <label style={labelStyle}>Contraseña</label>
              <div style={{ position: 'relative' }}>
                <input style={{ ...inputStyle, paddingRight: '44px' }}
                  type={showPass ? 'text' : 'password'} value={form.password} onChange={set('password')}
                  placeholder={mode === 'register' ? 'Mínimo 8 caracteres' : '••••••••'} required />
                <button type="button" onClick={() => setShowPass(!showPass)}
                  style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)',
                    background: 'none', color: '#8696a0', display: 'flex', alignItems: 'center' }}>
                  {showPass ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>

            {error && (
              <div style={{ backgroundColor: '#2d1a1a', border: '1px solid #5c2626',
                borderRadius: '8px', padding: '10px 14px', color: '#e57373', fontSize: '13px' }}>
                {error}
              </div>
            )}

            <button type="submit" disabled={loading}
              style={{
                backgroundColor: loading ? '#374045' : '#00a884', color: 'white',
                padding: '13px', borderRadius: '8px', fontSize: '15px', fontWeight: 600,
                marginTop: '4px', transition: 'background 0.2s', opacity: loading ? 0.8 : 1,
              }}>
              {loading ? 'Procesando...' : mode === 'login' ? 'Entrar' : 'Crear cuenta gratis'}
            </button>
          </form>
        </div>

        {/* Features */}
        <div style={{ display: 'flex', gap: '12px', marginTop: '24px', justifyContent: 'center' }}>
          {[
            { icon: <Bot size={16} color="#00a884" />, text: 'Agente IA Claude' },
            { icon: <ShoppingBag size={16} color="#00a884" />, text: 'Integración Shopify' },
            { icon: <MessageSquare size={16} color="#00a884" />, text: 'CRM en tiempo real' },
          ].map(({ icon, text }) => (
            <div key={text} style={{ display: 'flex', alignItems: 'center', gap: '5px',
              color: '#8696a0', fontSize: '12px' }}>
              {icon} {text}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
