import { MessageSquare, Package, ShoppingBag, BarChart2, Settings, LogOut, Wifi, WifiOff, UserCheck, Users, Sun, Moon } from 'lucide-react';
import { useTheme } from '../theme.js';

const NAV_ITEMS = [
  { key: 'dashboard',    icon: BarChart2,     label: 'Victorias' },
  { key: 'chats',        icon: MessageSquare, label: 'Chats' },
  { key: 'reengagement', icon: UserCheck,     label: 'Re-enganche' },
  { key: 'orders',       icon: ShoppingBag,   label: 'Pedidos' },
  { key: 'clientes',     icon: Users,         label: 'Clientes' },
  { key: 'catalogo',     icon: Package,       label: 'Catálogo' },
];

// Items visibles en la barra móvil (los más usados)
const MOBILE_ITEMS = ['chats', 'reengagement', 'orders', 'clientes', 'settings'];

export default function NavBar({ view, onChangeView, orgName, connected, onLogout, unreadCount, pendingOrders, isMobile }) {
  const { colors, isDark, toggle } = useTheme();
  const initial = (orgName || 'W')[0].toUpperCase();

  /* ── Barra inferior móvil ── */
  if (isMobile) {
    const mobileItems = [
      ...NAV_ITEMS.filter(i => MOBILE_ITEMS.slice(0, 4).includes(i.key)),
      { key: 'settings', icon: Settings, label: 'Ajustes' },
    ];

    return (
      <div style={{
        position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 100,
        height: '60px',
        backgroundColor: colors.navBg,
        borderTop: `1px solid ${colors.border}`,
        display: 'flex', alignItems: 'stretch',
        boxShadow: '0 -2px 12px rgba(0,0,0,0.12)',
      }}>
        {mobileItems.map(({ key, icon: Icon, label }) => {
          const active = view === key;
          const badge = key === 'chats' ? unreadCount : key === 'orders' ? pendingOrders : 0;
          return (
            <button key={key} onClick={() => onChangeView(key)}
              style={{
                flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center',
                justifyContent: 'center', gap: '3px',
                background: 'none', border: 'none', cursor: 'pointer',
                color: active ? colors.green : colors.textSecondary,
                position: 'relative',
                transition: 'color 0.15s',
              }}>
              <div style={{ position: 'relative' }}>
                <Icon size={20} />
                {badge > 0 && (
                  <span style={{
                    position: 'absolute', top: '-5px', right: '-7px',
                    backgroundColor: colors.green, color: 'white',
                    borderRadius: '10px', padding: '0 4px',
                    fontSize: '9px', fontWeight: 700, minWidth: '14px',
                    textAlign: 'center', lineHeight: '14px',
                  }}>
                    {badge > 99 ? '99+' : badge}
                  </span>
                )}
              </div>
              <span style={{ fontSize: '10px', fontWeight: active ? 600 : 400 }}>{label}</span>
              {active && (
                <div style={{
                  position: 'absolute', top: 0, left: '50%', transform: 'translateX(-50%)',
                  width: '28px', height: '2px', borderRadius: '0 0 4px 4px',
                  backgroundColor: colors.green,
                }} />
              )}
            </button>
          );
        })}
      </div>
    );
  }

  /* ── Barra lateral desktop ── */
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

      <div style={{ width: '32px', height: '1px', backgroundColor: colors.border, marginBottom: '4px' }} />

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

      <div style={{ flex: 1 }} />
      <div style={{ width: '32px', height: '1px', backgroundColor: colors.border, marginBottom: '4px' }} />

      <NavItem label={isDark ? 'Modo claro' : 'Modo oscuro'} onClick={toggle} colors={colors}>
        {isDark ? <Sun size={18} /> : <Moon size={18} />}
      </NavItem>
      <NavItem active={view === 'settings'} label="Ajustes" onClick={() => onChangeView('settings')} colors={colors}>
        <Settings size={20} />
      </NavItem>
      <NavItem label="Cerrar sesión" onClick={onLogout} danger colors={colors}>
        <LogOut size={18} />
      </NavItem>
    </div>
  );
}

function NavItem({ children, active, label, badge, onClick, danger, colors }) {
  return (
    <div style={{ position: 'relative' }}>
      <button onClick={onClick} title={label}
        style={{
          width: '44px', height: '44px', borderRadius: '12px',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: active ? colors.green : danger ? colors.red : colors.textSecondary,
          backgroundColor: active ? `${colors.green}18` : 'transparent',
          transition: 'all 0.15s', cursor: 'pointer', border: 'none',
        }}
        onMouseEnter={e => {
          if (!active) e.currentTarget.style.backgroundColor = colors.bgHover;
          e.currentTarget.style.color = active ? colors.green : danger ? colors.red : colors.textPrimary;
        }}
        onMouseLeave={e => {
          e.currentTarget.style.backgroundColor = active ? `${colors.green}18` : 'transparent';
          e.currentTarget.style.color = active ? colors.green : danger ? colors.red : colors.textSecondary;
        }}>
        {children}
      </button>
      {badge > 0 && (
        <div style={{
          position: 'absolute', top: '2px', right: '2px',
          backgroundColor: colors.green, color: 'white',
          borderRadius: '10px', padding: '0 5px',
          fontSize: '10px', fontWeight: 700, minWidth: '16px',
          textAlign: 'center', lineHeight: '16px', pointerEvents: 'none',
        }}>
          {badge > 99 ? '99+' : badge}
        </div>
      )}
    </div>
  );
}
