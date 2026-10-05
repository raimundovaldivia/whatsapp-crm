import { useEffect, useRef, useState } from 'react';
import {
  BarChart2, Check, ChevronRight, Facebook, Layers, LogOut, Megaphone, Menu,
  MessageSquare, Moon, Receipt, Settings, ShoppingBag, Store, Sun,
  Truck, UserCog, Users, Wifi, WifiOff, X,
} from 'lucide-react';
import { useTheme } from '../theme.js';

const ROLE_VIEWS = {
  owner:       ['chats', 'stats', 'orders', 'repartos', 'pagos', 'clientes', 'mensajeria', 'social', 'productos', 'evaluacion', 'settings', 'users', 'solutions'],
  admin:       ['chats', 'stats', 'orders', 'repartos', 'pagos', 'clientes', 'mensajeria', 'social', 'productos', 'evaluacion', 'settings', 'users', 'solutions'],
  supervisor:  ['chats', 'orders', 'repartos', 'pagos'],
  coordinador: ['repartos'],
  agent:       ['chats'],
};

const MAIN_NAV_ITEMS = [
  { key: 'chats',    icon: MessageSquare, label: 'Chats' },
  { key: 'orders',   icon: ShoppingBag,   label: 'Pedidos' },
  { key: 'repartos', icon: Truck,         label: 'Repartos' },
  { key: 'pagos',    icon: Receipt,       label: 'Pagos' },
  { key: 'clientes', icon: Users,         label: 'Clientes' },
];

const MORE_NAV_ITEMS = [
  { key: 'mensajeria', icon: Megaphone, label: 'Mensajería' },
  { key: 'social',     icon: Facebook,   label: 'Facebook e Instagram' },
  { key: 'productos',  icon: Store,     label: 'Mi tienda' },
  { key: 'stats',      icon: BarChart2, label: 'Estadísticas' },
  { key: 'evaluacion', icon: Check,     label: 'Evaluación' },
  { key: 'settings',   icon: Settings,  label: 'Configuración' },
  { key: 'solutions',  icon: Layers,    label: 'Soluciones' },
  { key: 'users',      icon: UserCog,   label: 'Equipo' },
];

const MOBILE_MAIN_KEYS = ['chats', 'orders', 'repartos', 'clientes'];

export default function NavBar(props) {
  return props.isMobile ? <MobileNav {...props} /> : <DesktopNav {...props} />;
}

function useNavigation({ userRole, modules }) {
  const allowed = ROLE_VIEWS[userRole] || ROLE_VIEWS.agent;
  const moduleOn = (key) => !modules || modules[key] !== false;
  const isVisible = (item) => allowed.includes(item.key) && moduleOn(item.key);

  return {
    allowed,
    mainItems: MAIN_NAV_ITEMS.filter(isVisible),
    moreItems: MORE_NAV_ITEMS.filter(isVisible),
  };
}

