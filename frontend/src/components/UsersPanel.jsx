import { useState, useEffect } from 'react';
import { UserCog, Plus, Trash2, X, Smartphone, Bell, BellOff, ChevronDown, ChevronUp } from 'lucide-react';
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
  supervisor: { label: 'Supervisor', bg: '#d9770622', color: '#d97706' },
  agent:      { label: 'Agente',     bg: '#64748b22', color: '#64748b' },
};

const NOTIF_LABELS = {
  new_messages: { label: 'Nuevos mensajes', desc: 'Aviso cuando un cliente escribe' },
  escalations:  { label: 'Escalaciones',    desc: 'Aviso cuando el bot escala' },
  payments:     { label: 'Comprobantes de pago', desc: 'Aviso cuando llega un pago' },
};

export default function UsersPanel() {
  const { colors } = useTheme();
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Crear usuario
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ email: '', password: '', name: '', role: 'agent' });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState(null);

  // Estado expandido por usuario (teléfono + notificaciones)
  const [expanded, setExpanded] = useState({}); // userId → boolean
  const [phoneEdits, setPhoneEdits] = useState({}); // userId → string
  const [savingPhone, setSavingPhone] = useState({}); // userId → boolean
  const [savingNotif, setSavingNotif] = useState({}); // userId → boolean
  const [changingRole, setChangingRole] = useState(null);
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

  const handleSavePhone = async (userId) => {
    const phone = (phoneEdits[userId] || '').replace(/[^\d+]/g, '');
    setSavingPhone(p => ({ ...p, [userId]: true }));
    try {
      const res = await api.patch(`/users/${userId}`, { whatsapp_phone: phone || null });
      setUsers(prev => prev.map(u => u.id === userId ? { ...u, whatsapp_phone: res.data.data.whatsapp_phone } : u));
    } catch (e) {
      alert(e.response?.data?.error || 'Error al guardar teléfono');
    } finally {
      setSavingPhone(p => ({ ...p, [userId]: false }));
    }
  };

  const handleToggleNotif = async (userId, key, current) => {
    const user = users.find(u => u.id === userId);
    const prefs = { new_messages: false, escalations: true, payments: false, ...(user?.wa_notifications || {}) };
    const updated = { ...prefs, [key]: !current };

    setSavingNotif(p => ({ ...p, [userId]: true }));
    try {
      await api.patch(`/users/${userId}`, { wa_notifications: updated });
      setUsers(prev => prev.map(u => u.id === userId ? { ...u, wa_notifications: updated } : u));
    } catch (e) {
      alert('Error al guardar preferencias');
    } finally {
      setSavingNotif(p => ({ ...p, [userId]: false }));
    }
  };

  const toggleExpand = (userId, u) => {
    setExpanded(prev => ({ ...prev, [userId]: !prev[userId] }));
    if (!phoneEdits[userId]) {
      setPhoneEdits(p => ({ ...p, [userId]: u.whatsapp_phone || '' }));
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
            <p style={{ margin: 0, fontSize: '13px', color: colors.textSecondary }}>Gestión de usuarios, roles y comandos WhatsApp</p>
          </div>
        </div>
        <button onClick={() => { setShowCreate(true); setFormError(null); }}
          style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '8px 16px', borderRadius: '8px', backgroundColor: colors.green, color: 'white', border: 'none', cursor: 'pointer', fontWeight: 600, fontSize: '14px' }}>
          <Plus size={16} />Agregar usuario
        </button>
      </div>

      {/* Info WA commands */}
      <div style={{ marginBottom: '20px', padding: '14px 18px', borderRadius: '10px', backgroundColor: colors.green + '11', border: `1px solid ${colors.green}33`, fontSize: '13px', color: colors.textSecondary }}>
        <span style={{ fontWeight: 600, color: colors.green }}>📱 Comandos WhatsApp</span>{' '}
        Los usuarios con teléfono WA registrado pueden enviar comandos al número del negocio:{' '}
        <span style={{ fontFamily: 'monospace', color: colors.textPrimary }}>CHATS, VER, MSG, PEDIDOS, PAGAR, PAUSAR, ACTIVAR, AYUDA</span>
      </div>

      {/* Modal crear */}
      {showCreate && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 50, backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ backgroundColor: colors.bgCard, borderRadius: '12px', padding: '28px', width: '400px', maxWidth: '90vw', boxShadow: '0 20px 60px rgba(0,0,0,0.4)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
              <h2 style={{ margin: 0, fontSize: '16px', fontWeight: 700, color: colors.textPrimary }}>Nuevo usuario</h2>
              <button onClick={() => setShowCreate(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: colors.textSecondary }}><X size={18} /></button>
            </div>
            <form onSubmit={handleCreate}>
              {[
                { label: 'Email', key: 'email', type: 'email', placeholder: 'usuario@empresa.com' },
                { label: 'Contraseña', key: 'password', type: 'password', placeholder: 'Mínimo 6 caracteres' },
                { label: 'Nombre (opcional)', key: 'name', type: 'text', placeholder: 'Nombre del usuario' },
              ].map(({ label, key, type, placeholder }) => (
                <div key={key} style={{ marginBottom: '14px' }}>
                  <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: colors.textSecondary, marginBottom: '4px' }}>{label}</label>
                  <input type={type} value={form[key]} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))} placeholder={placeholder} required={key !== 'name'}
                    style={{ width: '100%', boxSizing: 'border-box', padding: '8px 12px', borderRadius: '8px', border: `1px solid ${colors.border}`, backgroundColor: colors.bgInput, color: colors.textPrimary, fontSize: '14px' }} />
                </div>
              ))}
              <div style={{ marginBottom: '20px' }}>
                <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: colors.textSecondary, marginBottom: '4px' }}>Rol</label>
                <select value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))}
                  style={{ width: '100%', padding: '8px 12px', borderRadius: '8px', border: `1px solid ${colors.border}`, backgroundColor: colors.bgInput, color: colors.textPrimary, fontSize: '14px' }}>
                  {ROLES.map(r => <option key={r.value} value={r.value}>{r.label} — {r.desc}</option>)}
                </select>
              </div>
              {formError && <p style={{ margin: '0 0 12px', fontSize: '13px', color: '#ef4444' }}>{formError}</p>}
              <div style={{ display: 'flex', gap: '10px' }}>
                <button type="button" onClick={() => setShowCreate(false)}
                  style={{ flex: 1, padding: '9px', borderRadius: '8px', border: `1px solid ${colors.border}`, background: 'none', color: colors.textSecondary, cursor: 'pointer', fontSize: '14px' }}>Cancelar</button>
                <button type="submit" disabled={saving}
                  style={{ flex: 1, padding: '9px', borderRadius: '8px', border: 'none', backgroundColor: colors.green, color: 'white', cursor: saving ? 'wait' : 'pointer', fontWeight: 600, fontSize: '14px', opacity: saving ? 0.7 : 1 }}>
                  {saving ? 'Creando…' : 'Crear usuario'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Tabla */}
      <div style={{ backgroundColor: colors.bgCard, borderRadius: '12px', border: `1px solid ${colors.border}`, overflow: 'hidden' }}>
        {loading ? (
          <p style={{ padding: '32px', textAlign: 'center', color: colors.textSecondary }}>Cargando…</p>
        ) : error ? (
          <p style={{ padding: '32px', textAlign: 'center', color: '#ef4444' }}>{error}</p>
        ) : users.length === 0 ? (
          <p style={{ padding: '32px', textAlign: 'center', color: colors.textSecondary }}>No hay usuarios en esta organización</p>
        ) : (
          users.map((u, i) => {
            const badge = ROLE_BADGES[u.role] || ROLE_BADGES.agent;
            const isOwner = u.role === 'owner';
            const isExpanded = expanded[u.id];
            const prefs = { new_messages: false, escalations: true, payments: false, ...(u.wa_notifications || {}) };

            return (
              <div key={u.id} style={{ borderBottom: i < users.length - 1 ? `1px solid ${colors.border}` : 'none' }}>
                {/* Fila principal */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto auto auto', alignItems: 'center', padding: '14px 16px', gap: '12px' }}>
                  {/* Nombre */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                    <div style={{ width: '34px', height: '34px', borderRadius: '50%', backgroundColor: colors.green + '22', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '13px', fontWeight: 700, color: colors.green, flexShrink: 0 }}>
                      {(u.name || u.email)[0].toUpperCase()}
                    </div>
                    <div>
                      <div style={{ fontSize: '14px', fontWeight: 600, color: colors.textPrimary }}>{u.name || '—'}</div>
                      <div style={{ fontSize: '12px', color: colors.textSecondary }}>{u.email}</div>
                    </div>
                  </div>

                  {/* Rol */}
                  <div>
                    {isOwner ? (
                      <span style={{ padding: '3px 10px', borderRadius: '20px', fontSize: '12px', fontWeight: 600, backgroundColor: badge.bg, color: badge.color }}>{badge.label}</span>
                    ) : (
                      <select value={u.role} disabled={changingRole === u.id} onChange={e => handleRoleChange(u.id, e.target.value)}
                        style={{ padding: '4px 10px', borderRadius: '20px', border: `1px solid ${colors.border}`, backgroundColor: badge.bg, color: badge.color, fontSize: '12px', fontWeight: 600, cursor: 'pointer' }}>
                        {ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                      </select>
                    )}
                  </div>

                  {/* Indicador WA */}
                  <div title={u.whatsapp_phone ? `WA: ${u.whatsapp_phone}` : 'Sin teléfono WA'}>
                    <Smartphone size={15} color={u.whatsapp_phone ? colors.green : colors.textSecondary} />
                  </div>

                  {/* Expandir */}
                  <button onClick={() => toggleExpand(u.id, u)} title="Configurar WA"
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: colors.textSecondary, padding: '4px', borderRadius: '6px' }}>
                    {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                  </button>

                  {/* Eliminar */}
                  {!isOwner ? (
                    <button onClick={() => handleDelete(u.id, u.email)} disabled={deletingId === u.id} title="Eliminar usuario"
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: deletingId === u.id ? colors.textSecondary : '#ef4444', padding: '4px', borderRadius: '6px', opacity: deletingId === u.id ? 0.5 : 1 }}>
                      <Trash2 size={15} />
                    </button>
                  ) : <div style={{ width: '22px' }} />}
                </div>

                {/* Panel expandido — Teléfono WA + Notificaciones */}
                {isExpanded && (
                  <div style={{ borderTop: `1px solid ${colors.border}`, padding: '16px 20px', backgroundColor: colors.bgApp }}>
                    {/* Teléfono WA */}
                    <div style={{ marginBottom: '16px' }}>
                      <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: colors.textSecondary, marginBottom: '6px' }}>
                        📱 Teléfono WhatsApp personal
                      </label>
                      <div style={{ display: 'flex', gap: '8px' }}>
                        <input
                          type="tel"
                          value={phoneEdits[u.id] ?? (u.whatsapp_phone || '')}
                          onChange={e => setPhoneEdits(p => ({ ...p, [u.id]: e.target.value }))}
                          placeholder="56987654321"
                          style={{ flex: 1, padding: '7px 12px', borderRadius: '8px', border: `1px solid ${colors.border}`, backgroundColor: colors.bgInput, color: colors.textPrimary, fontSize: '13px' }}
                        />
                        <button onClick={() => handleSavePhone(u.id)} disabled={savingPhone[u.id]}
                          style={{ padding: '7px 16px', borderRadius: '8px', border: 'none', backgroundColor: colors.green, color: 'white', cursor: 'pointer', fontSize: '13px', fontWeight: 600, opacity: savingPhone[u.id] ? 0.7 : 1 }}>
                          {savingPhone[u.id] ? '…' : 'Guardar'}
                        </button>
                      </div>
                      <p style={{ margin: '4px 0 0', fontSize: '11px', color: colors.textSecondary }}>
                        Con este número el usuario puede enviar comandos al número del negocio.
                      </p>
                    </div>

                    {/* Notificaciones */}
                    <div>
                      <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, color: colors.textSecondary, marginBottom: '8px' }}>
                        🔔 Notificaciones WhatsApp {!u.whatsapp_phone && <span style={{ color: '#f59e0b' }}>(requiere teléfono)</span>}
                      </label>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        {Object.entries(NOTIF_LABELS).map(([key, { label, desc }]) => {
                          const active = !!prefs[key];
                          return (
                            <div key={key} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', borderRadius: '8px', border: `1px solid ${colors.border}`, backgroundColor: colors.bgCard }}>
                              <div>
                                <div style={{ fontSize: '13px', fontWeight: 500, color: colors.textPrimary }}>{label}</div>
                                <div style={{ fontSize: '11px', color: colors.textSecondary }}>{desc}</div>
                              </div>
                              <button
                                onClick={() => handleToggleNotif(u.id, key, active)}
                                disabled={savingNotif[u.id] || !u.whatsapp_phone}
                                style={{
                                  padding: '5px 14px', borderRadius: '20px', border: 'none', cursor: u.whatsapp_phone ? 'pointer' : 'not-allowed',
                                  backgroundColor: active ? colors.green : colors.border,
                                  color: active ? 'white' : colors.textSecondary,
                                  fontSize: '12px', fontWeight: 600,
                                  opacity: !u.whatsapp_phone ? 0.5 : 1,
                                  display: 'flex', alignItems: 'center', gap: '4px',
                                }}>
                                {active ? <><Bell size={12} /> Activo</> : <><BellOff size={12} /> Inactivo</>}
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Leyenda de roles */}
      <div style={{ marginTop: '20px', display: 'flex', flexWrap: 'wrap', gap: '12px' }}>
        {ROLES.map(r => {
          const badge = ROLE_BADGES[r.value];
          return (
            <div key={r.value} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: colors.textSecondary }}>
              <span style={{ padding: '2px 8px', borderRadius: '20px', backgroundColor: badge.bg, color: badge.color, fontWeight: 600, fontSize: '11px' }}>{badge.label}</span>
              — {r.desc}
            </div>
          );
        })}
      </div>
    </div>
  );
}
