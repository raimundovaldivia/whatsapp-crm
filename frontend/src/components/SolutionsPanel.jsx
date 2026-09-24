import { useCallback, useEffect, useState } from 'react';
import { api } from '../utils/api';
import { useTheme } from '../theme';
import './solutions.css';

const statusNames = { base:'Cuenta base', expired:'Vencido', legacy:'Acceso existente', trial:'En prueba', active:'Activo', suspended:'Suspendido', cancelled:'Cancelado', pending:'Pendiente', approved:'Aprobada', declined:'No aprobada' };
const errorText = e => e.response?.data?.error || 'No pudimos conectar. Intenta nuevamente.';
const date = value => value ? new Date(value).toLocaleDateString('es-CL') : 'Sin vencimiento';
const number = value => value === null ? 'Sin límite contratado' : Number(value).toLocaleString('es-CL');

export default function SolutionsPanel({ publicView = false, onStart, onClose }) {
  const { colors } = useTheme();
  const [data,setData] = useState(null), [error,setError] = useState(''), [notice,setNotice] = useState('');
  const [busy,setBusy] = useState(''), [admin,setAdmin] = useState(false), [note,setNote] = useState('');
  const load = useCallback(async () => {
    setError('');
    try { setData((await api.get(publicView ? '/commercial/catalog' : '/commercial/me')).data); }
    catch(e) { setError(errorText(e)); }
  },[publicView]);
  useEffect(() => { load(); },[load]);
  async function request(key) {
    setBusy(key); setError(''); setNotice('');
    try { await api.post('/commercial/requests',{module:key,note}); await load(); setNotice('Solicitud recibida. Nuestro equipo revisará tu contratación antes de activar el módulo.'); }
    catch(e) { setError(errorText(e)); } finally { setBusy(''); }
  }
  const style = { '--sol-bg':colors.bgApp,'--sol-card':colors.bgPanel,'--sol-text':colors.textPrimary,'--sol-muted':colors.textSecondary,'--sol-border':colors.border,'--sol-accent':colors.green };
  return <section className="solutions" style={style} aria-label="Soluciones para tu ecommerce">
    <div className="sol-container">
      <header className="sol-header"><div><span className="sol-eyebrow">RESEL · COMERCIO CONECTADO</span><h1>{publicView ? 'Tu operación, tus soluciones.' : 'Mis soluciones'}</h1><p>Una base compartida. Las herramientas que necesita tu tienda, en un solo lugar.</p></div>
        <div className="sol-actions">{data?.platformAdmin && <button onClick={() => setAdmin(!admin)}>{admin ? 'Volver a mi tienda' : 'Administración comercial'}</button>}{onClose && <button onClick={onClose}>Volver</button>}</div>
      </header>
      {error && <div role="alert" className="sol-error">{error} <button onClick={load}>Reintentar</button></div>}
      {notice && <div role="status" className="sol-notice">{notice}</div>}
      {!data && !error && <p role="status">Cargando soluciones…</p>}
      {data && admin ? <CommercialAdmin catalog={data.catalog} /> : data && <>
        <div className="sol-base"><div><span className="sol-badge">BASE COMPARTIDA</span><h2>Tu equipo y tus clientes, conectados</h2><p>Conversaciones, clientes, usuarios, permisos e integraciones. Los módulos contratados amplían esta base.</p></div>{publicView ? <button className="sol-primary" onClick={onStart}>Crear mi cuenta</button> : <div><strong>{statusNames[data.state] || 'Cuenta base'}</strong><p>{date(data.contract?.expires_at)}</p></div>}</div>
        {!publicView && <div className="sol-meters">
          <Usage title="Turnos del agente de ventas" used={data.usage.bot_turns} limit={data.limits.bot_turns} detail={`Mes ${data.period} · Cada procesamiento iniciado cuenta como un turno.`} />
          <Usage title="Usuarios del equipo" used={data.usage.seats} limit={data.limits.seats} detail="Incluye al dueño y a los repartidores." />
          <div className="sol-card"><h3>Contratación asistida</h3><p>Solicita los módulos que necesitas. La activación se confirma con nuestro equipo.</p><small>Solicitar no genera un cobro ni activa automáticamente una solución.</small></div>
        </div>}
        <div className="sol-section"><h2>Soluciones para cada etapa</h2><p>Precios y condiciones según tu operación. IA, WhatsApp y otros proveedores pueden generar costos adicionales que se acuerdan en la propuesta.</p></div>
        {!publicView && <label className="sol-note">Cuéntanos qué necesitas (opcional)<textarea maxLength={1000} value={note} onChange={e=>setNote(e.target.value)} placeholder="Por ejemplo: coordinar entregas para tres repartidores" /></label>}
        <div className="sol-grid">{data.catalog.map((solution,index) => {
          const available = data.available?.includes(solution.key);
          const pending = data.requests?.some(r=>r.module_key===solution.key && r.status==='pending');
          return <article key={solution.key} className={`sol-card ${available?'sol-active':''}`}>
            <div className="sol-card-top"><span className="sol-index">{String(index+1).padStart(2,'0')}</span><span className="sol-badge">{available?'Disponible':pending?'Solicitud pendiente':'A tu medida'}</span></div>
            <h2>{solution.name}</h2><p>{solution.description}</p><ul>{solution.includes.map(x=><li key={x}>{x}</li>)}</ul>
            {solution.requires.length>0 && <small>Incluye contratación de Gestión de pedidos.</small>}
            <button className={available?'':'sol-primary'} disabled={!publicView && (available || pending || !!busy)} onClick={()=>publicView?onStart():request(solution.key)}>{publicView?'Me interesa':available?'Incluido en tu acceso':pending?'En revisión':busy===solution.key?'Enviando…':'Solicitar propuesta'}</button>
          </article>;
        })}</div>
        {!publicView && data.requests.length>0 && <div className="sol-card sol-history"><h2>Mis solicitudes</h2>{data.requests.map(r=><div className="sol-row" key={r.id}><span>{data.catalog.find(s=>s.key===r.module_key)?.name || r.module_key}</span><span>{statusNames[r.status]} · {date(r.created_at)}</span></div>)}</div>}
      </>}
    </div>
  </section>;
}

