import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001';

export function useSocket(orgId, onNewMessage, onAgentModeChanged, onMessageStatus, onOrderCreated, onBotTyping, onPaymentProof, onSync) {
  const socketRef = useRef(null);
  const handlersRef = useRef({});
  const [connected, setConnected] = useState(false);

  // Mantener los callbacks al día sin destruir y recrear el socket en cada render.
  handlersRef.current = {
    onNewMessage,
    onAgentModeChanged,
    onMessageStatus,
    onOrderCreated,
    onBotTyping,
    onPaymentProof,
    onSync,
  };

  useEffect(() => {
    if (!orgId) return;

    const socket = io(BACKEND_URL, {
      // Polling primero permite conectar aun cuando un proxy o una red móvil
      // bloquea momentáneamente WebSocket; luego Socket.IO sube a WebSocket.
      transports: ['polling', 'websocket'],
      upgrade: true,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
      randomizationFactor: 0.3,
      timeout: 15000,
      auth: { token: localStorage.getItem('crm_token') },
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      setConnected(true);
      // Recuperar desde la API cualquier mensaje ocurrido durante el corte.
      handlersRef.current.onSync?.();
    });

    socket.on('disconnect', () => setConnected(false));
    socket.on('connect_error', () => setConnected(false));

    // Escuchar eventos con prefijo de org para aislamiento multi-tenant
    socket.on(`new_message_${orgId}`,       data => handlersRef.current.onNewMessage?.(data));
    socket.on(`agent_mode_changed_${orgId}`, data => handlersRef.current.onAgentModeChanged?.(data));
    socket.on(`status_update_${orgId}`,     data => handlersRef.current.onMessageStatus?.(data));
    socket.on(`order_created_${orgId}`,     data => handlersRef.current.onOrderCreated?.(data));
    socket.on(`bot_typing_${orgId}`,        data => handlersRef.current.onBotTyping?.(data));
    socket.on(`payment_proof_${orgId}`,     data => handlersRef.current.onPaymentProof?.(data));

    const reconnectIfNeeded = () => {
      if (!socket.connected) socket.connect();
    };
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') reconnectIfNeeded();
    };
    window.addEventListener('online', reconnectIfNeeded);
    document.addEventListener('visibilitychange', handleVisibility);

    return () => {
      window.removeEventListener('online', reconnectIfNeeded);
      document.removeEventListener('visibilitychange', handleVisibility);
      socket.disconnect();
      socketRef.current = null;
      setConnected(false);
    };
  }, [orgId]);

  return { connected };
}
