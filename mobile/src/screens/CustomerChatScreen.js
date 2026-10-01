import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TextInput, TouchableOpacity,
  ActivityIndicator, KeyboardAvoidingView, Platform, Alert,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { getStopChat, sendStopChatMessage } from '../services/api';
import { C, R, shadowSoft } from '../theme';

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
        <View style={[s.channelIcon, { backgroundColor: (canWrite ? C.green : C.orange) + '1F' }]}>
          <MaterialCommunityIcons name={canWrite ? 'message-check-outline' : 'clock-alert-outline'} size={20} color={canWrite ? C.green : C.orange} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[s.channelTitle, { color: canWrite ? C.green : C.orange }]}>
            {canWrite ? 'Canal oficial disponible' : 'Ventana de respuesta cerrada'}
          </Text>
          <Text style={s.channelText}>
            {canWrite
              ? 'El mensaje saldrá desde el WhatsApp del negocio y quedará registrado.'
              : 'El cliente debe escribir primero. Usa el aviso operativo desde la parada.'}
          </Text>
        </View>
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
          {sending ? <ActivityIndicator color={C.inkOnAccent} /> : <MaterialCommunityIcons name="send" size={20} color={C.inkOnAccent} />}
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: C.bg },
  identity: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: C.borderSoft, backgroundColor: C.card },
  avatar: { width: 44, height: 44, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: '#0A3D3A', borderWidth: 1, borderColor: '#147A72' },
  avatarText: { color: '#fff', fontSize: 18, fontWeight: '800' },
  customer: { color: C.text, fontSize: 16, fontWeight: '800' },
  phone: { color: C.muted, fontSize: 12, marginTop: 3 },
  channelBanner: { flexDirection: 'row', alignItems: 'center', gap: 11, margin: 12, marginBottom: 0, padding: 12, borderRadius: R.md, borderWidth: 1, ...shadowSoft },
  channelIcon: { width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  channelOpen: { backgroundColor: '#082A2B', borderColor: '#155E5B' },
  channelClosed: { backgroundColor: '#2A210D', borderColor: '#714F0C' },
  channelTitle: { fontWeight: '800', fontSize: 13 },
  channelText: { color: C.text, fontSize: 12, lineHeight: 17, marginTop: 4 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10 },
  loadingText: { color: C.muted },
  messages: { flex: 1 },
  messagesContent: { flexGrow: 1, paddingHorizontal: 13, paddingVertical: 18 },
  row: { width: '100%', marginBottom: 8 },
  rowOut: { alignItems: 'flex-end' },
  rowIn: { alignItems: 'flex-start' },
  bubble: { maxWidth: '84%', minWidth: 110, borderRadius: 17, paddingHorizontal: 12, paddingVertical: 10, borderWidth: 1, ...shadowSoft },
  bubbleOut: { backgroundColor: '#0B544F', borderColor: '#147A72', borderBottomRightRadius: 5 },
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
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 9, padding: 11, paddingBottom: Platform.OS === 'ios' ? 17 : 11, borderTopWidth: 1, borderTopColor: C.borderSoft, backgroundColor: C.card },
  input: { flex: 1, maxHeight: 110, minHeight: 48, color: C.text, backgroundColor: C.bgSoft, borderWidth: 1, borderColor: C.border, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 12 },
  inputDisabled: { opacity: 0.55 },
  send: { width: 48, height: 48, borderRadius: 16, backgroundColor: C.green, alignItems: 'center', justifyContent: 'center' },
  sendDisabled: { opacity: 0.35 },
});
