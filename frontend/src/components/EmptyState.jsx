import { CheckCircle, Circle, ShoppingBag, MessageCircle, UserCheck } from 'lucide-react';
import { useTheme } from '../theme.js';

const STEPS = [
  {
    num: 1,
    icon: ShoppingBag,
    title: 'Conecta tu tienda Shopify',
    desc: 'El bot accede a tu catálogo de productos y clientes en tiempo real.',
    action: 'Ir a Ajustes → Shopify',
    tab: 'shopify',
  },
  {
    num: 2,
    icon: MessageCircle,
    title: 'Configura WhatsApp',
    desc: 'El agente IA responderá automáticamente a cada mensaje entrante.',
    action: 'Ir a Ajustes → WhatsApp',
    tab: 'whatsapp',
  },
  {
    num: 3,
    icon: UserCheck,
    title: 'Activa el re-enganche',
    desc: 'Recupera clientes inactivos con mensajes personalizados por IA.',
    action: 'Ir a Re-enganche',
    tab: 'reengagement',
  },
];

export default function EmptyState({ orgName, onChangeView }) {
  const { colors } = useTheme();

  return (
    <div style={{
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.bgApp,
      padding: '40px 24px',
      gap: '32px',
    }}>
      {/* Title */}
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontSize: '28px', marginBottom: '8px' }}>👋</div>
        <h2 style={{ color: colors.textPrimary, fontSize: '20px', fontWeight: 700, margin: '0 0 8px' }}>
          Bienvenido{orgName ? `, ${orgName}` : ''}
        </h2>
        <p style={{ color: colors.textSecondary, fontSize: '13px', margin: 0, lineHeight: 1.6 }}>
          Sigue estos 3 pasos para que el bot empiece a vender por ti
        </p>
      </div>

      {/* Checklist */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', width: '100%', maxWidth: '380px' }}>
        {STEPS.map((step) => {
          const Icon = step.icon;
          return (
            <div
              key={step.num}
              onClick={() => onChangeView?.(step.tab === 'shopify' || step.tab === 'whatsapp' ? 'settings' : step.tab)}
              style={{
                display: 'flex', alignItems: 'flex-start', gap: '14px',
                backgroundColor: colors.bgPanel,
                borderRadius: '12px',
                padding: '16px 18px',
                border: `1px solid ${colors.border}`,
                cursor: onChangeView ? 'pointer' : 'default',
                transition: 'border-color 0.15s, box-shadow 0.15s',
              }}
              onMouseEnter={e => {
                if (!onChangeView) return;
                e.currentTarget.style.borderColor = `${colors.green}66`;
                e.currentTarget.style.boxShadow = `0 0 0 3px ${colors.green}12`;
              }}
              onMouseLeave={e => {
                e.currentTarget.style.borderColor = colors.border;
                e.currentTarget.style.boxShadow = 'none';
              }}
            >
              {/* Step number circle */}
              <div style={{
                width: '36px', height: '36px', borderRadius: '50%', flexShrink: 0,
                backgroundColor: `${colors.green}18`,
                border: `1px solid ${colors.green}44`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                <Icon size={17} color={colors.green} />
              </div>

              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '3px' }}>
                  <span style={{
                    backgroundColor: `${colors.green}22`, color: colors.green,
                    fontSize: '10px', fontWeight: 700, padding: '1px 6px',
                    borderRadius: '4px', flexShrink: 0,
                  }}>
                    Paso {step.num}
                  </span>
                  <span style={{ color: colors.textPrimary, fontSize: '13px', fontWeight: 600 }}>
                    {step.title}
                  </span>
                </div>
                <p style={{ color: colors.textSecondary, fontSize: '12px', margin: '0 0 6px', lineHeight: 1.5 }}>
                  {step.desc}
                </p>
                {onChangeView && (
                  <span style={{ color: colors.green, fontSize: '11px', fontWeight: 600 }}>
                    {step.action} →
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <p style={{ color: colors.textMuted, fontSize: '11px', textAlign: 'center', margin: 0 }}>
        Powered by Anthropic Claude · Cifrado de extremo a extremo
      </p>
    </div>
  );
}
