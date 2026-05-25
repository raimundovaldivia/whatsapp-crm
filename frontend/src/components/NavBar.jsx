import { MessageSquare, Package, ShoppingBag, BarChart2, Settings, LogOut, Wifi, WifiOff, UserCheck, Users, FileText, Sun, Moon } from 'lucide-react';
import { useTheme } from '../theme.js';

const NAV_ITEMS = [
  { key: 'chats',        icon: MessageSquare, label: 'Chats' },
  { key: 'reengagement', icon: UserCheck,     label: 'Re-enganche' },
  { key: 'templates',    icon: FileText,      label: 'Templates' },
  { key: 'clientes',     icon: Users,         label: 'Clientes' },
  { key: 'catalogo',     icon: Package,       label: 'Catálogo' },
  { key: 'orders',       icon: ShoppingBag,   label: 'Pedidos' },
  { key: 'dashboard',    icon: BarChart2,     label: 'Dashboard' },
];

export default function NavBar({ view, onChangeView, orgName, connected, onLogout, unreadCount, pendingOrders }) {
  const { colors, isDark, toggle } = useTheme();
  const initial = (orgName || 'W')[0].toUpperCase();

  return (
    <div style={{
      width: '64px',
      height: '100vh',
      backgroundColor: colors.navBg,
      borderRight: `1px solid ${colors.border}`,
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
        backgroundColor: colors.green,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontWeight: 700, color: 'white', fontSize: '16px',
        marginBottom: '8px', flexShrink: 0,
      }} title={orgName}>
        {initial}
      </div>

      {/* Indicador conexión */}
      <div style={{ marginBottom: '12px' }} title={connected ? 'Conectado' : 'Sin conexión'}>
        {connected
          ? <Wifi size={13} color={colors.green} />
          : <WifiOff size={13} color={colors.red} />}
      </div>

      {/* Separador */}
      <div style={{ width: '32px', height: '1px', backgroundColor: colors.border, marginBottom: '4px' }} />

      {/* Items de navegación */}
      {NAV_ITEMS.map(({ key, icon: Icon, label }) => {
        const active = view === key;
        const badge = key === 'chats' ? unreadCount : key === 'orders' ? pendingOrders : 0;

        return (
          <NavItem key={key} active={active} label={label} badge={badge}
            onClick={() => onChangeView(key)} colors={colors}>
            <Icon size={20} />
          </NavItem>
        );
      })}

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {/* Separador */}
      <div style={{ width: '32px', height: '1px', backgroundColor: colors.border, marginBottom: '4px' }} />

      {/* Theme toggle */}
      <NavItem label={isDark ? 'Modo claro' : 'Modo oscuro'} onClick={toggle} colors={colors}>
        {isDark ? <Sun size={18} /> : <Moon size={18} />}
      </NavItem>

      {/* Ajustes */}
      <NavItem active={view === 'settings'} label="Ajustes" onClick={() => onChangeView('settings')} colors={colors}>
        <Settings size={20} />
      </NavItem>

      {/* Logout */}
      <NavItem label="Cerrar sesión" onClick={onLogout} danger colors={colors}>
        <LogOut size={18} />
      </NavItem>
    </div>
  );
}

function NavItem({ children, active, label, badge, onClick, danger, colors }) {
  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={onClick}
        title={label}
        style={{
          width: '44px', height: '44px', borderRadius: '12px',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: active ? colors.green : danger ? colors.red : colors.textSecondary,
          backgroundColor: active ? `${colors.green}18` : 'transparent',
          transition: 'all 0.15s',
          cursor: 'pointer',
          border: 'none',
        }}
        onMouseEnter={e => {
          if (!active) e.currentTarget.style.backgroundColor = colors.bgHover;
          e.currentTarget.style.color = active ? colors.green : danger ? colors.red : colors.textPrimary;
        }}
        onMouseLeave={e => {
          e.currentTarget.style.backgroundColor = active ? `${colors.green}18` : 'transparent';
          e.currentTarget.style.color = active ? colors.green : danger ? colors.red : colors.textSecondary;
        }}
      >
        {children}
      </button>

      {/* Badge */}
      {badge > 0 && (
        <div style={{
          position: 'absolute', top: '2px', right: '2px',
          backgroundColor: colors.green, color: 'white',
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
