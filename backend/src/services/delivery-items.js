const db = require('../db/database');
async function routeItems(req, res) {
  let client;
  try {
    const raw = await db.getSetting(req.orgId, 'modules');
    const modules = typeof raw === 'string' ? JSON.parse(raw || '{}') : raw || {};
    if (modules.edit_delivered_items !== true) return res.status(403).json({ error: 'Edición de productos desactivada' });
    const { source, id, items } = req.method === 'GET' ? req.query : req.body;
    if (!['bot','shopify'].includes(source)) return res.status(400).json({ error: 'Pedido inválido' });
    client = await db.getPool().connect();
    await client.query('BEGIN');
    const driver = ['repartidor','coordinador'].includes(req.role) ? req.userId : null;
    const { rows: [route] } = await client.query(`SELECT * FROM delivery_routes WHERE id=$1 AND organization_id=$2
      AND ($3::int IS NULL OR driver_user_id=$3 OR driver_user_id IS NULL) FOR UPDATE`, [Number(req.params.id), req.orgId, driver]);
    const members = Array.isArray(route?.orders) ? route.orders : JSON.parse(route?.orders || '[]');
    if (!route || !members.some(o => o.source === source && String(o.id) === String(id))) throw Object.assign(new Error('Pedido fuera de tu ruta'), { status: 404 });
    if (!['sent','in_progress','completed'].includes(route.status)) throw Object.assign(new Error('Ruta no disponible'), { status: 409 });
    const table = source === 'bot' ? 'orders' : 'shopify_orders', column = source === 'bot' ? 'id' : 'shopify_order_id';
    const key = source === 'bot' ? Number(id) : String(id);
    const { rows: [order] } = await client.query(`SELECT items,total_price FROM ${table} WHERE ${column}=$1 AND organization_id=$2 FOR UPDATE`, [key,req.orgId]);
    if (!order) throw Object.assign(new Error('Pedido no encontrado'), { status: 404 });
    let result;
    if (req.method === 'GET') {
      const list = Array.isArray(order.items) ? order.items : JSON.parse(order.items || '[]');
      result = { items: list.map(i => ({ name:i.name || i.title || '',quantity:Number(i.quantity)||0,price:Number(i.price)||0,extra:!!i._deliveryExtra })),total:Number(order.total_price)||0 };
    } else {
      if (!Array.isArray(items) || items.length > 100 || items.some(i => !i || typeof i.name !== 'string' || !i.name.trim() || !Number.isSafeInteger(i.quantity) || i.quantity < 0 || i.quantity > 1000 || !Number.isSafeInteger(i.price) || i.price < 0 || i.price > 100000000)) throw Object.assign(new Error('Productos inválidos'), { status: 400 });
      const clean = items.filter(i => i.quantity > 0).map(i => ({ name:i.name.slice(0,200), title:i.name.slice(0,200), quantity:i.quantity, price:i.price, ...(i.extra ? {_deliveryExtra:true}: {}) }));
      const total = clean.reduce((s,i) => s+i.quantity*i.price,0);
      if (!Number.isSafeInteger(total)) throw Object.assign(new Error('Total inválido'), {status:400});
      await client.query(`UPDATE ${table} SET items=$1,total_price=$2,delivery_modified=TRUE WHERE ${column}=$3 AND organization_id=$4`, [JSON.stringify(clean),String(total),key,req.orgId]);
      result = {items:clean,total};
    }
    await client.query('COMMIT');
    res.json({success:true,...result});
  } catch (err) {
    if(client) await client.query('ROLLBACK');
    res.status(err.status || 500).json({error:err.message});
  } finally {client?.release();}
}
module.exports = { routeItems };
