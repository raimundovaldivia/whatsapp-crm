import { useEffect, useState } from 'react';
import { api } from '../utils/api.js';
export const RETURN_STATES = {requested:'Solicitado',approved:'Aprobado',scheduled:'Programado',in_progress:'En retiro/cambio',review:'Pendiente de resolución',resolved:'Resuelto',rejected:'Rechazado',cancelled:'Cancelado'};
const money = n => '$'+Number(n||0).toLocaleString('es-CL');
const address = value => typeof value === 'string' ? value : Object.values(value||{}).filter(v=>typeof v==='string').join(', ');
export default function ReturnsPanel({colors,order,dispatch=false}) {
  const [cases,setCases]=useState([]),[drivers,setDrivers]=useState([]),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [form,setForm]=useState({kind:'return',reason:'',replacementDescription:'',pickupRequired:true,moneyDirection:'none',moneyMethod:'none',moneyAmount:0});
  const [quantities,setQuantities]=useState({}),[plans,setPlans]=useState({});
  const [requestKey,setRequestKey]=useState(()=>crypto.randomUUID());
  async function load(){try{const {data}=await api.get('/delivery/returns',{params:order?{source:order.source,orderId:order.rawId}:undefined});setCases(data.cases);}catch(e){setError(e.response?.data?.error||e.message);}}
  useEffect(()=>{load();api.get('/delivery/drivers').then(r=>setDrivers(r.data.drivers||[])).catch(()=>{});},[order?.rawId,order?.source]);
  const style={background:colors.bgInput,color:colors.textPrimary,border:`1px solid ${colors.border}`,borderRadius:7,padding:9};
  const button={...style,cursor:'pointer'};
  const field=(key,value)=>setForm(f=>({...f,[key]:value}));
  async function create(){setBusy(true);setError('');try{
    await api.post('/delivery/returns',{...form,requestKey,source:order.source,orderId:order.rawId,items:Object.entries(quantities).filter(([,q])=>Number(q)>0).map(([index,quantity])=>({index:Number(index),quantity:Number(quantity)}))});
    setRequestKey(crypto.randomUUID());setQuantities({});await load();
  }catch(e){setError(e.response?.data?.error||e.message);}finally{setBusy(false);}}
  async function act(row,action,extra={}){
    if(['complete','resolve'].includes(action)&&!window.confirm(`Confirma que las operaciones y el movimiento de dinero indicados en la solicitud #${row.id} ya se realizaron.`))return;
    setBusy(true);setError('');try{await api.post(`/delivery/returns/${row.id}/actions`,{action,...extra});await load();}catch(e){setError(e.response?.data?.error||e.message);}finally{setBusy(false);}
  }
  const visibleCases=dispatch?cases.filter(row=>row.inventory_status==='pending_review'||!['resolved','rejected','cancelled'].includes(row.status)):cases;
  return <div style={{padding:16,color:colors.textPrimary,height:dispatch?'auto':'100%',flexShrink:0,overflowY:dispatch?'visible':'auto',boxSizing:'border-box',border:dispatch?`1px solid ${colors.border}`:undefined,borderRadius:12}}>
    <h3>{dispatch?'Retiros y cambios pendientes':'Devoluciones y cambios'}{order?' · '+(order.shopifyName||'#'+order.rawId):''}</h3>
    <p style={{color:colors.textSecondary,fontSize:13}}>Cada solicitud conserva el pedido original. El retiro queda pendiente de revisión de inventario; no aumenta automáticamente el stock.</p>
    {dispatch&&<p style={{color:colors.textSecondary,fontSize:13}}>Todas las tareas pendientes, incluidas futuras y sin programar. Esta sección tiene su propio estado y no usa los filtros de ventas de abajo. Al programarlas, aparecen en Cambios y devoluciones de la app del despachador asignado.</p>}
    {error&&<p role="alert" style={{color:colors.red}}>{error}</p>}
    <button style={button} disabled={busy} onClick={load}>Actualizar</button>
    {order&&<fieldset style={{border:`1px solid ${colors.border}`,margin:'14px 0',borderRadius:10}}><legend>Registrar solicitud</legend>
      <select aria-label="Tipo de solicitud" style={style} value={form.kind} onChange={e=>field('kind',e.target.value)}><option value="return">Devolución</option><option value="exchange">Cambio</option><option value="issue">Problema con el producto</option></select>
      {(order.items||[]).map((item,index)=><label key={index} style={{display:'flex',alignItems:'center',gap:10,marginTop:10}}><span style={{flex:1}}>{item.title||item.name} · comprado: {item.quantity}</span><input aria-label={`Cantidad afectada de ${item.title||item.name}`} style={{...style,width:70}} type="number" min="0" max={item.quantity} step="1" value={quantities[index]||''} placeholder="0" onChange={e=>setQuantities({...quantities,[index]:e.target.value})}/></label>)}
      <textarea aria-label="Motivo" placeholder="Motivo de la devolución o cambio" value={form.reason} onChange={e=>field('reason',e.target.value)} style={{...style,width:'100%',boxSizing:'border-box',marginTop:10}}/>
      <textarea aria-label="Reemplazo" placeholder="Qué entregar como reemplazo: productos y cantidades (si corresponde)" value={form.replacementDescription} onChange={e=>field('replacementDescription',e.target.value)} style={{...style,width:'100%',boxSizing:'border-box',marginTop:8}}/>
      <label><input type="checkbox" checked={form.pickupRequired} onChange={e=>field('pickupRequired',e.target.checked)}/> Requiere retirar productos</label>
      <div style={{display:'flex',gap:8,flexWrap:'wrap',margin:'12px 0'}}>
        <select aria-label="Movimiento de dinero" style={style} value={form.moneyDirection} onChange={e=>setForm({...form,moneyDirection:e.target.value,moneyMethod:e.target.value==='none'?'none':'efectivo',moneyAmount:0})}><option value="none">Sin movimiento de dinero</option><option value="refund">Devolver al cliente</option><option value="collect">Cobrar diferencia</option></select>
        {form.moneyDirection!=='none'&&<><select aria-label="Medio de pago" style={style} value={form.moneyMethod} onChange={e=>field('moneyMethod',e.target.value)}><option value="efectivo">Efectivo</option><option value="transferencia">Transferencia</option>{form.moneyDirection==='refund'&&<option value="credit">Saldo a favor</option>}</select><input aria-label="Monto" style={style} type="number" min="1" step="1" value={form.moneyAmount} onChange={e=>field('moneyAmount',e.target.value)}/></>}
      </div><button style={{...button,background:colors.green}} disabled={busy} onClick={create}>Registrar solicitud</button>
    </fieldset>}
    {!visibleCases.length&&<p>{dispatch?'No hay retiros ni cambios pendientes.':'No hay solicitudes registradas.'}</p>}
    {visibleCases.map(row=>{const plan=plans[row.id]||{date:String(row.scheduled_date||'').slice(0,10),driverId:row.driver_user_id||''};const patch=v=>setPlans({...plans,[row.id]:{...plan,...v}});return <div key={row.id} style={{border:`1px solid ${colors.border}`,borderRadius:12,padding:16,marginTop:12,background:colors.bgCard}}>
      <strong>#{row.id} · {row.customer.name} · {RETURN_STATES[row.status]}{row.inventory_status==='pending_review'?' · Inventario pendiente':''}</strong>
      <p>Pedido {row.order_id} · {row.kind==='exchange'?'Cambio':row.kind==='issue'?'Problema':'Devolución'}</p>
      <p>{row.reason}</p><ul>{row.items.map(item=><li key={item.index}>{item.quantity} × {item.name}</li>)}</ul>
      <p>{row.pickup_required?'Retirar los productos indicados.':'No requiere retiro.'} {row.replacement_description&&`Entregar: ${row.replacement_description}`}</p>
      <p>{address(row.customer.address)} · {row.customer.phone}</p>
      <p>{row.money_direction==='none'?'Sin movimiento de dinero':`${row.money_direction==='refund'?'Devolver':'Cobrar'} ${money(row.money_amount)} · ${row.money_method==='credit'?'Saldo a favor':row.money_method} · ${row.money_confirmed?'Registrado':'Pendiente'}`}</p>
      {!row.scheduled_date&&<p style={{color:colors.red}}>Pendiente de asignar fecha y despachador{row.status==='requested'?' · primero aprueba la solicitud':''}.</p>}
      {row.scheduled_date&&<p>Programado: {String(row.scheduled_date).slice(0,10)} · {drivers.find(d=>d.id===row.driver_user_id)?.name||'Despachador asignado'}</p>}
      <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
        {row.status==='requested'&&<><button style={button} disabled={busy} onClick={()=>act(row,'approve')}>Aprobar</button><button style={button} disabled={busy} onClick={()=>act(row,'reject')}>Rechazar</button></>}
        {['approved','scheduled'].includes(row.status)&&<><input aria-label="Fecha de retiro" type="date" style={style} value={plan.date||''} onChange={e=>patch({date:e.target.value})}/><select aria-label="Despachador" style={style} value={plan.driverId||''} onChange={e=>patch({driverId:e.target.value})}><option value="">Elegir despachador</option>{drivers.map(d=><option key={d.id} value={d.id}>{d.name}</option>)}</select><button style={button} disabled={busy} onClick={()=>act(row,'schedule',plan)}>Programar</button></>}
        {(row.status==='review'||(row.status==='approved'&&!row.pickup_required&&!row.replacement_description))&&<button style={button} disabled={busy} onClick={()=>act(row,'resolve',{moneyConfirmed:true})}>Confirmar resolución y movimiento de dinero</button>}
        {['requested','approved','scheduled'].includes(row.status)&&<button style={button} disabled={busy} onClick={()=>act(row,'cancel')}>Cancelar solicitud</button>}
      </div>
      {row.inventory_status==='pending_review'&&<div style={{marginTop:12}}><strong>Inventario: pendiente de revisión</strong><p>Revisa físicamente el producto. Esta acción no modifica stock.</p><input aria-label="Nota de inventario" placeholder="Nota de revisión" style={style} value={plan.note||''} onChange={e=>patch({note:e.target.value})}/><button style={button} disabled={busy} onClick={()=>act(row,'inventory',{note:plan.note,disposition:'discarded'})}>Registrar descarte</button><button style={button} disabled={busy} onClick={()=>act(row,'inventory',{note:plan.note,disposition:'reviewed'})}>Registrar revisión</button></div>}
      <details style={{marginTop:12}}><summary>Seguimiento</summary>{row.events.map((event,index)=><p key={index} style={{fontSize:12}}>{new Date(event.at).toLocaleString('es-CL')} · {RETURN_STATES[event.status]||RETURN_STATES[event.action]||event.action} · Usuario {event.userId} {event.note&&'· '+event.note}</p>)}</details>
    </div>;})}
  </div>;
}
