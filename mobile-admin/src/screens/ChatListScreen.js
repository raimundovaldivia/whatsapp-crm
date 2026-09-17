import React, { useState, useCallback } from 'react';
import { View, Text, FlatList, TouchableOpacity, RefreshControl, ActivityIndicator } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { colors } from '../theme';
import { getConversations } from '../services/api';

function timeAgo(ts) {
  if (!ts) return '';
  const s = (Date.now() - new Date(ts).getTime()) / 1000;
  if (s < 60) return 'ahora';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export default function ChatListScreen({ navigation }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const data = await getConversations();
      setItems(Array.isArray(data) ? data : []);
      setError(null);
    } catch (e) { setError(e.response?.data?.error || e.message); }
    finally { setLoading(false); setRefreshing(false); }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const renderItem = ({ item }) => {
    const human = item.agent_mode === 'human';
    const unread = item.unread_count > 0 || item.unread;
    return (
      <TouchableOpacity
        onPress={() => navigation.navigate('ChatDetail', { id: item.id, name: item.contact_name || item.phone_number })}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderBottomWidth: 1, borderBottomColor: colors.border }}>
        <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: colors.bgSub, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ color: colors.textPrimary, fontWeight: '700' }}>{(item.contact_name || '?').slice(0, 1).toUpperCase()}</Text>
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text numberOfLines={1} style={{ color: colors.textPrimary, fontWeight: unread ? '800' : '600', flex: 1 }}>
              {item.contact_name || item.phone_number}
            </Text>
            <Text style={{ color: colors.textMuted, fontSize: 11 }}>{timeAgo(item.last_message_at || item.updated_at)}</Text>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 }}>
            <Text numberOfLines={1} style={{ color: colors.textSecondary, fontSize: 13, flex: 1 }}>
              {item.last_message || '—'}
            </Text>
            {human && <Text style={{ color: colors.orange, fontSize: 10, fontWeight: '800' }}>👤 humano</Text>}
            {unread ? <View style={{ minWidth: 18, height: 18, borderRadius: 9, backgroundColor: colors.green, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 5 }}><Text style={{ color: '#04210f', fontSize: 11, fontWeight: '800' }}>{item.unread_count || '•'}</Text></View> : null}
          </View>
        </View>
      </TouchableOpacity>
    );
  };

  if (loading) return <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator color={colors.green} /></View>;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      {error && <Text style={{ color: colors.red, padding: 12 }}>{error}</Text>}
      <FlatList
        data={items}
        keyExtractor={i => String(i.id)}
        renderItem={renderItem}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={colors.green} />}
        ListEmptyComponent={<Text style={{ color: colors.textMuted, textAlign: 'center', marginTop: 40 }}>Sin conversaciones</Text>}
      />
    </View>
  );
}