function DesktopNav({ view, onChangeView, orgName, connected, onLogout, unreadCount, pendingOrders, pendingProofs, userRole, modules }) {
  const { colors, isDark, toggle } = useTheme();
  const { allowed, mainItems, moreItems } = useNavigation({ userRole, modules });
  const [openMenu, setOpenMenu] = useState(null);
  const navRef = useRef(null);
  const initial = (orgName || 'W')[0].toUpperCase();
  const moreActive = moreItems.some(item => item.key === view);

  useEffect(() => {
    const closeOutside = (event) => {
      if (navRef.current && !navRef.current.contains(event.target)) setOpenMenu(null);
    };
    document.addEventListener('mousedown', closeOutside);
    return () => document.removeEventListener('mousedown', closeOutside);
  }, []);

  const goTo = (key) => {
    setOpenMenu(null);
    onChangeView(key);
  };

  return (
    <nav ref={navRef} aria-label="Navegación principal" style={{
      width: '72px', height: '100vh', backgroundColor: colors.navBg,
      borderRight: `1px solid ${colors.border}`, display: 'flex',
      flexDirection: 'column', alignItems: 'center', padding: '12px 0',
      gap: '6px', flexShrink: 0, position: 'relative', zIndex: 80,
    }}>
      <button aria-label="Abrir menú de cuenta" aria-expanded={openMenu === 'account'}
        onClick={() => setOpenMenu(openMenu === 'account' ? null : 'account')}
        style={{
          width: '44px', height: '44px', borderRadius: '50%', border: 'none',
          backgroundColor: colors.green, display: 'flex', alignItems: 'center',
          justifyContent: 'center', fontWeight: 700, color: 'white', fontSize: '17px',
          marginBottom: '2px', flexShrink: 0, cursor: 'pointer',
          boxShadow: openMenu === 'account' ? `0 0 0 3px ${colors.green}35` : 'none',
        }}>
        {initial}
      </button>

      <div title={connected ? 'Conectado' : 'Sin conexión'} style={{
        display: 'flex', alignItems: 'center', color: connected ? colors.green : colors.red,
        fontSize: '9px', marginBottom: '8px',
      }}>
        {connected ? <Wifi size={14} /> : <WifiOff size={14} />}
      </div>

      {mainItems.map(item => (
        <NavItem key={item.key} active={view === item.key} label={item.label}
          badge={getBadge(item.key, unreadCount, pendingOrders, pendingProofs)}
          onClick={() => goTo(item.key)} colors={colors}>
          <item.icon size={21} />
        </NavItem>
      ))}

      {moreItems.length > 0 && (
        <NavItem active={moreActive || openMenu === 'more'} label="Más funciones"
          onClick={() => setOpenMenu(openMenu === 'more' ? null : 'more')} colors={colors}>
          <Menu size={21} />
        </NavItem>
      )}

      <div style={{ flex: 1 }} />
      <NavItem label={isDark ? 'Usar modo claro' : 'Usar modo oscuro'} onClick={toggle} colors={colors}>
        {isDark ? <Sun size={19} /> : <Moon size={19} />}
      </NavItem>

      {openMenu === 'more' && (
        <Popover title="Más funciones" colors={colors} bottom={66}>
          {moreItems.map(item => (
            <MenuRow key={item.key} icon={item.icon} label={item.label}
              active={view === item.key} onClick={() => goTo(item.key)} colors={colors} />
          ))}
        </Popover>
      )}

      {openMenu === 'account' && (
        <Popover title={orgName || 'Mi cuenta'} colors={colors} top={12}>
          {allowed.includes('settings') && (
            <MenuRow icon={Settings} label="Configuración de la cuenta" active={view === 'settings'}
              onClick={() => goTo('settings')} colors={colors} />
          )}
          <MenuRow icon={LogOut} label="Cerrar sesión" danger onClick={() => {
            setOpenMenu(null);
            onLogout();
          }} colors={colors} />
        </Popover>
      )}
    </nav>
  );
}

function MobileNav({ view, onChangeView, unreadCount, pendingOrders, pendingProofs, userRole, modules, onLogout }) {
  const { colors, isDark, toggle } = useTheme();
  const { allowed, mainItems, moreItems } = useNavigation({ userRole, modules });
  const [moreOpen, setMoreOpen] = useState(false);
  const visibleMain = mainItems.filter(item => MOBILE_MAIN_KEYS.includes(item.key));
  const mobileMoreItems = [
    ...mainItems.filter(item => !MOBILE_MAIN_KEYS.includes(item.key)),
    ...moreItems,
  ];
  const moreActive = mobileMoreItems.some(item => item.key === view) || view === 'settings';

  const goTo = (key) => {
    setMoreOpen(false);
    onChangeView(key);
  };

  return (
    <>
      {moreOpen && (
        <div onClick={() => setMoreOpen(false)} style={{
          position: 'fixed', inset: 0, zIndex: 98, backgroundColor: 'rgba(0,0,0,.45)',
        }}>
          <div onClick={event => event.stopPropagation()} style={{
            position: 'absolute', left: 10, right: 10, bottom: 'calc(70px + env(safe-area-inset-bottom, 0px))',
            backgroundColor: colors.bgPanel, border: `1px solid ${colors.border}`,
            borderRadius: '16px', padding: '10px', boxShadow: '0 16px 40px rgba(0,0,0,.28)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 8px 10px' }}>
              <strong style={{ color: colors.textPrimary, fontSize: '14px' }}>Más funciones</strong>
              <button aria-label="Cerrar menú" onClick={() => setMoreOpen(false)} style={iconButton(colors)}><X size={19} /></button>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px' }}>
              {mobileMoreItems.map(item => (
                <MenuRow key={item.key} icon={item.icon} label={item.label} active={view === item.key}
                  onClick={() => goTo(item.key)} colors={colors} />
              ))}
              <MenuRow icon={isDark ? Sun : Moon} label={isDark ? 'Modo claro' : 'Modo oscuro'} onClick={toggle} colors={colors} />
              <MenuRow icon={LogOut} label="Cerrar sesión" danger onClick={onLogout} colors={colors} />
            </div>
          </div>
        </div>
      )}

      <nav aria-label="Navegación principal" style={{
        position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 100,
        height: 'calc(60px + env(safe-area-inset-bottom, 0px))',
        paddingBottom: 'env(safe-area-inset-bottom, 0px)', boxSizing: 'border-box',
        backgroundColor: colors.navBg, borderTop: `1px solid ${colors.border}`,
        display: 'flex', alignItems: 'stretch', boxShadow: '0 -2px 12px rgba(0,0,0,0.12)',
      }}>
        {visibleMain.map(item => (
          <MobileItem key={item.key} item={item} active={view === item.key}
            badge={getBadge(item.key, unreadCount, pendingOrders, pendingProofs)}
            onClick={() => goTo(item.key)} colors={colors} />
        ))}
        {(mobileMoreItems.length > 0 || allowed.includes('settings')) && (
          <MobileItem item={{ icon: Menu, label: 'Más' }} active={moreActive || moreOpen}
            onClick={() => setMoreOpen(!moreOpen)} colors={colors} />
        )}
      </nav>
    </>
  );
}

