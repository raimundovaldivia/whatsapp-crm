import React, { useCallback, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ActivityIndicator,
  ScrollView, RefreshControl, TextInput, Alert,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { getExpenses } from '../services/api';
import { flushExpenses } from '../utils/expenseQueue';

const C = {
  bg: '#0f172a', card: '#1e293b', border: '#334155', green: '#22c55e',
  orange: '#fb923c', blue: '#38bdf8', red: '#f87171', text: '#f1f5f9', muted: '#94a3b8',
};
const CLP = n => `$${Math.round(Number(n) || 0).toLocaleString('es-CL')}`;
const MODES = [
  { key: 'day', label: 'Día' },
  { key: 'week', label: 'Semana' },
  { key: 'month', label: 'Mes' },
  { key: 'custom', label: 'Fechas' },
];

function iso(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function atNoon(value) { return new Date(`${value}T12:00:00`); }
function addDays(date, days) { const out = new Date(date); out.setDate(out.getDate() + days); return out; }
function rangeFor(mode, anchor) {
  const d = new Date(anchor);
  if (mode === 'day') return { from: iso(d), to: iso(d) };
  if (mode === 'week') {
    const monday = addDays(d, -((d.getDay() + 6) % 7));
    return { from: iso(monday), to: iso(addDays(monday, 6)) };
  }
  const first = new Date(d.getFullYear(), d.getMonth(), 1);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return { from: iso(first), to: iso(last) };
}
function moveAnchor(mode, anchor, direction) {
  if (mode === 'day') return addDays(anchor, direction);
  if (mode === 'week') return addDays(anchor, direction * 7);
  const d = new Date(anchor); d.setDate(1); d.setMonth(d.getMonth() + direction); return d;
}
function shortDay(value) {
  return atNoon(value).toLocaleDateString('es-CL', { weekday: 'short', day: 'numeric', month: 'short' });
}
function periodLabel(mode, range) {
  if (mode === 'day') return atNoon(range.from).toLocaleDateString('es-CL', { weekday: 'long', day: 'numeric', month: 'long' });
  if (mode === 'month') return atNoon(range.from).toLocaleDateString('es-CL', { month: 'long', year: 'numeric' });
  return `${shortDay(range.from)} – ${shortDay(range.to)}`;
}

export default function ExpensesScreen() {
  const insets = useSafeAreaInsets();
  const [mode, setMode] = useState('week');
  const [anchor, setAnchor] = useState(new Date());
  const initial = rangeFor('week', new Date());
  const [customFrom, setCustomFrom] = useState(initial.from);
  const [customTo, setCustomTo] = useState(initial.to);
  const [appliedCustom, setAppliedCustom] = useState(initial);
  const [data, setData] = useState({ expenses: [], total: 0, count: 0, byDay: [] });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);

  const range = useMemo(() => mode === 'custom' ? appliedCustom : rangeFor(mode, anchor), [mode, anchor, appliedCustom]);

  const load = useCallback(async (refresh = false) => {
    if (refresh) setRefreshing(true); else setLoading(true);
    setError(null);
    try {
      const result = await getExpenses(range.from, range.to);
      setData({ expenses: result.expenses || [], total: result.total || 0, count: result.count || 0, byDay: result.byDay || [] });
    } catch (e) {
      if (e.response?.status !== 401) setError(e.response?.data?.error || e.message || 'No se pudieron cargar los gastos');
    } finally {
      setLoading(false); setRefreshing(false);
    }
  }, [range.from, range.to]);

  useFocusEffect(useCallback(() => {
    let active = true;
    flushExpenses().catch(() => {}).finally(() => { if (active) load(); });
    return () => { active = false; };
  }, [load]));

  const categories = useMemo(() => {
    const totals = {};
    for (const expense of data.expenses) {
      const category = expense.category || 'Otro';
      totals[category] = (totals[category] || 0) + Number(expense.amount || 0);
    }
    return Object.entries(totals).sort((a, b) => b[1] - a[1]);
  }, [data.expenses]);

  function chooseMode(next) {
    setMode(next);
    if (next !== 'custom') setAnchor(new Date());
  }
  function applyCustom() {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(customFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(customTo)) {
      Alert.alert('Revisa las fechas', 'Escríbelas como AAAA-MM-DD.'); return;
    }
    if (customFrom > customTo) { Alert.alert('Revisa las fechas', 'La fecha inicial no puede ser posterior a la final.'); return; }
    setAppliedCustom({ from: customFrom, to: customTo });
  }

  return (
    <View style={s.container}>
      <ScrollView
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => load(true)} tintColor={C.green} />}
        contentContainerStyle={[s.content, { paddingBottom: insets.bottom + 28 }]}>
        <View style={s.modeRow}>
          {MODES.map(item => (
            <TouchableOpacity key={item.key} onPress={() => chooseMode(item.key)} style={[s.modeChip, mode === item.key && s.modeChipOn]}>
              <Text style={[s.modeText, mode === item.key && s.modeTextOn]}>{item.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {mode === 'custom' ? (
          <View style={s.customBox}>
            <View style={s.dateRow}>
              <View style={s.dateField}><Text style={s.fieldLabel}>Desde</Text><TextInput value={customFrom} onChangeText={setCustomFrom} style={s.input} placeholder="AAAA-MM-DD" placeholderTextColor={C.muted} /></View>
              <View style={s.dateField}><Text style={s.fieldLabel}>Hasta</Text><TextInput value={customTo} onChangeText={setCustomTo} style={s.input} placeholder="AAAA-MM-DD" placeholderTextColor={C.muted} /></View>
            </View>
            <TouchableOpacity style={s.applyBtn} onPress={applyCustom}><Text style={s.applyText}>Aplicar fechas</Text></TouchableOpacity>
          </View>
        ) : (
          <View style={s.periodRow}>
            <TouchableOpacity style={s.arrowBtn} onPress={() => setAnchor(a => moveAnchor(mode, a, -1))}><Text style={s.arrowText}>‹</Text></TouchableOpacity>
            <Text style={s.periodText}>{periodLabel(mode, range)}</Text>
            <TouchableOpacity style={s.arrowBtn} onPress={() => setAnchor(a => moveAnchor(mode, a, 1))}><Text style={s.arrowText}>›</Text></TouchableOpacity>
          </View>
        )}

        <View style={s.totalCard}>
          <Text style={s.totalLabel}>Total del período</Text>
          <Text style={s.totalValue}>{CLP(data.total)}</Text>
          <Text style={s.totalCount}>{data.count} gasto{data.count === 1 ? '' : 's'} registrado{data.count === 1 ? '' : 's'}</Text>
        </View>

        {loading ? (
          <View style={s.center}><ActivityIndicator size="large" color={C.green} /><Text style={s.muted}>Cargando gastos…</Text></View>
        ) : error ? (
          <View style={s.center}><Text style={s.error}>{error}</Text><TouchableOpacity style={s.retryBtn} onPress={() => load()}><Text style={s.retryText}>Reintentar</Text></TouchableOpacity></View>
        ) : data.count === 0 ? (
          <View style={s.empty}><Text style={s.emptyIcon}>🧾</Text><Text style={s.emptyTitle}>Sin gastos en este período</Text><Text style={s.muted}>Los gastos que registres durante una ruta aparecerán aquí.</Text></View>
        ) : (
          <>
            <Text style={s.sectionTitle}>Totales por día</Text>
            {[...data.byDay].reverse().map(day => (
              <View key={day.day} style={s.dayRow}>
                <View><Text style={s.dayName}>{shortDay(day.day)}</Text><Text style={s.dayCount}>{day.count} gasto{day.count === 1 ? '' : 's'}</Text></View>
                <Text style={s.dayTotal}>{CLP(day.total)}</Text>
              </View>
            ))}

            {categories.length > 0 && <Text style={s.sectionTitle}>Por categoría</Text>}
            <View style={s.categoryWrap}>
              {categories.map(([category, total]) => (
                <View key={category} style={s.categoryChip}><Text style={s.categoryName}>{category}</Text><Text style={s.categoryTotal}>{CLP(total)}</Text></View>
              ))}
            </View>

            <Text style={s.sectionTitle}>Detalle</Text>
            {data.expenses.map(expense => (
              <View key={expense.id} style={s.expenseCard}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={s.expenseTitle}>{expense.category || 'Otro'}</Text>
                  <Text style={s.expenseDate}>{new Date(expense.created_at).toLocaleString('es-CL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: 'America/Santiago' })}{expense.has_photo ? '  📷' : ''}</Text>
                  {!!expense.note && <Text style={s.expenseNote}>{expense.note}</Text>}
                </View>
                <Text style={s.expenseAmount}>{CLP(expense.amount)}</Text>
              </View>
            ))}
          </>
        )}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  content: { padding: 16, gap: 12 },
  modeRow: { flexDirection: 'row', gap: 7 },
  modeChip: { flex: 1, alignItems: 'center', paddingVertical: 9, borderRadius: 10, borderWidth: 1, borderColor: C.border, backgroundColor: C.card },
  modeChipOn: { backgroundColor: C.green, borderColor: C.green },
  modeText: { color: C.muted, fontSize: 12, fontWeight: '700' },
  modeTextOn: { color: '#052e16' },
  periodRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: C.card, borderRadius: 12, borderWidth: 1, borderColor: C.border, padding: 8 },
  arrowBtn: { width: 42, height: 38, alignItems: 'center', justifyContent: 'center', borderRadius: 9, backgroundColor: C.border },
  arrowText: { color: C.text, fontSize: 30, lineHeight: 32 },
  periodText: { flex: 1, textAlign: 'center', color: C.text, fontSize: 14, fontWeight: '700', textTransform: 'capitalize' },
  customBox: { backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 12, padding: 12, gap: 10 },
  dateRow: { flexDirection: 'row', gap: 10 },
  dateField: { flex: 1 },
  fieldLabel: { color: C.muted, fontSize: 11, marginBottom: 5 },
  input: { color: C.text, backgroundColor: C.bg, borderWidth: 1, borderColor: C.border, borderRadius: 9, paddingHorizontal: 10, paddingVertical: 10, fontSize: 13 },
  applyBtn: { backgroundColor: C.blue, borderRadius: 9, padding: 11, alignItems: 'center' },
  applyText: { color: '#082f49', fontWeight: '800' },
  totalCard: { backgroundColor: C.card, borderWidth: 1, borderColor: C.green + '66', borderRadius: 16, padding: 20, alignItems: 'center' },
  totalLabel: { color: C.muted, fontSize: 13 },
  totalValue: { color: C.green, fontSize: 34, fontWeight: '900', marginVertical: 3 },
  totalCount: { color: C.text, fontSize: 12 },
  center: { alignItems: 'center', paddingVertical: 45, gap: 10 },
  muted: { color: C.muted, fontSize: 13, textAlign: 'center' },
  error: { color: C.red, fontSize: 14, textAlign: 'center' },
  retryBtn: { backgroundColor: C.card, borderWidth: 1, borderColor: C.border, paddingHorizontal: 18, paddingVertical: 9, borderRadius: 9 },
  retryText: { color: C.text, fontWeight: '700' },
  empty: { alignItems: 'center', paddingVertical: 42, gap: 8 },
  emptyIcon: { fontSize: 45 },
  emptyTitle: { color: C.text, fontSize: 17, fontWeight: '800' },
  sectionTitle: { color: C.text, fontSize: 16, fontWeight: '800', marginTop: 6 },
  dayRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 12, padding: 14 },
  dayName: { color: C.text, fontSize: 14, fontWeight: '700', textTransform: 'capitalize' },
  dayCount: { color: C.muted, fontSize: 11, marginTop: 2 },
  dayTotal: { color: C.green, fontSize: 17, fontWeight: '800' },
  categoryWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  categoryChip: { minWidth: '47%', flexGrow: 1, backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 11, padding: 12 },
  categoryName: { color: C.muted, fontSize: 11 },
  categoryTotal: { color: C.text, fontSize: 15, fontWeight: '800', marginTop: 3 },
  expenseCard: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, backgroundColor: C.card, borderWidth: 1, borderColor: C.border, borderRadius: 12, padding: 13 },
  expenseTitle: { color: C.text, fontSize: 14, fontWeight: '700' },
  expenseDate: { color: C.muted, fontSize: 11, marginTop: 3 },
  expenseNote: { color: C.muted, fontSize: 12, lineHeight: 17, marginTop: 5 },
  expenseAmount: { color: C.orange, fontSize: 16, fontWeight: '800' },
});