function Usage({title,used,limit,detail}) {
  return <div className="sol-card"><h3>{title}</h3><div className="sol-value">{number(used)} <span>/ {number(limit)}</span></div>{limit !== null && limit>0 && <progress max={limit} value={Math.min(used,limit)} aria-label={title} />}<small>{detail}</small></div>;
}

function CommercialAdmin({catalog}) {
  const [organizations,setOrganizations] = useState([]), [search,setSearch] = useState(''), [offset,setOffset] = useState(0);
  const [selected,setSelected] = useState(null), [form,setForm] = useState(null), [error,setError] = useState(''), [notice,setNotice] = useState(''), [busy,setBusy] = useState(false), [loading,setLoading] = useState(true);
  async function list(term=search,page=offset) {
    setLoading(true); setError('');
    try { const {data}=await api.get('/commercial/admin/organizations',{params:{search:term,offset:page}}); setOrganizations(data.organizations); }
    catch(e) {setError(errorText(e));} finally {setLoading(false);}
  }
  useEffect(()=>{list('',0);},[]);
  async function open(id) {
    setBusy(true);setError('');setSelected(null);setForm(null);
    try {
      const {data}=await api.get(`/commercial/admin/organizations/${id}`);setSelected(data);
      setForm({status:data.contract?.status==='legacy'?'active':data.contract?.status || 'trial',modules:data.contract?.modules || [],limits:data.limits,expires_at:data.contract?.expires_at?.slice(0,10) || '',revision:data.contract?.revision || 0,reason:''});
    } catch(e){setError(errorText(e));} finally {setBusy(false);}
  }
  function toggle(key,checked) {
    setForm(f=>{
      let modules=checked?[...new Set([...f.modules,key,...catalog.find(s=>s.key===key).requires])]:f.modules.filter(k=>k!==key);
      if(!checked) modules=modules.filter(k=>!catalog.find(s=>s.key===k).requires.includes(key));
      return {...f,modules};
    });
  }
  async function save(e) {
    e.preventDefault();setBusy(true);setError('');setNotice('');
    try { await api.put(`/commercial/admin/organizations/${selected.organization.id}/contract`,{...form,expires_at:form.expires_at?`${form.expires_at}T23:59:59Z`:null});window.dispatchEvent(new Event('commercial-changed'));await open(selected.organization.id);await list();setNotice('Contrato actualizado. El historial conserva el motivo y el responsable.'); }
    catch(e){setError(errorText(e));} finally {setBusy(false);}
  }
  async function decline(id) {
    if(form.reason.trim().length<5){setError('Escribe el motivo antes de rechazar una solicitud.');return;}
    setBusy(true);setError('');
    try {await api.post(`/commercial/admin/requests/${id}/decline`,{reason:form.reason});await open(selected.organization.id);await list();setNotice('Solicitud cerrada.');}catch(e){setError(errorText(e));}finally{setBusy(false);}
  }
  return <div>
    <div className="sol-section"><h2>Administración comercial</h2><p>Gestiona contratos y solicitudes. Este acceso es independiente de los administradores de cada tienda.</p></div>
    {error&&<div className="sol-error" role="alert">{error}</div>}{notice&&<div className="sol-notice" role="status">{notice}</div>}
    <form className="sol-search" onSubmit={e=>{e.preventDefault();setOffset(0);list(search,0);}}><input aria-label="Buscar tienda" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Buscar por tienda"/><button disabled={loading}>Buscar</button></form>
    <div className="sol-admin-grid"><aside className="sol-card"><h3>Tiendas</h3>{loading?<p>Cargando…</p>:!organizations.length?<p>No hay tiendas para esta búsqueda.</p>:organizations.map(o=><button className="sol-org" key={o.id} disabled={busy} onClick={()=>open(o.id)}><strong>{o.name}</strong><span>{statusNames[o.status]||'Cuenta base'}{o.pending_requests>0?` · ${o.pending_requests} solicitud(es)`:''}</span></button>)}<div className="sol-actions"><button disabled={loading||offset===0} onClick={()=>{setOffset(offset-50);list(search,offset-50);}}>Anterior</button><button disabled={loading||organizations.length<50} onClick={()=>{setOffset(offset+50);list(search,offset+50);}}>Siguiente</button></div></aside>
      <div>{busy&&!selected&&<p role="status">Cargando tienda…</p>}{!selected&&!busy&&<div className="sol-card"><h2>Selecciona una tienda</h2><p>Revisa sus solicitudes y configura el acceso acordado.</p></div>}
      {selected&&form&&<form onSubmit={save} className="sol-card sol-contract"><h2>{selected.organization.name}</h2><p>Estado actual: {statusNames[selected.contract?.status]||'Cuenta base'} · {date(selected.contract?.expires_at)}</p>
        <label>Estado del contrato<select aria-label="Estado del contrato" value={form.status} onChange={e=>setForm({...form,status:e.target.value})}>{['trial','active','suspended','cancelled'].map(s=><option key={s} value={s}>{statusNames[s]}</option>)}</select></label>
        <label>Vencimiento (UTC; obligatorio para pruebas)<input type="date" required={form.status==='trial'} value={form.expires_at} onChange={e=>setForm({...form,expires_at:e.target.value})}/></label>
        <fieldset><legend>Módulos contratados</legend>{catalog.map(s=><label className="sol-check" key={s.key}><input type="checkbox" checked={form.modules.includes(s.key)} onChange={e=>toggle(s.key,e.target.checked)}/>{s.name}</label>)}</fieldset>
        {['bot_turns','seats'].map(key=><label key={key}>{key==='seats'?'Usuarios del equipo':'Turnos mensuales del agente de ventas'}<input type="number" min={key==='seats'?1:0} max={10000000} value={form.limits[key]??''} placeholder="Sin límite" onChange={e=>setForm({...form,limits:{...form.limits,[key]:e.target.value===''?null:Number(e.target.value)}})}/><small>Vacío significa sin límite. Consumo actual: {number(selected.usage[key])}.</small></label>)}
        <label>Motivo del cambio<textarea required minLength={5} maxLength={1000} value={form.reason} onChange={e=>setForm({...form,reason:e.target.value})} placeholder="Acuerdo comercial, cambio de plan o solicitud del cliente"/></label>
        <p className="sol-impact">Guardar aplica el acceso de inmediato. Suspender o cancelar detiene las funciones contratadas; conserva los datos y el acceso a la cuenta base. La aprobación no registra ni ejecuta un pago.</p>
        <button className="sol-primary" disabled={busy}>{busy?'Guardando…':'Guardar contrato'}</button><button type="button" disabled={busy} onClick={()=>open(selected.organization.id)}>Recargar contrato</button>
        <h3>Solicitudes</h3>{selected.requests.length===0?<p>Sin solicitudes.</p>:selected.requests.map(r=><div className="sol-request" key={r.id}><strong>{catalog.find(s=>s.key===r.module_key)?.name}</strong><p>{r.note||'Sin comentario'} · {statusNames[r.status]}</p>{r.status==='pending'&&<small>Activa este módulo en el contrato para aprobar la solicitud. <button type="button" disabled={busy} onClick={()=>decline(r.id)}>Rechazar solicitud</button></small>}</div>)}
        <h3>Historial de cambios</h3>{selected.audit.length===0?<p>Sin cambios comerciales registrados.</p>:selected.audit.map(a=><div className="sol-request" key={a.id}><strong>{date(a.created_at)} · Operador {a.actor_id}</strong><p>{a.reason}</p></div>)}
      </form>}</div>
    </div>
  </div>;
}
