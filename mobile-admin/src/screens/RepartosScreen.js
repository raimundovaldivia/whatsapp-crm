import React, { useState, useCallback } from 'react';
import { View, Text, ScrollView, RefreshControl, ActivityIndicator } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { colors, CLP } from '../theme';
import { getDispatches, getExpenses } from '../services/api';

function isoDay(d) { return new Date(d).toLocaleDateString('sv-SE', { timeZone: 'America/Santiago' }); }

export default function RepartosScreen() {
  const [days, setDays] = useState([]);
  const [totals, setTotals] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const to = isoDay(Date.now());
      const from = isoDay(Date.now() - 6 * 86400000);
      const [rows, expenses] = await Promise.all([getDispatches(from, to), getExpenses(from, to).catch(() => [])]);

      const gastosByDay = {};
      for (const e of expenses) { const d = isoDay(e.created_at); gastosByDay[d] = (gastosByDay[d] || 0) + (Number(e.amount) || 0); }

      const byDay = {}; const order = [];
      for (const r of rows) {
        if (!byDay[r.day]) { byDay[r.day] = { day: r.day, paradas: 0, entregados: 0, fallidos: 0, efectivo: 0, transferencia: 0, cobrosPend: 0, extras: 0, gastos: gastosByDay[r.day] || 0 }; order.push(byDay[r.day]); }
        const d = byDay[r.day]; d.paradas++;
        if (r.status === 'entregado') {
          d.entregados++;
          const amt = (r.total || 0) + (r.extra_total || 0);
          if (r.payment_method === 'efectivo') d.efectivo += amt;
          else if (r.payment_method === 'transferencia') { d.transferencia += amt; if (r.charge?.pending) d.cobrosPend++; }
          d.extras += r.extra_total || 0;
        } else if (r.status === 'cancelled') d.fallidos++;
      }
      const t = order.reduce((a, d) => ({
        entregados: a.entregados + d.entregados, fallidos: a.fallidos + d.fallidos,
        efectivo: a.efectivo + d.efectivo, transferencia: a.transferencia + d.transferencia,
        gastos: a.gastos + d.gastos, cobrosPend: a.cobrosPend + d.cobrosPend,
      }), { entregados: 0, fallidos: 0, efectivo: 0, transferencia: 0, gastos: 0, cobrosPend: 0 });
      t.netoEfectivo = t.efectivo - t.gastos;
      setDays(order); setTotals(t); setError(null);
    } catch (e) { setError(e.response?.data?.error || e.message); }
    finally { setLoading(false); setRefreshing(false); }
  }, []);

  useFocusEffect(useCallback(() => { load(); }, [load]));

  const dayLabel = day => new Date(day + 'T12:00:00').toLocaleDateString('es-CL', { weekday: 'long', day: 'numeric', month: 'long' });
  const Chip = ({ label, color }) => (
    <Text style={{ fontSize: 11, fontWeight: '700', color, backgroundColor: `${color}22`, borderColor: `${color}55`, borderWidth: 1, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2, marginRight: 6, marginTop: 6 }}>{label}</Text>
  );

  if (loading) return <View style={{ flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center' }}><ActivityIndicator color={colors.green} /></View>;

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.bg }} contentContainerStyle={{ padding: 14 }}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); load(); }} tintColor={colors.green} />}>
      <Text style={{ color: colors.textMuted, fontSize: 12, marginBottom: 8 }}>Últimos 7 días</Text>
      {error && <Text style={{ color: colors.red }}>{error}</Text>}

      {totals && (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', marginBottom: 12 }}>
          <Chip label={`${totals.entregados} entregados`} color="#2dd4bf" />
          {totals.fallidos > 0 && <Chip label={`${totals.fallidos} fallidos`} color="#f87171" />}
          <Chip label={`💵 ${CLP(totals.efectivo)} efectivo`} color="#22c55e" />
          <Chip label={`🏦 ${CLP(totals.transferencia)} transf.`} color="#38bdf8" />
          {totals.gastos > 0 && <Chip label={`🧾 ${CLP(totals.gastos)} gastos`} color="#fb923c" />}
          {totals.gastos > 0 && <Chip label={`💰 ${CLP(totals.netoEfectivo)} neto`} color={totals.netoEfectivo >= 0 ? '#22c55e' : '#f87171'} />}
          {totals.cobrosPend > 0 && <Chip label={`⚠️ ${totals.cobrosPend} sin cobrar`} color="#f87171" />}
        </View>
      )}

      {days.length === 0 && <Text style={{ color: colors.textMuted, textAlign: 'center', marginTop: 30 }}>Sin despachos esta semana.</Text>}

      {days.map(d => (
        <View key={d.day} style={{ backgroundColor: colors.bgCard, borderWidth: 1, borderColor: colors.border, borderRadius: 12, padding: 12, marginBottom: 10 }}>
          <Text style={{ color: colors.textPrimary, fontWeight: '700', textTransform: 'capitalize' }}>{dayLabel(d.day)}</Text>
          <Text style={{ color: colors.textMuted, fontSize: 12, marginTop: 2 }}>{d.paradas} paradas</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
            <Chip label={`${d.entregados} ✓`} color="#2dd4bf" />
            {d.fallidos > 0 && <Chip label={`${d.fallidos} ✗`} color="#f87171" />}
            <Chip label={`💵 ${CLP(d.efectivo)}`} color="#22c55e" />
            <Chip label={`🏦 ${CLP(d.transferencia)}`} color="#38bdf8" />
            {d.extras > 0 && <Chip label={`🥚 +${CLP(d.extras)}`} color="#c4b5fd" />}
            {d.gastos > 0 && <Chip label={`🧾 ${CLP(d.gastos)}`} color="#fb923c" />}
          </View>
        </View>
      ))}
    </ScrollView>
  );
}
