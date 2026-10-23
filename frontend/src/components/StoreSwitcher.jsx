import { useEffect, useState } from 'react';
import { authAPI, rememberAuthSession, switchAuthSession } from '../utils/api.js';
import { useTheme } from '../theme.js';

export default function StoreSwitcher({ organization }) {
  const { colors } = useTheme();
  const [stores, setStores] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [verify, setVerify] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
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
    try { switchAuthSession(await authAPI.switchOrganization(id)); }
    catch (err) { setError(err.response?.data?.error || 'No pudimos cambiar de tienda'); setBusy(false); }
  }
  async function verifyStores(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const data = await authAPI.verifyOrganizations(password);
      rememberAuthSession(data);
      setStores(data.organizations);
      setVerify(false);
      setNotice(data.organizations.length > 1 ? 'Tus tiendas están listas para cambiar.' : 'Solo se verificó esta tienda con esa contraseña.');
    } catch (err) { setError(err.response?.data?.error || 'No pudimos verificar tus tiendas'); }
    finally { setPassword(''); setBusy(false); }
  }
  const input = { width: '100%', boxSizing: 'border-box', background: colors.bgApp, color: colors.textPrimary,
    border: `1px solid ${colors.borderStrong}`, borderRadius: 8, padding: '9px 10px', font: 'inherit', marginTop: 6 };
  const options = stores.length ? stores : [{ organization_id: organization.id, name: organization.name }];
  return (
    <section aria-label="Cambiar de tienda" aria-busy={busy || loading} style={{ padding: '8px 10px 12px', fontSize: 13 }}>
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
      {notice && <p role="status" style={{ color: colors.textSecondary }}>{notice}</p>}
      {error && <p role="alert" style={{ color: colors.red }}>{error}</p>}
    </section>
  );
}
