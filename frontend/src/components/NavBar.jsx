import { MessageSquare, Package, ShoppingBag, BarChart2, Settings, LogOut, Wifi, WifiOff, UserCheck, Users } from 'lucide-react';

const NAV_ITEMS = [
  { key: 'chats',        icon: MessageSquare, label: 'Chats' },
  { key: 'clientes',     icon: Users,         label: 'Clientes' },
  { key: 'catalogo',     icon: Package,       label: 'Catálogo' },
  { key: 'orders',       icon: ShoppingBag,   label: 'Pedidos' },
  { key: 'reengagement', icon: UserCheck,     label: 'Re-enganche' },
  { key: 'dashboard',    icon: BarChart2,     label: 'Dashboard' },
];

export default function NavBar({ view, onChangeView, orgName, connected, onLogout, unreadCount, pendingOrders }) {
  const initial = (orgName || 'W')[0].toUpperCase();

  return (
    <div style={{
      width: '64px',
      height: '100vh',
      backgroundColor: '#202c33',
      borderRight: '1px solid #2a3942',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      padding: '12px 0',
      gap: '4px',
      flexShrink: 0,
    }}>
      {/* Avatar org */}
      <div style={{
        width: '40px', height: '40px', borderRadius: '50%',
        backgroundColor: '#00a884',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontWeight: 700, color: 'white', fontSize: '16px',
        marginBottom: '8px', flexShrink: 0,
        title: orgName,
      }}>
        {initial}
      </div>

      {/* Indicador conexión */}
      <div style={{ marginBottom: '12px' }} title={connected ? 'Conectado' : 'Sin conexión'}>
        {connected
          ? <Wifi size={13} color="#00a884" />
          : <WifiOff size={13} color="#e9423a" />}
      </div>

      {/* Separador */}
      <div style={{ width: '32px', height: '1px', backgroundColor: '#2a3942', marginBottom: '4px' }} />

      {/* Items de navegación */}
      {NAV_ITEMS.map(({ key, icon: Icon, label }) => {
        const active = view === key;
        const badge = key === 'chats' ? unreadCount : key === 'orders' ? pendingOrders : 0;

        return (
          <NavItem key={key} active={active} label={label} badge={badge}
            onClick={() => onChangeView(key)}>
            <Icon size={20} />
          </NavItem>
        );
      })}

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* Separador */}
      <div style={{ width: '32px', height: '1px', backgroundColor: '#2a3942', marginBottom: '4px' }} />

      {/* Ajustes */}
      <NavItem active={view === 'settings'} label="Ajustes" onClick={() => onChangeView('settings')}>
        <Settings size={20} />
      </NavItem>

      {/* Logout */}
      <NavItem label="Cerrar sesión" onClick={onLogout} danger>
        <LogOut size={18} />
      </NavItem>
    </div>
  );
}

function NavItem({ children, active, label, badge, onClick, danger }) {
  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={onClick}
        title={label}
        style={{
          width: '44px', height: '44px', borderRadius: '12px',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: active ? '#00a884' : danger ? '#e57373' : '#8696a0',
          backgroundColor: active ? '#00a88418' : 'transparent',
          transition: 'all 0.15s',
          cursor: 'pointer',
        }}
        onMouseEnter={e => {
          if (!active) e.currentTarget.style.backgroundColor = '#2a3942';
          e.currentTarget.style.color = active ? '#00a884' : danger ? '#ff6b6b' : '#e9edef';
        }}
        onMouseLeave={e => {
          e.currentTarget.style.backgroundColor = active ? '#00a88418' : 'transparent';
          e.currentTarget.style.color = active ? '#00a884' : danger ? '#e57373' : '#8696a0';
        }}
      >
        {children}
      </button>

      {/* Badge */}
      {badge > 0 && (
        <div style={{
          position: 'absolute', top: '2px', right: '2px',
          backgroundColor: '#00a884', color: 'white',
          borderRadius: '10px', padding: '0 5px',
          fontSize: '10px', fontWeight: 700, minWidth: '16px',
          textAlign: 'center', lineHeight: '16px',
          pointerEvents: 'none',
        }}>
          {badge > 99 ? '99+' : badge}
        </div>
      )}
    </div>
  );
}
