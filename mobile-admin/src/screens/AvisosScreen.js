import React, { useState, useCallback } from 'react';
import { View, Text, FlatList, TouchableOpacity, RefreshControl, ActivityIndicator, Alert } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { colors } from '../theme';
import { getAlerts, dismissAlert, getSession } from '../services/api';

function timeAgo(ts) {
  if (!ts) return '';
  const s = (Date.now() - new Date(ts).getTime()) / 1000;
  if (s < 60) return 'ahora';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export default function AvisosScreen({ onLogout }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [user, setUser] = useState(null);

  const load = useCallback(async () => {
    try {
      const [data, sess] = await Promise.all([getAlerts(), getSession()]);
      setItems(Array.isArray(data) ? data : []);
      setUser(sess.user);
    } catch { /* noop */ }
    finally { setLoading(false); setRefreshing(false); }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  async function remove(item) {
    setItems(prev => prev.filter(a => a.id !== item.id));
    dismissAlert(item.id);
  }

  const KIND = {
    order:    { icon: '📦', color: '#38bdf8' },
    payment:  { icon: '💸', color: '#22c55e' },
    help:     { icon: '🆘', color: '#f87171' },
    handoff:  { icon: '👤', color: '#fb923c' },
  };

  const renderItem = ({ item }) => {
    const k = KIND[item.kind] || { icon: '🔔', color: colors.textMuted };
    return (
      <TouchableOpacity onLongPress={() => remove(item)}
        style={{ flexDirection: 'row', gap: 10, padding: 14, borderBottomWidth: 1, borderBottomColor: colors.border }}>
        <Text style={{ fontSize: 20 }}>{k.icon}</Text>
        <View style={{ flex: 1 }}>
          <Text style={{ color: colors.textPrimary, fontSize: 14 }}>{item.body || item.message || item.title}</Text>
          <Text style={{ color: colors.textMuted, fontSize: 11, marginTop: 3 }}>{timeAgo(item.created_at)} · mantén presionado para descartar</Text>
        </View>
      </TouchableOpacity>
    );
  };

  if (loading) return <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator color={colors.green} /></View>;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <FlatList
        data={items}
        keyExtractor={(i, idx) => String(i.id || idx)}
        renderItem={renderItem}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={colors.green} />}
        ListEmptyComponent={<Text style={{ color: colors.textMuted, textAlign: 'center', marginTop: 40 }}>Sin avisos pendientes 🎉</Text>}
        ListFooterComponent={
          <View style={{ padding: 16, marginTop: 8 }}>
            <Text style={{ color: colors.textMuted, fontSize: 12, textAlign: 'center', marginBottom: 12 }}>
              {user ? `${user.name || user.email} · ${user.role}` : ''}
            </Text>
            <TouchableOpacity onPress={() => Alert.alert('Cerrar sesión', '¿Salir de la app?', [{ text: 'Cancelar', style: 'cancel' }, { text: 'Salir', style: 'destructive', onPress: onLogout }])}
              style={{ borderWidth: 1, borderColor: colors.red, borderRadius: 10, padding: 12, alignItems: 'center' }}>
              <Text style={{ color: colors.red, fontWeight: '700' }}>Cerrar sesión</Text>
            </TouchableOpacity>
          </View>
        }
      />
    </View>
  );
}
