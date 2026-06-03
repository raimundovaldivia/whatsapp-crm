import { useState, useEffect } from 'react';
import {
  CheckCircle, Copy, ExternalLink, Loader, AlertCircle,
  ChevronDown, ChevronUp, Eye, EyeOff, Sparkles,
} from 'lucide-react';
import { setupAPI } from '../utils/api.js';
import { useTheme } from '../theme.js';

const BASE_URL        = import.meta.env.VITE_API_URL || window.location.origin.replace(':5173', ':3001');
const WEBHOOK_META    = `${BASE_URL}/webhook`;
const WEBHOOK_TWILIO  = `${BASE_URL}/twilio-webhook`;
const WEBHOOK_KAPSO   = `${BASE_URL}/kapso-webhook`;

const makeToken = () => {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return 'crm_' + Array.from({ length: 24 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
};

/* ════════ sub-componentes ════════ */

function Field({ label, hint, children, colors }) {
  return (
    <div>
      <label style={{ fontSize: '13px', color: colors.textPrimary, fontWeight: 500, marginBottom: '6px', display: 'block' }}>
        {label}
      </label>
      {children}
      {hint && <p style={{ fontSize: '11px', color: colors.textSecondary, marginTop: '4px', lineHeight: '1.5', margin: '4px 0 0' }}>{hint}</p>}
    </div>
  );
}

function CopyBox({ label, value, copied, onCopy, accent, colors }) {
  return (
    <div style={{
      backgroundColor: accent ? colors.bgAccent : colors.bgSub,
      border: `1px solid ${accent ? colors.green : colors.borderStrong}`,
      borderRadius: '8px', padding: '10px 14px',
      display: 'flex', alignItems: 'center', gap: '10px',
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        {label && <div style={{ fontSize: '10px', color: colors.textSecondary, marginBottom: '3px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>{label}</div>}
        <code style={{ fontSize: '12px', color: accent ? colors.green : colors.textPrimary, wordBreak: 'break-all' }}>{value}</code>
      </div>
      <button onClick={() => onCopy(value)}
        style={{
          display: 'flex', alignItems: 'center', gap: '4px',
          backgroundColor: copied ? colors.bgAccent : colors.bgHover,
          color: copied ? colors.green : colors.textSecondary,
          padding: '6px 10px', borderRadius: '6px', fontSize: '12px',
          border: `1px solid ${copied ? colors.green : 'transparent'}`,
          flexShrink: 0, transition: 'all 0.2s', cursor: 'pointer',
        }}>
        <Copy size={12} />
        {copied ? 'Copiado ✓' : 'Copiar'}
      </button>
    </div>
  );
}

function HelpPanel({ title, children, colors }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ backgroundColor: colors.bgInput, borderRadius: '10px', border: `1px solid ${colors.border}`, overflow: 'hidden' }}>
      <button onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', padding: '11px 16px', display: 'flex', alignItems: 'center',
          justifyContent: 'space-between', background: 'none', color: colors.textSecondary,
          fontSize: '13px', textAlign: 'left', cursor: 'pointer', border: 'none',
        }}>
        <span>📖 {title}</span>
        {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>
      {open && (
        <div style={{ padding: '4px 16px 16px', display: 'flex', flexDirection: 'column', gap: '12px', borderTop: `1px solid ${colors.border}` }}>
          {children}
        </div>
      )}
    </div>
  );
}

function GuideStep({ n, title, children, colors }) {
  return (
    <div style={{ display: 'flex', gap: '10px', paddingTop: '8px' }}>
      <div style={{ width: '20px', height: '20px', borderRadius: '50%', backgroundColor: colors.bgHover, color: colors.green, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', fontWeight: 700, flexShrink: 0, marginTop: '1px' }}>{n}</div>
      <div>
        <div style={{ fontSize: '13px', color: colors.textPrimary, fontWeight: 500 }}>{title}</div>
        {children && <div style={{ fontSize: '12px', color: colors.textSecondary, marginTop: '3px', lineHeight: '1.7' }}>{children}</div>}
      </div>
    </div>
  );
}

/* ════════════════════════════════════════
   WIZARD PRINCIPAL
════════════════════════════════════════ */

export default function SetupWizard({ org, onComplete }) {
  const { colors } = useTheme();

  // step: 0=whatsapp, 1=shopify, 2=templates, 3=done
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
  const [webhookVisible,  setWebhookVisible]  = useState(false);

  const [shopUrl, setShopUrl] = useState('');

  // Template step state
  const [generatingTemplates,  setGeneratingTemplates]  = useState(false);
  const [suggestedTemplates,   setSuggestedTemplates]   = useState([]);
  const [submittingTemplates,  setSubmittingTemplates]  = useState(false);
  const [templatesSubmitted,   setTemplatesSubmitted]   = useState(false);
  const [editingTemplate,      setEditingTemplate]      = useState(null);

  // Detectar retorno de Kapso o Shopify
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);

    // ─── Kapso retorno exitoso ───────────────────────────────────────
    if (params.get('kapso_success') === '1') {
      const phoneNumberId       = params.get('phone_number_id');
      const displayPhoneNumber  = params.get('display_phone_number');
      const businessAccountId   = params.get('business_account_id');
      window.history.replaceState({}, '', window.location.pathname);

      if (phoneNumberId) {
        import('../utils/api.js').then(({ api }) => {
          api.post('/setup/kapso/save', { phoneNumberId, displayPhoneNumber, businessAccountId })
            .then(() => {
              setKapsoConnected(true);
              setProvider('kapso');
              setSuccess(`✅ WhatsApp conectado${displayPhoneNumber ? ': ' + decodeURIComponent(displayPhoneNumber) : ''}`);
              setTimeout(() => go(1), 1500);
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

    // ─── Shopify OAuth retorno exitoso ───────────────────────────────
    if (params.get('shopify_success') === '1') {
      const shop = params.get('shop') || '';
      window.history.replaceState({}, '', window.location.pathname);
      setShopifyInfo({ shopName: shop });
      setSuccess(`✅ Shopify conectado: ${shop}`);
      go(2); // Go to templates step
    }

    // ─── Shopify OAuth error ─────────────────────────────────────────
    const shopifyError = params.get('shopify_error');
    if (shopifyError) {
      window.history.replaceState({}, '', window.location.pathname);
      setError(`Error conectando Shopify: ${decodeURIComponent(shopifyError)}`);
      go(1);
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

  /* ── Conectar WhatsApp via Kapso ── */
  const connectKapso = async () => {
    setKapsoConnecting(true); setError('');
    try {
      const { api } = await import('../utils/api.js');
      const r = await api.post('/setup/kapso/connect');
      if (r.data?.setupUrl) {
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

  /* ── Guardar credenciales WA (Meta o Twilio) ── */
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

  /* ── Conectar Shopify via OAuth ── */
  const connectShopify = async () => {
    if (!shopUrl.trim()) { setError('Por favor ingresa el dominio de tu tienda.'); return; }
    setLoading(true); setError('');
    try {
      const { api } = await import('../utils/api.js');
      // Pasar el input tal cual — el backend normaliza cualquier formato de URL
      const { data } = await api.get('/shopify-oauth/auth-url', { params: { shop: shopUrl.trim() } });
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

  /* ── Generar templates con IA ── */
  const generateTemplates = async () => {
    setGeneratingTemplates(true);
    setError('');
    try {
      const { api } = await import('../utils/api.js');
      const r = await api.post('/reengagement/generate-templates');
      setSuggestedTemplates(r.data.templates || []);
    } catch (err) {
      setError('Error generando templates: ' + (err.response?.data?.error || err.message));
    } finally {
      setGeneratingTemplates(false);
    }
  };

  /* ── Enviar templates a Meta ── */
  const submitTemplates = async () => {
    setSubmittingTemplates(true);
    setError('');
    try {
      const { api } = await import('../utils/api.js');
      await api.post('/reengagement/submit-templates', { templates: suggestedTemplates });
      setTemplatesSubmitted(true);
      setSuccess('✅ Templates enviados a Meta para revisión. La aprobación tarda 1-3 días hábiles.');
    } catch (err) {
      setError('Error enviando templates: ' + (err.response?.data?.error || err.message));
    } finally {
      setSubmittingTemplates(false);
    }
  };

  const finish = async () => {
    setLoading(true);
    try { await setupAPI.complete(); onComplete(); }
    catch (err) { setError(err.response?.data?.error || 'Error'); setLoading(false); }
  };

  /* estilos dinámicos */
  const inp = {
    width: '100%', backgroundColor: colors.bgInput, border: `1px solid ${colors.borderStrong}`,
    borderRadius: '8px', padding: '11px 14px', color: colors.textPrimary, fontSize: '14px',
    outline: 'none', boxSizing: 'border-box',
  };
  const primary = {
    flex: 1, padding: '13px', borderRadius: '9px', fontSize: '15px', fontWeight: 600,
    backgroundColor: loading ? colors.bgHover : colors.green, color: 'white',
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
    cursor: loading ? 'not-allowed' : 'pointer', border: 'none',
  };
  const secondary = {
    padding: '13px 20px', borderRadius: '9px', fontSize: '14px',
    backgroundColor: colors.bgHover, color: colors.textSecondary, cursor: 'pointer', border: 'none',
  };

  // Progress steps: 4 steps total now
  const PROGRESS = [
    { emoji: '💬', label: 'WhatsApp',  done: step > 0 },
    { emoji: '🛍️', label: 'Shopify',  done: step > 1 },
    { emoji: '📋', label: 'Templates', done: step > 2 },
    { emoji: '🎉', label: 'Listo',     done: step > 3 },
  ];

  return (
    <div style={{ minHeight: '100vh', backgroundColor: colors.bgApp, display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '40px 20px', overflowY: 'auto' }}>
      <div style={{ width: '100%', maxWidth: '620px' }}>

        {/* Encabezado */}
        <div style={{ textAlign: 'center', marginBottom: '28px' }}>
          <div style={{ fontSize: '40px', marginBottom: '10px' }}>🤖</div>
          <h1 style={{ color: colors.textPrimary, fontSize: '22px', fontWeight: 700, margin: 0 }}>
            Conecta tu WhatsApp a Shopify
          </h1>
          <p style={{ color: colors.textSecondary, fontSize: '14px', marginTop: '8px' }}>
            Bienvenido, <strong style={{ color: colors.textPrimary }}>{org?.name}</strong>
          </p>
        </div>

        {/* Barra de progreso — 4 pasos */}
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: '28px', padding: '0 8px' }}>
          {PROGRESS.map((s, i, arr) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', flex: i < arr.length - 1 ? 1 : 'none' }}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
                <div style={{
                  width: '38px', height: '38px', borderRadius: '50%', fontSize: '16px',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  backgroundColor: s.done ? colors.green : i === step ? colors.bgHover : colors.bgSub,
                  border: `2px solid ${s.done ? colors.green : i === step ? colors.green : colors.border}`,
                  boxShadow: i === step && !s.done ? `0 0 0 3px ${colors.green}22` : 'none',
                  transition: 'all 0.3s',
                }}>
                  {s.done ? <CheckCircle size={18} color="white" /> : s.emoji}
                </div>
                <span style={{ fontSize: '10px', color: s.done || i === step ? colors.textPrimary : colors.textMuted, fontWeight: s.done || i === step ? 600 : 400 }}>
                  {s.label}
                </span>
              </div>
              {i < arr.length - 1 && (
                <div style={{ flex: 1, height: '2px', margin: '0 6px', marginBottom: '16px', backgroundColor: s.done ? colors.green : colors.border, transition: 'background 0.3s' }} />
              )}
            </div>
          ))}
        </div>

        {/* ══════════════════════════════════
            PASO 0: Conectar WhatsApp
        ══════════════════════════════════ */}
        {step === 0 && (
          <div style={{ backgroundColor: colors.bgPanel, borderRadius: '16px', border: `1px solid ${colors.border}` }}>
            <div style={{ padding: '20px 24px 16px', borderBottom: `1px solid ${colors.border}` }}>
              <h2 style={{ color: colors.textPrimary, fontSize: '17px', fontWeight: 600, margin: 0 }}>💬 Conectar WhatsApp</h2>
              <p style={{ color: colors.textSecondary, fontSize: '12px', marginTop: '4px', marginBottom: 0 }}>Elige tu proveedor de WhatsApp Business API</p>
            </div>

            <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '18px' }}>

              {/* Selector de provider */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '10px' }}>
                {[
                  { key: 'kapso',  emoji: '🚀', title: 'Kapso',    sub: 'Sin proceso Meta · Recomendado' },
                  { key: 'twilio', emoji: '⚡', title: 'Twilio',   sub: 'Sandbox gratis · fácil' },
                  { key: 'meta',   emoji: '📘', title: 'Meta API', sub: 'Oficial · requiere app Meta' },
                ].map(p => (
                  <button key={p.key} onClick={() => { setProvider(p.key); setError(''); }}
                    style={{
                      padding: '12px', borderRadius: '10px', cursor: 'pointer', textAlign: 'left',
                      backgroundColor: provider === p.key ? colors.bgAccent : colors.bgInput,
                      border: `2px solid ${provider === p.key ? colors.green : colors.border}`,
                    }}>
                    <div style={{ fontSize: '20px', marginBottom: '5px' }}>{p.emoji}</div>
                    <div style={{ fontSize: '13px', fontWeight: 600, color: colors.textPrimary }}>{p.title}</div>
                    <div style={{ fontSize: '10px', color: colors.textSecondary, marginTop: '2px', lineHeight: 1.4 }}>{p.sub}</div>
                  </button>
                ))}
              </div>

              {/* Flujo automático Kapso */}
              {provider === 'kapso' && (<>
                <div style={{ backgroundColor: colors.bgAccent, borderRadius: '10px', padding: '16px 18px', border: `1px solid ${colors.green}33`, display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  <p style={{ color: colors.green, fontSize: '14px', margin: 0, fontWeight: 600 }}>
                    🚀 Conexión en 5 minutos — sin escribir datos
                  </p>
                  <p style={{ color: colors.textSecondary, fontSize: '13px', margin: 0, lineHeight: 1.7 }}>
                    Haz clic en el botón de abajo. Serás redirigido a Kapso donde conectarás tu número con login de Facebook. Al terminar, volverás aquí automáticamente.
                  </p>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                    {[
                      '✅ Sin verificación manual de Meta',
                      '✅ Sin copiar Phone Number IDs ni tokens',
                      '✅ Webhook configurado automáticamente',
                    ].map(t => (
                      <span key={t} style={{ fontSize: '12px', color: colors.green }}>{t}</span>
                    ))}
                  </div>
                </div>

                {/* Webhook URL inline para Kapso (collapsible) */}
                <div style={{ backgroundColor: colors.bgSub, borderRadius: '10px', border: `1px solid ${colors.border}`, overflow: 'hidden' }}>
                  <button onClick={() => setWebhookVisible(v => !v)}
                    style={{ width: '100%', padding: '11px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'none', color: colors.textSecondary, fontSize: '13px', cursor: 'pointer', border: 'none' }}>
                    <span>🔗 URL del webhook (para configurar en Kapso)</span>
                    {webhookVisible ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                  </button>
                  {webhookVisible && (
                    <div style={{ padding: '4px 16px 16px', borderTop: `1px solid ${colors.border}` }}>
                      <CopyBox
                        label="URL del Webhook → pégala en app.kapso.ai"
                        value={WEBHOOK_KAPSO}
                        copied={copied === 'kapsourl'}
                        onCopy={v => copy(v, 'kapsourl')}
                        accent
                        colors={colors}
                      />
                      <div style={{ marginTop: '10px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        <GuideStep n="1" title="Ve a app.kapso.ai → tu número" colors={colors}>
                          <a href="https://app.kapso.ai" target="_blank" rel="noreferrer" style={{ color: colors.green }}>app.kapso.ai <ExternalLink size={10} /></a>
                        </GuideStep>
                        <GuideStep n="2" title="Webhooks → Add webhook" colors={colors}>
                          Pega la URL de arriba. Evento: <code style={{ color: colors.green }}>whatsapp.message.received</code>
                        </GuideStep>
                      </div>
                    </div>
                  )}
                </div>

                {kapsoConnected ? (
                  <div style={{ backgroundColor: colors.bgAccent, borderRadius: '10px', padding: '16px 18px', border: `1px solid ${colors.green}`, display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <CheckCircle size={22} color={colors.green} />
                    <div>
                      <div style={{ color: colors.green, fontSize: '14px', fontWeight: 600 }}>WhatsApp conectado con Kapso</div>
                      <div style={{ color: colors.textSecondary, fontSize: '12px', marginTop: '2px' }}>Continúa al siguiente paso</div>
                    </div>
                  </div>
                ) : (
                  <button
                    onClick={connectKapso}
                    disabled={kapsoConnecting}
                    style={{
                      width: '100%', padding: '16px', borderRadius: '10px', fontSize: '15px', fontWeight: 700,
                      backgroundColor: kapsoConnecting ? colors.bgHover : colors.green,
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

                <p style={{ color: colors.textMuted, fontSize: '11px', textAlign: 'center', margin: 0, lineHeight: 1.5 }}>
                  Necesitas cuenta en{' '}
                  <a href="https://app.kapso.ai" target="_blank" rel="noreferrer" style={{ color: colors.textSecondary }}>app.kapso.ai</a>
                  {' '}y <code style={{ color: colors.textSecondary }}>KAPSO_API_KEY</code> en el backend.
                </p>
              </>)}

              {/* Formulario Twilio */}
              {provider === 'twilio' && (<>
                <Field label="Account SID" hint="console.twilio.com → Dashboard → Account Info → Account SID" colors={colors}>
                  <input style={inp} value={twilioForm.twilioAccountSid} onChange={setTw('twilioAccountSid')} placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" />
                </Field>
                <Field label="Auth Token" hint="console.twilio.com → Dashboard → Account Info → Auth Token" colors={colors}>
                  <div style={{ position: 'relative' }}>
                    <input style={{ ...inp, paddingRight: '44px' }}
                      type={showPwd.twToken ? 'text' : 'password'}
                      value={twilioForm.twilioAuthToken} onChange={setTw('twilioAuthToken')}
                      placeholder="xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" />
                    <button onClick={() => toggle('twToken')} style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', background: 'none', color: colors.textSecondary, cursor: 'pointer', border: 'none' }}>
                      {showPwd.twToken ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                </Field>
                <Field label="Número Twilio WhatsApp" hint="Sandbox: +14155238886 · O tu número real de Twilio" colors={colors}>
                  <input style={inp} value={twilioForm.twilioPhoneNumber} onChange={setTw('twilioPhoneNumber')} placeholder="+14155238886" />
                </Field>

                <HelpPanel title="¿Cómo configurar Twilio en 3 pasos?" colors={colors}>
                  <GuideStep n="1" title="Crea cuenta en console.twilio.com" colors={colors}>Es gratis. Copia el Account SID y Auth Token del Dashboard.</GuideStep>
                  <GuideStep n="2" title="Activa el Sandbox de WhatsApp" colors={colors}>Messaging → Try it Out → Send a WhatsApp message. Sigue las instrucciones para unirte al sandbox desde tu celular.</GuideStep>
                  <GuideStep n="3" title="Configura el webhook en el paso siguiente" colors={colors}>Te daremos la URL exacta que debes pegar en Twilio.</GuideStep>
                </HelpPanel>

                {/* Webhook URL inline para Twilio */}
                <div style={{ backgroundColor: colors.bgSub, borderRadius: '10px', border: `1px solid ${colors.border}`, overflow: 'hidden' }}>
                  <button onClick={() => setWebhookVisible(v => !v)}
                    style={{ width: '100%', padding: '11px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'none', color: colors.textSecondary, fontSize: '13px', cursor: 'pointer', border: 'none' }}>
                    <span>🔗 URL del webhook Twilio</span>
                    {webhookVisible ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                  </button>
                  {webhookVisible && (
                    <div style={{ padding: '4px 16px 16px', borderTop: `1px solid ${colors.border}` }}>
                      <CopyBox label="URL del Webhook → Twilio" value={WEBHOOK_TWILIO} copied={copied === 'twurl'} onCopy={v => copy(v, 'twurl')} accent colors={colors} />
                    </div>
                  )}
                </div>
              </>)}

              {/* Formulario Meta */}
              {provider === 'meta' && (<>
                <Field label="Phone Number ID" hint="Meta → WhatsApp → Configuración de API → 'Phone Number ID'" colors={colors}>
                  <input style={inp} value={waForm.phoneNumberId} onChange={setWa('phoneNumberId')} placeholder="367417763113234" />
                </Field>
                <Field label="WhatsApp Business Account ID" hint="Meta → WhatsApp → Configuración de API → 'WhatsApp Business Account ID'" colors={colors}>
                  <input style={inp} value={waForm.businessAccountId} onChange={setWa('businessAccountId')} placeholder="341716095690499" />
                </Field>
                <Field label="Token de acceso permanente" hint="Meta → Configuración → Usuarios del sistema → Generar token → permiso: whatsapp_business_messaging" colors={colors}>
                  <div style={{ position: 'relative' }}>
                    <input style={{ ...inp, paddingRight: '44px' }}
                      type={showPwd.token ? 'text' : 'password'}
                      value={waForm.accessToken} onChange={setWa('accessToken')}
                      placeholder="EAAxxxxxxxxxxxxxxxxxx..." />
                    <button onClick={() => toggle('token')} style={{ position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', background: 'none', color: colors.textSecondary, cursor: 'pointer', border: 'none' }}>
                      {showPwd.token ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                </Field>

                {/* Webhook URL inline para Meta */}
                <div style={{ backgroundColor: colors.bgSub, borderRadius: '10px', border: `1px solid ${colors.border}`, overflow: 'hidden' }}>
                  <button onClick={() => setWebhookVisible(v => !v)}
                    style={{ width: '100%', padding: '11px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'none', color: colors.textSecondary, fontSize: '13px', cursor: 'pointer', border: 'none' }}>
                    <span>🔗 Datos del webhook Meta</span>
                    {webhookVisible ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                  </button>
                  {webhookVisible && (
                    <div style={{ padding: '4px 16px 16px', borderTop: `1px solid ${colors.border}`, display: 'flex', flexDirection: 'column', gap: '8px' }}>
                      <CopyBox label="1 · URL del Webhook" value={WEBHOOK_META} copied={copied === 'wurl'} onCopy={v => copy(v, 'wurl')} accent colors={colors} />
                      <CopyBox label="2 · Token de verificación" value={waForm.webhookVerifyToken} copied={copied === 'wtok'} onCopy={v => copy(v, 'wtok')} accent colors={colors} />
                    </div>
                  )}
                </div>

                <HelpPanel title="¿Dónde encuentro estos datos?" colors={colors}>
                  <GuideStep n="1" title="Ve a developers.facebook.com" colors={colors}>Inicia sesión y abre tu App de WhatsApp Business.</GuideStep>
                  <GuideStep n="2" title="Menú → WhatsApp → Configuración de API" colors={colors}>Ahí verás el Phone Number ID y el Business Account ID.</GuideStep>
                  <GuideStep n="3" title="Token permanente" colors={colors}>Menú → Configuración → Usuarios del sistema → crear admin → Generar token → activar <code style={{ color: colors.green }}>whatsapp_business_messaging</code>.</GuideStep>
                </HelpPanel>
              </>)}
            </div>
          </div>
        )}

        {/* ══════════════════════════════════
            PASO 1: Shopify OAuth
        ══════════════════════════════════ */}
        {step === 1 && (
          <div style={{ backgroundColor: colors.bgPanel, borderRadius: '16px', border: `1px solid ${colors.border}` }}>
            <div style={{ padding: '20px 24px 16px', borderBottom: `1px solid ${colors.border}` }}>
              <h2 style={{ color: colors.textPrimary, fontSize: '17px', fontWeight: 600, margin: 0 }}>🛍️ Conectar tu tienda Shopify</h2>
              <p style={{ color: colors.textSecondary, fontSize: '12px', marginTop: '4px', marginBottom: 0 }}>
                Un clic — te llevamos a Shopify para que autorices el acceso
              </p>
            </div>

            <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '20px' }}>

              <div style={{ backgroundColor: colors.bgAccent, borderRadius: '10px', padding: '16px 18px', border: `1px solid ${colors.green}33`, display: 'flex', flexDirection: 'column', gap: '10px' }}>
                <p style={{ color: colors.green, fontSize: '14px', margin: 0, fontWeight: 600 }}>
                  🔐 Conexión segura con Shopify OAuth
                </p>
                <p style={{ color: colors.textSecondary, fontSize: '13px', margin: 0, lineHeight: 1.7 }}>
                  Ingresa tu dominio y haz clic en el botón. Te redirigiremos a Shopify donde inicias sesión y autorizas el acceso. Al terminar, vuelves aquí automáticamente.
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  {[
                    '✅ Sin copiar tokens ni credenciales',
                    '✅ Conexión permanente — no expira',
                    '✅ Revocable desde tu panel de Shopify',
                  ].map(t => (
                    <span key={t} style={{ fontSize: '12px', color: colors.green }}>{t}</span>
                  ))}
                </div>
              </div>

              <Field label="Tu tienda Shopify" hint="Pega la URL de tu admin · Ej: admin.shopify.com/store/szc7zd-ip" colors={colors}>
                <input
                  style={{ ...inp }}
                  value={shopUrl}
                  onChange={e => setShopUrl(e.target.value)}
                  placeholder="admin.shopify.com/store/szc7zd-ip"
                  onKeyDown={e => e.key === 'Enter' && connectShopify()}
                />
              </Field>

            </div>
          </div>
        )}

        {/* ══════════════════════════════════
            PASO 2: Templates de Re-engagement
        ══════════════════════════════════ */}
        {step === 2 && (
          <div style={{ backgroundColor: colors.bgPanel, borderRadius: '16px', border: `1px solid ${colors.border}` }}>
            <div style={{ padding: '20px 24px 16px', borderBottom: `1px solid ${colors.border}` }}>
              <h2 style={{ color: colors.textPrimary, fontSize: '17px', fontWeight: 600, margin: 0 }}>📋 Templates de Re-engagement</h2>
              <p style={{ color: colors.textSecondary, fontSize: '12px', marginTop: '4px', marginBottom: 0 }}>
                Plantillas de mensajes aprobadas por Meta para contactar clientes
              </p>
            </div>

            <div style={{ padding: '24px', display: 'flex', flexDirection: 'column', gap: '20px' }}>

              {/* Banner explicativo */}
              <div style={{ backgroundColor: colors.bgAccent2, borderRadius: '10px', padding: '14px 16px', border: `1px solid ${colors.border}`, display: 'flex', gap: '10px', alignItems: 'flex-start' }}>
                <span style={{ fontSize: '16px', flexShrink: 0 }}>💡</span>
                <p style={{ color: colors.textSecondary, fontSize: '13px', margin: 0, lineHeight: 1.7 }}>
                  Para contactar clientes que no han comprado en un tiempo, WhatsApp requiere templates pre-aprobados. Los creamos automáticamente con el contenido de tu tienda.
                </p>
              </div>

              {!suggestedTemplates.length && !generatingTemplates && !templatesSubmitted && (
                <button
                  onClick={generateTemplates}
                  style={{
                    width: '100%', padding: '16px', borderRadius: '10px', fontSize: '15px', fontWeight: 700,
                    background: `linear-gradient(135deg, ${colors.green} 0%, #00c853 100%)`,
                    color: 'white', cursor: 'pointer', border: 'none',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '10px',
                    boxShadow: `0 4px 12px ${colors.green}44`,
                    transition: 'opacity 0.2s',
                  }}>
                  <Sparkles size={18} /> ✨ Generar templates con IA
                </button>
              )}

              {generatingTemplates && (
                <div style={{ textAlign: 'center', padding: '32px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '12px' }}>
                  <Loader size={28} color={colors.green} style={{ animation: 'spin 1s linear infinite' }} />
                  <span style={{ color: colors.textSecondary, fontSize: '14px' }}>Analizando tu catálogo...</span>
                </div>
              )}

              {/* Cards de templates */}
              {suggestedTemplates.length > 0 && !templatesSubmitted && (
                <>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                    {suggestedTemplates.map((t, i) => (
                      <div key={i} style={{ backgroundColor: colors.bgSub, borderRadius: '10px', border: `1px solid ${colors.border}`, overflow: 'hidden' }}>
                        <div style={{ padding: '12px 14px', display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                              <span style={{ backgroundColor: `${colors.green}22`, color: colors.green, border: `1px solid ${colors.green}44`, borderRadius: '5px', padding: '2px 8px', fontSize: '11px', fontWeight: 700, fontFamily: 'monospace' }}>
                                {t.name}
                              </span>
                              {t.displayName && (
                                <span style={{ color: colors.textPrimary, fontSize: '13px', fontWeight: 600 }}>{t.displayName}</span>
                              )}
                            </div>
                            {editingTemplate === i ? (
                              <textarea
                                value={t.body}
                                onChange={e => setSuggestedTemplates(prev => prev.map((tmpl, idx) => idx === i ? { ...tmpl, body: e.target.value } : tmpl))}
                                rows={4}
                                style={{
                                  width: '100%', backgroundColor: colors.bgInput, color: colors.textPrimary,
                                  border: `1px solid ${colors.green}`, borderRadius: '8px',
                                  padding: '9px 12px', fontSize: '13px', resize: 'vertical', boxSizing: 'border-box',
                                  fontFamily: 'inherit', outline: 'none',
                                }}
                              />
                            ) : (
                              <p style={{ color: colors.textSecondary, fontSize: '13px', margin: 0, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
                                {t.body}
                              </p>
                            )}
                            {t.variables && t.variables.length > 0 && (
                              <div style={{ marginTop: '8px', display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                                {t.variables.map((v, vi) => (
                                  <span key={vi} style={{ backgroundColor: `${colors.green}15`, color: colors.green, fontSize: '11px', borderRadius: '4px', padding: '2px 6px' }}>
                                    {`{{${vi + 1}}}`} = {v}
                                  </span>
                                ))}
                              </div>
                            )}
                            {t.useCase && (
                              <p style={{ color: colors.textMuted, fontSize: '11px', margin: '6px 0 0', fontStyle: 'italic' }}>{t.useCase}</p>
                            )}
                          </div>
                          <button
                            onClick={() => setEditingTemplate(editingTemplate === i ? null : i)}
                            style={{ background: 'none', border: `1px solid ${colors.border}`, borderRadius: '6px', cursor: 'pointer', color: colors.textSecondary, padding: '5px 10px', fontSize: '12px', flexShrink: 0, whiteSpace: 'nowrap' }}>
                            {editingTemplate === i ? 'Guardar' : 'Editar'}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>

                  <button
                    onClick={submitTemplates}
                    disabled={submittingTemplates}
                    style={{
                      width: '100%', padding: '14px', borderRadius: '10px', fontSize: '15px', fontWeight: 700,
                      backgroundColor: submittingTemplates ? colors.bgHover : colors.green,
                      color: 'white', cursor: submittingTemplates ? 'not-allowed' : 'pointer', border: 'none',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
                    }}>
                    {submittingTemplates
                      ? <><Loader size={16} style={{ animation: 'spin 1s linear infinite' }} /> Enviando a Meta...</>
                      : <>Enviar a Meta → <span style={{ fontSize: '12px', fontWeight: 400, opacity: 0.8 }}>revisión en 1-3 días</span></>
                    }
                  </button>
                </>
              )}

              {/* Estado de éxito post-envío */}
              {templatesSubmitted && (
                <div style={{ backgroundColor: colors.bgAccent, borderRadius: '12px', padding: '20px', border: `1px solid ${colors.green}`, textAlign: 'center' }}>
                  <CheckCircle size={36} color={colors.green} style={{ marginBottom: '12px' }} />
                  <div style={{ color: colors.textPrimary, fontSize: '16px', fontWeight: 700, marginBottom: '8px' }}>Templates enviados a Meta</div>
                  <p style={{ color: colors.textSecondary, fontSize: '13px', margin: 0, lineHeight: 1.7 }}>
                    Meta revisará y aprobará los templates en <strong style={{ color: colors.textPrimary }}>1-3 días hábiles</strong>.<br />
                    Una vez aprobados, aparecerán en la sección Templates y podrás usarlos en Re-enganche.
                  </p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ══════════════════════════════════
            PASO 3: Listo
        ══════════════════════════════════ */}
        {step === 3 && (
          <div style={{ backgroundColor: colors.bgPanel, borderRadius: '16px', border: `1px solid ${colors.border}`, padding: '32px 28px', textAlign: 'center' }}>
            <div style={{ fontSize: '52px', marginBottom: '12px' }}>🎉</div>
            <h2 style={{ color: colors.textPrimary, fontSize: '21px', fontWeight: 700, margin: '0 0 8px' }}>¡Todo listo!</h2>
            <p style={{ color: colors.textSecondary, fontSize: '14px', marginBottom: '28px' }}>
              Tu agente IA ya está respondiendo mensajes en WhatsApp.
            </p>

            {shopifyInfo && (
              <div style={{ backgroundColor: colors.bgAccent, borderRadius: '10px', padding: '12px 18px', marginBottom: '20px', border: `1px solid ${colors.green}`, display: 'inline-flex', alignItems: 'center', gap: '8px' }}>
                <CheckCircle size={16} color={colors.green} />
                <span style={{ color: colors.green, fontSize: '13px' }}>
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
                <div key={a.name} style={{ backgroundColor: colors.bgSub, borderRadius: '10px', padding: '14px 16px', border: `1px solid ${colors.border}`, display: 'flex', gap: '12px', alignItems: 'center' }}>
                  <span style={{ fontSize: '22px' }}>{a.emoji}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ color: colors.textPrimary, fontSize: '14px', fontWeight: 500 }}>{a.name}</div>
                    <div style={{ color: colors.textSecondary, fontSize: '12px', marginTop: '2px' }}>{a.desc}</div>
                  </div>
                  <CheckCircle size={18} color={colors.green} />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Mensajes error / éxito */}
        {error && (
          <div style={{ backgroundColor: '#2d1a1a', border: `1px solid ${colors.red}66`, borderRadius: '8px', padding: '12px 16px', color: colors.red, fontSize: '13px', marginTop: '16px', display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
            <AlertCircle size={15} style={{ flexShrink: 0, marginTop: '1px' }} />{error}
          </div>
        )}
        {success && (
          <div style={{ backgroundColor: colors.bgAccent, border: `1px solid ${colors.green}`, borderRadius: '8px', padding: '12px 16px', color: colors.green, fontSize: '13px', marginTop: '16px' }}>
            {success}
          </div>
        )}

        {/* Botones de navegación */}
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
            <button onClick={connectShopify} disabled={loading || !shopUrl.trim()} style={{ ...primary, backgroundColor: (!shopUrl.trim() || loading) ? colors.bgHover : colors.green, cursor: (!shopUrl.trim() || loading) ? 'not-allowed' : 'pointer' }}>
              {loading && <Loader size={16} style={{ animation: 'spin 1s linear infinite' }} />}
              {loading ? 'Redirigiendo a Shopify...' : '🛍️ Autorizar con Shopify →'}
            </button>
          )}
          {step === 2 && (templatesSubmitted || suggestedTemplates.length > 0) && (
            <button onClick={() => go(3)} style={primary}>
              Continuar →
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
          <button
            onClick={() => {
              if (step === 2) go(3);
              else if (step === 1) go(2);
              else go(1);
            }}
            style={{ background: 'none', color: colors.textMuted, fontSize: '12px', width: '100%', textAlign: 'center', marginTop: '10px', padding: '6px', cursor: 'pointer', border: 'none' }}>
            {step === 2 ? 'Configurar templates después' : 'Saltar por ahora'}
          </button>
        )}

      </div>
      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        input:focus { border-color: #00a884 !important; box-shadow: 0 0 0 2px rgba(0,168,132,0.15); }
        textarea:focus { border-color: #00a884 !important; box-shadow: 0 0 0 2px rgba(0,168,132,0.15); }
      `}</style>
    </div>
  );
}
