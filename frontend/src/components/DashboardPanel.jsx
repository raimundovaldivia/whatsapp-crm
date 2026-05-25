import { useState, useEffect } from 'react';
import { BarChart2, MessageSquare, ShoppingBag, DollarSign, Users, TrendingUp, Bot, RefreshCw } from 'lucide-react';
import { api } from '../utils/api.js';
import { useTheme } from '../theme.js';

export default function DashboardPanel() {
  const { colors } = useTheme();
  const [stats, setStats]   = useState(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const [ordersRes, convsRes] = await Promise.all([
        api.get('/orders/stats'),
        api.get('/conversations'),
      ]);
      const orders = ordersRes.data;
      const conversations = convsRes.data.data || [];

      const aiConvs = conversations.filter(c => c.agent_mode === 'ai').length;
      const humanConvs = conversations.filter(c => c.agent_mode === 'human').length;

      setStats({
        totalOrders:    orders.total    || 0,
        pendingOrders:  orders.pending  || 0,
        paidOrders:     orders.paid     || 0,
        revenue:        orders.revenue  || 0,
        totalConvs:     conversations.length,
        activeConvs:    conversations.filter(c => c.unread_count > 0).length,
        aiConvs,
        humanConvs,
      });
    } catch (err) {
      console.error('Dashboard error:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const card = {
    backgroundColor: colors.bgPanel,
    borderRadius: '12px',
    padding: '20px',
    border: `1px solid ${colors.border}`,
  };

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100vh', backgroundColor: colors.bgApp, overflow: 'hidden' }}>

      {/* Header */}
      <div style={{
        padding: '14px 24px', backgroundColor: colors.bgPanel,
        borderBottom: `1px solid ${colors.border}`,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <BarChart2 size={20} color={colors.green} />
          <h1 style={{ color: colors.textPrimary, fontSize: '17px', fontWeight: 600 }}>Dashboard</h1>
        </div>
        <button onClick={load}
          style={{ background: 'none', color: colors.textSecondary, padding: '6px', borderRadius: '50%', display: 'flex' }}
          onMouseEnter={e => e.currentTarget.style.background = colors.borderStrong}
          onMouseLeave={e => e.currentTarget.style.background = 'none'}>
          <RefreshCw size={16} />
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '24px' }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: '80px', color: colors.textSecondary }}>
            <BarChart2 size={40} style={{ marginBottom: '12px', opacity: 0.3 }} />
            <div>Cargando métricas...</div>
          </div>
        ) : stats ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', maxWidth: '900px' }}>

            {/* Sección ventas */}
            <div>
              <div style={{ color: colors.textSecondary, fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: '12px', fontWeight: 600 }}>
                Ventas
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '12px' }}>
                <StatCard icon={<ShoppingBag size={20} color={colors.textSecondary} />}  label="Total pedidos"  value={stats.totalOrders}   color={colors.textPrimary} card={card} labelColor={colors.textSecondary} />
                <StatCard icon={<TrendingUp size={20} color={colors.yellow} />}           label="Pendientes"     value={stats.pendingOrders} color={colors.yellow} card={card} labelColor={colors.textSecondary} />
                <StatCard icon={<ShoppingBag size={20} color={colors.green} />}           label="Pagados"        value={stats.paidOrders}    color={colors.green} card={card} labelColor={colors.textSecondary} />
                <StatCard
                  icon={<DollarSign size={20} color={colors.green} />}
                  label="Ingresos"
                  value={`$${Number(stats.revenue).toLocaleString('es-CL', { minimumFractionDigits: 0 })}`}
                  color={colors.green}
                  card={card}
                  labelColor={colors.textSecondary}
                />
              </div>
            </div>

            {/* Sección conversaciones */}
            <div>
              <div style={{ color: colors.textSecondary, fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: '12px', fontWeight: 600 }}>
                Conversaciones
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '12px' }}>
                <StatCard icon={<Users size={20} color={colors.textSecondary} />}         label="Total clientes"  value={stats.totalConvs}  color={colors.textPrimary} card={card} labelColor={colors.textSecondary} />
                <StatCard icon={<MessageSquare size={20} color={colors.yellow} />}        label="Sin leer"        value={stats.activeConvs} color={colors.yellow} card={card} labelColor={colors.textSecondary} />
                <StatCard icon={<Bot size={20} color={colors.green} />}                   label="Con IA activa"   value={stats.aiConvs}     color={colors.green} card={card} labelColor={colors.textSecondary} />
                <StatCard icon={<Users size={20} color={colors.purple} />}                label="Modo humano"     value={stats.humanConvs}  color={colors.purple} card={card} labelColor={colors.textSecondary} />
              </div>
            </div>

            {/* Tasa de conversión */}
            {stats.totalConvs > 0 && (
              <div>
                <div style={{ color: colors.textSecondary, fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: '12px', fontWeight: 600 }}>
                  Rendimiento
                </div>
                <div style={{ ...card }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                    <div>
                      <div style={{ color: colors.textPrimary, fontSize: '14px', fontWeight: 600 }}>Tasa de conversión</div>
                      <div style={{ color: colors.textSecondary, fontSize: '12px', marginTop: '2px' }}>Conversaciones → Pedidos</div>
                    </div>
                    <div style={{ fontSize: '28px', fontWeight: 700, color: colors.green }}>
                      {stats.totalConvs > 0 ? Math.round((stats.totalOrders / stats.totalConvs) * 100) : 0}%
                    </div>
                  </div>
                  <div style={{ backgroundColor: colors.bgApp, borderRadius: '6px', height: '8px', overflow: 'hidden' }}>
                    <div style={{
                      width: `${Math.min(100, stats.totalConvs > 0 ? (stats.totalOrders / stats.totalConvs) * 100 : 0)}%`,
                      height: '100%', backgroundColor: colors.green,
                      borderRadius: '6px', transition: 'width 0.6s ease',
                    }} />
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '8px', fontSize: '12px', color: colors.textSecondary }}>
                    <span>{stats.totalConvs} clientes</span>
                    <span>{stats.totalOrders} pedidos</span>
                  </div>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div style={{ textAlign: 'center', padding: '80px', color: colors.textSecondary }}>Error cargando datos</div>
        )}
      </div>
    </div>
  );
}

function StatCard({ icon, label, value, color, card, labelColor }) {
  return (
    <div style={{ ...card }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
        {icon}
        <span style={{ fontSize: '12px', color: labelColor }}>{label}</span>
      </div>
      <div style={{ fontSize: '26px', fontWeight: 700, color }}>{value}</div>
    </div>
  );
}
