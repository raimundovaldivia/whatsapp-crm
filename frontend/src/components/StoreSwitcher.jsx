import { useEffect, useRef, useState } from 'react';
import { ArrowRightLeft, X } from 'lucide-react';
import { authAPI } from '../utils/api.js';
import { authSession } from '../utils/browser-session.js';
import { useTheme } from '../theme.js';

export default function StoreSwitcher({ user, organization, onClose }) {
  const { colors } = useTheme();
  const dialog = useRef(null);
  const passwordInput = useRef(null);
  const active = useRef(true);
  const [password, setPassword] = useState('');
  const [choices, setChoices] = useState(null);
  const [verifiedSession, setVerifiedSession] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    active.current = true;
    const element = dialog.current;
    element.showModal();
    passwordInput.current?.focus();
    return () => { active.current = false; element.close(); };
  }, []);

  const validateAccount = data => {
    if (data?.user?.email?.toLowerCase() !== user.email.toLowerCase()) throw new Error('La cuenta recibida no corresponde a este correo.');
    return data;
  };

  const verify = async event => {
    event.preventDefault();
    setBusy(true); setError('');
    try {
      const data = await authAPI.login({ email: user.email, password });
      if (!active.current) return;
      if (data.needsOrganization) {
        setChoices(data.organizations);
      } else {
        validateAccount(data);
        setVerifiedSession(data);
        setChoices([{ organization_id: data.organization.id, name: data.organization.name, role: data.user.role }]);
        setPassword('');
      }
    } catch (err) {
      if (active.current) setError(err.response?.data?.error || err.message || 'No se pudo verificar el acceso.');
    } finally { if (active.current) setBusy(false); }
  };

  const choose = async id => {
    setBusy(true); setError('');
    try {
      const data = verifiedSession || await authAPI.login({ email: user.email, password, organizationId: id });
      if (!active.current) return;
      validateAccount(data);
      if (data.organization?.id !== id) throw new Error('No se pudo entrar a la tienda elegida.');
      authSession.save(data, { switchStore: true });
    } catch (err) {
      if (active.current) { setError(err.response?.data?.error || err.message || 'No se pudo cambiar de tienda.'); setBusy(false); }
    }
  };

  const button = { border: `1px solid ${colors.border}`, borderRadius: 10, padding: '12px 14px', background: colors.bgSub, color: colors.textPrimary, cursor: busy ? 'wait' : 'pointer', fontSize: 14 };
  return (
    <dialog ref={dialog} aria-labelledby="store-switch-title" aria-describedby="store-switch-description"
      onCancel={event => { event.preventDefault(); onClose(); }}
      style={{ width: 'min(440px, calc(100vw - 32px))', margin: 'auto', inset: 0, boxSizing: 'border-box', maxHeight: 'calc(100dvh - 32px)', padding: 24, borderRadius: 18, border: `1px solid ${colors.border}`, background: colors.bgPanel, color: colors.textPrimary, boxShadow: '0 24px 80px rgba(0,0,0,.4)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <h2 id="store-switch-title" style={{ margin: 0, display: 'flex', gap: 10, alignItems: 'center', fontSize: 20 }}><ArrowRightLeft size={22} /> Cambiar tienda</h2>
        <button type="button" aria-label="Cerrar cambio de tienda" onClick={onClose} style={{ ...button, padding: 7 }}><X size={18} /></button>
      </div>
      <p style={{ margin: '16px 0 10px', fontSize: 14, lineHeight: 1.6, overflowWrap: 'anywhere' }}>Estás en <strong>{organization.name}</strong><br />{user.email}</p>
      <p id="store-switch-description" style={{ marginBottom: 16, color: colors.textSecondary, fontSize: 13, lineHeight: 1.6 }}>Ingresa la contraseña de la tienda a la que quieres entrar. Guarda tus cambios antes de continuar.</p>
      {error && <p role="alert" style={{ color: colors.red, fontSize: 14 }}>{error}</p>}
      {!choices ? (
        <form onSubmit={verify} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <label htmlFor="store-switch-password" style={{ fontSize: 14 }}>Contraseña</label>
          <input ref={passwordInput} id="store-switch-password" type="password" autoComplete="current-password" autoFocus required maxLength={128}
            value={password} disabled={busy} onChange={event => setPassword(event.target.value)}
            style={{ ...button, boxSizing: 'border-box', width: '100%', cursor: 'text' }} />
          <button type="submit" disabled={busy || !password} style={{ ...button, background: colors.green, color: 'white', fontWeight: 600 }}>{busy ? 'Verificando…' : 'Ver mis tiendas'}</button>
        </form>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <p style={{ fontSize: 14, margin: '0 0 4px' }}>Elige la tienda que quieres abrir:</p>
          {choices.map(choice => (
            <button key={choice.organization_id} type="button" disabled={busy || choice.organization_id === organization.id}
              onClick={() => choose(choice.organization_id)} style={{ ...button, textAlign: 'left', opacity: choice.organization_id === organization.id ? 0.65 : 1 }}>
              <strong>{choice.name || choice.slug}</strong>
              <span style={{ display: 'block', marginTop: 4, fontSize: 12, color: colors.textSecondary }}>{choice.organization_id === organization.id ? 'Tienda actual' : 'Entrar a esta tienda'}</span>
            </button>
          ))}
          <p style={{ color: colors.textSecondary, fontSize: 12, lineHeight: 1.6 }}>Si falta una tienda, prueba con la contraseña que usas en ella.</p>
          <button type="button" disabled={busy} onClick={() => { setChoices(null); setVerifiedSession(null); setPassword(''); setError(''); }} style={button}>Usar otra contraseña</button>
        </div>
      )}
      <p role="status" aria-live="polite" style={{ fontSize: 13 }}>{busy && choices ? 'Abriendo tienda…' : ''}</p>
    </dialog>
  );
}
