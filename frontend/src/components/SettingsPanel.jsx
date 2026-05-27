/**
 * SettingsPanel — Ajustes del CRM
 * Tabs: Shopify · WhatsApp · IA
 */

import { useState, useEffect, useRef } from 'react';
import {
  CheckCircle, AlertCircle, ExternalLink, Loader,
  ShoppingBag, RefreshCw, MessageCircle, Phone, Brain,
  Eye, EyeOff, Save, Zap, FileText, ChevronRight,
  Sparkles, ArrowRight, Clock, MapPin, DollarSign, CreditCard,
} from 'lucide-react';
import { setupAPI, api, reengagementAPI } from '../utils/api.js';
import TemplateManager from './TemplateManager.jsx';
import { useTheme } from '../theme.js';

const TABS = [
  { key: 'shopify',   label: 'Shopify',    icon: ShoppingBag },
  { key: 'whatsapp',  label: 'WhatsApp',   icon: MessageCircle },
  { key: 'ia',        label: 'IA & Bot',   icon: Brain },
  { key: 'templates', label: 'Templates',  icon: FileText },
];

function Field({ label: lbl, hint: h, type = 'text', value, onChange, placeholder, password, colors }) {
  const [show, setShow] = useState(false);
  const inp = {
    width: '100%', backgroundColor: colors.bgApp, border: `1px solid ${colors.borderStrong}`,
    borderRadius: '8px', padding: '10px 14px', color: colors.textPrimary, fontSize: '14px',
    outline: 'none', boxSizing: 'border-box',
  };
  const labelStyle = { fontSize: '12px', color: colors.textSecondary, marginBottom: '5px', display: 'block' };
  const hintStyle  = { fontSize: '11px', color: colors.textMuted, margin: '4px 0 0' };
  return (
    <div>
      <label style={labelStyle}>{lbl}</label>
      <div style={{ position: 'relative' }}>
        <input
          style={{ ...inp, paddingRight: password ? '40px' : '14px' }}
          type={password && !show ? 'password' : 'text'}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
        />
        {password && (
          <button onClick={() => setShow(s => !s)}
            style={{ position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: colors.textSecondary, padding: 0 }}>
            {show ? <EyeOff size={15} /> : <Eye size={15} />}
          </button>
        )}
      </div>
      {h && <p style={hintStyle}>{h}</p>}
    </div>
  );
}

function Badge({ ok, colors }) {
  return ok
    ? <span style={{ marginLeft: 'auto', backgroundColor: colors.bgAccent, color: colors.green, fontSize: '11px', padding: '3px 10px', borderRadius: '20px', border: `1px solid ${colors.green}55` }}>✓ Conectado</span>
    : <span style={{ marginLeft: 'auto', backgroundColor: '#2d1a1a', color: colors.red, fontSize: '11px', padding: '3px 10px', borderRadius: '20px', border: '1px solid #5c262655' }}>Sin configurar</span>;
}

