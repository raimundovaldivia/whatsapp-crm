import { useState, useEffect } from 'react';
import { UserCog, Plus, Trash2, ChevronDown, X, Check } from 'lucide-react';
import { useTheme } from '../theme.js';
import { api } from '../utils/api.js';

const ROLES = [
  { value: 'admin',      label: 'Admin',      desc: 'Acceso completo' },
  { value: 'supervisor', label: 'Supervisor',  desc: 'Chats, pedidos, repartos, pagos' },
  { value: 'agent',      label: 'Agente',      desc: 'Solo chats' },
];

const ROLE_BADGES = {
  owner:      { label: 'Owner',      bg: '#7c3aed22', color: '#7c3aed' },
  admin:      { label: 'Admin',      bg: '#16a34a22', color: '#16a34a' },
  supervisor: { label: 'Supervisor', bg: '#d97706222', color: '#d97706' },
  agent:      { label: 'Agente',     bg: '#64748b22', color: '#64748b' },
};

export default function UsersPanel() {
  const { colors } = useTheme();
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ email: '', password: '', name: '', role: 'agent' });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState(null);
  const [changingRole, setChangingRole] = useState(null); // userId being changed
  const [deletingId, setDeletingId] = useState(null);

  const loadUsers = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get('/users');
      setUsers(res.data.data || []);
    } catch (e) {
      setError('Error al cargar usuarios');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadUsers(); }, []);

  const handleCreate = async (e) => {
    e.preventDefault();
    setSaving(true);
    setFormError(null);
    try {
      await api.post('/users', form);
      setShowCreate(false);
      setForm({ email: '', password: '', name: '', role: 'agent' });
      await loadUsers();
    } catch (e) {
      setFormError(e.response?.data?.error || 'Error al crear usuario');
    } finally {
      setSaving(false);
    }
  };

  const handleRoleChange = async (userId, newRole) => {
    setChangingRole(userId);
    try {
      await api.patch(`/users/${userId}/role`, { role: newRole });
      setUsers(prev => prev.map(u => u.id === userId ? { ...u, role: newRole } : u));
    } catch (e) {
      alert(e.response?.data?.error || 'Error al cambiar rol');
    } finally {
      setChangingRole(null);
    }
  };

  const handleDelete = async (userId, userEmail) => {
    if (!confirm(`¿Eliminar al usuario ${userEmail}? Esta acción no se puede deshacer.`)) return;
    setDeletingId(userId);
    try {
      await api.delete(`/users/${userId}`);
      setUsers(prev => prev.filter(u => u.id !== userId));
    } catch (e) {
      alert(e.response?.data?.error || 'Error al eliminar usuario');
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div style={{
      flex: 1, height: '100vh', overflow: 'auto',
      backgroundColor: colors.bgApp, padding: '32px',
      fontFamily: 'system-ui, sans-serif',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '28px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <UserCog size={24} color={colors.green} />
          <div>
            <h1 style={{ margin: 0, fontSize: '20px', fontWeight: 700, color: colors.textPrimary }}>Equipo</h1>
            <p style={{ margin: 0, fontSize: '13px', color: colors.textSecondary }}>Gestión de usuarios y roles</p>
          </div>
        </div>
        <button
          onClick={() => { setShowCreate(true); setFormError(null); }}
          style={{
            display: 'flex', alignItems: 'center', gap: '6px',
            padding: '8px 16px', borderRadius: '8px',
            backgroundColor: colors.green, color: 'white',
            border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: '14px',
          }}>
          <Plus size={16} />
          Agregar usuario
        </button>
      </div>

      {/* Modal crear usuario */}
      {showCreate && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 50,
          backgroundColor: 'rgba(0,0,0,0.5)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div style={{
            backgroundColor: colors.bgCard, borderRadius: '12px',
            padding: '28px', width: '400px', maxWidth: '90vw',
            boxShadow: '0 20px 60px rgba(0,0,0,0.4)',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h2 style={{ margin: 0, fontSize: '16px', fontWeight: 700, color: colors.textPrimary }}>Nuevo usuario</h2>
              <button onClick={() => setShowCreate(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: colors.textSecondary }}>
                <X size={18} />
              </button>
            </div>
            <form onSubmit={handleCreate}>
              {[
                { label: 'Email', key: 'email', type: 'email', placeholder: 'usuario@empresa.com' },
                { label: 'Contraseña', key: 'password', type: 'password', placeholder: 'Mínimo 6 caracteres' },
                { label: 'Nombre (opcional)', key: 'name', type: 'text', placeholder: 'Nombre del usuario' },
              ].map(({ label, key, type, placeholder }) => (
                <div key={key} style={{ marginBottom: '14px' }}>
                  <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: colors.textSecondary, marginBottom: '4px' }}>
                    {label}
                  </label>
                  <input
                    type={type}
                    value={form[key]}
                    onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                    placeholder={placeholder}
                    required={key !== 'name'}
                    style={{
                      width: '100%', boxSizing: 'border-box',
                      padding: '8px 12px', borderRadius: '8px',
                      border: `1px solid ${colors.border}`,
                      backgroundColor: colors.bgInput || colors.bgApp,
                      color: colors.textPrimary, fontSize: '14px',
                    }}
                  />
                </div>
              ))}
              <div style={{ marginBottom: '20px' }}>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: colors.textSecondary, marginBottom: '4px' }}>Rol</label>
                <select
                  value={form.role}
                  onChange={e => setForm(f => ({ ...f, role: e.target.value }))}
                  style={{
                    width: '100%', padding: '8px 12px', borderRadius: '8px',
                    border: `1px solid ${colors.border}`,
                    backgroundColor: colors.bgInput || colors.bgApp,
                    color: colors.textPrimary, fontSize: '14px',
                  }}>
                  {ROLES.map(r => (
                    <option key={r.value} value={r.value}>{r.label} — {r.desc}</option>
                  ))}
                </select>
              </div>
              {formError && (
                <p style={{ margin: '0 0 12px', fontSize: '13px', color: '#ef4444' }}>{formError}</p>
              )}
              <div style={{ display: 'flex', gap: '10px' }}>
                <button type="button" onClick={() => setShowCreate(false)}
                  style={{ flex: 1, padding: '9px', borderRadius: '8px', border: `1px solid ${colors.border}`, background: 'none', color: colors.textSecondary, cursor: 'pointer', fontSize: '14px' }}>
                  Cancelar
                </button>
                <button type="submit" disabled={saving}
                  style={{ flex: 1, padding: '9px', borderRadius: '8px', border: 'none', backgroundColor: colors.green, color: 'white', cursor: saving ? 'wait' : 'pointer', fontWeight: 600, fontSize: '14px', opacity: saving ? 0.7 : 1 }}>
                  {saving ? 'Creando…' : 'Crear usuario'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Tabla de usuarios */}
      <div style={{
        backgroundColor: colors.bgCard, borderRadius: '12px',
        border: `1px solid ${colors.border}`, overflow: 'hidden',
      }}>
        {loading ? (
          <p style={{ padding: '32px', textAlign: 'center', color: colors.textSecondary }}>Cargando…</p>
        ) : error ? (
          <p style={{ padding: '32px', textAlign: 'center', color: '#ef4444' }}>{error}</p>
        ) : users.length === 0 ? (
          <p style={{ padding: '32px', textAlign: 'center', color: colors.textSecondary }}>No hay usuarios en esta organización</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${colors.border}` }}>
                {['Usuario', 'Email', 'Rol', 'Creado', ''].map(h => (
                  <th key={h} style={{ padding: '12px 16px', textAlign: 'left', fontSize: '12px', fontWeight: 600, color: colors.textSecondary, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {users.map((u, i) => {
                const badge = ROLE_BADGES[u.role] || ROLE_BADGES.agent;
                const isOwner = u.role === 'owner';
                return (
                  <tr key={u.id} style={{ borderBottom: i < users.length - 1 ? `1px solid ${colors.border}` : 'none' }}>
                    <td style={{ padding: '14px 16px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                        <div style={{
                          width: '34px', height: '34px', borderRadius: '50%',
                          backgroundColor: colors.green + '22',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: '13px', fontWeight: 700, color: colors.green,
                        }}>
                          {(u.name || u.email)[0].toUpperCase()}
                        </div>
                        <span style={{ fontSize: '14px', fontWeight: 600, color: colors.textPrimary }}>
                          {u.name || '—'}
                        </span>
                      </div>
                    </td>
                    <td style={{ padding: '14px 16px', fontSize: '13px', color: colors.textSecondary }}>{u.email}</td>
                    <td style={{ padding: '14px 16px' }}>
                      {isOwner ? (
                        <span style={{ padding: '3px 10px', borderRadius: '20px', fontSize: '12px', fontWeight: 600, backgroundColor: badge.bg, color: badge.color }}>
                          {badge.label}
                        </span>
                      ) : (
                        <select
                          value={u.role}
                          disabled={changingRole === u.id}
                          onChange={e => handleRoleChange(u.id, e.target.value)}
                          style={{
                            padding: '4px 10px', borderRadius: '20px',
                            border: `1px solid ${colors.border}`,
                            backgroundColor: badge.bg,
                            color: badge.color,
                            fontSize: '12px', fontWeight: 600, cursor: 'pointer',
                          }}>
                          {ROLES.map(r => (
                            <option key={r.value} value={r.value}>{r.label}</option>
                          ))}
                        </select>
                      )}
                    </td>
                    <td style={{ padding: '14px 16px', fontSize: '12px', color: colors.textSecondary }}>
                      {new Date(u.created_at).toLocaleDateString('es-CL', { day: '2-digit', month: 'short', year: 'numeric' })}
                    </td>
                    <td style={{ padding: '14px 16px', textAlign: 'right' }}>
                      {!isOwner && (
                        <button
                          onClick={() => handleDelete(u.id, u.email)}
                          disabled={deletingId === u.id}
                          title="Eliminar usuario"
                          style={{
                            background: 'none', border: 'none', cursor: 'pointer',
                            color: deletingId === u.id ? colors.textSecondary : '#ef4444',
                            padding: '6px', borderRadius: '6px',
                            opacity: deletingId === u.id ? 0.5 : 1,
                          }}>
                          <Trash2 size={15} />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Leyenda de roles */}
      <div style={{ marginTop: '20px', display: 'flex', flexWrap: 'wrap', gap: '12px' }}>
        {ROLES.map(r => {
          const badge = ROLE_BADGES[r.value];
          return (
            <div key={r.value} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: colors.textSecondary }}>
              <span style={{ padding: '2px 8px', borderRadius: '20px', backgroundColor: badge.bg, color: badge.color, fontWeight: 600, fontSize: '11px' }}>
                {badge.label}
              </span>
              — {r.desc}
            </div>
          );
        })}
      </div>
    </div>
  );
}
