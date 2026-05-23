/**
 * SettingsPanel — Ajustes del CRM
 * Tabs: Shopify · WhatsApp · IA
 */

import { useState, useEffect } from 'react';
import {
  CheckCircle, AlertCircle, ExternalLink, Loader,
  ShoppingBag, RefreshCw, MessageCircle, Phone, Brain,
  Eye, EyeOff, Save, Zap,
} from 'lucide-react';
import { setupAPI, api } from '../utils/api.js';

const TABS = [
  { key: 'shopify',   label: 'Shopify',    icon: ShoppingBag },
  { key: 'whatsapp',  label: 'WhatsApp',   icon: MessageCircle },
  { key: 'ia',        label: 'IA & Bot',   icon: Brain },
];

/* ── helpers de estilo ── */
const card = {
  backgroundColor: '#202c33', borderRadius: '14px',
  border: '1px solid #2a3942', overflow: 'hidden',
};
const cardHeader = (icon, title, badge) => ({
  padding: '16px 22px', borderBottom: '1px solid #2a3942',
  display: 'flex', alignItems: 'center', gap: '10px',
});
const inp = {
  width: '100%', backgroundColor: '#111b21', border: '1px solid #374045',
  borderRadius: '8px', padding: '10px 14px', color: '#e9edef', fontSize: '14px',
  outline: 'none', boxSizing: 'border-box',
};
const label = { fontSize: '12px', color: '#8696a0', marginBottom: '5px', display: 'block' };
const hint  = { fontSize: '11px', color: '#4a5568', margin: '4px 0 0' };

function Field({ label: lbl, hint: h, type = 'text', value, onChange, placeholder, password }) {
  const [show, setShow] = useState(false);
  return (
    <div>
      <label style={label}>{lbl}</label>
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
            style={{ position: 'absolute', right: '10px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: '#8696a0', padding: 0 }}>
            {show ? <EyeOff size={15} /> : <Eye size={15} />}
          </button>
        )}
      </div>
      {h && <p style={hint}>{h}</p>}
    </div>
  );
}

function Badge({ ok }) {
  return ok
    ? <span style={{ marginLeft: 'auto', backgroundColor: '#0d2e25', color: '#00a884', fontSize: '11px', padding: '3px 10px', borderRadius: '20px', border: '1px solid #00a88455' }}>✓ Conectado</span>
    : <span style={{ marginLeft: 'auto', backgroundColor: '#2d1a1a', color: '#e57373',  fontSize: '11px', padding: '3px 10px', borderRadius: '20px', border: '1px solid #5c262655' }}>Sin configurar</span>;
}

