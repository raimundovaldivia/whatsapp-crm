import React, { useState, useCallback, useRef, useLayoutEffect } from 'react';
import { View, Text, FlatList, TextInput, TouchableOpacity, ActivityIndicator, KeyboardAvoidingView, Platform, Alert } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { colors } from '../theme';
import { getMessages, sendMessage, setAgentMode } from '../services/api';

export default function ChatDetailScreen({ route, navigation }) {
  const { id, name } = route.params;
  const [conv, setConv] = useState(null);
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const listRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const data = await getMessages(id, 80);
      setConv(data.conversation || null);
      setMessages(Array.isArray(data.messages) ? data.messages : []);
    } catch (e) { /* noop */ }
    finally { setLoading(false); }
  }, [id]);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  useLayoutEffect(() => {
    navigation.setOptions({ title: name || 'Chat' });
  }, [navigation, name]);

  const human = conv?.agent_mode === 'human';

  async function toggleMode() {
    const next = human ? 'ai' : 'human';
    try {
      await setAgentMode(id, next);
      setConv(c => ({ ...(c || {}), agent_mode: next }));
    } catch (e) { Alert.alert('Error', e.response?.data?.error || e.message); }
  }

  async function send() {
    const body = text.trim();
    if (!body) return;
    setSending(true);
    try {
      // Al responder manualmente, pasar a modo humano si el bot está activo
      if (!human) { try { await setAgentMode(id, 'human'); setConv(c => ({ ...(c || {}), agent_mode: 'human' })); } catch {} }
      await sendMessage(id, body);
      setText('');
      await load();
      setTimeout(() => listRef.current?.scrollToEnd?.({ animated: true }), 100);
    } catch (e) { Alert.alert('No se pudo enviar', e.response?.data?.error || e.message); }
    finally { setSending(false); }
  }

  const renderMsg = ({ item }) => {
    const inbound = item.direction === 'inbound';
    const isAI = item.sent_by === 'ai';
    return (
      <View style={{ alignSelf: inbound ? 'flex-start' : 'flex-end', maxWidth: '82%', marginVertical: 3, marginHorizontal: 10 }}>
        <View style={{ backgroundColor: inbound ? colors.bgCard : (isAI ? '#14324a' : colors.green), borderRadius: 14, padding: 10, borderTopLeftRadius: inbound ? 2 : 14, borderTopRightRadius: inbound ? 14 : 2 }}>
          <Text style={{ color: inbound ? colors.textPrimary : (isAI ? colors.textPrimary : '#04210f'), fontSize: 14 }}>{item.content}</Text>
        </View>
        <Text style={{ color: colors.textMuted, fontSize: 10, marginTop: 2, alignSelf: inbound ? 'flex-start' : 'flex-end' }}>
          {isAI ? '🤖 ' : ''}{item.created_at ? new Date(item.created_at).toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' }) : ''}
        </Text>
      </View>
    );
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} keyboardVerticalOffset={90} style={{ flex: 1, backgroundColor: colors.bg }}>
      {/* Barra de modo */}
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 10, borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.bgPanel }}>
        <Text style={{ color: human ? colors.orange : colors.green, fontWeight: '700', fontSize: 13 }}>
          {human ? '👤 Atendiendo tú (bot en pausa)' : '🤖 Bot activo'}
        </Text>
        <TouchableOpacity onPress={toggleMode} style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 8, paddingVertical: 5, paddingHorizontal: 10 }}>
          <Text style={{ color: colors.textSecondary, fontSize: 12, fontWeight: '700' }}>{human ? 'Devolver al bot' : 'Tomar el control'}</Text>
        </TouchableOpacity>
      </View>

      {loading ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator color={colors.green} /></View>
      ) : (
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(m, i) => String(m.id || i)}
          renderItem={renderMsg}
          contentContainerStyle={{ paddingVertical: 10 }}
          onContentSizeChange={() => listRef.current?.scrollToEnd?.({ animated: false })}
        />
      )}

      <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8, padding: 10, borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.bgPanel }}>
        <TextInput
          value={text} onChangeText={setText}
          placeholder="Escribe un mensaje…" placeholderTextColor={colors.textMuted}
          multiline
          style={{ flex: 1, maxHeight: 120, backgroundColor: colors.bgCard, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 10, color: colors.textPrimary, fontSize: 14, borderWidth: 1, borderColor: colors.border }}
        />
        <TouchableOpacity onPress={send} disabled={sending || !text.trim()}
          style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: colors.green, alignItems: 'center', justifyContent: 'center', opacity: sending || !text.trim() ? 0.5 : 1 }}>
          {sending ? <ActivityIndicator color="#04210f" /> : <Text style={{ color: '#04210f', fontWeight: '800' }}>➤</Text>}
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}
