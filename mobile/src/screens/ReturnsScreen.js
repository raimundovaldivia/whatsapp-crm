import React,{useState,useCallback} from 'react';
import {ScrollView,View,Text,TouchableOpacity,TextInput,Alert,RefreshControl,Linking} from 'react-native';
import {useFocusEffect} from '@react-navigation/native';
import {getReturnTasks,updateReturnTask} from '../services/api';
import {C} from '../theme';
const states={scheduled:'Programado',in_progress:'En retiro/cambio',review:'Esperando resolución del equipo',resolved:'Resuelto'};
const money=n=>'$'+Number(n||0).toLocaleString('es-CL');
const address=value=>typeof value==='string'?value:Object.values(value||{}).filter(v=>typeof v==='string').join(', ');
export default function ReturnsScreen(){
  const [rows,setRows]=useState([]),[loading,setLoading]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[checks,setChecks]=useState({}),[history,setHistory]=useState(false);
  const load=useCallback(async()=>{setLoading(true);setError('');try{setRows((await getReturnTasks()).cases||[]);}catch(e){setError(e.response?.data?.error||'No se pudo cargar. Revisa la conexión.');}finally{setLoading(false);}},[]);
  useFocusEffect(useCallback(()=>{load();},[load]));
  async function act(row,action){
    setBusy(true);try{await updateReturnTask(row.id,{action,...(checks[row.id]||{})});setChecks(c=>({...c,[row.id]:{}}));await load();}catch(e){Alert.alert('No se registró la acción',e.response?.data?.error||'Verifica con conexión antes de repetir un cobro o devolución.');await load();}finally{setBusy(false);}
  }
  function complete(row){Alert.alert('Confirmar visita',`Confirma solo lo realizado. ${row.money_method==='efectivo'?`${row.money_direction==='refund'?'Devolviste':'Cobraste'} ${money(row.money_amount)} en efectivo.`:'El equipo resolverá cualquier transferencia o saldo a favor pendiente.'}`,[{text:'Volver',style:'cancel'},{text:'Confirmar',onPress:()=>act(row,'complete')}]);}
  const text={color:C.text,fontSize:15,marginBottom:8};
  const button={padding:13,backgroundColor:C.green,borderRadius:9,marginTop:9};
  return <ScrollView style={{flex:1,backgroundColor:C.bg}} contentContainerStyle={{padding:16,paddingBottom:50}} refreshControl={<RefreshControl refreshing={loading} onRefresh={load}/>}>
    <Text style={{...text,fontSize:23,fontWeight:'700'}}>Cambios y devoluciones</Text>
    <Text style={text}>Tareas asignadas a ti. Revisa qué retirar, qué entregar y el dinero antes de la visita.</Text>
    {!!error&&<Text style={{...text,color:C.red}}>{error}</Text>}
    <TouchableOpacity onPress={()=>setHistory(!history)}><Text style={{...text,color:C.green}}>{history?'Ocultar resueltos':'Mostrar también resueltos'}</Text></TouchableOpacity>
    {!loading&&!rows.filter(r=>history||r.status!=='resolved').length&&<Text style={text}>Sin tareas pendientes.</Text>}
    {rows.filter(r=>history||r.status!=='resolved').map(row=>{const check=checks[row.id]||{};const set=(key,value)=>setChecks(c=>({...c,[row.id]:{...(c[row.id]||{}),[key]:value}}));return <View key={row.id} style={{backgroundColor:C.card,borderRadius:12,padding:16,marginBottom:16}}>
      <Text style={{...text,fontWeight:'700'}}>#{row.id} · {row.customer.name}</Text><Text style={text}>{states[row.status]} · {String(row.scheduled_date||'').slice(0,10)}</Text>
      <Text style={text}>{address(row.customer.address)}</Text>
      <TouchableOpacity onPress={()=>Linking.openURL('https://www.google.com/maps/search/?api=1&query='+encodeURIComponent(address(row.customer.address)))}><Text style={{...text,color:C.green}}>Abrir dirección en mapa</Text></TouchableOpacity>
      {!!row.customer.phone&&<TouchableOpacity onPress={()=>Linking.openURL('tel:'+row.customer.phone.replace(/[^+0-9]/g,''))}><Text style={{...text,color:C.green}}>Llamar al cliente</Text></TouchableOpacity>}
      <Text style={text}>Motivo: {row.reason}</Text>
      <Text style={{...text,fontWeight:'700'}}>{row.pickup_required?'Retirar:':'Productos afectados (sin retiro):'}</Text>
      {row.items.map(item=><Text key={item.index} style={text}>{item.quantity} × {item.name}</Text>)}
      {!!row.replacement_description&&<Text style={{...text,fontWeight:'700'}}>Entregar: {row.replacement_description}</Text>}
      <Text style={{...text,color:C.green,fontWeight:'700'}}>{row.money_direction==='none'?'Sin cobro ni devolución de dinero':`${row.money_direction==='refund'?'Devolver':'Cobrar'} ${money(row.money_amount)} · ${row.money_method==='credit'?'saldo a favor (lo gestiona el equipo)':row.money_method}`}</Text>
      {row.status==='scheduled'&&<TouchableOpacity disabled={busy} style={button} onPress={()=>act(row,'start')}><Text>Iniciar retiro/cambio</Text></TouchableOpacity>}
      {row.status==='in_progress'&&<>
        {[[row.pickup_required,'pickedUp','Retiré los productos'],[!!row.replacement_description,'replaced','Entregué el reemplazo'],[row.money_method==='efectivo','moneyConfirmed',`${row.money_direction==='refund'?'Devolví':'Cobré'} ${money(row.money_amount)} en efectivo`]].filter(([show])=>show).map(([,key,label])=><TouchableOpacity key={key} disabled={busy} onPress={()=>set(key,!check[key])} style={{paddingVertical:12}}><Text style={text}>{check[key]?'☑':'☐'} {label}</Text></TouchableOpacity>)}
        <TextInput style={{color:C.text,borderWidth:1,borderColor:C.muted,padding:12,borderRadius:8}} placeholder="Observaciones o motivo si no se pudo completar" placeholderTextColor={C.muted} value={check.note||''} onChangeText={value=>set('note',value)} multiline/>
        <TouchableOpacity disabled={busy} style={button} onPress={()=>complete(row)}><Text>{busy?'Guardando…':'Completar visita'}</Text></TouchableOpacity>
        <TouchableOpacity disabled={busy} style={{...button,backgroundColor:C.card,borderColor:C.muted,borderWidth:1}} onPress={()=>act(row,'incident')}><Text style={text}>No se pudo realizar · avisar al equipo</Text></TouchableOpacity>
      </>}
      {row.inventory_status==='pending_review'&&<Text style={text}>Entrega los productos retirados al equipo para revisar su estado. No se incorporan automáticamente al stock.</Text>}
    </View>;})}
  </ScrollView>;
}
