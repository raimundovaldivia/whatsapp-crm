import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TextInput, TouchableOpacity,
  ActivityIndicator, KeyboardAvoidingView, Platform, Alert, Image, Linking,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { getStopChat, sendStopChatMessage, sendStopChatMedia } from '../services/api';
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
  const insets = useSafeAreaInsets();
  const [messages, setMessages] = useState([]);
  const [windowInfo, setWindowInfo] = useState({ available: false, reason: null });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [sending, setSending] = useState(false);
  const [text, setText] = useState('');
  const [attachment, setAttachment] = useState(null);
  const [selecting, setSelecting] = useState(false);
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
    if ((!clean && !attachment) || sending) return;
    const pendingAttachment = attachment;
    setSending(true);
    try {
      const response = pendingAttachment
        ? await sendStopChatMedia(routeId, stopKey, { ...pendingAttachment, caption: clean })
        : await sendStopChatMessage(routeId, stopKey, clean);
      setText('');
      setAttachment(null);
      if (response?.data?.message) setMessages(prev => [...prev, response.data.message]);
      if (response?.data?.channel) {
        setWindowInfo(prev => ({ ...prev, available: true, channel: response.data.channel, fallback: !!response.data.fallback }));
      }
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

  function ensureSize(size) {
    if (Number(size || 0) > 6 * 1024 * 1024) {
      Alert.alert('Archivo demasiado grande', 'El máximo permitido es 6 MB.');
      return false;
    }
    return true;
  }

  function mimeFromName(name = '') {
    const ext = name.toLowerCase().split('.').pop();
    return ({ pdf:'application/pdf', doc:'application/msword', docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xls:'application/vnd.ms-excel', xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', csv:'text/csv', txt:'text/plain' })[ext] || 'application/octet-stream';
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  async function pickPhoto() {
    setSelecting(true);
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) return Alert.alert('Permiso necesario', 'Permite el acceso a las fotos para adjuntar una imagen.');
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.72, base64: true });
      if (result.canceled || !result.assets?.[0]) return;
      const asset = result.assets[0];
      if (!ensureSize(asset.fileSize)) return;
      if (!asset.base64) throw new Error('No se pudo leer la foto');
      const mimeType = asset.mimeType || 'image/jpeg';
      setAttachment({ data: `data:${mimeType};base64,${asset.base64}`, mimeType, fileName: asset.fileName || `foto-${Date.now()}.jpg`, size: asset.fileSize || 0 });
    } catch (err) {
      Alert.alert('No se pudo adjuntar', err.message || 'Intenta nuevamente.');
    } finally { setSelecting(false); }
  }

  async function pickDocument() {
    setSelecting(true);
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: ['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'text/csv', 'text/plain'],
        copyToCacheDirectory: true,
      });
      if (result.canceled || !result.assets?.[0]) return;
      const asset = result.assets[0];
      if (!ensureSize(asset.size)) return;
      const mimeType = asset.mimeType || mimeFromName(asset.name);
      if (mimeType === 'application/octet-stream') return Alert.alert('Formato no permitido', 'Usa PDF, Word, Excel, CSV o TXT.');
      const response = await fetch(asset.uri);
      const data = await blobToDataUrl(await response.blob());
      setAttachment({ data, mimeType, fileName: asset.name || 'archivo', size: asset.size || 0 });
    } catch (err) {
      Alert.alert('No se pudo adjuntar', err.message || 'Intenta nuevamente.');
    } finally { setSelecting(false); }
  }

  function chooseAttachment() {
    Alert.alert('Adjuntar', '¿Qué quieres enviar?', [
      { text: 'Foto', onPress: pickPhoto },
      { text: 'Documento', onPress: pickDocument },
      { text: 'Cancelar', style: 'cancel' },
    ]);
  }

  const canWrite = !!windowInfo.available;
  const usingEvolution = canWrite && windowInfo.channel === 'evolution';

  return (
    <KeyboardAvoidingView
      style={s.screen}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}>
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
          <MaterialCommunityIcons name={canWrite ? (usingEvolution ? 'swap-horizontal-circle-outline' : 'message-check-outline') : 'clock-alert-outline'} size={20} color={canWrite ? C.green : C.orange} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[s.channelTitle, { color: canWrite ? C.green : C.orange }]}>
            {canWrite ? (usingEvolution ? 'Conversación por Evolution' : 'Canal oficial disponible') : 'Canales no disponibles'}
          </Text>
          <Text style={s.channelText}>
            {canWrite
              ? usingEvolution
                ? 'La ventana de Kapso está cerrada. La app enviará automáticamente por Evolution y guardará la conversación.'
                : 'El mensaje saldrá por Kapso y quedará registrado en el chat central.'
              : (windowInfo.message || 'Kapso está cerrado y Evolution no está disponible.')}
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
                  {message.type === 'image' && String(message.media_id || '').startsWith('https://') && (
                    <Image source={{ uri: message.media_id }} style={s.messageImage} resizeMode="cover" />
                  )}
                  {message.type === 'document' && String(message.media_id || '').startsWith('https://') ? (
                    <TouchableOpacity style={s.document} onPress={() => Linking.openURL(message.media_id)} activeOpacity={0.75}>
                      <Text style={s.documentIcon}>📎</Text><Text style={s.documentName}>{String(message.content || 'Archivo').split('\n')[0].replace(/^📎\s*/, '')}</Text>
                    </TouchableOpacity>
                  ) : (
                    <Text style={s.messageText}>{message.content || ''}</Text>
                  )}
                  <View style={s.meta}><Text style={s.time}>{formatTime(message.created_at)}</Text>{outbound && <Text style={[s.time, message.status === 'failed' && { color: C.red }]}>{statusLabel(message.status)}</Text>}</View>
                </View>
              </View>
            );
          })}
        </ScrollView>
      )}

      <View style={[s.composer, { paddingBottom: Math.max(11, insets.bottom + 6) }]}>
        {attachment && (
          <View style={s.attachmentPreview}>
            {String(attachment.mimeType).startsWith('image/') && String(attachment.data).startsWith('data:')
              ? <Image source={{ uri: attachment.data }} style={s.attachmentImage} />
              : <Text style={s.attachmentIcon}>📎</Text>}
            <View style={{ flex:1 }}><Text style={s.attachmentName} numberOfLines={1}>{attachment.fileName}</Text><Text style={s.attachmentSize}>{attachment.size ? `${Math.round(attachment.size / 1024)} KB` : 'Listo para enviar'}</Text></View>
            <TouchableOpacity onPress={() => setAttachment(null)}><Text style={s.removeAttachment}>✕</Text></TouchableOpacity>
          </View>
        )}
        <View style={s.composerRow}>
        <TouchableOpacity style={[s.attach, (!canWrite || sending || selecting) && s.sendDisabled]} onPress={chooseAttachment} disabled={!canWrite || sending || selecting} activeOpacity={0.8}>
          {selecting ? <ActivityIndicator color={C.text} size="small" /> : <Text style={s.attachText}>📎</Text>}
        </TouchableOpacity>
        <TextInput
          style={[s.input, !canWrite && s.inputDisabled]}
          value={text}
          onChangeText={setText}
          placeholder={canWrite ? 'Escribe para coordinar la entrega…' : 'No hay un canal disponible'}
          placeholderTextColor={C.muted}
          selectionColor={C.green}
          cursorColor={C.green}
          editable={canWrite && !sending}
          multiline
          maxLength={1000}
        />
        <TouchableOpacity style={[s.send, (!canWrite || (!text.trim() && !attachment) || sending) && s.sendDisabled]} onPress={send} disabled={!canWrite || (!text.trim() && !attachment) || sending} activeOpacity={0.8}>
          {sending ? <ActivityIndicator color={C.inkOnAccent} /> : <MaterialCommunityIcons name={attachment ? 'upload' : 'send'} size={20} color={C.inkOnAccent} />}
        </TouchableOpacity>
        </View>
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
  messageImage: { width: 220, height: 170, maxWidth: '100%', borderRadius: 9, marginBottom: 6, backgroundColor: C.border },
  document: { flexDirection:'row', alignItems:'center', gap:8, backgroundColor:'#0f172a99', borderRadius:9, padding:10, minWidth:210 },
  documentIcon: { fontSize:22 },
  documentName: { color:C.text, fontSize:13, fontWeight:'700', flex:1 },
  meta: { flexDirection: 'row', gap: 7, justifyContent: 'flex-end', marginTop: 5 },
  time: { color: '#cbd5e1', fontSize: 10 },
  errorBox: { backgroundColor: '#3f1d25', borderColor: '#7f1d1d', borderWidth: 1, borderRadius: 10, padding: 10, marginBottom: 12 },
  errorText: { color: '#fecaca', textAlign: 'center', fontSize: 12 },
  empty: { flex: 1, minHeight: 190, alignItems: 'center', justifyContent: 'center', padding: 30 },
  emptyTitle: { color: C.text, fontWeight: '800', fontSize: 16 },
  emptyText: { color: C.muted, textAlign: 'center', marginTop: 6, lineHeight: 18 },
  composer: { padding: 11, paddingBottom: Platform.OS === 'ios' ? 17 : 11, borderTopWidth: 1, borderTopColor: C.borderSoft, backgroundColor: C.card },
  composerRow: { flexDirection:'row', alignItems:'flex-end', gap:9 },
  attachmentPreview: { flexDirection:'row', alignItems:'center', gap:9, marginBottom:8, padding:8, backgroundColor:C.bgSoft, borderRadius:R.md, borderWidth:1, borderColor:C.border },
  attachmentImage: { width:42, height:42, borderRadius:7 },
  attachmentIcon: { fontSize:24 },
  attachmentName: { color:C.text, fontSize:12, fontWeight:'700' },
  attachmentSize: { color:C.muted, fontSize:10, marginTop:2 },
  removeAttachment: { color:C.muted, fontSize:18, padding:6 },
  attach: { width:48, height:48, borderRadius:16, backgroundColor:C.bgSoft, borderWidth:1, borderColor:C.border, alignItems:'center', justifyContent:'center' },
  attachText: { fontSize:21 },
  input: { flex: 1, maxHeight: 110, minHeight: 48, color: C.text, backgroundColor: C.bgSoft, borderWidth: 1, borderColor: C.border, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, lineHeight: 20, textAlignVertical: 'top', includeFontPadding: false },
  inputDisabled: { opacity: 0.55 },
  send: { width: 48, height: 48, borderRadius: 16, backgroundColor: C.green, alignItems: 'center', justifyContent: 'center' },
  sendDisabled: { opacity: 0.35 },
});
