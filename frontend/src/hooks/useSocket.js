import { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001';

export function useSocket(orgId, onNewMessage, onAgentModeChanged, onMessageStatus, onOrderCreated) {
  const socketRef = useRef(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!orgId) return;

    const socket = io(BACKEND_URL, { transports: ['websocket', 'polling'] });
    socketRef.current = socket;

    socket.on('connect', () => {
      setConnected(true);
      socket.emit('join_org', orgId); // Unirse a la sala de la organización
    });

    socket.on('disconnect', () => setConnected(false));

    // Escuchar eventos con prefijo de org para aislamiento multi-tenant
    socket.on(`new_message_${orgId}`,       data => onNewMessage?.(data));
    socket.on(`agent_mode_changed_${orgId}`, data => onAgentModeChanged?.(data));
    socket.on(`status_update_${orgId}`,     data => onMessageStatus?.(data));
    socket.on(`order_created_${orgId}`,     data => onOrderCreated?.(data));

    return () => socket.disconnect();
  }, [orgId]);

  return { connected };
}