function Alert({ type, msg, colors }) {
  const isErr = type === 'error';
  return (
    <div style={{ backgroundColor: isErr ? '#2d1a1a' : colors.bgAccent, border: `1px solid ${isErr ? '#5c2626' : colors.green}`, borderRadius: '8px', padding: '10px 14px', color: isErr ? colors.red : colors.green, fontSize: '13px', display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
      {isErr ? <AlertCircle size={14} style={{ flexShrink: 0, marginTop: '1px' }} /> : <CheckCircle size={14} style={{ flexShrink: 0, marginTop: '1px' }} />}
      {msg}
    </div>
  );
}

function SaveBtn({ loading, onClick, label: lbl = 'Guardar cambios', colors }) {
  return (
    <button onClick={onClick} disabled={loading}
      style={{ padding: '11px', borderRadius: '8px', fontSize: '14px', fontWeight: 600, backgroundColor: loading ? colors.borderStrong : colors.green, color: 'white', border: 'none', cursor: loading ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', width: '100%' }}>
      {loading ? <Loader size={15} style={{ animation: 'spin 1s linear infinite' }} /> : <Save size={15} />}
      {loading ? 'Guardando...' : lbl}
    </button>
  );
}

/* ══════════════════════════════════════════════
   TAB SHOPIFY
══════════════════════════════════════════════ */
function ShopifyTab() {
  const { colors } = useTheme();
  const [status, setStatus]       = useState(null);
  const [statusLoading, setStatusLoading] = useState(true);   // ← mientras carga el estado real
  const [shopInput, setShopInput] = useState('');
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState('');
  const [success, setSuccess]     = useState('');

  const card = {
    backgroundColor: colors.bgPanel, borderRadius: '14px',
    border: `1px solid ${colors.border}`, overflow: 'hidden',
  };
  const inp = {
    width: '100%', backgroundColor: colors.bgApp, border: `1px solid ${colors.borderStrong}`,
    borderRadius: '8px', padding: '10px 14px', color: colors.textPrimary, fontSize: '14px',
    outline: 'none', boxSizing: 'border-box',
  };

  useEffect(() => {
    setupAPI.shopifyStatus().then(r => {
      setStatus(r);
      if (r.shop) setShopInput(r.shop.replace('.myshopify.com', ''));
    }).catch(() => {}).finally(() => setStatusLoading(false));

    // Detectar retorno del OAuth de Shopify
    const params = new URLSearchParams(window.location.search);
    if (params.get('shopify_success') === '1') {
      const shop = params.get('shop') || '';
      window.history.replaceState({}, '', window.location.pathname);
      setSuccess(`✅ Shopify conectado: ${shop}`);
      setupAPI.shopifyStatus().then(setStatus).catch(() => {});
    }
    if (params.get('shopify_error')) {
      window.history.replaceState({}, '', window.location.pathname);
      setError('Error conectando Shopify: ' + decodeURIComponent(params.get('shopify_error')));
    }
  }, []);

  const connectOAuth = async () => {
    if (!shopInput.trim()) { setError('Ingresa el dominio de tu tienda'); return; }
    setLoading(true); setError('');
    try {
      const { api } = await import('../utils/api.js');
      const shop = shopInput.trim().replace(/^https?:\/\//, '').replace(/\.myshopify\.com.*/, '').replace(/\/$/, '');
      const { data } = await api.get('/shopify-oauth/auth-url', { params: { shop } });
      if (data.url) {
        window.location.href = data.url;
      } else {
        setError(data.error || 'No se pudo generar la URL de Shopify');
        setLoading(false);
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Error al conectar con Shopify');
      setLoading(false);
    }
  };

  const disconnect = async () => {
    if (!window.confirm('¿Desconectar Shopify? El bot dejará de tener acceso a productos y clientes.')) return;
    try {
      const { api } = await import('../utils/api.js');
      await api.delete('/shopify-oauth/disconnect');
      setStatus({ connected: false });
      setSuccess('Shopify desconectado.');
    } catch (err) {
      setError('Error al desconectar: ' + (err.response?.data?.error || err.message));
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div style={card}>
        <div style={{ padding: '16px 22px', borderBottom: `1px solid ${colors.border}`, display: 'flex', alignItems: 'center', gap: '10px' }}>
          <ShoppingBag size={17} color={colors.green} />
          <span style={{ color: colors.textPrimary, fontSize: '15px', fontWeight: 600 }}>Tienda Shopify</span>
          {!statusLoading && <Badge ok={status?.connected} colors={colors} />}
        </div>
        <div style={{ padding: '20px 22px', display: 'flex', flexDirection: 'column', gap: '14px' }}>

          {/* Cargando estado */}
          {statusLoading ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '14px 0', color: colors.textSecondary, fontSize: '13px' }}>
              <Loader size={15} style={{ animation: 'spin 1s linear infinite', flexShrink: 0 }} />
              Verificando conexión con Shopify...
            </div>
          ) : /* Conectado */ status?.connected ? (
            <>
              <div style={{ backgroundColor: colors.bgAccent, borderRadius: '8px', padding: '12px 16px', border: `1px solid ${colors.green}`, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <CheckCircle size={16} color={colors.green} />
                  <div>
                    <div style={{ color: colors.green, fontSize: '13px', fontWeight: 600 }}>Shopify conectado</div>
                    <div style={{ color: colors.textSecondary, fontSize: '12px', marginTop: '1px' }}>{status.shop}</div>
                  </div>
                </div>
                <button
                  onClick={disconnect}
                  style={{ backgroundColor: colors.bgHover, color: colors.textSecondary, border: `1px solid ${colors.borderStrong}`, borderRadius: '6px', padding: '5px 12px', fontSize: '12px', cursor: 'pointer' }}>
                  Desconectar
                </button>
              </div>
              <div style={{ backgroundColor: colors.bgApp, borderRadius: '8px', padding: '12px 14px', fontSize: '12px', color: colors.textSecondary, lineHeight: 1.7 }}>
                Para cambiar de tienda, desconecta primero y vuelve a conectar.
              </div>
            </>
          ) : (
            /* No conectado — flujo OAuth */
            <>
              <div style={{ backgroundColor: colors.bgApp, borderRadius: '8px', padding: '12px 14px', fontSize: '12px', color: colors.textSecondary, lineHeight: 1.7 }}>
                🔐 Conexión segura vía Shopify OAuth — sin tokens manuales. El acceso no expira salvo que lo revoques desde tu panel de Shopify.
              </div>
              <div>
                <label style={{ fontSize: '13px', color: colors.textPrimary, fontWeight: 500, marginBottom: '6px', display: 'block' }}>
                  Dominio de tu tienda
                </label>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <input
                    style={{ flex: 1, backgroundColor: colors.bgApp, border: `1px solid ${colors.borderStrong}`, borderRadius: '8px', padding: '10px 14px', color: colors.textPrimary, fontSize: '14px', outline: 'none', boxSizing: 'border-box' }}
                    value={shopInput}
                    onChange={e => setShopInput(e.target.value)}
                    placeholder="mi-tienda"
                    onKeyDown={e => e.key === 'Enter' && connectOAuth()}
                  />
                  <span style={{ color: colors.textMuted, fontSize: '13px', whiteSpace: 'nowrap', flexShrink: 0 }}>.myshopify.com</span>
                </div>
              </div>
              <button
                onClick={connectOAuth}
                disabled={loading || !shopInput.trim()}
                style={{ padding: '12px', borderRadius: '9px', fontSize: '14px', fontWeight: 600, backgroundColor: (!shopInput.trim() || loading) ? colors.borderStrong : colors.green, color: 'white', cursor: (!shopInput.trim() || loading) ? 'not-allowed' : 'pointer', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
                🛍️ Conectar con Shopify
                <ExternalLink size={14} />
              </button>
            </>
          )}

          {error   && <Alert type="error"   msg={error}   colors={colors} />}
          {success && <Alert type="success" msg={success} colors={colors} />}
        </div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════
   KAPSO RECONNECT PANEL
══════════════════════════════════════════════ */
function KapsoReconnectPanel({ colors }) {
  const [connecting, setConnecting] = useState(false);
  const [error, setError]           = useState('');

  const reconnect = async () => {
    setConnecting(true); setError('');
    try {
      const r = await api.post('/setup/kapso/connect');
      if (r.data?.setupUrl) {
        window.location.href = r.data.setupUrl;
      } else {
        setError(r.data?.error || 'No se pudo generar el link de Kapso');
        setConnecting(false);
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Error al conectar con Kapso. ¿Está KAPSO_API_KEY configurada?');
      setConnecting(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      <div style={{ backgroundColor: colors.bgAccent, borderRadius: '8px', padding: '14px 16px', border: `1px solid ${colors.green}33` }}>
        <p style={{ color: colors.green, fontSize: '13px', margin: '0 0 8px', fontWeight: 600 }}>
          🚀 Conexión automática — sin escribir datos
        </p>
        <p style={{ color: colors.textSecondary, fontSize: '12px', margin: 0, lineHeight: 1.7 }}>
          Haz clic en el botón para reconectar o cambiar tu número de WhatsApp a través de Kapso. El proceso toma ~5 minutos con login de Facebook.
        </p>
      </div>

      <button
        onClick={reconnect}
        disabled={connecting}
        style={{
          width: '100%', padding: '14px', borderRadius: '9px', fontSize: '14px', fontWeight: 700,
          backgroundColor: connecting ? colors.borderStrong : colors.green,
          color: 'white', cursor: connecting ? 'not-allowed' : 'pointer',
          border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px',
        }}>
        {connecting
          ? <><Loader size={16} style={{ animation: 'spin 1s linear infinite' }} /> Abriendo Kapso...</>
          : <><Zap size={16} /> Reconectar WhatsApp con Kapso <ExternalLink size={14} /></>
        }
      </button>

      {error && <Alert type="error" msg={error} colors={colors} />}

      <p style={{ color: colors.textMuted, fontSize: '11px', textAlign: 'center', margin: 0 }}>
        Requiere <code style={{ color: colors.textMuted }}>KAPSO_API_KEY</code> en variables de entorno del backend.
      </p>
    </div>
  );
}

/* ══════════════════════════════════════════════
   TAB WHATSAPP
══════════════════════════════════════════════ */
function WhatsAppTab() {
  const { colors } = useTheme();
  const [provider,     setProvider]     = useState('meta');
  const [savedProvider, setSavedProvider] = useState(null); // proveedor activo en DB
  const [loading,      setLoading]      = useState(true);
  const [saving,       setSaving]       = useState(false);
  const [testing,      setTesting]      = useState(false);
  const [error,        setError]        = useState('');
  const [success,      setSuccess]      = useState('');
  const [testResult,   setTestResult]   = useState(null); // { ok, msg }

  // Meta fields
  const [phoneNumberId,      setPhoneNumberId]      = useState('');
  const [businessAccountId,  setBusinessAccountId]  = useState('');
  const [accessToken,        setAccessToken]        = useState('');
  const [webhookVerifyToken, setWebhookVerifyToken] = useState('');

  // Twilio fields
  const [twilioSid,   setTwilioSid]   = useState('');
  const [twilioToken, setTwilioToken] = useState('');
  const [twilioPhone, setTwilioPhone] = useState('');

  // Kapso fields
  const [kapsoApiKey,     setKapsoApiKey]     = useState('');
  const [kapsoPhoneId,    setKapsoPhoneId]    = useState('');
  const [kapsoWabaId,     setKapsoWabaId]     = useState('');  // WABA ID para templates
  const [webhookSecret,   setWebhookSecret]   = useState('');
  const [savingWabaId,    setSavingWabaId]    = useState(false);
  const [wabaIdSuccess,   setWabaIdSuccess]   = useState('');

  const card = {
    backgroundColor: colors.bgPanel, borderRadius: '14px',
    border: `1px solid ${colors.border}`, overflow: 'hidden',
  };

  const loadConfig = () => {
    api.get('/settings/whatsapp').then(r => {
      const d = r.data?.data;
      if (!d) return;
      setProvider(d.provider || 'meta');
      setSavedProvider(d.provider || null);
      setPhoneNumberId(d.phoneNumberId || '');
      setBusinessAccountId(d.businessAccountId || '');
      setAccessToken(d.accessToken || '');
      setWebhookVerifyToken(d.webhookVerifyToken || '');
      setTwilioSid(d.twilioAccountSid || '');
      setTwilioToken(d.twilioAuthToken || '');
      setTwilioPhone(d.twilioPhoneNumber || '');
      setKapsoApiKey(d.kapsoApiKey || '');
      setKapsoPhoneId(d.phoneNumberId || '');  // Kapso también usa phone_number_id
      setKapsoWabaId(d.businessAccountId || '');  // WABA ID para templates
      setWebhookSecret(d.webhookSecret || '');
    }).catch(() => {}).finally(() => setLoading(false));
  };

  useEffect(() => { loadConfig(); }, []);

  const save = async () => {
    setSaving(true); setError(''); setSuccess(''); setTestResult(null);
    try {
      const body = provider === 'twilio'
        ? { provider: 'twilio', twilioAccountSid: twilioSid, twilioAuthToken: twilioToken, twilioPhoneNumber: twilioPhone }
        : provider === 'kapso'
        ? { provider: 'kapso', kapsoApiKey, phoneNumberId: kapsoPhoneId, webhookSecret, businessAccountId: kapsoWabaId || null }
        : { provider: 'meta', phoneNumberId, businessAccountId, accessToken, webhookVerifyToken };
      const r = await api.put('/settings/whatsapp', body);
      if (r.data.success) {
        setSuccess('✅ ' + r.data.message);
        setSavedProvider(provider);
      } else {
        setError(r.data.error);
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Error al guardar');
    } finally { setSaving(false); }
  };

  // Guarda solo el WABA ID para Kapso (sin tocar el resto de la config)
  const saveWabaId = async () => {
    setSavingWabaId(true); setWabaIdSuccess(''); setError('');
    try {
      const r = await api.put('/settings/whatsapp', {
        provider: 'kapso',
        kapsoApiKey,
        phoneNumberId: kapsoPhoneId,
        webhookSecret,
        businessAccountId: kapsoWabaId || null,
      });
      if (r.data.success) {
        setWabaIdSuccess('✅ WABA ID guardado');
        setSavedProvider('kapso');
        setTimeout(() => setWabaIdSuccess(''), 3000);
      } else {
        setError(r.data.error);
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Error al guardar');
    } finally { setSavingWabaId(false); }
  };

  // Prueba enviando un GET al webhook propio para ver si responde
  const testConnection = async () => {
    setTesting(true); setTestResult(null);
    try {
      const r = await api.get('/settings/whatsapp/test');
      setTestResult({ ok: r.data.success, msg: r.data.message || r.data.error });
    } catch (err) {
      setTestResult({ ok: false, msg: err.response?.data?.error || 'No se pudo conectar al backend' });
    } finally { setTesting(false); }
  };

  if (loading) return (
    <div style={{ textAlign: 'center', padding: '60px', color: colors.textSecondary }}>
      <Loader size={24} style={{ animation: 'spin 1s linear infinite', margin: '0 auto' }} />
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

      {/* Estado actual */}
      {savedProvider && (
        <div style={{ backgroundColor: colors.bgAccent, border: `1px solid ${colors.green}33`, borderRadius: '10px', padding: '12px 16px', display: 'flex', alignItems: 'center', gap: '10px' }}>
          <CheckCircle size={16} color={colors.green} />
          <span style={{ color: colors.green, fontSize: '13px', fontWeight: 600 }}>
            Proveedor activo: {savedProvider === 'kapso' ? 'Kapso WhatsApp 🚀' : savedProvider === 'meta' ? 'WhatsApp Business (Meta)' : 'Twilio WhatsApp'}
          </span>
          <button onClick={testConnection} disabled={testing}
            style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '6px', backgroundColor: colors.bgSub, border: `1px solid ${colors.green}55`, borderRadius: '7px', padding: '5px 12px', color: colors.green, fontSize: '12px', cursor: testing ? 'not-allowed' : 'pointer' }}>
            {testing ? <Loader size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <Zap size={12} />}
            {testing ? 'Probando...' : 'Probar conexión'}
          </button>
        </div>
      )}

      {/* Resultado del test */}
      {testResult && (
        <Alert type={testResult.ok ? 'success' : 'error'} msg={testResult.ok ? '✅ ' + testResult.msg : '❌ ' + testResult.msg} colors={colors} />
      )}

      {/* Selector de proveedor */}
      <div style={card}>
        <div style={{ padding: '16px 22px', borderBottom: `1px solid ${colors.border}`, display: 'flex', alignItems: 'center', gap: '10px' }}>
          <MessageCircle size={17} color={colors.green} />
          <span style={{ color: colors.textPrimary, fontSize: '15px', fontWeight: 600 }}>Proveedor de mensajería</span>
          <span style={{ color: colors.textMuted, fontSize: '11px', marginLeft: 'auto' }}>Solo uno puede estar activo</span>
        </div>
        <div style={{ padding: '20px 22px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px' }}>
            {[
              { key: 'kapso',  icon: Zap,           title: 'Kapso',             desc: 'Sin proceso Meta · más fácil' },
              { key: 'meta',   icon: MessageCircle, title: 'WhatsApp Business', desc: 'API oficial de Meta' },
              { key: 'twilio', icon: Phone,         title: 'Twilio',            desc: 'Sandbox o número propio' },
            ].map(opt => (
              <button key={opt.key} onClick={() => setProvider(opt.key)}
                style={{
                  display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '5px',
                  padding: '14px', borderRadius: '10px', cursor: 'pointer', textAlign: 'left',
                  backgroundColor: provider === opt.key ? colors.bgAccent : colors.bgApp,
                  border: `2px solid ${provider === opt.key ? colors.green : colors.border}`,
                  transition: 'all 0.15s', position: 'relative',
                }}>
                {savedProvider && (
                  <span style={{
                    position: 'absolute', top: '7px', right: '7px',
                    fontSize: '9px', fontWeight: 700, padding: '2px 5px', borderRadius: '4px',
                    backgroundColor: savedProvider === opt.key ? `${colors.green}22` : '#2d1a1a',
                    color: savedProvider === opt.key ? colors.green : colors.red,
                  }}>
                    {savedProvider === opt.key ? 'ACTIVO' : 'INACTIVO'}
                  </span>
                )}
                <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
                  <opt.icon size={15} color={provider === opt.key ? colors.green : colors.textSecondary} />
                  <span style={{ color: provider === opt.key ? colors.green : colors.textPrimary, fontWeight: 600, fontSize: '12px' }}>
                    {opt.title}
                  </span>
                  {opt.key === 'kapso' && (
                    <span style={{ backgroundColor: `${colors.green}22`, color: colors.green, fontSize: '9px', padding: '1px 5px', borderRadius: '4px' }}>
                      Nuevo
                    </span>
                  )}
                </div>
                <span style={{ color: colors.textSecondary, fontSize: '10px', lineHeight: 1.4 }}>{opt.desc}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Campos según proveedor */}
      <div style={card}>
        <div style={{ padding: '16px 22px', borderBottom: `1px solid ${colors.border}`, display: 'flex', alignItems: 'center', gap: '10px' }}>
          {provider === 'kapso'
            ? <><Zap size={17} color={colors.green} /><span style={{ color: colors.textPrimary, fontSize: '15px', fontWeight: 600 }}>Configuración Kapso</span></>
            : provider === 'meta'
            ? <><MessageCircle size={17} color={colors.green} /><span style={{ color: colors.textPrimary, fontSize: '15px', fontWeight: 600 }}>Configuración Meta WhatsApp</span></>
            : <><Phone size={17} color={colors.green} /><span style={{ color: colors.textPrimary, fontSize: '15px', fontWeight: 600 }}>Configuración Twilio</span></>
          }
        </div>
        <div style={{ padding: '20px 22px', display: 'flex', flexDirection: 'column', gap: '14px' }}>

          {provider === 'kapso' ? (
            <>
              <KapsoReconnectPanel colors={colors} />

              {/* WABA ID — necesario para enviar templates */}
              <div style={{ marginTop: '4px', backgroundColor: colors.bgApp, borderRadius: '9px', padding: '14px 16px', border: `1px solid ${colors.border}` }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
                  <span style={{ color: colors.textPrimary, fontSize: '13px', fontWeight: 600 }}>WABA ID — para Templates WhatsApp</span>
                  <span style={{ backgroundColor: '#1a4060', color: '#4db6e8', fontSize: '10px', padding: '1px 6px', borderRadius: '4px', fontWeight: 600 }}>Templates</span>
                </div>
                <p style={{ color: colors.textSecondary, fontSize: '11px', margin: '0 0 10px', lineHeight: 1.6 }}>
                  El WhatsApp Business Account ID es necesario para listar y enviar templates cuando la ventana de 24h ha expirado.
                  Encuéntralo en <a href="https://app.kapso.ai" target="_blank" rel="noreferrer" style={{ color: '#4db6e8' }}>app.kapso.ai</a> → tu número → Account ID.
                </p>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <input
                    value={kapsoWabaId}
                    onChange={e => setKapsoWabaId(e.target.value)}
                    placeholder="123456789012345"
                    style={{
                      flex: 1, backgroundColor: colors.bgSub, color: colors.textPrimary,
                      border: `1px solid ${colors.border}`, borderRadius: '7px',
                      padding: '8px 12px', fontSize: '13px', outline: 'none',
                      fontFamily: 'monospace',
                    }}
                  />
                  <button
                    onClick={saveWabaId}
                    disabled={savingWabaId}
                    style={{
                      backgroundColor: '#1a4060', color: '#4db6e8',
                      border: '1px solid #1e5a80', borderRadius: '7px',
                      padding: '8px 14px', fontSize: '12px', fontWeight: 600,
                      cursor: savingWabaId ? 'not-allowed' : 'pointer',
                      flexShrink: 0, opacity: savingWabaId ? 0.7 : 1,
                      whiteSpace: 'nowrap',
                    }}>
                    {savingWabaId ? 'Guardando...' : 'Guardar'}
                  </button>
                </div>
                {wabaIdSuccess && <div style={{ color: colors.greenLight, fontSize: '12px', marginTop: '6px' }}>{wabaIdSuccess}</div>}
                {kapsoWabaId && (
                  <div style={{ color: colors.textMuted, fontSize: '11px', marginTop: '6px' }}>
                    ✓ WABA ID configurado — los templates están disponibles
                  </div>
                )}
              </div>
            </>
          ) : provider === 'meta' ? (
            <>
              <div style={{ backgroundColor: colors.bgApp, borderRadius: '8px', padding: '12px 14px', fontSize: '12px', color: colors.textSecondary, lineHeight: 1.7 }}>
                Obtén estos datos en{' '}
                <a href="https://developers.facebook.com/apps" target="_blank" rel="noreferrer" style={{ color: colors.green }}>Meta for Developers</a>
                {' '}→ tu app → WhatsApp → Configuración de la API.
              </div>
              <Field label="Phone Number ID *" value={phoneNumberId} onChange={setPhoneNumberId} placeholder="123456789012345" hint="ID numérico del número de WhatsApp registrado" colors={colors} />
              <Field label="Business Account ID" value={businessAccountId} onChange={setBusinessAccountId} placeholder="123456789012345" hint="ID de tu cuenta de WhatsApp Business (opcional)" colors={colors} />
              <Field label="Access Token *" value={accessToken} onChange={setAccessToken} placeholder="EAAxxxxx..." hint="Token de acceso permanente (usuario del sistema recomendado)" password colors={colors} />
              <Field label="Webhook Verify Token *" value={webhookVerifyToken} onChange={setWebhookVerifyToken} placeholder="mi_token_secreto" hint="Cadena que usas para verificar el webhook en Meta" password colors={colors} />
            </>
          ) : (
            <>
              <div style={{ backgroundColor: colors.bgApp, borderRadius: '8px', padding: '12px 14px', fontSize: '12px', color: colors.textSecondary, lineHeight: 1.7 }}>
                Obtén estos datos en{' '}
                <a href="https://console.twilio.com" target="_blank" rel="noreferrer" style={{ color: colors.green }}>console.twilio.com</a>
                {' '}→ Account Info. El número debe tener WhatsApp habilitado.
              </div>
              <Field label="Account SID *" value={twilioSid} onChange={setTwilioSid} placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" hint="Empieza con AC — en tu panel principal de Twilio" colors={colors} />
              <Field label="Auth Token *" value={twilioToken} onChange={setTwilioToken} placeholder="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" hint="Token de autenticación de tu cuenta Twilio" password colors={colors} />
              <Field label="Número WhatsApp Twilio *" value={twilioPhone} onChange={setTwilioPhone} placeholder="+14155238886" hint="Número con formato E.164 (+1 para sandbox, o tu número propio)" colors={colors} />
            </>
          )}

          {provider !== 'kapso' && <SaveBtn loading={saving} onClick={save} colors={colors} />}
          {error   && <Alert type="error"   msg={error}   colors={colors} />}
          {success && <Alert type="success" msg={success} colors={colors} />}
        </div>
      </div>

      {/* Info webhook — Meta y Twilio */}
      {(provider === 'meta' || provider === 'twilio') && (
        <div style={card}>
          <div style={{ padding: '16px 22px', borderBottom: `1px solid ${colors.border}`, display: 'flex', alignItems: 'center', gap: '10px' }}>
            <Zap size={17} color={colors.yellow} />
            <span style={{ color: colors.textPrimary, fontSize: '15px', fontWeight: 600 }}>URL del Webhook</span>
          </div>
          <div style={{ padding: '16px 22px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <p style={{ color: colors.textSecondary, fontSize: '12px', margin: 0 }}>
              {provider === 'meta'
                ? 'Configura esta URL en Meta for Developers → Webhooks → Suscripción al número:'
                : 'Configura esta URL en Twilio Dashboard → Messaging → Sandbox Settings → When a message comes in:'}
            </p>
            <div style={{ backgroundColor: colors.bgApp, borderRadius: '8px', padding: '10px 14px', fontFamily: 'monospace', fontSize: '12px', color: colors.green, wordBreak: 'break-all' }}>
              {window.location.origin.replace(':5173', ':3001')}{provider === 'twilio' ? '/twilio-webhook' : '/webhook'}
            </div>
            {provider === 'meta' && (
              <p style={{ color: colors.textMuted, fontSize: '11px', margin: 0 }}>
                Suscribirse a: <strong style={{ color: colors.textSecondary }}>messages</strong>
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════
   TAB IA & BOT
══════════════════════════════════════════════ */
function IATab({ onSwitchTab }) {
  const { colors, isDark } = useTheme();

  // Estado de conexiones (para tarjetas de acceso rápido)
  const [setupStatus,    setSetupStatus]    = useState(null);
  const [templateCount,  setTemplateCount]  = useState(null);

  // Configuración del bot
  const [aiEnabled,     setAiEnabled]     = useState(true);
  const [storeContext,  setStoreContext]   = useState('');
  const [extraPrompt,   setExtraPrompt]   = useState('');

  // Info de entrega estructurada
  const [schedule,       setSchedule]       = useState('');
  const [zone,           setZone]           = useState('');
  const [minimum,        setMinimum]        = useState('');
  const [paymentMethods, setPaymentMethods] = useState('');
  const [deliverySaved,  setDeliverySaved]  = useState(false);
  const deliveryTimer = useRef(null);

  const [loading,    setLoading]   = useState(true);
  const [syncing,    setSyncing]   = useState(false);
  const [syncMsg,    setSyncMsg]   = useState('');   // mensaje inline junto al botón
  const [ctxSaved,   setCtxSaved]  = useState(false);
  const [saving,     setSaving]    = useState(false);
  const [success,    setSuccess]   = useState('');
  const [error,      setError]     = useState('');
  const saveTimer  = useRef(null);
  const syncMsgTimer = useRef(null);

  const card = {
    backgroundColor: colors.bgPanel, borderRadius: '14px',
    border: `1px solid ${colors.border}`, overflow: 'hidden',
  };
  const inp = {
    width: '100%', backgroundColor: colors.bgApp, border: `1px solid ${colors.borderStrong}`,
    borderRadius: '8px', padding: '10px 14px', color: colors.textPrimary, fontSize: '14px',
    outline: 'none', boxSizing: 'border-box',
  };
  const labelStyle = { fontSize: '12px', fontWeight: 600, color: colors.textSecondary, marginBottom: '6px', display: 'block', textTransform: 'uppercase', letterSpacing: '0.4px' };
  const hintStyle  = { fontSize: '11px', color: colors.textMuted, margin: '5px 0 0', lineHeight: 1.5 };

  useEffect(() => {
    Promise.all([
      api.get('/settings'),
      reengagementAPI.getStoreContext(),
      setupAPI.shopifyStatus().catch(() => null),
      setupAPI.whatsappStatus().catch(() => null),
      reengagementAPI.getTemplates().catch(() => ({ data: [] })),
      reengagementAPI.getDeliveryInfo().catch(() => ({ info: {} })),
    ]).then(([settings, ctx, shopify, whatsapp, tpls, delivery]) => {
      const d = settings.data?.data;
      if (d) {
        setAiEnabled(d.ai_enabled_global !== false);
        setExtraPrompt(d.ai_system_prompt_extra || '');
      }
      setStoreContext(ctx.context || '');
      setSetupStatus({ shopify, whatsapp });
      setTemplateCount((tpls.data || []).length);
      const di = delivery.info || {};
      setSchedule(di.schedule || '');
      setZone(di.zone || '');
      setMinimum(di.minimum || '');
      setPaymentMethods(di.paymentMethods || '');
    }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  // Auto-guardar contexto en DB con debounce 1.5s
  const handleContextChange = (val) => {
    setStoreContext(val);
    setCtxSaved(false);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try { await reengagementAPI.saveStoreContext(val); setCtxSaved(true); setTimeout(() => setCtxSaved(false), 2500); }
      catch {}
    }, 1500);
  };

  // Auto-guardar delivery info con debounce 1s
  const handleDeliveryChange = (field, val) => {
    const setters = { schedule: setSchedule, zone: setZone, minimum: setMinimum, paymentMethods: setPaymentMethods };
    setters[field]?.(val);
    setDeliverySaved(false);
    if (deliveryTimer.current) clearTimeout(deliveryTimer.current);
    deliveryTimer.current = setTimeout(async () => {
      const current = { schedule, zone, minimum, paymentMethods, [field]: val };
      try {
        await reengagementAPI.saveDeliveryInfo(current);
        setDeliverySaved(true);
        setTimeout(() => setDeliverySaved(false), 2500);
      } catch {}
    }, 1000);
  };

  const showSyncMsg = (msg, isErr = false) => {
    if (syncMsgTimer.current) clearTimeout(syncMsgTimer.current);
    setSyncMsg({ text: msg, err: isErr });
    syncMsgTimer.current = setTimeout(() => setSyncMsg(''), 4000);
  };

  const syncFromShopify = async () => {
    setSyncing(true);
    setSyncMsg('');
    try {
      const res = await reengagementAPI.syncStoreContext();
      // Always update textarea — even if empty, so the user sees sync ran
      setStoreContext(res.context ?? '');
      if (res.context) {
        showSyncMsg('✓ Contexto actualizado desde Shopify');
      } else {
        showSyncMsg('Shopify no devolvió contenido — verifica que tengas páginas publicadas', true);
      }
    } catch (err) {
      const detail = err.response?.data?.error || err.message || 'Error desconocido';
      showSyncMsg(`Error: ${detail}`, true);
      setError(`Error sincronizando desde Shopify: ${detail}`);
    } finally {
      setSyncing(false);
    }
  };

  const save = async () => {
    setSaving(true); setError(''); setSuccess('');
    try {
      await Promise.all([
        api.put('/settings', { ai_enabled_global: aiEnabled, ai_system_prompt_extra: extraPrompt }),
        reengagementAPI.saveStoreContext(storeContext),
        reengagementAPI.saveDeliveryInfo({ schedule, zone, minimum, paymentMethods }),
      ]);
      setSuccess('✅ Configuración guardada correctamente');
    } catch (err) {
      setError(err.response?.data?.error || 'Error al guardar');
    } finally { setSaving(false); }
  };

  if (loading) return (
    <div style={{ textAlign: 'center', padding: '60px', color: colors.textSecondary }}>
      <Loader size={24} style={{ animation: 'spin 1s linear infinite', margin: '0 auto' }} />
    </div>
  );

  const shopifyOk = setupStatus?.shopify?.connected;
  const waOk      = setupStatus?.whatsapp?.connected;

  /* ── Tarjetas de acceso rápido ─────────────────────────────── */
  const quickCards = [
    {
      key:   'shopify',
      icon:  ShoppingBag,
      label: 'Tienda Shopify',
      desc:  shopifyOk ? (setupStatus?.shopify?.storeName || setupStatus?.shopify?.storeUrl || 'Conectada') : 'Sin conectar',
      ok:    shopifyOk,
      color: '#96bf48',
    },
    {
      key:   'whatsapp',
      icon:  MessageCircle,
      label: 'WhatsApp',
      desc:  waOk ? (setupStatus?.whatsapp?.provider ? `via ${setupStatus.whatsapp.provider}` : 'Conectado') : 'Sin conectar',
      ok:    waOk,
      color: '#25d366',
    },
    {
      key:   'templates',
      icon:  FileText,
      label: 'Templates',
      desc:  templateCount !== null ? `${templateCount} aprobado${templateCount !== 1 ? 's' : ''}` : 'Ver templates',
      ok:    templateCount > 0,
      color: colors.purple,
    },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

      {/* ── Acceso rápido ─────────────────────────────────────── */}
      <div style={card}>
        <div style={{ padding: '14px 20px', borderBottom: `1px solid ${colors.border}`, display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Zap size={15} color={colors.yellow} />
          <span style={{ color: colors.textPrimary, fontSize: '14px', fontWeight: 600 }}>Configuración rápida</span>
          <span style={{ marginLeft: 4, color: colors.textMuted, fontSize: '12px' }}>— conecta los servicios que necesita el agente</span>
        </div>
        <div style={{ padding: '16px 20px', display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '10px' }}>
          {quickCards.map(c => (
            <button key={c.key} onClick={() => onSwitchTab(c.key)}
              style={{
                backgroundColor: colors.bgApp, border: `1px solid ${c.ok ? c.color + '55' : colors.border}`,
                borderRadius: '12px', padding: '14px 12px', cursor: 'pointer', textAlign: 'left',
                display: 'flex', flexDirection: 'column', gap: '8px',
                transition: 'border-color 0.15s, box-shadow 0.15s',
              }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = c.color; e.currentTarget.style.boxShadow = `0 0 0 3px ${c.color}22`; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = c.ok ? c.color + '55' : colors.border; e.currentTarget.style.boxShadow = 'none'; }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={{ width: '30px', height: '30px', borderRadius: '8px', backgroundColor: c.color + '22', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <c.icon size={15} color={c.color} />
                </div>
                {c.ok !== null && c.ok !== undefined && (
                  <span style={{ fontSize: '10px', fontWeight: 700, padding: '2px 7px', borderRadius: '20px',
                    backgroundColor: c.ok ? colors.bgAccent : isDark ? '#2d1a1a' : '#fff3f3',
                    color: c.ok ? colors.green : colors.red, border: `1px solid ${c.ok ? colors.green + '44' : colors.red + '44'}` }}>
                    {c.ok ? '✓ OK' : '!'}
                  </span>
                )}
              </div>
              <div>
                <div style={{ fontSize: '13px', fontWeight: 600, color: colors.textPrimary, marginBottom: '2px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  {c.label} <ArrowRight size={11} color={colors.textMuted} />
                </div>
                <div style={{ fontSize: '11px', color: colors.textMuted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.desc}</div>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* ── Agente IA ──────────────────────────────────────────── */}
      <div style={card}>
        <div style={{ padding: '14px 20px', borderBottom: `1px solid ${colors.border}`, display: 'flex', alignItems: 'center', gap: '8px' }}>
          <Brain size={15} color={colors.green} />
          <span style={{ color: colors.textPrimary, fontSize: '14px', fontWeight: 600 }}>Agente IA</span>
        </div>
        <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '18px' }}>

          {/* Toggle IA global */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', backgroundColor: colors.bgApp, borderRadius: '10px', padding: '14px 16px' }}>
            <div>
              <div style={{ color: colors.textPrimary, fontSize: '14px', fontWeight: 600 }}>IA activada globalmente</div>
              <div style={{ color: colors.textSecondary, fontSize: '12px', marginTop: '2px' }}>El bot responde automáticamente a nuevos mensajes de WhatsApp</div>
            </div>
            <button onClick={() => setAiEnabled(v => !v)}
              style={{ width: '44px', height: '24px', borderRadius: '12px', border: 'none', cursor: 'pointer',
                backgroundColor: aiEnabled ? colors.green : colors.borderStrong,
                position: 'relative', transition: 'background-color 0.2s', flexShrink: 0 }}>
              <span style={{ position: 'absolute', top: '2px', left: aiEnabled ? '22px' : '2px',
                width: '20px', height: '20px', borderRadius: '50%', backgroundColor: 'white', transition: 'left 0.2s' }} />
            </button>
          </div>

          {/* ── Info de entrega estructurada ──────────────────────── */}
          <div style={{ backgroundColor: colors.bgApp, borderRadius: '12px', padding: '16px', border: `1px solid ${colors.border}` }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
                <span style={{ fontSize: '13px' }}>🚚</span>
                <span style={{ color: colors.textPrimary, fontSize: '13px', fontWeight: 700 }}>Información de entrega</span>
              </div>
              {deliverySaved && (
                <span style={{ fontSize: '11px', color: colors.green }}>✓ Guardado</span>
              )}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              {/* Horarios */}
              <div>
                <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: '5px' }}>
                  <Clock size={11} color={colors.textMuted} /> Horarios de entrega
                </label>
                <input
                  value={schedule}
                  onChange={e => handleDeliveryChange('schedule', e.target.value)}
                  placeholder="Lun–Vie 9am–6pm, Sáb 9am–1pm"
                  style={{ ...inp, borderColor: schedule ? `${colors.green}44` : colors.borderStrong }}
                />
              </div>
              {/* Zona */}
              <div>
                <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: '5px' }}>
                  <MapPin size={11} color={colors.textMuted} /> Zona de reparto
                </label>
                <input
                  value={zone}
                  onChange={e => handleDeliveryChange('zone', e.target.value)}
                  placeholder="Santiago centro, Providencia, Ñuñoa"
                  style={{ ...inp, borderColor: zone ? `${colors.green}44` : colors.borderStrong }}
                />
              </div>
              {/* Mínimo */}
              <div>
                <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: '5px' }}>
                  <DollarSign size={11} color={colors.textMuted} /> Pedido mínimo
                </label>
                <input
                  value={minimum}
                  onChange={e => handleDeliveryChange('minimum', e.target.value)}
                  placeholder="$15.000 o sin mínimo"
                  style={{ ...inp, borderColor: minimum ? `${colors.green}44` : colors.borderStrong }}
                />
              </div>
              {/* Métodos de pago */}
              <div>
                <label style={{ ...labelStyle, display: 'flex', alignItems: 'center', gap: '5px' }}>
                  <CreditCard size={11} color={colors.textMuted} /> Métodos de pago
                </label>
                <input
                  value={paymentMethods}
                  onChange={e => handleDeliveryChange('paymentMethods', e.target.value)}
                  placeholder="Transferencia, efectivo, Webpay"
                  style={{ ...inp, borderColor: paymentMethods ? `${colors.green}44` : colors.borderStrong }}
                />
              </div>
            </div>
            <p style={{ ...hintStyle, marginTop: '10px' }}>
              El bot usa estos datos para responder preguntas de clientes sobre entregas y pagos. Se guardan automáticamente.
            </p>
          </div>

          {/* Contexto de la tienda */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
              <label style={labelStyle}>Contexto de la tienda</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                {ctxSaved && !syncMsg && <span style={{ fontSize: '11px', color: colors.green }}>✓ Guardado</span>}
                {syncMsg && (
                  <span style={{ fontSize: '11px', color: syncMsg.err ? colors.red : colors.green, maxWidth: '260px', textAlign: 'right' }}>
                    {syncMsg.text}
                  </span>
                )}
                <button onClick={syncFromShopify} disabled={syncing}
                  style={{ background: 'none', border: `1px solid ${colors.border}`, borderRadius: '6px', padding: '4px 9px',
                    cursor: syncing ? 'not-allowed' : 'pointer', color: syncing ? colors.textMuted : colors.textSecondary,
                    fontSize: '11px', display: 'flex', alignItems: 'center', gap: '4px', opacity: syncing ? 0.7 : 1,
                    whiteSpace: 'nowrap', flexShrink: 0 }}>
                  <RefreshCw size={11} style={{ animation: syncing ? 'spin 1s linear infinite' : 'none' }} />
                  {syncing ? 'Sincronizando...' : 'Recargar desde Shopify'}
                </button>
              </div>
            </div>
            <textarea
              value={storeContext}
              onChange={e => handleContextChange(e.target.value)}
              rows={8}
              placeholder="Carga el contexto desde Shopify con el botón de arriba, o escribe aquí información sobre tu tienda: nombre, productos, horarios de entrega, zona de reparto, mínimo de pedido, formas de pago..."
              style={{ ...inp, resize: 'vertical', lineHeight: 1.55, fontFamily: 'inherit',
                borderColor: storeContext.trim() ? colors.green + '55' : colors.borderStrong }}
            />
            <p style={hintStyle}>
              El agente usa este contexto para responder preguntas sobre tu tienda, productos, políticas y entregas.
              Se sincroniza automáticamente desde tus páginas de Shopify (Sobre nosotros, FAQ, Políticas de envío, etc.)
            </p>
          </div>

          {/* Instrucciones adicionales */}
          <div>
            <label style={labelStyle}>Instrucciones adicionales</label>
            <textarea
              value={extraPrompt}
              onChange={e => setExtraPrompt(e.target.value)}
              rows={4}
              placeholder="Reglas específicas para el bot. Ej: Nunca ofrecer descuentos sin aprobación previa. Siempre confirmar disponibilidad antes de cerrar una venta. Saludar por el nombre del cliente."
              style={{ ...inp, resize: 'vertical', lineHeight: 1.55, fontFamily: 'inherit' }}
            />
            <p style={hintStyle}>Reglas de comportamiento y restricciones que el bot debe seguir siempre.</p>
          </div>

          <SaveBtn loading={saving} onClick={save} colors={colors} />
          {error   && <Alert type="error"   msg={error}   colors={colors} />}
          {success && <Alert type="success" msg={success} colors={colors} />}
        </div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════
   PANEL PRINCIPAL
══════════════════════════════════════════════ */
export default function SettingsPanel({ successMessage, onClearMessage }) {
  const { colors } = useTheme();
  const [activeTab, setActiveTab] = useState('shopify');

  useEffect(() => {
    if (successMessage) onClearMessage?.();
  }, [successMessage]);

  return (
    <div style={{ flex: 1, backgroundColor: colors.bgApp, overflowY: 'auto', padding: '28px 32px' }}>
      <div style={{ maxWidth: '640px', margin: '0 auto' }}>

        {/* Título */}
        <div style={{ marginBottom: '24px' }}>
          <h1 style={{ color: colors.textPrimary, fontSize: '20px', fontWeight: 700, margin: 0 }}>⚙️ Ajustes</h1>
          <p style={{ color: colors.textSecondary, fontSize: '13px', marginTop: '4px' }}>Configura las conexiones y el comportamiento del CRM</p>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', backgroundColor: colors.bgApp, borderRadius: '10px', padding: '4px', marginBottom: '24px', gap: '2px' }}>
          {TABS.map(t => (
            <button key={t.key} onClick={() => setActiveTab(t.key)}
              style={{
                flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '7px',
                padding: '9px', borderRadius: '8px', border: 'none', cursor: 'pointer',
                backgroundColor: activeTab === t.key ? colors.bgPanel : 'transparent',
                color: activeTab === t.key ? colors.textPrimary : colors.textSecondary,
                fontSize: '13px', fontWeight: activeTab === t.key ? 600 : 400,
                transition: 'all 0.15s',
              }}>
              <t.icon size={14} />
              {t.label}
            </button>
          ))}
        </div>

        {/* Contenido del tab */}
        {activeTab === 'shopify'   && <ShopifyTab />}
        {activeTab === 'whatsapp'  && <WhatsAppTab />}
        {activeTab === 'ia'        && <IATab onSwitchTab={setActiveTab} />}
        {activeTab === 'templates' && (
          <div style={{ padding: '20px 24px' }}>
            <div style={{ marginBottom: '16px' }}>
              <h2 style={{ color: colors.textPrimary, fontSize: '17px', fontWeight: 700, margin: '0 0 4px' }}>
                WhatsApp Templates
              </h2>
              <p style={{ color: colors.textSecondary, fontSize: '12px', margin: 0 }}>
                Crea y gestiona templates pre-aprobados por Meta. Son la única forma de contactar clientes cuya ventana de 24h ha expirado.
              </p>
            </div>
            <TemplateManager />
          </div>
        )}
      </div>

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