function Alert({ type, msg }) {
  const isErr = type === 'error';
  return (
    <div style={{ backgroundColor: isErr ? '#2d1a1a' : '#0d2e25', border: `1px solid ${isErr ? '#5c2626' : '#00a884'}`, borderRadius: '8px', padding: '10px 14px', color: isErr ? '#e57373' : '#00a884', fontSize: '13px', display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
      {isErr ? <AlertCircle size={14} style={{ flexShrink: 0, marginTop: '1px' }} /> : <CheckCircle size={14} style={{ flexShrink: 0, marginTop: '1px' }} />}
      {msg}
    </div>
  );
}

function SaveBtn({ loading, onClick, label: lbl = 'Guardar cambios' }) {
  return (
    <button onClick={onClick} disabled={loading}
      style={{ padding: '11px', borderRadius: '8px', fontSize: '14px', fontWeight: 600, backgroundColor: loading ? '#374045' : '#00a884', color: 'white', border: 'none', cursor: loading ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', width: '100%' }}>
      {loading ? <Loader size={15} style={{ animation: 'spin 1s linear infinite' }} /> : <Save size={15} />}
      {loading ? 'Guardando...' : lbl}
    </button>
  );
}

/* ══════════════════════════════════════════════
   TAB SHOPIFY
══════════════════════════════════════════════ */
function ShopifyTab() {
  const [status, setStatus]   = useState(null);
  const [shopInput, setShopInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');
  const [success, setSuccess] = useState('');

  useEffect(() => {
    setupAPI.shopifyStatus().then(r => {
      setStatus(r);
      if (r.shop) setShopInput(r.shop.replace('.myshopify.com', ''));
    }).catch(() => {});

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

  const connectOAuth = () => {
    if (!shopInput.trim()) { setError('Ingresa el dominio de tu tienda'); return; }
    setLoading(true); setError('');
    const backendUrl = import.meta.env.VITE_API_URL || window.location.origin.replace(':5173', ':3001');
    const token = localStorage.getItem('crm_token') || sessionStorage.getItem('crm_token') || '';
    const shop  = shopInput.trim().replace(/^https?:\/\//, '').replace(/\.myshopify\.com.*/, '').replace(/\/$/, '');
    window.location.href = `${backendUrl}/shopify-oauth/connect?shop=${encodeURIComponent(shop)}&_token=${encodeURIComponent(token)}`;
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
        <div style={{ padding: '16px 22px', borderBottom: '1px solid #2a3942', display: 'flex', alignItems: 'center', gap: '10px' }}>
          <ShoppingBag size={17} color="#00a884" />
          <span style={{ color: '#e9edef', fontSize: '15px', fontWeight: 600 }}>Tienda Shopify</span>
          <Badge ok={status?.connected} />
        </div>
        <div style={{ padding: '20px 22px', display: 'flex', flexDirection: 'column', gap: '14px' }}>

          {/* Conectado */}
          {status?.connected ? (
            <>
              <div style={{ backgroundColor: '#0d2e25', borderRadius: '8px', padding: '12px 16px', border: '1px solid #00a884', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <CheckCircle size={16} color="#00a884" />
                  <div>
                    <div style={{ color: '#00a884', fontSize: '13px', fontWeight: 600 }}>Shopify conectado</div>
                    <div style={{ color: '#8696a0', fontSize: '12px', marginTop: '1px' }}>{status.shop}</div>
                  </div>
                </div>
                <button
                  onClick={disconnect}
                  style={{ backgroundColor: '#2a3942', color: '#8696a0', border: '1px solid #374045', borderRadius: '6px', padding: '5px 12px', fontSize: '12px', cursor: 'pointer' }}>
                  Desconectar
                </button>
              </div>
              <div style={{ backgroundColor: '#111b21', borderRadius: '8px', padding: '12px 14px', fontSize: '12px', color: '#8696a0', lineHeight: 1.7 }}>
                Para cambiar de tienda, desconecta primero y vuelve a conectar.
              </div>
            </>
          ) : (
            /* No conectado — flujo OAuth */
            <>
              <div style={{ backgroundColor: '#111b21', borderRadius: '8px', padding: '12px 14px', fontSize: '12px', color: '#8696a0', lineHeight: 1.7 }}>
                🔐 Conexión segura vía Shopify OAuth — sin tokens manuales. El acceso no expira salvo que lo revoques desde tu panel de Shopify.
              </div>
              <div>
                <label style={{ fontSize: '13px', color: '#e9edef', fontWeight: 500, marginBottom: '6px', display: 'block' }}>
                  Dominio de tu tienda
                </label>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  <input
                    style={{ flex: 1, backgroundColor: '#111b21', border: '1px solid #374045', borderRadius: '8px', padding: '10px 14px', color: '#e9edef', fontSize: '14px', outline: 'none', boxSizing: 'border-box' }}
                    value={shopInput}
                    onChange={e => setShopInput(e.target.value)}
                    placeholder="mi-tienda"
                    onKeyDown={e => e.key === 'Enter' && connectOAuth()}
                  />
                  <span style={{ color: '#556169', fontSize: '13px', whiteSpace: 'nowrap', flexShrink: 0 }}>.myshopify.com</span>
                </div>
              </div>
              <button
                onClick={connectOAuth}
                disabled={loading || !shopInput.trim()}
                style={{ padding: '12px', borderRadius: '9px', fontSize: '14px', fontWeight: 600, backgroundColor: (!shopInput.trim() || loading) ? '#374045' : '#00a884', color: 'white', cursor: (!shopInput.trim() || loading) ? 'not-allowed' : 'pointer', border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}>
                🛍️ Conectar con Shopify
                <ExternalLink size={14} />
              </button>
            </>
          )}

          {error   && <Alert type="error"   msg={error} />}
          {success && <Alert type="success" msg={success} />}
        </div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════
   KAPSO RECONNECT PANEL
══════════════════════════════════════════════ */
function KapsoReconnectPanel() {
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
      <div style={{ backgroundColor: '#0d2e25', borderRadius: '8px', padding: '14px 16px', border: '1px solid #00a88433' }}>
        <p style={{ color: '#00a884', fontSize: '13px', margin: '0 0 8px', fontWeight: 600 }}>
          🚀 Conexión automática — sin escribir datos
        </p>
        <p style={{ color: '#8696a0', fontSize: '12px', margin: 0, lineHeight: 1.7 }}>
          Haz clic en el botón para reconectar o cambiar tu número de WhatsApp a través de Kapso. El proceso toma ~5 minutos con login de Facebook.
        </p>
      </div>

      <button
        onClick={reconnect}
        disabled={connecting}
        style={{
          width: '100%', padding: '14px', borderRadius: '9px', fontSize: '14px', fontWeight: 700,
          backgroundColor: connecting ? '#374045' : '#00a884',
          color: 'white', cursor: connecting ? 'not-allowed' : 'pointer',
          border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px',
        }}>
        {connecting
          ? <><Loader size={16} style={{ animation: 'spin 1s linear infinite' }} /> Abriendo Kapso...</>
          : <><Zap size={16} /> Reconectar WhatsApp con Kapso <ExternalLink size={14} /></>
        }
      </button>

      {error && <Alert type="error" msg={error} />}

      <p style={{ color: '#556169', fontSize: '11px', textAlign: 'center', margin: 0 }}>
        Requiere <code style={{ color: '#556169' }}>KAPSO_API_KEY</code> en variables de entorno del backend.
      </p>
    </div>
  );
}

/* ══════════════════════════════════════════════
   TAB WHATSAPP
══════════════════════════════════════════════ */
function WhatsAppTab() {
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
  const [webhookSecret,   setWebhookSecret]   = useState('');

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
        ? { provider: 'kapso', kapsoApiKey, phoneNumberId: kapsoPhoneId, webhookSecret }
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
    <div style={{ textAlign: 'center', padding: '60px', color: '#8696a0' }}>
      <Loader size={24} style={{ animation: 'spin 1s linear infinite', margin: '0 auto' }} />
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>

      {/* Estado actual */}
      {savedProvider && (
        <div style={{ backgroundColor: '#0d2e25', border: '1px solid #00a88433', borderRadius: '10px', padding: '12px 16px', display: 'flex', alignItems: 'center', gap: '10px' }}>
          <CheckCircle size={16} color="#00a884" />
          <span style={{ color: '#00a884', fontSize: '13px', fontWeight: 600 }}>
            Proveedor activo: {savedProvider === 'kapso' ? 'Kapso WhatsApp 🚀' : savedProvider === 'meta' ? 'WhatsApp Business (Meta)' : 'Twilio WhatsApp'}
          </span>
          <button onClick={testConnection} disabled={testing}
            style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '6px', backgroundColor: '#182820', border: '1px solid #00a88455', borderRadius: '7px', padding: '5px 12px', color: '#00a884', fontSize: '12px', cursor: testing ? 'not-allowed' : 'pointer' }}>
            {testing ? <Loader size={12} style={{ animation: 'spin 1s linear infinite' }} /> : <Zap size={12} />}
            {testing ? 'Probando...' : 'Probar conexión'}
          </button>
        </div>
      )}

      {/* Resultado del test */}
      {testResult && (
        <Alert type={testResult.ok ? 'success' : 'error'} msg={testResult.ok ? '✅ ' + testResult.msg : '❌ ' + testResult.msg} />
      )}

      {/* Selector de proveedor */}
      <div style={card}>
        <div style={{ padding: '16px 22px', borderBottom: '1px solid #2a3942', display: 'flex', alignItems: 'center', gap: '10px' }}>
          <MessageCircle size={17} color="#00a884" />
          <span style={{ color: '#e9edef', fontSize: '15px', fontWeight: 600 }}>Proveedor de mensajería</span>
          <span style={{ color: '#4a5568', fontSize: '11px', marginLeft: 'auto' }}>Solo uno puede estar activo</span>
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
                  backgroundColor: provider === opt.key ? '#0d2e25' : '#111b21',
                  border: `2px solid ${provider === opt.key ? '#00a884' : '#2a3942'}`,
                  transition: 'all 0.15s', position: 'relative',
                }}>
                {savedProvider && (
                  <span style={{
                    position: 'absolute', top: '7px', right: '7px',
                    fontSize: '9px', fontWeight: 700, padding: '2px 5px', borderRadius: '4px',
                    backgroundColor: savedProvider === opt.key ? '#00a88422' : '#2d1a1a',
                    color: savedProvider === opt.key ? '#00a884' : '#e57373',
                  }}>
                    {savedProvider === opt.key ? 'ACTIVO' : 'INACTIVO'}
                  </span>
                )}
                <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
                  <opt.icon size={15} color={provider === opt.key ? '#00a884' : '#8696a0'} />
                  <span style={{ color: provider === opt.key ? '#00a884' : '#e9edef', fontWeight: 600, fontSize: '12px' }}>
                    {opt.title}
                  </span>
                  {opt.key === 'kapso' && (
                    <span style={{ backgroundColor: '#00a88422', color: '#00a884', fontSize: '9px', padding: '1px 5px', borderRadius: '4px' }}>
                      Nuevo
                    </span>
                  )}
                </div>
                <span style={{ color: '#8696a0', fontSize: '10px', lineHeight: 1.4 }}>{opt.desc}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Campos según proveedor */}
      <div style={card}>
        <div style={{ padding: '16px 22px', borderBottom: '1px solid #2a3942', display: 'flex', alignItems: 'center', gap: '10px' }}>
          {provider === 'kapso'
            ? <><Zap size={17} color="#00a884" /><span style={{ color: '#e9edef', fontSize: '15px', fontWeight: 600 }}>Configuración Kapso</span></>
            : provider === 'meta'
            ? <><MessageCircle size={17} color="#00a884" /><span style={{ color: '#e9edef', fontSize: '15px', fontWeight: 600 }}>Configuración Meta WhatsApp</span></>
            : <><Phone size={17} color="#00a884" /><span style={{ color: '#e9edef', fontSize: '15px', fontWeight: 600 }}>Configuración Twilio</span></>
          }
        </div>
        <div style={{ padding: '20px 22px', display: 'flex', flexDirection: 'column', gap: '14px' }}>

          {provider === 'kapso' ? (
            <KapsoReconnectPanel />
          ) : provider === 'meta' ? (
            <>
              <div style={{ backgroundColor: '#111b21', borderRadius: '8px', padding: '12px 14px', fontSize: '12px', color: '#8696a0', lineHeight: 1.7 }}>
                Obtén estos datos en{' '}
                <a href="https://developers.facebook.com/apps" target="_blank" rel="noreferrer" style={{ color: '#00a884' }}>Meta for Developers</a>
                {' '}→ tu app → WhatsApp → Configuración de la API.
              </div>
              <Field label="Phone Number ID *" value={phoneNumberId} onChange={setPhoneNumberId} placeholder="123456789012345" hint="ID numérico del número de WhatsApp registrado" />
              <Field label="Business Account ID" value={businessAccountId} onChange={setBusinessAccountId} placeholder="123456789012345" hint="ID de tu cuenta de WhatsApp Business (opcional)" />
              <Field label="Access Token *" value={accessToken} onChange={setAccessToken} placeholder="EAAxxxxx..." hint="Token de acceso permanente (usuario del sistema recomendado)" password />
              <Field label="Webhook Verify Token *" value={webhookVerifyToken} onChange={setWebhookVerifyToken} placeholder="mi_token_secreto" hint="Cadena que usas para verificar el webhook en Meta" password />
            </>
          ) : (
            <>
              <div style={{ backgroundColor: '#111b21', borderRadius: '8px', padding: '12px 14px', fontSize: '12px', color: '#8696a0', lineHeight: 1.7 }}>
                Obtén estos datos en{' '}
                <a href="https://console.twilio.com" target="_blank" rel="noreferrer" style={{ color: '#00a884' }}>console.twilio.com</a>
                {' '}→ Account Info. El número debe tener WhatsApp habilitado.
              </div>
              <Field label="Account SID *" value={twilioSid} onChange={setTwilioSid} placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" hint="Empieza con AC — en tu panel principal de Twilio" />
              <Field label="Auth Token *" value={twilioToken} onChange={setTwilioToken} placeholder="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" hint="Token de autenticación de tu cuenta Twilio" password />
              <Field label="Número WhatsApp Twilio *" value={twilioPhone} onChange={setTwilioPhone} placeholder="+14155238886" hint="Número con formato E.164 (+1 para sandbox, o tu número propio)" />
            </>
          )}

          {provider !== 'kapso' && <SaveBtn loading={saving} onClick={save} />}
          {error   && <Alert type="error"   msg={error} />}
          {success && <Alert type="success" msg={success} />}
        </div>
      </div>

      {/* Info webhook — Meta y Twilio */}
      {(provider === 'meta' || provider === 'twilio') && (
        <div style={{ ...card }}>
          <div style={{ padding: '16px 22px', borderBottom: '1px solid #2a3942', display: 'flex', alignItems: 'center', gap: '10px' }}>
            <Zap size={17} color="#f0b429" />
            <span style={{ color: '#e9edef', fontSize: '15px', fontWeight: 600 }}>URL del Webhook</span>
          </div>
          <div style={{ padding: '16px 22px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <p style={{ color: '#8696a0', fontSize: '12px', margin: 0 }}>
              {provider === 'meta'
                ? 'Configura esta URL en Meta for Developers → Webhooks → Suscripción al número:'
                : 'Configura esta URL en Twilio Dashboard → Messaging → Sandbox Settings → When a message comes in:'}
            </p>
            <div style={{ backgroundColor: '#111b21', borderRadius: '8px', padding: '10px 14px', fontFamily: 'monospace', fontSize: '12px', color: '#00a884', wordBreak: 'break-all' }}>
              {window.location.origin.replace(':5173', ':3001')}{provider === 'twilio' ? '/twilio-webhook' : '/webhook'}
            </div>
            {provider === 'meta' && (
              <p style={{ color: '#4a5568', fontSize: '11px', margin: 0 }}>
                Suscribirse a: <strong style={{ color: '#8696a0' }}>messages</strong>
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
function IATab() {
  const [aiEnabled, setAiEnabled] = useState(true);
  const [extraPrompt, setExtraPrompt] = useState('');
  const [loading, setLoading]  = useState(true);
  const [saving, setSaving]    = useState(false);
  const [success, setSuccess]  = useState('');
  const [error, setError]      = useState('');

  useEffect(() => {
    api.get('/settings').then(r => {
      const d = r.data?.data;
      if (!d) return;
      setAiEnabled(d.ai_enabled_global !== false);
      setExtraPrompt(d.ai_system_prompt_extra || '');
    }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const save = async () => {
    setSaving(true); setError(''); setSuccess('');
    try {
      await api.put('/settings', { ai_enabled_global: aiEnabled, ai_system_prompt_extra: extraPrompt });
      setSuccess('✅ Configuración de IA guardada');
    } catch (err) {
      setError(err.response?.data?.error || 'Error al guardar');
    } finally { setSaving(false); }
  };

  if (loading) return (
    <div style={{ textAlign: 'center', padding: '60px', color: '#8696a0' }}>
      <Loader size={24} style={{ animation: 'spin 1s linear infinite', margin: '0 auto' }} />
    </div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <div style={card}>
        <div style={{ padding: '16px 22px', borderBottom: '1px solid #2a3942', display: 'flex', alignItems: 'center', gap: '10px' }}>
          <Brain size={17} color="#00a884" />
          <span style={{ color: '#e9edef', fontSize: '15px', fontWeight: 600 }}>Agente IA</span>
        </div>
        <div style={{ padding: '20px 22px', display: 'flex', flexDirection: 'column', gap: '16px' }}>

          {/* Toggle IA global */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', backgroundColor: '#111b21', borderRadius: '10px', padding: '14px 16px' }}>
            <div>
              <div style={{ color: '#e9edef', fontSize: '14px', fontWeight: 600 }}>IA activada globalmente</div>
              <div style={{ color: '#8696a0', fontSize: '12px', marginTop: '2px' }}>El bot responde automáticamente a nuevos mensajes</div>
            </div>
            <button onClick={() => setAiEnabled(v => !v)}
              style={{
                width: '44px', height: '24px', borderRadius: '12px', border: 'none', cursor: 'pointer',
                backgroundColor: aiEnabled ? '#00a884' : '#374045',
                position: 'relative', transition: 'background-color 0.2s', flexShrink: 0,
              }}>
              <span style={{
                position: 'absolute', top: '2px', left: aiEnabled ? '22px' : '2px',
                width: '20px', height: '20px', borderRadius: '50%', backgroundColor: 'white',
                transition: 'left 0.2s',
              }} />
            </button>
          </div>

          {/* Prompt extra */}
          <div>
            <label style={label}>Instrucciones adicionales para el bot</label>
            <textarea
              value={extraPrompt}
              onChange={e => setExtraPrompt(e.target.value)}
              rows={5}
              placeholder="Ej: Siempre saluda con el nombre del cliente. No ofrezcas descuentos sin aprobación previa. Si preguntan por envíos, decir que demoran 24-48h..."
              style={{ ...inp, resize: 'vertical', lineHeight: 1.55, fontFamily: 'inherit' }}
            />
            <p style={hint}>Estas instrucciones se agregan al prompt del agente en cada conversación</p>
          </div>

          <SaveBtn loading={saving} onClick={save} />
          {error   && <Alert type="error"   msg={error} />}
          {success && <Alert type="success" msg={success} />}
        </div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════
   PANEL PRINCIPAL
══════════════════════════════════════════════ */
export default function SettingsPanel({ successMessage, onClearMessage }) {
  const [activeTab, setActiveTab] = useState('shopify');

  useEffect(() => {
    if (successMessage) onClearMessage?.();
  }, [successMessage]);

  return (
    <div style={{ flex: 1, backgroundColor: '#0b141a', overflowY: 'auto', padding: '28px 32px' }}>
      <div style={{ maxWidth: '640px', margin: '0 auto' }}>

        {/* Título */}
        <div style={{ marginBottom: '24px' }}>
          <h1 style={{ color: '#e9edef', fontSize: '20px', fontWeight: 700, margin: 0 }}>⚙️ Ajustes</h1>
          <p style={{ color: '#8696a0', fontSize: '13px', marginTop: '4px' }}>Configura las conexiones y el comportamiento del CRM</p>
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', backgroundColor: '#111b21', borderRadius: '10px', padding: '4px', marginBottom: '24px', gap: '2px' }}>
          {TABS.map(t => (
            <button key={t.key} onClick={() => setActiveTab(t.key)}
              style={{
                flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '7px',
                padding: '9px', borderRadius: '8px', border: 'none', cursor: 'pointer',
                backgroundColor: activeTab === t.key ? '#202c33' : 'transparent',
                color: activeTab === t.key ? '#e9edef' : '#8696a0',
                fontSize: '13px', fontWeight: activeTab === t.key ? 600 : 400,
                transition: 'all 0.15s',
              }}>
              <t.icon size={14} />
              {t.label}
            </button>
          ))}
        </div>

        {/* Contenido del tab */}
        {activeTab === 'shopify'  && <ShopifyTab />}
        {activeTab === 'whatsapp' && <WhatsAppTab />}
        {activeTab === 'ia'       && <IATab />}
      </div>

      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