function MobileItem({ item, active, badge, onClick, colors }) {
  const Icon = item.icon;
  return (
    <button onClick={onClick} style={{
      flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', gap: '3px', background: 'none', border: 'none',
      cursor: 'pointer', color: active ? colors.green : colors.textSecondary,
      position: 'relative', transition: 'color 0.15s',
    }}>
      <div style={{ position: 'relative' }}>
        <Icon size={20} />
        <Badge value={badge} colors={colors} />
      </div>
      <span style={{ fontSize: '10px', fontWeight: active ? 600 : 400 }}>{item.label}</span>
      {active && <div style={{ position: 'absolute', top: 0, left: '50%', transform: 'translateX(-50%)', width: '28px', height: '2px', borderRadius: '0 0 4px 4px', backgroundColor: colors.green }} />}
    </button>
  );
}

function Popover({ title, children, colors, top, bottom }) {
  return (
    <div style={{
      position: 'absolute', left: '62px', top, bottom, width: '224px',
      backgroundColor: colors.bgPanel, border: `1px solid ${colors.border}`,
      borderRadius: '14px', padding: '8px', boxShadow: '0 16px 42px rgba(0,0,0,.3)',
    }}>
      <div style={{ padding: '8px 10px 9px', color: colors.textSecondary, fontSize: '11px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.06em' }}>
        {title}
      </div>
      {children}
    </div>
  );
}

function MenuRow({ icon: Icon, label, active, danger, onClick, colors }) {
  return (
    <button onClick={onClick} style={{
      width: '100%', minHeight: '42px', padding: '0 10px', border: 'none', borderRadius: '9px',
      backgroundColor: active ? `${colors.green}18` : 'transparent',
      color: danger ? colors.red : active ? colors.green : colors.textPrimary,
      display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', textAlign: 'left',
    }} onMouseEnter={event => { if (!active) event.currentTarget.style.backgroundColor = colors.bgHover; }}
      onMouseLeave={event => { event.currentTarget.style.backgroundColor = active ? `${colors.green}18` : 'transparent'; }}>
      <Icon size={18} />
      <span style={{ flex: 1, fontSize: '13px', fontWeight: active ? 650 : 500 }}>{label}</span>
      {!danger && <ChevronRight size={15} color={colors.textSecondary} />}
    </button>
  );
}

function NavItem({ children, active, label, badge, onClick, colors }) {
  return (
    <div style={{ position: 'relative' }}>
      <button onClick={onClick} title={label} aria-label={label} style={{
        width: '46px', height: '46px', borderRadius: '13px', display: 'flex',
        alignItems: 'center', justifyContent: 'center', color: active ? colors.green : colors.textSecondary,
        backgroundColor: active ? `${colors.green}18` : 'transparent', transition: 'all 0.15s',
        cursor: 'pointer', border: 'none',
      }} onMouseEnter={event => {
        if (!active) event.currentTarget.style.backgroundColor = colors.bgHover;
        event.currentTarget.style.color = active ? colors.green : colors.textPrimary;
      }} onMouseLeave={event => {
        event.currentTarget.style.backgroundColor = active ? `${colors.green}18` : 'transparent';
        event.currentTarget.style.color = active ? colors.green : colors.textSecondary;
      }}>
        {children}
      </button>
      <Badge value={badge} colors={colors} />
    </div>
  );
}

function Badge({ value, colors }) {
  if (!value) return null;
  return (
    <span style={{
      position: 'absolute', top: '-3px', right: '-6px', backgroundColor: colors.green,
      color: 'white', borderRadius: '10px', padding: '0 5px', fontSize: '10px',
      fontWeight: 700, minWidth: '16px', textAlign: 'center', lineHeight: '16px', pointerEvents: 'none',
    }}>
      {value > 99 ? '99+' : value}
    </span>
  );
}

function getBadge(key, unreadCount, pendingOrders, pendingProofs) {
  if (key === 'chats') return unreadCount;
  if (key === 'orders') return pendingOrders;
  if (key === 'pagos') return pendingProofs || 0;
  return 0;
}

function iconButton(colors) {
  return {
    width: '34px', height: '34px', borderRadius: '9px', border: 'none',
    backgroundColor: colors.bgHover, color: colors.textSecondary, display: 'flex',
    alignItems: 'center', justifyContent: 'center', cursor: 'pointer',
  };
}
