import { useEffect, useMemo, useState } from 'react';
import {
  Award, CheckCircle2, Link2, Loader2, Plus, RefreshCw,
  Search, Share2, ToggleLeft, ToggleRight, UserPlus, Users, XCircle,
} from 'lucide-react';
import { referralsAPI } from '../utils/api.js';
import { useTheme } from '../theme.js';
import * as ui from '../ui.js';
import ReferralProgram from './ReferralProgram.jsx';

const STATUS = {
  pending: { label: 'Pendiente', color: 'warning' },
  qualified: { label: 'Calificado', color: 'info' },
  rewarded: { label: 'Premiado', color: 'success' },
  rejected: { label: 'Rechazado', color: 'danger' },
};

function errorMessage(error, fallback) {
  return error?.response?.data?.error || fallback;
}

function formatDate(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('es-CL', {
    timeZone: 'America/Santiago', day: '2-digit', month: 'short', year: 'numeric',
  }).format(new Date(value));
}

export default function ReferralsPanel() {
  const { colors } = useTheme();
  const [payload, setPayload] = useState({
    data: [], codes: [], summary: {},
    settings: { enabled: false, reward_referrer: '', reward_referred: '', terms: '' },
  });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [search, setSearch] = useState('');
  const [contactQuery, setContactQuery] = useState('');
  const [contactOptions, setContactOptions] = useState([]);
  const [selectedContact, setSelectedContact] = useState(null);
  const [claim, setClaim] = useState({ code: '', referred_phone: '', referred_name: '', notes: '' });

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const data = await referralsAPI.list({ status: statusFilter || undefined, search: search || undefined });
      setPayload(data);
      if (!claim.code && data.codes?.length) {
        setClaim(current => ({ ...current, code: data.codes.find(item => item.active)?.code || '' }));
      }
    } catch (requestError) {
      setError(errorMessage(requestError, 'No se pudo cargar el programa de referidos.'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [statusFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (contactQuery.trim().length < 2 || selectedContact) {
      setContactOptions([]);
      return undefined;
    }
    const timer = setTimeout(async () => {
      try { setContactOptions(await referralsAPI.suggestContacts(contactQuery.trim())); }
      catch { setContactOptions([]); }
    }, 250);
    return () => clearTimeout(timer);
  }, [contactQuery, selectedContact]);

  const activeCodes = useMemo(() => payload.codes.filter(item => item.active), [payload.codes]);

  const act = async (key, operation, successText) => {
    setBusy(key); setError(''); setNotice('');
    try {
      await operation();
      setNotice(successText);
      await load();
      return true;
    } catch (requestError) {
      setError(errorMessage(requestError, 'No se pudo completar la acción.'));
      return false;
    } finally {
      setBusy('');
    }
  };

  const createCode = async () => {
    if (!selectedContact) return setError('Selecciona un cliente para crear su código.');
    const ok = await act(
      'code',
      () => referralsAPI.createCode(selectedContact.id),
      `Código listo para ${selectedContact.name || selectedContact.phone}.`,
    );
    if (ok) { setSelectedContact(null); setContactQuery(''); setContactOptions([]); }
  };

  const createClaim = async event => {
    event.preventDefault();
    const ok = await act('claim', () => referralsAPI.createClaim(claim), 'Referido registrado.');
    if (ok) setClaim(current => ({ ...current, referred_phone: '', referred_name: '', notes: '' }));
  };

  const shareCode = async code => {
    if (!code.public_url) {
      setError('Falta configurar CRM_PUBLIC_URL en el backend para generar el enlace.');
      return;
    }
    const text = `Te invito a comprar con mi código ${code.code}: ${code.public_url}`;
    try {
      if (navigator.share) await navigator.share({ title: 'Invitación', text, url: code.public_url });
      else await navigator.clipboard.writeText(text);
      setNotice(navigator.share ? 'Invitación compartida.' : 'Invitación copiada.');
    } catch (shareError) {
      if (shareError?.name !== 'AbortError') setError('No se pudo compartir el enlace.');
    }
  };

  const changeStatus = async (referral, nextStatus) => {
    let note = '';
    if (nextStatus === 'rejected') {
      note = window.prompt('Motivo del rechazo:')?.trim() || '';
      if (!note) return;
    }
    await act(
      `status-${referral.id}`,
      () => referralsAPI.setStatus(referral.id, nextStatus, note),
      `Referido marcado como ${STATUS[nextStatus].label.toLowerCase()}.`,
    );
  };

  const summary = payload.summary || {};
  return (
    <main style={{ flex: 1, minWidth: 0, height: '100%', overflowY: 'auto', background: colors.bgApp, color: colors.textPrimary }}>
      <div style={{ width: 'min(1180px, 100%)', margin: '0 auto', padding: '24px clamp(14px, 3vw, 32px) 48px', boxSizing: 'border-box' }}>
        <header style={{ display: 'flex', gap: 14, alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', marginBottom: 20 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
              <Share2 size={23} color={colors.green} />
              <h1 style={{ margin: 0, color: colors.textPrimary, fontSize: 24 }}>Referidos</h1>
            </div>
            <p style={{ margin: '7px 0 0', color: colors.textSecondary, fontSize: 13, lineHeight: 1.5 }}>
              Crea enlaces por cliente, atribuye nuevos compradores y controla la entrega de premios.
            </p>
          </div>
          <button onClick={load} disabled={loading} style={ui.btn(colors, 'secondary')}>
            <RefreshCw size={15} /> Actualizar
          </button>
        </header>

        {(error || notice) && (
          <div role="status" style={{ ...ui.card(colors), marginBottom: 16, color: error ? colors.danger : colors.success, borderColor: error ? `${colors.danger}66` : `${colors.success}66` }}>
            {error || notice}
          </div>
        )}

        <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(155px, 1fr))', gap: 10, marginBottom: 18 }}>
          <Metric icon={Users} label="Total" value={summary.total || 0} color={colors.green} colors={colors} />
          <Metric icon={UserPlus} label="Pendientes" value={summary.pending || 0} color={colors.warning} colors={colors} />
          <Metric icon={CheckCircle2} label="Calificados" value={summary.qualified || 0} color={colors.info} colors={colors} />
          <Metric icon={Award} label="Premiados" value={summary.rewarded || 0} color={colors.success} colors={colors} />
        </section>

        <ReferralProgram onChange={load} refreshKey={payload} />

        <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 360px), 1fr))', gap: 14, marginBottom: 18 }}>
          <div style={ui.card(colors)}>
            <h2 style={{ ...ui.sectionTitle(colors), margin: '0 0 12px', fontSize: 16 }}><Link2 size={16} style={{ verticalAlign: -3, marginRight: 7 }} />Crear código</h2>
            <div style={{ position: 'relative' }}>
              <div style={{ position: 'relative' }}>
                <Search size={15} color={colors.textMuted} style={{ position: 'absolute', left: 11, top: 11 }} />
                <input value={contactQuery} placeholder="Buscar cliente por nombre o teléfono"
                  onChange={event => { setContactQuery(event.target.value); setSelectedContact(null); }}
                  style={ui.input(colors, { width: '100%', paddingLeft: 34, boxSizing: 'border-box' })} />
              </div>
              {contactOptions.length > 0 && (
                <div style={{ position: 'absolute', zIndex: 5, top: 43, left: 0, right: 0, background: colors.bgPanel, border: `1px solid ${colors.border}`, borderRadius: 9, overflow: 'hidden', boxShadow: '0 12px 30px rgba(0,0,0,.25)' }}>
                  {contactOptions.map(contact => (
                    <button key={contact.id} onClick={() => { setSelectedContact(contact); setContactQuery(contact.name || contact.phone); setContactOptions([]); }}
                      style={{ width: '100%', padding: '10px 12px', border: 0, borderBottom: `1px solid ${colors.border}`, background: 'transparent', color: colors.textPrimary, textAlign: 'left', cursor: 'pointer' }}>
                      <strong>{contact.name || 'Sin nombre'}</strong> <span style={{ color: colors.textSecondary }}>{contact.phone}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button onClick={createCode} disabled={!selectedContact || busy === 'code'} style={ui.btn(colors, 'primary', { marginTop: 10 })}>
              <Plus size={15} /> Generar código
            </button>
          </div>

          <form onSubmit={createClaim} style={ui.card(colors)}>
            <h2 style={{ ...ui.sectionTitle(colors), margin: '0 0 12px', fontSize: 16 }}><UserPlus size={16} style={{ verticalAlign: -3, marginRight: 7 }} />Registrar referido</h2>
            <div style={{ display: 'grid', gap: 9 }}>
              <select required value={claim.code} onChange={event => setClaim(current => ({ ...current, code: event.target.value }))} style={ui.select(colors, { width: '100%' })}>
                <option value="">Código del cliente que refiere</option>
                {activeCodes.map(code => <option key={code.id} value={code.code}>{code.code} · {code.referrer_name || code.referrer_phone}</option>)}
              </select>
              <input required value={claim.referred_phone} placeholder="Teléfono del referido"
                onChange={event => setClaim(current => ({ ...current, referred_phone: event.target.value }))} style={ui.input(colors)} />
              <input value={claim.referred_name} placeholder="Nombre (opcional)"
                onChange={event => setClaim(current => ({ ...current, referred_name: event.target.value }))} style={ui.input(colors)} />
              <input value={claim.notes} placeholder="Nota (opcional)"
                onChange={event => setClaim(current => ({ ...current, notes: event.target.value }))} style={ui.input(colors)} />
            </div>
            <button type="submit" disabled={!activeCodes.length || busy === 'claim'} style={ui.btn(colors, 'primary', { marginTop: 10 })}>
              <Plus size={15} /> Registrar
            </button>
          </form>
        </section>

        <section style={{ ...ui.card(colors), marginBottom: 18, padding: 0, overflow: 'hidden' }}>
          <div style={{ padding: '14px 14px 10px' }}>
            <h2 style={{ ...ui.sectionTitle(colors), margin: 0, fontSize: 16 }}>Códigos por cliente</h2>
          </div>
          {payload.codes.length === 0 ? <Empty text="Todavía no hay códigos creados." colors={colors} /> : payload.codes.map(code => (
            <div key={code.id} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', padding: '11px 14px', borderTop: `1px solid ${colors.border}` }}>
              <div style={{ flex: '1 1 210px', minWidth: 0 }}>
                <strong style={{ color: colors.textPrimary, fontSize: 13 }}>{code.referrer_name || 'Sin nombre'}</strong>
                <div style={{ color: colors.textSecondary, fontSize: 11, marginTop: 3 }}>{code.referrer_phone} · {code.referral_count} referidos · {code.conversion_count} compras válidas · {code.click_count} clics</div>
              </div>
              <code style={{ color: colors.green, background: colors.bgSub, border: `1px solid ${colors.border}`, borderRadius: 7, padding: '6px 9px', fontWeight: 700 }}>{code.code}</code>
              <button onClick={() => shareCode(code)} disabled={!code.active} style={ui.btn(colors, 'secondary', { padding: '7px 10px' })}><Share2 size={14} /> Compartir</button>
              <button onClick={() => act(`code-${code.id}`, () => referralsAPI.setCodeActive(code.id, !code.active), code.active ? 'Código pausado.' : 'Código activado.')}
                style={ui.btn(colors, 'ghost', { color: code.active ? colors.success : colors.textMuted, padding: '7px 9px' })}>
                {code.active ? <ToggleRight size={22} /> : <ToggleLeft size={22} />} {code.active ? 'Activo' : 'Pausado'}
              </button>
            </div>
          ))}
        </section>

        <section style={{ ...ui.card(colors), padding: 0, overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: 14 }}>
            <h2 style={{ ...ui.sectionTitle(colors), margin: '0 auto 0 0', fontSize: 16 }}>Seguimiento</h2>
            <input value={search} onChange={event => setSearch(event.target.value)} placeholder="Buscar..." style={ui.input(colors, { width: 180 })} />
            <select value={statusFilter} onChange={event => setStatusFilter(event.target.value)} style={ui.select(colors)}>
              <option value="">Todos</option>
              {Object.entries(STATUS).map(([key, item]) => <option key={key} value={key}>{item.label}</option>)}
            </select>
            <button onClick={load} style={ui.btn(colors, 'secondary', { padding: '7px 10px' })}><Search size={14} /></button>
          </div>
          {loading ? (
            <div style={{ padding: 36, textAlign: 'center', color: colors.textSecondary }}><Loader2 size={22} /> Cargando…</div>
          ) : payload.data.length === 0 ? <Empty text="No hay referidos para estos filtros." colors={colors} /> : payload.data.map(referral => {
            const state = STATUS[referral.status];
            return (
              <div key={referral.id} style={{ display: 'flex', alignItems: 'center', gap: 11, flexWrap: 'wrap', padding: '12px 14px', borderTop: `1px solid ${colors.border}` }}>
                <div style={{ flex: '1 1 220px', minWidth: 0 }}>
                  <strong style={{ color: colors.textPrimary, fontSize: 13 }}>{referral.referred_name || referral.referred_phone}</strong>
                  <div style={{ color: colors.textSecondary, fontSize: 11, marginTop: 3 }}>
                    {referral.referred_phone} · Referido por {referral.referrer_name || referral.referrer_phone} · {formatDate(referral.created_at)}
                  </div>
                  {referral.notes && <div style={{ color: colors.textMuted, fontSize: 11, marginTop: 3 }}>{referral.notes}</div>}
                </div>
                <span style={ui.chip(colors, colors[state.color])}>{state.label}</span>
                <span style={{ color: colors.textMuted, fontSize: 11 }}>{referral.source === 'whatsapp' ? 'WhatsApp' : 'Manual'}</span>
                <div style={{ display: 'flex', gap: 5 }}>


                  {['pending', 'qualified'].includes(referral.status) && <button onClick={() => changeStatus(referral, 'rejected')} title="Rechazar" style={smallIcon(colors, colors.danger)}><XCircle size={16} /></button>}

                </div>
              </div>
            );
          })}
        </section>
      </div>
    </main>
  );
}

function Metric({ icon: Icon, label, value, color, colors }) {
  return <div style={ui.card(colors, { display: 'flex', alignItems: 'center', gap: 11 })}>
    <div style={{ width: 38, height: 38, borderRadius: 10, display: 'grid', placeItems: 'center', background: `${color}1F`, color }}><Icon size={19} /></div>
    <div><div style={{ color: colors.textSecondary, fontSize: 11 }}>{label}</div><strong style={{ color: colors.textPrimary, fontSize: 20 }}>{value}</strong></div>
  </div>;
}

function Field({ label, children, style }) {
  return <label style={{ display: 'grid', gap: 6, ...style }}><span style={{ fontSize: 12, fontWeight: 650 }}>{label}</span>{children}</label>;
}

function Empty({ text, colors }) {
  return <div style={{ padding: 28, color: colors.textSecondary, textAlign: 'center', fontSize: 13 }}>{text}</div>;
}

function smallIcon(colors, color) {
  return { width: 32, height: 32, display: 'grid', placeItems: 'center', borderRadius: 8, border: `1px solid ${colors.border}`, background: colors.bgSub, color, cursor: 'pointer' };
}
