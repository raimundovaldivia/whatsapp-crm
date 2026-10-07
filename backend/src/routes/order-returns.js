const router = require('express').Router();
const { getPool } = require('../db/database');
const { requireRole } = require('../middleware/auth');
const ADMIN = ['owner','admin','supervisor','coordinador'];
const fail = (message, status=400) => Object.assign(new Error(message), { status });
const dateValid = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
router.use(requireRole(...ADMIN, 'repartidor'));
router.get('/', async (req,res) => {
  try {
    const params=[req.orgId]; let where='organization_id=$1';
    if(req.role==='repartidor'){params.push(req.userId);where+=` AND driver_user_id=$${params.length} AND status IN ('scheduled','in_progress','review','resolved')`;}
    if(req.query.source && req.query.orderId){params.push(req.query.source,String(req.query.orderId));where+=` AND source=$${params.length-1} AND order_id=$${params.length}`;}
    const {rows}=await getPool().query(`SELECT * FROM order_returns WHERE ${where} ORDER BY created_at DESC`,params);
    res.json({cases:rows});
  }catch(err){res.status(500).json({error:'No se pudieron cargar devoluciones y cambios.'});}
});
router.post('/',requireRole(...ADMIN),async(req,res)=>{
  let client;
  try{
    const b=req.body;
    if(!['bot','shopify'].includes(b.source)||!b.orderId||!['return','exchange','issue'].includes(b.kind))throw fail('Pedido o tipo inválido.');
    if(typeof b.requestKey!=='string'||b.requestKey.length<10||b.requestKey.length>100)throw fail('Identificador de solicitud inválido.');
    if(typeof b.reason!=='string'||!b.reason.trim()||b.reason.length>2000)throw fail('Indica el motivo (máximo 2000 caracteres).');
    const replacement=String(b.replacementDescription||'').trim();
    if(replacement.length>2000||(b.kind==='exchange'&&!replacement))throw fail('Indica qué productos y cantidades se entregan como reemplazo.');
    const amount=Number(b.moneyAmount||0),direction=b.moneyDirection||'none',method=b.moneyMethod||'none';
    if(!Number.isSafeInteger(amount)||amount<0||amount>2147483647||!['none','refund','collect'].includes(direction)
      ||!['none','efectivo','transferencia','credit'].includes(method)
      ||(direction==='none'&&(amount!==0||method!=='none'))||(direction!=='none'&&(amount<=0||method==='none'))
      ||(method==='credit'&&direction!=='refund'))throw fail('Revisa el monto y la forma del cobro o devolución.');
    client=await getPool().connect();await client.query('BEGIN');
    const old=await client.query('SELECT * FROM order_returns WHERE organization_id=$1 AND request_key=$2',[req.orgId,b.requestKey]);
    if(old.rows.length){await client.query('COMMIT');return res.json({case:old.rows[0]});}
    const isShop=b.source==='shopify';
    const {rows:[order]}=await client.query(`SELECT * FROM ${isShop?'shopify_orders':'orders'} WHERE organization_id=$1 AND ${isShop?'shopify_order_id':'id::text'}=$2 FOR UPDATE`,[req.orgId,String(b.orderId)]);
    if(!order)throw fail('Pedido no encontrado.',404);
    const originals=Array.isArray(order.items)?order.items:JSON.parse(order.items||'[]');
    if(!Array.isArray(b.items)||!b.items.length)throw fail('Selecciona los productos afectados.');
    const existing=await client.query("SELECT items FROM order_returns WHERE organization_id=$1 AND source=$2 AND order_id=$3 AND status NOT IN ('cancelled','rejected')",[req.orgId,b.source,String(b.orderId)]);
    const used=new Map();for(const row of existing.rows)for(const item of row.items)used.set(item.index,(used.get(item.index)||0)+item.quantity);
    const seen=new Set();
    const items=b.items.map(item=>{
      const index=Number(item.index),quantity=Number(item.quantity),original=originals[index];
      if(!Number.isInteger(index)||seen.has(index)||!original||!Number.isInteger(quantity)||quantity<=0||quantity+(used.get(index)||0)>Number(original.quantity))throw fail('Las cantidades superan lo comprado o ya tienen una devolución registrada.');
      seen.add(index);return {index,quantity,name:original.name||original.title||original.product_name||'Producto',price:Number(original.price)||0};
    });
    const customer={name:order.customer_name||'Cliente',phone:order.customer_phone||'',
      address:isShop?[order.shipping_address1||order.raw_json?.shippingAddress?.address1,order.raw_json?.shippingAddress?.address2,order.shipping_city].filter(Boolean).join(', '):(typeof order.shipping_address==='string' && order.shipping_address.trim().startsWith('{')?JSON.parse(order.shipping_address):order.shipping_address)};
    const event={action:'requested',userId:req.userId,at:new Date().toISOString(),note:b.reason.trim()};
    const {rows:[created]}=await client.query(`INSERT INTO order_returns(organization_id,source,order_id,kind,items,customer,reason,replacement_description,pickup_required,money_direction,money_method,money_amount,created_by,request_key,events)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,[req.orgId,b.source,String(b.orderId),b.kind,JSON.stringify(items),JSON.stringify(customer),b.reason.trim(),replacement,b.pickupRequired!==false,direction,method,amount,req.userId,b.requestKey,JSON.stringify([event])]);
    await client.query('COMMIT');res.status(201).json({case:created});
  }catch(err){if(client)await client.query('ROLLBACK');res.status(err.status||500).json({error:err.status?err.message:'No se pudo registrar la solicitud.'});}finally{client?.release();}
});
router.post('/:id/actions',async(req,res)=>{
  let client;
  try{
    client=await getPool().connect();await client.query('BEGIN');
    const {rows:[row]}=await client.query('SELECT * FROM order_returns WHERE id=$1 AND organization_id=$2 FOR UPDATE',[req.params.id,req.orgId]);
    if(!row)throw fail('Solicitud no encontrada.',404);
    const driver=req.role==='repartidor', b=req.body, action=b.action;
    if(driver&&(row.driver_user_id!==req.userId||!['start','complete','incident'].includes(action)))throw fail('No autorizado para esta solicitud.',403);
    let status=row.status,inventory=row.inventory_status,assigned=row.driver_user_id,date=row.scheduled_date,confirmMoney=false;
    if(action==='approve'&&status==='requested')status='approved';
    else if(action==='reject'&&status==='requested')status='rejected';
    else if(action==='cancel'&&['requested','approved','scheduled'].includes(status))status='cancelled';
    else if(action==='schedule'&&['approved','scheduled'].includes(status)){
      if(!dateValid(b.date)||!Number.isInteger(Number(b.driverId)))throw fail('Indica fecha y despachador.');
      const {rows}=await client.query("SELECT id FROM users WHERE id=$1 AND organization_id=$2 AND merged_into_user_id IS NULL AND role IN ('repartidor','coordinador')",[b.driverId,req.orgId]);
      if(!rows.length)throw fail('Despachador inválido.');
      assigned=Number(b.driverId);date=b.date;status='scheduled';
    }else if(action==='start'&&status==='scheduled')status='in_progress';
    else if(action==='incident'&&status==='in_progress'){
      if(!String(b.note||'').trim())throw fail('Describe por qué no se pudo completar.');
      status='approved';assigned=null;date=null;
    }else if(action==='complete'&&status==='in_progress'){
      if(row.pickup_required&&b.pickedUp!==true)throw fail('Confirma que retiraste los productos.');
      if(row.replacement_description&&b.replaced!==true)throw fail('Confirma la entrega del reemplazo.');
      if(row.money_method==='efectivo'&&b.moneyConfirmed!==true)throw fail('Confirma el movimiento real de efectivo.');
      inventory=row.pickup_required?'pending_review':'not_received';
      confirmMoney=row.money_method==='efectivo';
      status=row.money_amount>0&&!confirmMoney?'review':'resolved';
    }else if(action==='resolve'&&['approved','review'].includes(status)){
      if(status==='approved'&&(row.pickup_required||row.replacement_description))throw fail('Primero debe completarse el retiro o reemplazo.');
      if(row.money_amount>0&&b.moneyConfirmed!==true)throw fail('Confirma que el reembolso/cobro o saldo a favor ya fue registrado.');
      confirmMoney=row.money_amount>0;status='resolved';
    }else if(action==='inventory'&&inventory==='pending_review'){
      if(!['discarded','reviewed'].includes(b.disposition)||!String(b.note||'').trim())throw fail('Indica disposición y nota de revisión.');
      inventory=b.disposition;
    }else throw fail('El estado cambió o la acción no corresponde. Actualiza la lista.',409);
    if(confirmMoney&&row.money_amount>0){
      await client.query(`INSERT INTO return_money_movements(return_id,organization_id,method,amount,recorded_by) VALUES($1,$2,$3,$4,$5) ON CONFLICT(return_id) DO NOTHING`,[row.id,req.orgId,row.money_method,row.money_direction==='refund'?-row.money_amount:row.money_amount,req.userId]);
    }
    const event={action,status,userId:req.userId,at:new Date().toISOString(),note:String(b.note||'').slice(0,2000),driverId:assigned,scheduledDate:date,inventoryStatus:inventory,pickedUp:b.pickedUp===true,replaced:b.replaced===true,moneyConfirmed:confirmMoney};
    const {rows:[updated]}=await client.query(`UPDATE order_returns SET status=$3,inventory_status=$4,driver_user_id=$5,scheduled_date=$6,
      money_confirmed=money_confirmed OR $7,events=events || $8::jsonb,updated_at=NOW() WHERE id=$1 AND organization_id=$2 RETURNING *`,[row.id,req.orgId,status,inventory,assigned,date,confirmMoney,JSON.stringify([event])]);
    await client.query('COMMIT');res.json({case:updated});
  }catch(err){if(client)await client.query('ROLLBACK');res.status(err.status||500).json({error:err.status?err.message:'No se pudo registrar la acción.'});}finally{client?.release();}
});
module.exports=router;
