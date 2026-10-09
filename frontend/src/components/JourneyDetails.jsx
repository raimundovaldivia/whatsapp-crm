import { useEffect, useState } from 'react';
import { api } from '../utils/api.js';
import { useTheme } from '../theme.js';
import { purchaseAgeLabel } from '../utils/broadcast-audience.mjs';
const reasonLabels = { baja_marketing:'Pidió no recibir promociones', otra_secuencia_activa:'Incluido en otra campaña activa', pedido_activo:'Tiene un pedido marcado como activo', atencion_humana:'Conversación en atención humana', contactado_recientemente:'Recibió una plantilla dentro del descanso entre campañas', respondio:'Respondió al mensaje', secuencia_no_activa:'Campaña no activa', mensaje_anterior_fallido:'Falló el mensaje anterior' };
const stateLabels = { draft:'Borrador', active:'Pendiente de procesamiento', excluded:'Excluido', completed:'Procesado', failed:'Fallido', stopped:'Detenido' };
const modes = [['first_name','Primer nombre'],['full_name','Nombre completo'],['city','Ciudad'],['phone','Teléfono'],['last_order_date','Fecha última compra'],['days_since_order','Días sin comprar'],['total_orders','Cantidad de pedidos'],['fixed','Texto fijo']];
export default function JourneyDetails({ id, onClose, onSaved }) {
  const { colors:c } = useTheme();
  const [journey,setJourney] = useState(null), [steps,setSteps] = useState([]), [recipient,setRecipient] = useState('');
  const [error,setError] = useState(''), [busy,setBusy] = useState(false), [messages,setMessages] = useState([]), [saved,setSaved] = useState('');
  useEffect(() => { let live=true; api.get(`/reengagement/journeys/${id}`).then(({data}) => {
    if (!live) return; setJourney(data.journey); setSteps(data.journey.steps); setRecipient(String(data.journey.enrollments[0]?.id || ''));
  }).catch(e => { if(live) setError(e.response?.data?.error || 'No se pudo cargar'); }); return () => { live=false; }; }, [id]);
  const style={background:c.bgCard,color:c.textPrimary,border:`1px solid ${c.border}`,borderRadius:7,padding:8};
  const update=(si,vi,patch) => { setMessages([]); setSaved(''); setSteps(old=>old.map((s,i)=>i!==si?s:{...s,variable_modes:s.variable_modes.map((m,j)=>j!==vi?m:{...(typeof m==='string'?{mode:m}:m),...patch})})); };
  const preview=async()=>{setBusy(true);setError('');setMessages([]);try { const {data}=await api.post(`/reengagement/journeys/${id}/preview`,{steps,enrollmentId:recipient});setMessages(data.messages); }catch(e){setError(e.response?.data?.error || 'No se pudo generar la vista previa');}finally{setBusy(false);}};
  const save=async()=>{setBusy(true);setError('');try {await api.patch(`/reengagement/journeys/${id}`,{steps:steps.map(s=>({templateName:s.template_name,variableModes:s.variable_modes}))});setSaved('Cambios guardados. El borrador todavía no se ha enviado.');onSaved?.();}catch(e){setError(e.response?.data?.error || 'No se pudo guardar');}finally{setBusy(false);}};
  return <div role="dialog" aria-modal="true" aria-label="Detalles de campaña" style={{position:'fixed',inset:0,zIndex:10030,background:'#0009',display:'flex',justifyContent:'center',alignItems:'center',padding:16}}>
    <div style={{background:c.bgPanel,color:c.textPrimary,width:900,maxWidth:'100%',maxHeight:'90vh',overflowY:'auto',borderRadius:14,padding:20}}>
      <div style={{display:'flex',justifyContent:'space-between',gap:12}}><h2 style={{margin:0,fontSize:18}}>{journey?.name || 'Detalles de campaña'}</h2><button style={style} onClick={onClose}>Cerrar detalles</button></div>
      {error && <p role="alert" style={{color:c.red}}>{error}</p>}
      {journey && <>
        <p>Kapso · {journey.status === 'draft' ? 'Borrador' : journey.status} · {journey.enrollments.length} destinatarios</p>
        <p>{purchaseAgeLabel(journey.audience_filters?.purchaseDays || 'all')} · Descanso: {journey.cooldown_hours} horas</p>
        {steps.map((step,si)=><section key={step.id} style={{borderTop:`1px solid ${c.border}`,paddingTop:12,marginTop:12}}>
          <strong>Paso {si+1} · {step.template_name}</strong><p>Espera: {step.wait_hours} horas</p>
          <fieldset disabled={journey.status !== 'draft' || busy} style={{border:0,padding:0,display:'grid',gap:10}}>
            {step.variable_modes.map((value,vi)=>{const config=typeof value==='string'?{mode:value}:value;return <div key={vi} style={{display:'flex',gap:8,flexWrap:'wrap',alignItems:'center'}}>
              <strong>{`{{${vi+1}}}`}</strong><select aria-label={`Parámetro ${vi+1} paso ${si+1}`} value={config.mode} onChange={e=>update(si,vi,{mode:e.target.value})} style={style}>{modes.map(([k,l])=><option key={k} value={k}>{l}</option>)}</select>
              {config.mode==='fixed'?<input aria-label={`Texto ${vi+1} paso ${si+1}`} value={config.value || ''} onChange={e=>update(si,vi,{value:e.target.value})} style={{...style,flex:'1 1 300px'}}/>:<>
                <input aria-label={`Antes ${vi+1} paso ${si+1}`} placeholder="Texto antes" value={config.prefix || ''} onChange={e=>update(si,vi,{prefix:e.target.value})} style={style}/>
                <input aria-label={`Después ${vi+1} paso ${si+1}`} placeholder="Texto después" value={config.suffix || ''} onChange={e=>update(si,vi,{suffix:e.target.value})} style={style}/>
                <input aria-label={`Alternativa ${vi+1} paso ${si+1}`} placeholder="Si falta el dato" value={config.fallback || ''} onChange={e=>update(si,vi,{fallback:e.target.value})} style={style}/>
              </>}
            </div>;})}
          </fieldset>
        </section>)}
        <h3>Estado de los envíos</h3>
        {Object.entries(journey.enrollments.reduce((counts,e)=>{ const label=e.stop_reason ? (reasonLabels[e.stop_reason] || e.stop_reason) : (stateLabels[e.status] || e.status); counts[label]=(counts[label] || 0)+1; return counts; },{})).map(([label,count])=><p key={label}><strong>{count}</strong> · {label}</p>)}
        <p style={{fontSize:12}}>Procesado significa que se completó el paso; consulta Historial para confirmar entrega o lectura. Los pendientes se revisan automáticamente cada 10 minutos dentro del horario de envío.</p>
        <h3>Vista previa por destinatario</h3>
        <select aria-label="Destinatario de vista previa" value={recipient} onChange={e=>{setRecipient(e.target.value);setMessages([]);}} style={{...style,maxWidth:'100%'}}>{journey.enrollments.map(e=><option key={e.id} value={e.id}>{e.contact_name} · {e.phone}</option>)}</select>
        <button onClick={preview} disabled={busy || !recipient} style={{...style,marginLeft:8}}>Ver mensaje personalizado</button>
        {messages.map((m,i)=><pre key={i} style={{whiteSpace:'pre-wrap',background:c.bgCard,padding:16,borderRadius:10,fontFamily:'inherit'}}>{m}</pre>)}
        {saved && <p role="status" style={{color:c.green}}>{saved}</p>}
        {journey.status==='draft' && <button disabled={busy} onClick={save} style={{...style,marginTop:16,color:c.green}}>Guardar cambios del borrador</button>}
        <details style={{marginTop:16}}><summary>Ver destinatarios ({journey.enrollments.length})</summary>{journey.enrollments.map(e=><p key={e.id}>{e.contact_name} · {e.phone} · {stateLabels[e.status] || e.status}{e.stop_reason ? ` · ${reasonLabels[e.stop_reason] || e.stop_reason}` : ''}{e.next_run_at ? ` · Programado: ${new Date(e.next_run_at).toLocaleString('es-CL', {timeZone:'America/Santiago'})}` : ''}</p>)}</details>
      </>}
    </div>
  </div>;
}
