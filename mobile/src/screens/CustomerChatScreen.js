import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TextInput, TouchableOpacity,
  ActivityIndicator, KeyboardAvoidingView, Platform, Alert,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { getStopChat, sendStopChatMessage } from '../services/api';

const C = {
  bg: '#0f172a', card: '#1e293b', border: '#334155', green: '#22c55e',
  blue: '#38bdf8', red: '#f87171', text: '#f1f5f9', muted: '#94a3b8',
};

function formatTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' });
}

function statusLabel(status) {
  if (status === 'read') return '✓✓ Leído';
  if (status === 'delivered') return '✓✓ Entregado';
  if (status === 'failed') return 'No enviado';
  return '✓ Enviado';
}

export default function CustomerChatScreen({ route }) {
  const { routeId, stopKey, stop } = route.params;
  const [messages, setMessages] = useState([]);
  const [windowInfo, setWindowInfo] = useState({ available: false, reason: null });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [sending, setSending] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const scrollRef = useRef(null);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    else setRefreshing(true);
    try {
      const response = await getStopChat(routeId, stopKey);
      setMessages(Array.isArray(response?.data?.messages) ? response.data.messages : []);
      setWindowInfo(response?.data?.window || { available: false });
      setError('');
    } catch (err) {
      if (err.response?.status === 401) return;
      setError(err.response?.data?.error || 'No se pudo cargar el chat. Revisa tu conexión.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [routeId, stopKey]);

  useFocusEffect(useCallback(() => {
    let active = true;
    load(false);
    const timer = setInterval(() => { if (active) load(true); }, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [load]));

  useEffect(() => {
    if (messages.length) setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 80);
  }, [messages.length]);

  async function send() {
    const clean = text.trim();
    if (!clean || sending) return;
    setSending(true);
    try {
      const response = await sendStopChatMessage(routeId, stopKey, clean);
      setText('');
      if (response?.data?.message) setMessages(prev => [...prev, response.data.message]);
      setError('');
    } catch (err) {
      if (err.response?.status === 401) return;
      const expired = err.response?.data?.error === 'WINDOW_EXPIRED';
      const message = err.response?.data?.message || err.response?.data?.error || 'No se pudo enviar el mensaje.';
      if (expired) setWindowInfo(prev => ({ ...prev, available: false, reason: 'WINDOW_EXPIRED' }));
      Alert.alert(expired ? 'Ventana de WhatsApp cerrada' : 'Mensaje no enviado', message);
    } finally {
      setSending(false);
    }
  }

  const canWrite = !!windowInfo.available;

  return (
    <KeyboardAvoidingView style={s.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={90}>
      <View style={s.identity}>
        <View style={s.avatar}><Text style={s.avatarText}>{String(stop?.customerName || 'C').trim().charAt(0).toUpperCase()}</Text></View>
        <View style={{ flex: 1 }}>
          <Text style={s.customer}>{stop?.customerName || 'Cliente'}</Text>
          <Text style={s.phone}>{stop?.phone || 'Sin teléfono'} · {stop?.orderName || 'Pedido de la ruta'}</Text>
        </View>
        {refreshing && <ActivityIndicator size="small" color={C.green} />}
      </View>

      <View style={[s.channelBanner, canWrite ? s.channelOpen : s.channelClosed]}>
        <Text style={[s.channelTitle, { color: canWrite ? C.green : '#fbbf24' }]}>
          {canWrite ? '● Canal oficial disponible' : '● Ventana de respuesta cerrada'}
        </Text>
        <Text style={s.channelText}>
          {canWrite
            ? 'Lo que escribas saldrá desde el WhatsApp del negocio y quedará visible en el CRM.'
            : 'El cliente debe escribir primero. Desde la parada aún puedes usar el aviso operativo aprobado.'}
        </Text>
      </View>

      {loading ? (
        <View style={s.center}><ActivityIndicator color={C.green} /><Text style={s.loadingText}>Cargando conversación…</Text></View>
      ) : (
        <ScrollView
          ref={scrollRef}
          style={s.messages}
          contentContainerStyle={s.messagesContent}
          onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}>
          {!!error && <TouchableOpacity style={s.errorBox} onPress={() => load(false)}><Text style={s.errorText}>{error} · Toca para reintentar</Text></TouchableOpacity>}
          {!messages.length && !error && (
            <View style={s.empty}><Text style={s.emptyTitle}>Sin mensajes todavía</Text><Text style={s.emptyText}>Cuando el cliente escriba, la conversación aparecerá aquí.</Text></View>
          )}
          {messages.map((message, index) => {
            const outbound = message.direction === 'outbound';
            const ownDriverMessage = String(message.agent_type || '').startsWith('driver:');
            return (
              <View key={message.id || `${message.created_at}-${index}`} style={[s.row, outbound ? s.rowOut : s.rowIn]}>
                <View style={[s.bubble, outbound ? s.bubbleOut : s.bubbleIn]}>
                  <Text style={s.sender}>{outbound ? (ownDriverMessage ? 'Repartidor' : 'Equipo / Diva') : (stop?.customerName || 'Cliente')}</Text>
                  <Text style={s.messageText}>{message.content || ''}</Text>
                  <View style={s.meta}><Text style={s.time}>{formatTime(message.created_at)}</Text>{outbound && <Text style={[s.time, message.status === 'failed' && { color: C.red }]}>{statusLabel(message.status)}</Text>}</View>
                </View>
              </View>
            );
          })}
        </ScrollView>
      )}

      <View style={s.composer}>
        <TextInput
          style={[s.input, !canWrite && s.inputDisabled]}
          value={text}
          onChangeText={setText}
          placeholder={canWrite ? 'Escribe para coordinar la entrega…' : 'Espera un mensaje del cliente'}
          placeholderTextColor={C.muted}
          editable={canWrite && !sending}
          multiline
          maxLength={1000}
        />
        <TouchableOpacity style={[s.send, (!canWrite || !text.trim() || sending) && s.sendDisabled]} onPress={send} disabled={!canWrite || !text.trim() || sending} activeOpacity={0.8}>
          {sending ? <ActivityIndicator color="#fff" /> : <Text style={s.sendText}>➤</Text>}
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  identity: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderBottomWidth: 1, borderBottomColor: C.border, backgroundColor: C.card },
  avatar: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center', backgroundColor: '#0f766e' },
  avatarText: { color: '#fff', fontSize: 18, fontWeight: '800' },
  customer: { color: C.text, fontSize: 16, fontWeight: '800' },
  phone: { color: C.muted, fontSize: 12, marginTop: 3 },
  channelBanner: { margin: 12, marginBottom: 0, padding: 11, borderRadius: 12, borderWidth: 1 },
  channelOpen: { backgroundColor: '#052e2b', borderColor: '#166534' },
  channelClosed: { backgroundColor: '#31270d', borderColor: '#854d0e' },
  channelTitle: { fontWeight: '800', fontSize: 13 },
  channelText: { color: C.text, fontSize: 12, lineHeight: 17, marginTop: 4 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10 },
  loadingText: { color: C.muted },
  messages: { flex: 1 },
  messagesContent: { flexGrow: 1, padding: 12, paddingTop: 16 },
  row: { width: '100%', marginBottom: 8 },
  rowOut: { alignItems: 'flex-end' },
  rowIn: { alignItems: 'flex-start' },
  bubble: { maxWidth: '84%', minWidth: 110, borderRadius: 14, padding: 10, borderWidth: 1 },
  bubbleOut: { backgroundColor: '#075e54', borderColor: '#0f766e', borderBottomRightRadius: 3 },
  bubbleIn: { backgroundColor: C.card, borderColor: C.border, borderBottomLeftRadius: 3 },
  sender: { color: C.blue, fontSize: 11, fontWeight: '800', marginBottom: 4 },
  messageText: { color: C.text, fontSize: 15, lineHeight: 20 },
  meta: { flexDirection: 'row', gap: 7, justifyContent: 'flex-end', marginTop: 5 },
  time: { color: '#cbd5e1', fontSize: 10 },
  errorBox: { backgroundColor: '#3f1d25', borderColor: '#7f1d1d', borderWidth: 1, borderRadius: 10, padding: 10, marginBottom: 12 },
  errorText: { color: '#fecaca', textAlign: 'center', fontSize: 12 },
  empty: { flex: 1, minHeight: 190, alignItems: 'center', justifyContent: 'center', padding: 30 },
  emptyTitle: { color: C.text, fontWeight: '800', fontSize: 16 },
  emptyText: { color: C.muted, textAlign: 'center', marginTop: 6, lineHeight: 18 },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 9, padding: 10, paddingBottom: Platform.OS === 'ios' ? 16 : 10, borderTopWidth: 1, borderTopColor: C.border, backgroundColor: C.card },
  input: { flex: 1, maxHeight: 110, minHeight: 46, color: C.text, backgroundColor: C.bg, borderWidth: 1, borderColor: C.border, borderRadius: 14, paddingHorizontal: 13, paddingVertical: 11 },
  inputDisabled: { opacity: 0.55 },
  send: { width: 46, height: 46, borderRadius: 23, backgroundColor: '#0f766e', alignItems: 'center', justifyContent: 'center' },
  sendDisabled: { opacity: 0.35 },
  sendText: { color: '#fff', fontSize: 22, marginLeft: 2 },
});
