export function orderEditNotificationWarning(notification) {
  if (!notification || notification.sent || notification.reason === 'NO_CHANGES') return null;
  if (notification.reason === 'WINDOW_EXPIRED' || notification.reason === 'NO_INBOUND') {
    return 'El pedido se guardó, pero no se avisó al cliente porque la ventana de WhatsApp está cerrada.';
  }
  if (notification.reason === 'NO_PHONE') {
    return 'El pedido se guardó, pero no se pudo avisar porque el cliente no tiene teléfono.';
  }
  if (notification.reason === 'WHATSAPP_NOT_CONFIGURED') {
    return 'El pedido se guardó, pero no se pudo avisar porque WhatsApp no está configurado.';
  }
  return 'El pedido se guardó, pero el mensaje al cliente no pudo enviarse.';
}

export function alertOrderEditNotification(notification) {
  const warning = orderEditNotificationWarning(notification);
  if (warning) window.alert(warning);
  return warning;
}
