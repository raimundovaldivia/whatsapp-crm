import { useState, useEffect } from 'react';
import {
  CheckCircle, Copy, ExternalLink, Loader, AlertCircle,
  ChevronDown, ChevronUp, Eye, EyeOff,
} from 'lucide-react';
import { setupAPI } from '../utils/api.js';

const BASE_URL        = import.meta.env.VITE_API_URL || window.location.origin.replace(':5173', ':3001');
const WEBHOOK_META    = `${BASE_URL}/webhook`;
const WEBHOOK_TWILIO  = `${BASE_URL}/twilio-webhook`;
const WEBHOOK_KAPSO   = `${BASE_URL}/kapso-webhook`;

const makeToken = () => {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return 'crm_' + Array.from({ length: 24 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
};

/* ════════ sub-componentes ════════ */

function Field({ label, hint, children }) {
  return (
    <div>
      <label style={{ fontSize: '13px', color: '#e9edef', fontWeight: 500, marginBottom: '6px', display: 'block' }}>
        {label}
      </label>
      {children}
      {hint && <p style={{ fontSize: '11px', color: '#8696a0', marginTop: '4px', lineHeight: '1.5', margin: '4px 0 0' }}>{hint}</p>}
    </div>
  );
}

function CopyBox({ label, value, copied, onCopy, accent }) {
  return (
    <div style={{
      backgroundColor: accent ? '#0d2e25' : '#1a2428',
      border: `1px solid ${accent ? '#00a884' : '#374045'}`,
      borderRadius: '8px', padding: '10px 14px',
      display: 'flex', alignItems: 'center', gap: '10px',
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        {label && <div style={{ fontSize: '10px', color: '#8696a0', marginBottom: '3px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{label}</div>}
        <code style={{ fontSize: '12px', color: accent ? '#00a884' : '#e9edef', wordBreak: 'break-all' }}>{value}</code>
      </div>
      <button onClick={() => onCopy(value)}
        style={{
          display: 'flex', alignItems: 'center', gap: '4px',
          backgroundColor: copied ? '#0d2e25' : '#2a3942',
          color: copied ? '#00a884' : '#8696a0',
          padding: '6px 10px', borderRadius: '6px', fontSize: '12px',
          border: `1px solid ${copied ? '#00a884' : 'transparent'}`,
          flexShrink: 0, transition: 'all 0.2s', cursor: 'pointer',
        }}>
        <Copy size={12} />
        {copied ? 'Copiado ✓' : 'Copiar'}
      </button>
    </div>
  );
}

function StepNum({ n, label, done }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '14px' }}>
      <div style={{
        width: '26px', height: '26px', borderRadius: '50%', flexShrink: 0,
        backgroundColor: done ? '#00a884' : '#2a3942',
        border: `2px solid ${done ? '#00a884' : '#374045'}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {done ? <CheckCircle size={14} color="white" /> : <span style={{ fontSize: '12px', color: '#e9edef', fontWeight: 700 }}>{n}</span>}
      </div>
      <span style={{ fontSize: '14px', color: '#e9edef', fontWeight: 600 }}>{label}</span>
    </div>
  );
}

function HelpPanel({ title, children }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ backgroundColor: '#111b21', borderRadius: '10px', border: '1px solid #2a3942', overflow: 'hidden' }}>
      <button onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', padding: '11px 16px', display: 'flex', alignItems: 'center',
          justifyContent: 'space-between', background: 'none', color: '#8696a0',
          fontSize: '13px', textAlign: 'left', cursor: 'pointer', border: 'none',
        }}>
        <span>📖 {title}</span>
        {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>
      {open && (
        <div style={{ padding: '4px 16px 16px', display: 'flex', flexDirection: 'column', gap: '12px', borderTop: '1px solid #2a3942' }}>
          {children}
        </div>
      )}
    </div>
  );
}

function GuideStep({ n, title, children }) {
  return (
    <div style={{ display: 'flex', gap: '10px', paddingTop: '8px' }}>
      <div style={{ width: '20px', height: '20px', borderRadius: '50%', backgroundColor: '#2a3942', color: '#00a884', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', fontWeight: 700, flexShrink: 0, marginTop: '1px' }}>{n}</div>
      <div>
        <div style={{ fontSize: '13px', color: '#e9edef', fontWeight: 500 }}>{title}</div>
        {children && <div style={{ fontSize: '12px', color: '#8696a0', marginTop: '3px', lineHeight: '1.7' }}>{children}</div>}
      </div>
    </div>
  );
}

/* ════════════════════════════════════════
   WIZARD PRINCIPAL
════════════════════════════════════════ */

export default function SetupWizard({ org, onComplete }) {
  // step: 0=whatsapp-credenciales, 1=whatsapp-webhook, 2=shopify, 3=done
  const [step, setStep]       = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');
  const [success, setSuccess] = useState('');
  const [shopifyInfo, setShopifyInfo] = useState(null);
  const [copied, setCopied]   = useState('');
  const [showPwd, setShowPwd] = useState({});

  const [provider, setProvider] = useState('kapso'); // 'meta' | 'twilio' | 'kapso'

  // Formulario Meta
  const [waForm, setWaForm] = useState({
    phoneNumberId:      '',
    businessAccountId:  '',
    accessToken:        '',
    webhookVerifyToken: makeToken(),
  });

  // Formulario Twilio
  const [twilioForm, setTwilioForm] = useState({
    twilioAccountSid:  '',
    twilioAuthToken:   '',
    twilioPhoneNumber: '+14155238886',
  });
  const setTw = k => e => setTwilioForm(f => ({ ...f, [k]: e.target.value }));

  // Kapso — flujo automático
  const [kapsoConnecting, setKapsoConnecting] = useState(false);
  const [kapsoConnected,  setKapsoConnected]  = useState(false);

  const [shopUrl, setShopUrl] = useState('');

  // Detectar retorno de Kapso (kapso_success=1&phone_number_id=...) o Shopify
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);

    // ─── Kapso retorno exitoso ───────────────────────────────────────
    if (params.get('kapso_success') === '1') {
      const phoneNumberId       = params.get('phone_number_id');
      const displayPhoneNumber  = params.get('display_phone_number');
      const businessAccountId   = params.get('business_account_id');

      // Limpiar URL sin recargar
      window.history.replaceState({}, '', window.location.pathname);

      if (phoneNumberId) {
        // Guardar en backend y avanzar al siguiente paso
        import('../utils/api.js').then(({ api }) => {
          api.post('/setup/kapso/save', { phoneNumberId, displayPhoneNumber, businessAccountId })
            .then(() => {
              setKapsoConnected(true);
              setProvider('kapso');
              setSuccess(`✅ WhatsApp conectado${displayPhoneNumber ? ': ' + decodeURIComponent(displayPhoneNumber) : ''}`);
              setTimeout(() => go(1), 1500); // avanzar al paso de webhook
            })
            .catch(() => {
              setError('WhatsApp conectado en Kapso pero hubo un error guardando. Intenta de nuevo.');
            });
        });
      } else {
        setError('Kapso no devolvió el phone_number_id. Intenta conectar de nuevo.');
      }
    }

    // ─── Kapso error ─────────────────────────────────────────────────
    if (params.get('kapso_error') === '1') {
      window.history.replaceState({}, '', window.location.pathname);
      setError('No se pudo conectar WhatsApp via Kapso. Intenta de nuevo.');
    }

    const shopifyData = sessionStorage.getItem('shopify_just_connected');
    const shopifyErr  = sessionStorage.getItem('shopify_error');

    if (shopifyData) {
      sessionStorage.removeItem('shopify_just_connected');
      const { shopName, products } = JSON.parse(shopifyData);
      setShopifyInfo({ shopName, productCount: products });
      setSuccess(`✅ Shopify conectado: ${shopName}`);
      go(3);
    }
    if (shopifyErr) {
      sessionStorage.removeItem('shopify_error');
      setError(`Error conectando Shopify: ${shopifyErr}`);
      go(2);
    }
  }, []);

  const copy = async (text, key) => {
    try { await navigator.clipboard.writeText(text); } catch {}
    setCopied(key);
    setTimeout(() => setCopied(''), 2500);
  };

  const setWa = k => e => setWaForm(f => ({ ...f, [k]: e.target.value }));
  const go    = n => { setStep(n); setError(''); setSuccess(''); };
  const toggle = k => setShowPwd(s => ({ ...s, [k]: !s[k] }));

  /* ── Conectar WhatsApp via Kapso (flujo automático) ── */
  const connectKapso = async () => {
    setKapsoConnecting(true); setError('');
    try {
      const { api } = await import('../utils/api.js');
      const r = await api.post('/setup/kapso/connect');
      if (r.data?.setupUrl) {
        // Redirigir al cliente al flujo de Kapso
        window.location.href = r.data.setupUrl;
      } else {
        setError(r.data?.error || 'No se pudo generar el link de Kapso');
        setKapsoConnecting(false);
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Error al conectar con Kapso. ¿Está KAPSO_API_KEY configurada?');
      setKapsoConnecting(false);
    }
  };

  /* ── Guardar credenciales WA (Meta o Twilio) → paso webhook ── */
  const saveWhatsApp = async () => {
    setLoading(true); setError(''); setSuccess('');
    try {
      let payload;
      if (provider === 'twilio') {
        const { twilioAccountSid, twilioAuthToken, twilioPhoneNumber } = twilioForm;
        if (!twilioAccountSid || !twilioAuthToken || !twilioPhoneNumber) {
          setError('Por favor completa todos los campos de Twilio.'); setLoading(false); return;
        }
        payload = { provider: 'twilio', twilioAccountSid, twilioAuthToken, twilioPhoneNumber };
      } else {
        const { phoneNumberId, businessAccountId, accessToken, webhookVerifyToken } = waForm;
        if (!phoneNumberId || !businessAccountId || !accessToken || !webhookVerifyToken) {
          setError('Por favor completa todos los campos de Meta.'); setLoading(false); return;
        }
        payload = { provider: 'meta', ...waForm };
      }

      const result = await setupAPI.connectWhatsApp(payload);
      if (result?.warning) {
        setSuccess('✅ Guardado · ⚠️ ' + result.warning);
      } else {
        setSuccess('✅ WhatsApp configurado correctamente');
      }
      setTimeout(() => go(1), 1800);
    } catch (err) {
      setError(err.response?.data?.error || 'Error al guardar. Verifica los datos.');
    } finally { setLoading(false); }
  };

  /* ── Conectar Shopify via raigentic ── */
  const connectShopify = async () => {
    if (!shopUrl.trim()) {
      setError('Por favor ingresa la URL de tu tienda.'); return;
    }
    setLoading(true); setError(''); setSuccess('');
    try {
      const result = await setupAPI.connectShopify({ storeUrl: shopUrl.trim() });
      if (result.success) {
        setSuccess(`✅ Shopify conectado: ${shopUrl.trim()}`);
        setTimeout(() => go(3), 1500);
      } else {
        setError(result.error || 'Error al conectar Shopify');
      }
    } catch (err) {
      setError(err.response?.data?.error || 'No se pudo conectar. ¿Instalaste la app raigentic en tu tienda?');
    } finally { setLoading(false); }
  };

  const finish = async () => {
    setLoading(true);
    try { await setupAPI.complete(); onComplete(); }
    catch (err) { setError(err.response?.data?.error || 'Error'); setLoading(false); }
  };

  /* estilos */
  const inp = {
    width: '100%', backgroundColor: '#111b21', border: '1px solid #374045',
    borderRadius: '8px', padding: '11px 14px', color: '#e9edef', fontSize: '14px',
    outline: 'none', boxSizing: 'border-box',
  };
  const primary = {
    flex: 1, padding: '13px', borderRadius: '9px', fontSize: '15px', fontWeight: 600,
    backgroundColor: loading ? '#374045' : '#00a884', color: 'white',
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
    cursor: loading ? 'not-allowed' : 'pointer', border: 'none',
  };
  const secondary = {
    padding: '13px 20px', borderRadius: '9px', fontSize: '14px',
    backgroundColor: '#2a3942', color: '#8696a0', cursor: 'pointer', border: 'none',
  };

  /* ── indicadores de progreso visual ── */
  const progressSteps = [
    { label: 'Credenciales', done: step >= 1 },
    { label: 'Webhook',      done: step >= 2 },
    { label: 'Shopify',      done: step >= 3 },
    { label: 'Listo',        done: step >= 3 },
  ];

  return (
    <div style={{ minHeight: '100vh', backgroundColor: '#111b21', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '40px 20px', overflowY: 'auto' }}>
      <div style={{ width: '100%', maxWidth: '600px' }}>

        {/* Encabezado */}
        <div style={{ textAlign: 'center', marginBottom: '28px' }}>
          <div style={{ fontSize: '40px', marginBottom: '10px' }}>🤖</div>
          <h1 style={{ color: '#e9edef', fontSize: '22px', fontWeight: 700, margin: 0 }}>
            Conecta tu WhatsApp a Shopify
          </h1>
          <p style={{ color: '#8696a0', fontSize: '14px', marginTop: '8px' }}>
            Bienvenido, <strong style={{ color: '#e9edef' }}>{org?.name}</strong>
          </p>
        </div>

        {/* Barra de progreso */}
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: '28px', padding: '0 8px' }}>
          {[
            { emoji: '🔑', label: 'Cuenta WA',  done: step > 0 },
            { emoji: '🔗', label: 'Webhook',    done: step > 1 },
            { emoji: '🛍️', label: 'Shopify',   done: step > 2 },
            { emoji: '🎉', label: 'Listo',      done: step > 3 },
          ].map((s, i, arr) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', flex: i < arr.length - 1 ? 1 : 'none' }}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
                <div style={{
                  width: '38px', height: '38px', borderRadius: '50%', fontSize: '16px',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  backgroundColor: s.done ? '#00a884' : i === step || (i === 1 && step === 1) ? '#2a3942' : '#1a2428',
                  border: `2px solid ${s.done ? '#00a884' : (i === step || (i===1&&step===1)) ? '#00a884' : '#2a3942'}`,
                  boxShadow: (i === step || (i===1&&step===1)) && !s.done ? '0 0 0 3px rgba(0,168,132,0.12)' : 'none',
                }}>
                  {s.done ? <CheckCircle size={18} color="white" /> : s.emoji}
                </div>
                <span style={{ fontSize: '10px', color: s.done || i === step ? '#e9edef' : '#556169', fontWeight: s.done || i === step ? 600 : 400 }}>
                  {s.label}
                </span>
              </div>
              {i < arr.length - 1 && (
                <div style={{ flex: 1, height: '2px', margin: '0 6px', marginBottom: '16px', backgroundColor: s.done ? '#00a884' : '#2a3942', transition: 'background 0.3s' }} />
              )}
            </div>
          ))}
        </div>

        {/* ══════════════════════════════════
            PASO 0: Credenciales WhatsApp
        ══════════════════════════════════ */}
        {step === 0 && (
          <div style={{ backgroundColor: '#202c33', borderRadius: '16px', border: '1px solid #2a3942' }}>
            <div style={{ padding: '20px 24px 16px', borderBottom: '1px solid #2a3942' }}>
              <h2 style={{ color: '#e9edef', fontSize: '17px', fontWeight: 600, margin: 0 }}>💬 Conectar WhatsApp</h2>
              <p style={{ color: '#8696a0', fontSize: '12px', marginTop: '4px', marginBottom: 0 }}>Elige tu proveedor de WhatsApp Business API</p>
            </div>

            <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '18px' }}>

              {/* ── Selector de provider ── */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px' }}>
                {[
                  { key: 'kapso',  emoji: '🚀', title: 'Kapso',    sub: 'Sin proceso Meta · Recomendado' },
                  { key: 'twilio', emoji: '⚡', title: 'Twilio',   sub: 'Sandbox gratis · fácil' },
                  { key: 'meta',   emoji: '📘', title: 'Meta API', sub: 'Oficial · requiere app Meta' },
                ].map(p => (
                  <button key={p.key} onClick={() => { setProvider(p.key); setError(''); }}
                    style={{
                      padding: '12px', borderRadius: '10px', cursor: 'pointer', textAlign: 'left',
                      backgroundColor: provider === p.key ? '#0d2e25' : '#111b21',
                      border: `2px solid ${provider === p.key ? '#00a884' : '#2a3942'}`,
                    }}>
                    <div style={{ fontSize: '20px', marginBottom: '5px' }}>{p.emoji}</div>
                    <div style={{ fontSize: '13px', fontWeight: 600, color: '#e9edef' }}>{p.title}</div>
                    <div style={{ fontSize: '10px', color: '#8696a0', marginTop: '2px', lineHeight: 1.4 }}>{p.sub}</div>
                  </button>
                ))}
              </div>

              {/* ── Flujo automático Kapso ── */}
              {provider === 'kapso' && (<>
                <div style={{ backgroundColor: '#0d2e25', borderRadius: '10px', padding: '16px 18px', border: '1px solid #00a88433', display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  <p style={{ color: '#00a884', fontSize: '14px', margin: 0, fontWeight: 600 }}>
                    🚀 Conexión en 5 minutos — sin escribir datos
                  </p>
                  <p style={{ color: '#8696a0', fontSize: '13px', margin: 0, lineHeight: 1.7 }}>
                    Haz clic en el botón de abajo. Serás redirigido a Kapso donde conectarás tu número de WhatsApp con login de Facebook. Al terminar, volverás aquí automáticamente.
                  </p>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    {[
                      '✅ Sin verificación Manual de Meta',
                      '✅ Sin copiar Phone Number IDs ni tokens',
                      '✅ Webhook configurado automáticamente',
                    ].map(t => (
                      <span key={t} style={{ fontSize: '12px', color: '#00a884' }}>{t}</span>
                    ))}
                  </div>
                </div>

                {kapsoConnected ? (
                  <div style={{ backgroundColor: '#0d2e25', borderRadius: '10px', padding: '16px 18px', border: '1px solid #00a884', display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <CheckCircle size={22} color="#00a884" />
                    <div>
                      <div style={{ color: '#00a884', fontSize: '14px', fontWeight: 600 }}>WhatsApp conectado con Kapso</div>
                      <div style={{ color: '#8696a0', fontSize: '12px', marginTop: '2px' }}>Continúa al siguiente paso</div>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={connectKapso}
                    disabled={kapsoConnecting}
                    style={{
                      width: '100%', padding: '16px', borderRadius: '10px', fontSize: '15px', fontWeight: 700,
                      backgroundColor: kapsoConnecting ? '#374045' : '#00a884',
                      color: 'white', cursor: kapsoConnecting ? 'not-allowed' : 'pointer',
                      border: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px',
                      transition: 'background 0.2s',
                    }}>
                    {kapsoConnecting
                      ? <><Loader size={18} style={{ animation: 'spin 1s linear infinite' }} /> Abriendo Kapso...</>
                      : <>🔗 Conectar WhatsApp con Kapso <ExternalLink size={15} /></>
                    }
                  </button>
                )}

                <p style={{ color: '#556169', fontSize: '11px', textAlign: 'center', margin: 0, lineHeight: 1.5 }}>
                  Necesitas una cuenta gratis en{' '}
                  <a href="https://app.kapso.ai" target="_blank" rel="noreferrer" style={{ color: '#8696a0' }}>app.kapso.ai</a>
                  {' '}y la variable <code style={{ color: '#8696a0' }}>KAPSO_API_KEY</code> configurada en el backend.
                </p>
              </>)}

              {/* ── Formulario Twilio ── */}
              {provider === 'twilio' && (<>
                <Field label="Account SID" hint="console.twilio.com → Dashboard → Account Info → Account SID">
                  <input style={inp} value={twilioForm.twilioAccountSid} onChange={setTw('twilioAccountSid')} placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" />
                </Field>
                <Field label="Auth Token" hint="console.twilio.com → Dashboard → Account Info → Auth Token">
                  <div style={{ position: 'relative' }}>
                    <input style={{ ...inp, paddingRight: '44px' }}
                      type={showPwd.twToken ? 'text' : 'password'}
                      value={twilioForm.twilioAuthToken} onChange={setTw('twilioAuthToken')}
                      placeholder="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" />
                    <button onClick={() => toggle('twToken')} style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', background: 'none', color: '#8696a0', cursor: 'pointer', border: 'none' }}>
                      {showPwd.twToken ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                </Field>
                <Field label="Número Twilio WhatsApp" hint="Sandbox: +14155238886 · O tu número real de Twilio">
                  <input style={inp} value={twilioForm.twilioPhoneNumber} onChange={setTw('twilioPhoneNumber')} placeholder="+14155238886" />
                </Field>

                <HelpPanel title="¿Cómo configurar Twilio en 3 pasos?">
                  <GuideStep n="1" title="Crea cuenta en console.twilio.com">Es gratis. Copia el Account SID y Auth Token del Dashboard.</GuideStep>
                  <GuideStep n="2" title="Activa el Sandbox de WhatsApp">Messaging → Try it Out → Send a WhatsApp message. Sigue las instrucciones para unirte al sandbox desde tu celular.</GuideStep>
                  <GuideStep n="3" title="En el siguiente paso configuras el webhook">Te daremos la URL exacta que debes pegar en Twilio.</GuideStep>
                </HelpPanel>
              </>)}

              {/* ── Formulario Meta ── */}
              {provider === 'meta' && (<>
                <Field label="Phone Number ID" hint="Meta → WhatsApp → Configuración de API → 'Phone Number ID'">
                  <input style={inp} value={waForm.phoneNumberId} onChange={setWa('phoneNumberId')} placeholder="367417763113234" />
                </Field>
                <Field label="WhatsApp Business Account ID" hint="Meta → WhatsApp → Configuración de API → 'WhatsApp Business Account ID'">
                  <input style={inp} value={waForm.businessAccountId} onChange={setWa('businessAccountId')} placeholder="341716095690499" />
                </Field>
                <Field label="Token de acceso permanente" hint="Meta → Configuración → Usuarios del sistema → Generar token → permiso: whatsapp_business_messaging">
                  <div style={{ position: 'relative' }}>
                    <input style={{ ...inp, paddingRight: '44px' }}
                      type={showPwd.token ? 'text' : 'password'}
                      value={waForm.accessToken} onChange={setWa('accessToken')}
                      placeholder="EAAxxxxxxxxxxxxxxxxxx..." />
                    <button onClick={() => toggle('token')} style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', background: 'none', color: '#8696a0', cursor: 'pointer', border: 'none' }}>
                      {showPwd.token ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                </Field>
                <HelpPanel title="¿Dónde encuentro estos datos?">
                  <GuideStep n="1" title="Ve a developers.facebook.com">Inicia sesión y abre tu App de WhatsApp Business.</GuideStep>
                  <GuideStep n="2" title="Menú → WhatsApp → Configuración de API">Ahí verás el Phone Number ID y el Business Account ID.</GuideStep>
                  <GuideStep n="3" title="Token permanente">Menú → Configuración → Usuarios del sistema → crear admin → Generar token → activar <code style={{ color: '#00a884' }}>whatsapp_business_messaging</code>.</GuideStep>
                </HelpPanel>
              </>)}
            </div>
          </div>
        )}

        {/* ══════════════════════════════════
            PASO 1: Configurar webhook
        ══════════════════════════════════ */}
        {step === 1 && (
          <div style={{ backgroundColor: '#202c33', borderRadius: '16px', border: '1px solid #2a3942' }}>
            <div style={{ padding: '20px 24px 16px', borderBottom: '1px solid #2a3942' }}>
              <h2 style={{ color: '#e9edef', fontSize: '17px', fontWeight: 600, margin: 0 }}>
                🔗 Configurar Webhook en {provider === 'twilio' ? 'Twilio' : provider === 'kapso' ? 'Kapso' : 'Meta'}
              </h2>
              <p style={{ color: '#8696a0', fontSize: '12px', marginTop: '4px', marginBottom: 0 }}>
                Copia esta URL y pégala en {provider === 'twilio' ? 'Twilio Dashboard' : provider === 'kapso' ? 'app.kapso.ai' : 'Meta for Developers'}
              </p>
            </div>

            <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '20px' }}>

              <div style={{ backgroundColor: '#0d2e25', borderRadius: '10px', padding: '14px 16px', border: '1px solid #00a88433' }}>
                <p style={{ color: '#00a884', fontSize: '13px', margin: 0, lineHeight: '1.6' }}>
                  ✅ Tus credenciales ya están guardadas. Configura el webhook con los valores de abajo.
                </p>
              </div>

              {/* ─── Kapso ─── */}
              {provider === 'kapso' && (<>
                <CopyBox
                  label="URL del Webhook → pégala en Kapso"
                  value={WEBHOOK_KAPSO}
                  copied={copied === 'kapsourl'}
                  onCopy={v => copy(v, 'kapsourl')}
                  accent
                />
                <div style={{ backgroundColor: '#111b21', borderRadius: '10px', padding: '16px', border: '1px solid #2a3942', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  <div style={{ fontSize: '12px', color: '#e9edef', fontWeight: 600 }}>Pasos en Kapso:</div>
                  <GuideStep n="1" title="Ve a app.kapso.ai → tu número">
                    <a href="https://app.kapso.ai" target="_blank" rel="noreferrer" style={{ color: '#00a884' }}>
                      app.kapso.ai <ExternalLink size={10} />
                    </a>
                  </GuideStep>
                  <GuideStep n="2" title="Webhooks → Add webhook">
                    Pega la URL de arriba. Suscríbete al evento: <code style={{ color: '#00a884' }}>whatsapp.message.received</code>
                  </GuideStep>
                  <GuideStep n="3" title="(Opcional) Activa firma HMAC">
                    Si habilitaste firma, copia el secret y guárdalo en Ajustes → WhatsApp → Webhook Secret.
                  </GuideStep>
                </div>
              </>)}

              {/* ─── Twilio ─── */}
              {provider === 'twilio' && (<>
                <CopyBox
                  label="URL del Webhook → pégala en Twilio"
                  value={WEBHOOK_TWILIO}
                  copied={copied === 'twurl'}
                  onCopy={v => copy(v, 'twurl')}
                  accent
                />
                <div style={{ backgroundColor: '#111b21', borderRadius: '10px', padding: '16px', border: '1px solid #2a3942', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  <div style={{ fontSize: '12px', color: '#e9edef', fontWeight: 600 }}>Pasos en Twilio:</div>
                  <GuideStep n="1" title="Ve a console.twilio.com">
                    <a href="https://console.twilio.com/us1/develop/sms/try-it-out/whatsapp-learn" target="_blank" rel="noreferrer" style={{ color: '#00a884' }}>
                      Messaging → Try it Out → Send a WhatsApp message <ExternalLink size={10} />
                    </a>
                  </GuideStep>
                  <GuideStep n="2" title="Únete al sandbox desde tu celular">
                    Sigue las instrucciones para enviar el código de unión por WhatsApp (ej: <code style={{ color: '#00a884' }}>join silver-cat</code>).
                  </GuideStep>
                  <GuideStep n="3" title="Sandbox Settings → 'When a message comes in'">
                    Pega la URL del webhook de arriba. Método: <strong style={{ color: '#e9edef' }}>HTTP POST</strong>. Guarda.
                  </GuideStep>
                </div>
                <div style={{ backgroundColor: '#111b21', borderRadius: '8px', padding: '12px 14px', border: '1px solid #2a3942' }}>
                  <p style={{ color: '#8696a0', fontSize: '12px', margin: 0, lineHeight: '1.6' }}>
                    💡 Necesitas <strong style={{ color: '#e9edef' }}>ngrok</strong> corriendo para que Twilio llegue a tu backend local: <code style={{ color: '#00a884', fontSize: '11px' }}>ngrok http 3001</code>
                  </p>
                </div>
              </>)}

              {/* ─── Meta ─── */}
              {provider === 'meta' && (<>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  <CopyBox label="1 · URL del Webhook → pégala en Meta" value={WEBHOOK_META} copied={copied === 'wurl'} onCopy={v => copy(v, 'wurl')} accent />
                  <CopyBox label="2 · Token de verificación → pégalo en Meta" value={waForm.webhookVerifyToken} copied={copied === 'wtok'} onCopy={v => copy(v, 'wtok')} accent />
                </div>
                <div style={{ backgroundColor: '#111b21', borderRadius: '10px', padding: '16px', border: '1px solid #2a3942', display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  <div style={{ fontSize: '12px', color: '#e9edef', fontWeight: 600 }}>Pasos en Meta for Developers:</div>
                  <GuideStep n="1" title="Tu App → WhatsApp → Configuración de API">
                    <a href="https://developers.facebook.com" target="_blank" rel="noreferrer" style={{ color: '#00a884' }}>developers.facebook.com <ExternalLink size={10} /></a>
                  </GuideStep>
                  <GuideStep n="2" title="Sección 'Webhook' → Editar">Pega la URL y el token. Clic en <strong style={{ color: '#e9edef' }}>Verificar y guardar</strong>.</GuideStep>
                  <GuideStep n="3" title="Activa la suscripción 'messages'">Activa el campo <code style={{ color: '#00a884' }}>messages</code>.</GuideStep>
                </div>
              </>)}
            </div>
          </div>
        )}

        {/* ══════════════════════════════════
            PASO 2: Shopify OAuth
        ══════════════════════════════════ */}
        {step === 2 && (
          <div style={{ backgroundColor: '#202c33', borderRadius: '16px', border: '1px solid #2a3942' }}>
            <div style={{ padding: '20px 24px 16px', borderBottom: '1px solid #2a3942' }}>
              <h2 style={{ color: '#e9edef', fontSize: '17px', fontWeight: 600, margin: 0 }}>🛍️ Conectar tu tienda Shopify</h2>
              <p style={{ color: '#8696a0', fontSize: '12px', marginTop: '4px', marginBottom: 0 }}>
                Ingresa tu dominio de Shopify para que el bot acceda a tus productos
              </p>
            </div>

            <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '20px' }}>
              {/* Requisito previo */}
              <div style={{ backgroundColor: '#111b21', borderRadius: '10px', padding: '14px 16px', border: '1px solid #2a3942' }}>
                <div style={{ fontSize: '12px', color: '#e9edef', fontWeight: 600, marginBottom: '8px' }}>Requisito previo:</div>
                <GuideStep n="1" title="Instala la app raigentic en tu tienda">
                  <a href="https://raigentic.onrender.com" target="_blank" rel="noreferrer" style={{ color: '#00a884' }}>
                    raigentic.onrender.com
                  </a> — esto conecta Shopify con el bot.
                </GuideStep>
                <GuideStep n="2" title="Ingresa tu dominio myshopify abajo">
                  El bot consultará tu catálogo y creará pedidos desde ahí.
                </GuideStep>
              </div>

              <Field label="Dominio de tu tienda" hint="Ejemplo: mi-tienda.myshopify.com">
                <input
                  style={inp}
                  value={shopUrl}
                  onChange={e => setShopUrl(e.target.value)}
                  placeholder="mi-tienda.myshopify.com"
                  onKeyDown={e => e.key === 'Enter' && connectShopify()}
                />
              </Field>
            </div>
          </div>
        )}

        {/* ══════════════════════════════════
            PASO 3: Listo
        ══════════════════════════════════ */}
        {step === 3 && (
          <div style={{ backgroundColor: '#202c33', borderRadius: '16px', border: '1px solid #2a3942', padding: '32px 28px', textAlign: 'center' }}>
            <div style={{ fontSize: '52px', marginBottom: '12px' }}>🎉</div>
            <h2 style={{ color: '#e9edef', fontSize: '21px', fontWeight: 700, margin: '0 0 8px' }}>¡Todo listo!</h2>
            <p style={{ color: '#8696a0', fontSize: '14px', marginBottom: '28px' }}>
              Tu agente IA ya está respondiendo mensajes en WhatsApp.
            </p>

            {shopifyInfo && (
              <div style={{ backgroundColor: '#0d2e25', borderRadius: '10px', padding: '12px 18px', marginBottom: '20px', border: '1px solid #00a884', display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
                <CheckCircle size={16} color="#00a884" />
                <span style={{ color: '#00a884', fontSize: '13px' }}>
                  <strong>{shopifyInfo.shopName}</strong> — {shopifyInfo.productCount || 'N/A'} productos sincronizados
                </span>
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '24px', textAlign: 'left' }}>
              {[
                { emoji: '🎯', name: 'Agente Orquestador',  desc: 'Detecta en segundos qué quiere el cliente' },
                { emoji: '💼', name: 'Agente de Ventas',    desc: 'Persuade, resuelve dudas y guía hacia la compra' },
                { emoji: '📦', name: 'Agente de Órdenes',   desc: 'Toma el pedido y lo crea en Shopify automáticamente' },
              ].map(a => (
                <div key={a.name} style={{ backgroundColor: '#111b21', borderRadius: '10px', padding: '14px 16px', border: '1px solid #2a3942', display: 'flex', gap: '12px', alignItems: 'center' }}>
                  <span style={{ fontSize: '22px' }}>{a.emoji}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ color: '#e9edef', fontSize: '14px', fontWeight: 500 }}>{a.name}</div>
                    <div style={{ color: '#8696a0', fontSize: '12px', marginTop: '2px' }}>{a.desc}</div>
                  </div>
                  <CheckCircle size={18} color="#00a884" />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Mensajes error / éxito */}
        {error && (
          <div style={{ backgroundColor: '#2d1a1a', border: '1px solid #5c2626', borderRadius: '8px', padding: '12px 16px', color: '#e57373', fontSize: '13px', marginTop: '16px', display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
            <AlertCircle size={15} style={{ flexShrink: 0, marginTop: '1px' }} />{error}
          </div>
        )}
        {success && (
          <div style={{ backgroundColor: '#0d2e25', border: '1px solid #00a884', borderRadius: '8px', padding: '12px 16px', color: '#00a884', fontSize: '13px', marginTop: '16px' }}>
            {success}
          </div>
        )}

        {/* Botones */}
        <div style={{ marginTop: '16px', display: 'flex', gap: '10px' }}>
          {step > 0 && step < 3 && (
            <button onClick={() => go(step - 1)} style={secondary}>← Atrás</button>
          )}
          {step === 0 && provider !== 'kapso' && (
            <button onClick={saveWhatsApp} disabled={loading} style={primary}>
              {loading && <Loader size={16} style={{ animation: 'spin 1s linear infinite' }} />}
              {loading ? 'Guardando...' : 'Guardar y continuar →'}
            </button>
          )}
          {step === 0 && provider === 'kapso' && kapsoConnected && (
            <button onClick={() => go(1)} style={primary}>
              Continuar →
            </button>
          )}
          {step === 1 && (
            <button onClick={() => go(2)} style={primary}>
              {provider === 'kapso' ? 'Ya configuré el webhook en Kapso →'
               : provider === 'twilio' ? 'Ya configuré el webhook en Twilio →'
               : 'Ya verifiqué el webhook en Meta →'}
            </button>
          )}
          {step === 2 && (
            <button onClick={connectShopify} disabled={loading} style={primary}>
              {loading && <Loader size={16} style={{ animation: 'spin 1s linear infinite' }} />}
              {loading ? 'Verificando...' : '🛍️ Conectar con Shopify →'}
            </button>
          )}
          {step === 3 && (
            <button onClick={finish} disabled={loading} style={primary}>
              {loading && <Loader size={16} style={{ animation: 'spin 1s linear infinite' }} />}
              {loading ? 'Cargando...' : '🚀 Ir a mi CRM'}
            </button>
          )}
        </div>

        {/* Saltar */}
        {step < 3 && (
          <button onClick={() => go(step === 0 ? 1 : step === 1 ? 2 : 3)}
            style={{ background: 'none', color: '#556169', fontSize: '12px', width: '100%', textAlign: 'center', marginTop: '10px', padding: '6px', cursor: 'pointer', border: 'none' }}>
            {step === 1 ? 'Configurar webhook después' : 'Saltar por ahora'}
          </button>
        )}

      </div>
      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        input:focus { border-color: #00a884 !important; box-shadow: 0 0 0 2px rgba(0,168,132,0.15); }
      `}</style>
    </div>
  );
}
