import { useEffect, useState } from 'react';
import { Gift, MessageSquare, ShieldCheck, Sparkles, Play, Settings, Clock } from 'lucide-react';
import { referralsAPI } from '../utils/api.js';
import { useTheme } from '../theme.js';
import * as ui from '../ui.js';

const money = n => new Intl.NumberFormat('es-CL',{style:'currency',currency:'CLP',maximumFractionDigits:0}).format(n || 0);
const date = value => new Intl.DateTimeFormat('es-CL',{timeZone:'America/Santiago',dateStyle:'medium'}).format(new Date(value));
const phone = value => { const n=String(value || '').replace(/\D/g,''); return /^9\d{8}$/.test(n) ? `56${n}` : n; };
const states = { draft:'Por aprobar',queued:'En cola',sending:'Enviando',sent:'Enviado',blocked:'Falta configuración',uncertain:'Revisar envío',cancelled:'Cancelado',available:'Disponible',redeemed:'Usado',void:'Anulado',expired:'Vencido' };
const actions = { settings_saved:'Configuración guardada',invitation_prepared:'Invitación preparada',reward_issued:'Bono emitido',referral_rejected:'Referido rechazado',reward_redeemed:'Bono canjeado',messages_approved:'Mensajes aprobados' };

export default function ReferralProgram({ onChange, refreshKey }) {
  const {colors}=useTheme();
  const [data,setData]=useState(null);
  const [tab,setTab]=useState('program');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [command,setCommand]=useState('');
  const [plan,setPlan]=useState(null);
  const [selected,setSelected]=useState([]);
  const [redemption,setRedemption]=useState(null);
  const [quote,setQuote]=useState(null);
  const [orderId,setOrderId]=useState('');
  const load=async()=>{ const value=await referralsAPI.program(); setData(value); setSelected([]); };
  useEffect(()=>{load().catch(e=>setError(e.response?.data?.error || 'No se pudo cargar la configuración'));},[refreshKey]);
  const act=async(fn,message)=>{
    setBusy(true);setError('');setNotice('');
    try { const result=await fn(); await load(); onChange?.();setNotice(typeof message==='function'?message(result):message);return result; }
    catch(e){setError(e.response?.data?.error || 'No se pudo completar la acción');return null;}
    finally{setBusy(false);}
  };
  if(!data) return <section style={{...ui.card(colors),marginBottom:18}} role="status">{error || 'Cargando beneficios y automatizaciones…'}</section>;
  const s=data.settings,r=s.rules;
  const rule=(key,value)=>setData(d=>({...d,settings:{...d.settings,rules:{...d.settings.rules,[key]:value}}}));
  const card=ui.card(colors);
  const input=ui.input(colors,{width:'100%',boxSizing:'border-box'});
  const btn=kind=>ui.btn(colors,kind);
  const muted={fontSize:12,color:colors.textSecondary,lineHeight:1.6};
  const field=(label,child)=><label style={{display:'grid',gap:6,fontSize:12}}>{label}{child}</label>;
  const number=(label,key,min,max)=>field(label,<input type="number" min={min} max={max} value={r[key]} onChange={e=>rule(key,Number(e.target.value))} style={input}/>);
  const runCommand=async execute=>{
    setError('');setBusy(true);
    try{const result=await referralsAPI.command(command,execute); if(execute){await load();onChange?.();setPlan(null);setNotice('Instrucción ejecutada.');}else setPlan(result.preview);}
    catch(e){setError(e.response?.data?.error || 'No se pudo interpretar la instrucción');}finally{setBusy(false);}
  };
  return <section style={{...card,marginBottom:18}}>
    <div style={{display:'flex',gap:12,justifyContent:'space-between',alignItems:'center',flexWrap:'wrap'}}>
      <div><h2 style={{margin:0,fontSize:18}}>Convierte recomendaciones en nuevas compras</h2><p style={muted}>Bonos personales, un solo uso y seguimiento de cada compra hasta el premio.</p></div>
      <span style={ui.chip(colors,s.enabled?colors.success:colors.textMuted)}>{s.enabled?'Programa activo':'Programa pausado'}</span>
    </div>
    <div style={{display:'flex',gap:6,flexWrap:'wrap',borderBottom:`1px solid ${colors.border}`,paddingBottom:12,marginBottom:16}}>
      {[['program','Programa',Settings],['messages','Mensajes',MessageSquare],['rewards','Bonos y regalos',Gift],['audit','Actividad',Clock]].map(([id,label,Icon])=><button key={id} disabled={busy} onClick={()=>setTab(id)} style={btn(tab===id?'primary':'ghost')}><Icon size={15}/>{label}</button>)}
    </div>
    {(error||notice)&&<div role="status" style={{...card,marginBottom:12,color:error?colors.danger:colors.success}}>{error||notice}</div>}
    {tab==='program'&&<>
      <div style={{...card,background:colors.bgSub,marginBottom:16}}>
        <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:8}}><Sparkles size={18} color={colors.green}/><strong>Explícalo con tus palabras</strong></div>
        <textarea aria-label="Instrucción para el programa de referidos" value={command} maxLength={1000} onChange={e=>{setCommand(e.target.value);setPlan(null);}} rows={2} placeholder="Da 2000 para ambos y una bandeja a los 5 compradores" style={{...input,resize:'vertical',fontFamily:'inherit'}}/>
        <div style={{display:'flex',gap:6,flexWrap:'wrap',marginTop:8}}>
          {['Da 2000 para ambos y una bandeja a los 5 compradores','Prepara códigos para mis compradores','Revisa compras','Pausa referidos'].map(text=><button key={text} disabled={busy} onClick={()=>{setCommand(text);setPlan(null);}} style={{...btn('ghost'),fontSize:11}}>{text}</button>)}
        </div>
        <button disabled={busy||!command.trim()} onClick={()=>runCommand(false)} style={{...btn('secondary'),marginTop:8}}>Ver propuesta</button>
        {plan&&<div style={{marginTop:12}}><p style={{fontSize:13,lineHeight:1.6}}>{plan.summary}</p><button disabled={busy} onClick={()=>runCommand(true)} style={btn('primary')}>Aplicar propuesta</button></div>}
      </div>
      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(210px,1fr))',gap:10,marginBottom:16}}>
        {data.presets.map(p=><button key={p.id} disabled={busy} onClick={()=>setData(d=>({...d,settings:{...d.settings,rules:{...p.rules,gift_product_id:d.settings.rules.gift_product_id}}}))} style={{...card,textAlign:'left',cursor:'pointer',color:colors.textPrimary}}><Gift size={19} color={colors.green}/><strong style={{display:'block',marginTop:8}}>{p.name}</strong><p style={{...muted,marginBottom:0}}>{p.description}</p></button>)}
      </div>
      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(180px,1fr))',gap:12}}>
        {number('Descuento para quien refiere (CLP)','referrer_amount',1,100000)}
        {number('Descuento para el invitado (CLP)','referred_amount',1,100000)}
        {number('Compra mínima (CLP)','minimum_purchase',0,10000000)}
        {number('Vigencia del bono (días)','validity_days',1,365)}
        {field('Bandeja que se regalará',<select aria-label="Bandeja que se regalará" value={r.gift_product_id||''} onChange={e=>rule('gift_product_id',e.target.value?Number(e.target.value):null)} style={input}><option value="">Seleccionar del catálogo</option>{data.products.map(p=><option key={p.id} value={p.id}>{p.title} · stock {p.stock}</option>)}</select>)}
      </div>
      <h3 style={{fontSize:14,marginTop:20}}>Metas de compradores distintos</h3>
      {r.milestones.map((m,index)=><div key={index} style={{display:'flex',alignItems:'end',gap:8,flexWrap:'wrap',marginBottom:8}}>
        {field('Compradores',<input aria-label={`Compradores meta ${index+1}`} style={{...input,width:105}} type="number" min="1" max="100" value={m.count} onChange={e=>rule('milestones',r.milestones.map((v,i)=>i===index?{...v,count:Number(e.target.value)}:v))}/>)}
        {field('Premio',<select aria-label={`Premio meta ${index+1}`} value={m.kind} onChange={e=>rule('milestones',r.milestones.map((v,i)=>i===index?{...v,kind:e.target.value,amount:2000,quantity:1}:v))} style={input}><option value="gift">Bandeja gratis</option><option value="discount">Descuento extra</option></select>)}
        {field(m.kind==='gift'?'Bandejas':'Pesos',<input aria-label={`Valor meta ${index+1}`} style={{...input,width:110}} type="number" min="1" max={m.kind==='gift'?10:100000} value={m.kind==='gift'?m.quantity:m.amount} onChange={e=>rule('milestones',r.milestones.map((v,i)=>i===index?{...v,[m.kind==='gift'?'quantity':'amount']:Number(e.target.value)}:v))}/>)}
        <button disabled={busy} onClick={()=>rule('milestones',r.milestones.filter((_,i)=>i!==index))} style={btn('ghost')}>Quitar</button>
      </div>)}
      <button disabled={busy||r.milestones.length>=5} onClick={()=>rule('milestones',[...r.milestones,{count:Math.max(0,...r.milestones.map(m=>m.count))+5,kind:'gift',amount:0,quantity:1}])} style={btn('secondary')}>Añadir meta</button>
      <p style={muted}><ShieldCheck size={14} style={{verticalAlign:-2}}/> Cada nuevo comprador cuenta una sola vez. No se permiten autorreferidos. Cada meta se premia una sola vez, incluso si cambias el programa.</p>
      <h3 style={{fontSize:14,marginTop:20}}>Automatizaciones preestablecidas</h3>
      <div style={{display:'grid',gap:10}}>
        <label><input type="checkbox" checked={r.auto_invite} onChange={e=>rule('auto_invite',e.target.checked)}/> Invitar automáticamente a compradores actuales y futuros con compra pagada y entregada</label>
        <label><input type="checkbox" checked={r.auto_send} onChange={e=>rule('auto_send',e.target.checked)}/> Enviar automáticamente invitaciones, bonos y recordatorios</label>
        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(220px,1fr))',gap:12}}>
          {number('Espera después de entregar (horas)','invite_delay_hours',0,720)}
          {number('Recordar bono pendiente tras (días; 0 = sin aviso)','reminder_days',0,90)}
        </div>
      </div>
      <p style={muted}>Sin envío automático, los mensajes quedan por aprobar. Se respeta la exclusión de clientes y el horario 09:00–21:00 de Chile. Fuera de la ventana de WhatsApp, asigna la plantilla «Invitaciones y beneficios de referidos» en Mensajería. Se envía como máximo un recordatorio por bono.</p>
      <label><input type="checkbox" checked={s.enabled} onChange={e=>setData(d=>({...d,settings:{...d.settings,enabled:e.target.checked}}))}/> Activar programa</label>
      <div style={{display:'flex',gap:8,flexWrap:'wrap',marginTop:16}}>
        <button disabled={busy} onClick={()=>act(()=>referralsAPI.saveSettings(s),'Reglas guardadas. Los códigos existentes mantienen las condiciones prometidas.')} style={btn('primary')}>Guardar programa</button>
        <button disabled={busy} onClick={()=>act(()=>referralsAPI.prepare(),v=>`${v.prepared} invitaciones preparadas. Revisa la pestaña Mensajes.`)} style={btn('secondary')}><MessageSquare size={15}/>Preparar compradores actuales</button>
        <button disabled={busy} onClick={()=>act(()=>referralsAPI.reconcile(),v=>`${v.qualified} compras calificadas y ${v.issued} bonos nuevos.`)} style={btn('secondary')}><Play size={15}/>Revisar compras</button>
      </div>
      <p style={muted}>Los cambios se aplican al guardar. Las acciones usan la configuración guardada. La revisión de compras se ejecuta automáticamente cada minuto cuando el servidor está activo.</p>
    </>}
    {tab==='messages'&&<>
      <p style={muted}>Revisa el texto y el teléfono antes de aprobar. Un envío incierto requiere revisar el chat y nunca se reintenta automáticamente.</p>
      <button disabled={busy||!selected.length} onClick={()=>act(()=>referralsAPI.approveMessages(selected),v=>`${v.queued} mensajes aprobados para envío.`)} style={btn('primary')}>Aprobar y enviar seleccionados ({selected.length})</button>
      {!data.messages.length&&<p style={muted}>Prepara las invitaciones desde Programa para verlas aquí.</p>}
      {data.messages.map(m=><article key={m.id} style={{...card,marginTop:10}}>
        <label style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}><input aria-label={`Seleccionar mensaje para ${m.phone}`} type="checkbox" disabled={!['draft','blocked'].includes(m.status)||busy} checked={selected.includes(m.id)} onChange={e=>setSelected(v=>e.target.checked?[...v,m.id]:v.filter(id=>id!==m.id))}/><strong>{m.customer_name||m.phone}</strong><span style={muted}>{m.phone} · {states[m.status]}</span></label>
        <p style={{fontSize:13,lineHeight:1.7,whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{m.body}</p>
        {m.last_error&&<p style={{...muted,color:colors.warning}}>{m.last_error}</p>}
      </article>)}
    </>}
    {tab==='rewards'&&<>
      <p style={muted}>Cada bono pertenece a un teléfono y se usa una sola vez en un pedido del CRM. El canje queda consumido aunque el pedido se cancele después.</p>
      {redemption&&<div style={{...card,marginBottom:14,borderColor:colors.green}}>
        <strong>Canjear {redemption.token} · {redemption.beneficiary_phone}</strong>
        <select aria-label="Pedido para canjear el bono" value={orderId} onChange={e=>{setOrderId(e.target.value);setQuote(null);}} style={{...input,marginTop:10}}><option value="">Selecciona un pedido pendiente del cliente</option>{data.orders.filter(o=>phone(o.customer_phone)===redemption.beneficiary_phone).map(o=><option key={o.id} value={o.id}>#{o.id} · {o.customer_name} · {money(o.total_price)}</option>)}</select>
        <p style={muted}>Si no aparece un pedido, créalo en Pedidos antes de cobrar o programar el reparto. Los pedidos con cobro Shopify se gestionan allí y no admiten este canje.</p>
        <div style={{display:'flex',gap:8,flexWrap:'wrap'}}><button disabled={busy||!orderId} onClick={async()=>{setBusy(true);setError('');try{setQuote(await referralsAPI.previewReward(redemption.id,Number(orderId)));}catch(e){setError(e.response?.data?.error||'No se pudo revisar el pedido');}finally{setBusy(false);}}} style={btn('secondary')}>Revisar canje</button><button disabled={busy} onClick={()=>{setRedemption(null);setQuote(null);}} style={btn('ghost')}>Cerrar</button></div>
        {quote&&<div><p>Pedido #{quote.order_id}: {money(quote.before)} → <strong>{money(quote.after)}</strong> · Beneficio {quote.benefit}</p><button disabled={busy} onClick={async()=>{const result=await act(()=>referralsAPI.redeemReward(redemption.id,Number(orderId),quote.before),'Bono usado y pedido actualizado.');if(result){setRedemption(null);setQuote(null);}}} style={btn('primary')}>Confirmar canje único</button></div>}
      </div>}
      {!data.rewards.length&&<p style={muted}>Los bonos aparecerán al registrar invitados y verificar sus compras.</p>}
      {data.rewards.map(rw=><div key={rw.id} style={{borderTop:`1px solid ${colors.border}`,padding:'12px 0',display:'flex',alignItems:'center',gap:10,flexWrap:'wrap'}}>
        <div style={{flex:'1 1 240px'}}><strong>{rw.kind==='gift'?`${rw.quantity} bandeja(s) gratis`:money(rw.amount)}</strong><div style={muted}>{rw.beneficiary_phone} · {rw.token}</div><div style={muted}>Vence {date(new Date(new Date(rw.expires_at).getTime()-1))}{rw.redeemed_order_id?` · Pedido #${rw.redeemed_order_id}`:''}</div></div>
        <span style={ui.chip(colors,rw.display_status==='available'?colors.success:colors.textMuted)}>{states[rw.display_status]}</span>
        {rw.display_status==='available'&&<button disabled={busy} onClick={()=>{setRedemption(rw);setQuote(null);setOrderId('');}} style={btn('secondary')}>Canjear en pedido</button>}
      </div>)}
    </>}
    {tab==='audit'&&<><p style={muted}>Últimos 50 movimientos. Los bonos conservan su identidad después de usarse o anularse.</p>{data.audit.map((a,i)=><div key={i} style={{borderTop:`1px solid ${colors.border}`,padding:'10px 0',fontSize:13}}><strong>{actions[a.action]||a.action}</strong> · {date(a.created_at)}{a.details.reward_id&&<span> · Bono #{a.details.reward_id}</span>}{a.details.order_id&&<span> · Pedido #{a.details.order_id}</span>}{a.details.reason&&<p style={muted}>{a.details.reason}</p>}</div>)}</>}
  </section>;
}
