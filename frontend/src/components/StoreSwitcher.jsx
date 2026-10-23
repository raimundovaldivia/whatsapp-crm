import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { authAPI } from '../utils/api.js';
import { authSession } from '../utils/browser-session.js';
import { useTheme } from '../theme.js';

export default function StoreSwitcher({ organization, onClose }) {
  const { colors } = useTheme();
  const dialog = useRef(null);
  const active = useRef(true);
  const [stores, setStores] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [verify, setVerify] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    active.current = true;
    const element = dialog.current;
    element.showModal();
    return () => { active.current = false; element.close(); };
  }, []);
  useEffect(() => {
    let active = true;
    authAPI.organizations()
      .then(data => { if (active) setStores(data.organizations); })
      .catch(() => { if (active) setError('No pudimos cargar tus tiendas. Vuelve a abrir este menú.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  async function changeStore(event) {
    const id = Number(event.target.value);
    if (!id || id === organization.id || busy) return;
    setBusy(true); setError('');
    try {
      const data = await authAPI.switchOrganization(id);
      if (active.current) authSession.save(data, { switchStore: true });
    }
    catch (err) { if (active.current) { setError(err.response?.data?.error || 'No pudimos cambiar de tienda'); setBusy(false); } }
  }
  async function verifyStores(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError('');
    try {
      const data = await authAPI.verifyOrganizations(password);
      // Reload also reconnects the socket with the refreshed session token.
      if (active.current) authSession.save(data, { switchStore: true });
    } catch (err) { if (active.current) setError(err.response?.data?.error || 'No pudimos verificar tus tiendas'); }
    finally { if (active.current) { setPassword(''); setBusy(false); } }
  }
  const input = { width: '100%', boxSizing: 'border-box', background: colors.bgApp, color: colors.textPrimary,
    border: `1px solid ${colors.borderStrong}`, borderRadius: 8, padding: '9px 10px', font: 'inherit', marginTop: 6 };
  const options = stores.length ? stores : [{ organization_id: organization.id, name: organization.name }];
  return (
    <dialog ref={dialog} aria-labelledby="store-switch-title" aria-busy={busy || loading}
      onCancel={event => { event.preventDefault(); onClose(); }}
      style={{ width: 'min(440px, calc(100vw - 32px))', margin: 'auto', inset: 0, boxSizing: 'border-box', maxHeight: 'calc(100dvh - 32px)', padding: 24, borderRadius: 18, border: `1px solid ${colors.border}`, background: colors.bgPanel, color: colors.textPrimary, boxShadow: '0 24px 80px rgba(0,0,0,.4)', fontSize: 13 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 18 }}>
        <h2 id="store-switch-title" style={{ margin: 0, fontSize: 20 }}>Cambiar tienda</h2>
        <button type="button" aria-label="Cerrar cambio de tienda" onClick={onClose} style={{ border: 0, background: 'none', color: colors.textPrimary, cursor: 'pointer' }}><X size={20} /></button>
      </div>
      <label style={{ color: colors.textSecondary, display: 'block' }}>
        Tienda activa
        <select aria-label="Tienda activa" value={organization.id} onChange={changeStore} disabled={busy || loading} style={input}>
          {options.map(store => <option value={store.organization_id} key={store.organization_id}>{store.name}</option>)}
        </select>
      </label>
      <p style={{ color: colors.textMuted, fontSize: 11, lineHeight: 1.5, margin: '7px 0' }}>Cada tienda conserva su propio bot y sus datos. Guarda los cambios pendientes antes de cambiar.</p>
      <button type="button" disabled={busy || loading} onClick={() => { setVerify(!verify); setPassword(''); setError(''); }}
        style={{ background: 'none', border: 'none', color: colors.green, padding: '4px 0', cursor: 'pointer', fontSize: 12 }}>
        {verify ? 'Cancelar' : 'Verificar otra tienda de mi cuenta'}
      </button>
      {verify && <form onSubmit={verifyStores}>
        <p style={{ color: colors.textSecondary, fontSize: 12, lineHeight: 1.5 }}>Confirma la contraseña de la tienda que falta. Debe usar tu mismo correo. Solo se pide una vez durante esta sesión.</p>
        <label style={{ color: colors.textSecondary }}>Contraseña
          <input aria-label="Contraseña de la tienda" type="password" autoComplete="current-password" maxLength={128} required value={password} onChange={event => setPassword(event.target.value)} style={input} />
        </label>
        <button type="submit" disabled={busy || !password} style={{ ...input, background: colors.green, color: 'white', cursor: 'pointer' }}>Verificar tiendas</button>
      </form>}
      {busy && <p role="status" style={{ color: colors.textSecondary }}>Preparando tu tienda…</p>}
      {error && <p role="alert" style={{ color: colors.red }}>{error}</p>}
    </dialog>
  );
}
