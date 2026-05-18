import { useState, useEffect } from 'react';
import { BarChart2, MessageSquare, ShoppingBag, DollarSign, Users, TrendingUp, Bot, RefreshCw } from 'lucide-react';
import { api } from '../utils/api.js';

export default function DashboardPanel() {
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
    backgroundColor: '#202c33',
    borderRadius: '12px',
    padding: '20px',
    border: '1px solid #2a3942',
  };

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100vh', backgroundColor: '#0b141a', overflow: 'hidden' }}>

      {/* Header */}
      <div style={{
        padding: '14px 24px', backgroundColor: '#202c33',
        borderBottom: '1px solid #2a3942',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <BarChart2 size={20} color="#00a884" />
          <h1 style={{ color: '#e9edef', fontSize: '17px', fontWeight: 600 }}>Dashboard</h1>
        </div>
        <button onClick={load}
          style={{ background: 'none', color: '#8696a0', padding: '6px', borderRadius: '50%', display: 'flex' }}
          onMouseEnter={e => e.currentTarget.style.background = '#374045'}
          onMouseLeave={e => e.currentTarget.style.background = 'none'}>
          <RefreshCw size={16} />
        </button>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '24px' }}>
        {loading ? (
          <div style={{ textAlign: 'center', padding: '80px', color: '#8696a0' }}>
            <BarChart2 size={40} style={{ marginBottom: '12px', opacity: 0.3 }} />
            <div>Cargando métricas...</div>
          </div>
        ) : stats ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', maxWidth: '900px' }}>

            {/* Sección ventas */}
            <div>
              <div style={{ color: '#8696a0', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: '12px', fontWeight: 600 }}>
                Ventas
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '12px' }}>
                <StatCard icon={<ShoppingBag size={20} color="#8696a0" />}  label="Total pedidos"  value={stats.totalOrders}   color="#e9edef" card={card} />
                <StatCard icon={<TrendingUp size={20} color="#f0b429" />}   label="Pendientes"     value={stats.pendingOrders} color="#f0b429" card={card} />
                <StatCard icon={<ShoppingBag size={20} color="#00a884" />}  label="Pagados"        value={stats.paidOrders}    color="#00a884" card={card} />
                <StatCard
                  icon={<DollarSign size={20} color="#00a884" />}
                  label="Ingresos"
                  value={`$${Number(stats.revenue).toLocaleString('es-CL', { minimumFractionDigits: 0 })}`}
                  color="#00a884"
                  card={card}
                />
              </div>
            </div>

            {/* Sección conversaciones */}
            <div>
              <div style={{ color: '#8696a0', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: '12px', fontWeight: 600 }}>
                Conversaciones
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '12px' }}>
                <StatCard icon={<Users size={20} color="#8696a0" />}       label="Total clientes"  value={stats.totalConvs}  color="#e9edef" card={card} />
                <StatCard icon={<MessageSquare size={20} color="#f0b429" />} label="Sin leer"      value={stats.activeConvs} color="#f0b429" card={card} />
                <StatCard icon={<Bot size={20} color="#00a884" />}          label="Con IA activa"  value={stats.aiConvs}     color="#00a884" card={card} />
                <StatCard icon={<Users size={20} color="#4db6ac" />}        label="Modo humano"    value={stats.humanConvs}  color="#4db6ac" card={card} />
              </div>
            </div>

            {/* Tasa de conversión */}
            {stats.totalConvs > 0 && (
              <div>
                <div style={{ color: '#8696a0', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '0.8px', marginBottom: '12px', fontWeight: 600 }}>
                  Rendimiento
                </div>
                <div style={{ ...card }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                    <div>
                      <div style={{ color: '#e9edef', fontSize: '14px', fontWeight: 600 }}>Tasa de conversión</div>
                      <div style={{ color: '#8696a0', fontSize: '12px', marginTop: '2px' }}>Conversaciones → Pedidos</div>
                    </div>
                    <div style={{ fontSize: '28px', fontWeight: 700, color: '#00a884' }}>
                      {stats.totalConvs > 0 ? Math.round((stats.totalOrders / stats.totalConvs) * 100) : 0}%
                    </div>
                  </div>
                  <div style={{ backgroundColor: '#111b21', borderRadius: '6px', height: '8px', overflow: 'hidden' }}>
                    <div style={{
                      width: `${Math.min(100, stats.totalConvs > 0 ? (stats.totalOrders / stats.totalConvs) * 100 : 0)}%`,
                      height: '100%', backgroundColor: '#00a884',
                      borderRadius: '6px', transition: 'width 0.6s ease',
                    }} />
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '8px', fontSize: '12px', color: '#8696a0' }}>
                    <span>{stats.totalConvs} clientes</span>
                    <span>{stats.totalOrders} pedidos</span>
                  </div>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div style={{ textAlign: 'center', padding: '80px', color: '#8696a0' }}>Error cargando datos</div>
        )}
      </div>
    </div>
  );
}

function StatCard({ icon, label, value, color, card }) {
  return (
    <div style={{ ...card }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
        {icon}
        <span style={{ fontSize: '12px', color: '#8696a0' }}>{label}</span>
      </div>
      <div style={{ fontSize: '26px', fontWeight: 700, color }}>{value}</div>
    </div>
  );
}
