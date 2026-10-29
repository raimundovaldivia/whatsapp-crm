// Se vuelve a leer para cada turno: una respuesta antigua no es configuración.
async function salesStateContext(db, orgId) {
  const enabled = (await db.getSetting(orgId, 'bot_sales_enabled')) !== 'false';
  return [
    '## Estado operativo vigente de las ventas',
    enabled
      ? 'VENTAS HABILITADAS: la tienda permite iniciar y confirmar nuevos pedidos.'
      : 'VENTAS PAUSADAS: la tienda permite consultas, pero no crear ni confirmar nuevos pedidos.',
    'Este estado proviene de la configuración actual y tiene prioridad sobre mensajes anteriores del chat o instrucciones antiguas sobre habilitar ventas. No deduzcas el estado actual de respuestas pasadas del bot.',
    enabled
      ? 'No digas que las ventas están pendientes de habilitación o que falta autorización de la tienda. Sigue comprobando catálogo, precio, stock, cobertura, datos y confirmación explícita. Solo afirma que un pedido fue creado cuando el sistema devuelva su número.'
      : 'Explica la pausa cuando corresponda. No ofrezcas cerrar un pedido ni uses frases que activen su creación; puedes responder consultas y atender pedidos existentes.',
  ].join('\n');
}

module.exports = { salesStateContext };
