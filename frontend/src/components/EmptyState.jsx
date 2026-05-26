import { MessageSquare, Bot, ShoppingBag } from 'lucide-react';
import { useTheme } from '../theme.js';

export default function EmptyState({ orgName }) {
  const { colors } = useTheme();
  return (
    <div style={{
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.bgApp,
      gap: '24px',
    }}>
      {/* Icono central */}
      <div style={{
        width: '120px',
        height: '120px',
        borderRadius: '50%',
        backgroundColor: colors.bgPanel,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        border: `2px solid ${colors.border}`,
      }}>
        <MessageSquare size={52} color={colors.green} strokeWidth={1.5} />
      </div>

      {/* Texto principal */}
      <div style={{ textAlign: 'center', maxWidth: '400px' }}>
        <h2 style={{ color: colors.textPrimary, fontSize: '22px', fontWeight: 300, marginBottom: '12px' }}>
          Resel
        </h2>
        <p style={{ color: colors.textSecondary, fontSize: '14px', lineHeight: '1.6' }}>
          Selecciona una conversación para comenzar.<br />
          El agente IA responde automáticamente usando<br />
          el catálogo de tu tienda Shopify.
        </p>
      </div>

      {/* Features */}
      <div style={{ display: 'flex', gap: '20px', marginTop: '8px' }}>
        {[
          { icon: <Bot size={20} color={colors.green} />, label: 'Agente IA con Claude' },
          { icon: <ShoppingBag size={20} color={colors.green} />, label: 'Productos de Shopify' },
          { icon: <MessageSquare size={20} color={colors.green} />, label: 'CRM en tiempo real' },
        ].map(({ icon, label }) => (
          <div key={label} style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '8px',
            backgroundColor: colors.bgPanel,
            padding: '14px 18px',
            borderRadius: '12px',
            border: `1px solid ${colors.border}`,
          }}>
            {icon}
            <span style={{ fontSize: '12px', color: colors.textSecondary, textAlign: 'center' }}>{label}</span>
          </div>
        ))}
      </div>

      <p style={{ color: colors.textMuted, fontSize: '12px', marginTop: '8px' }}>
        Cifrado de extremo a extremo · Powered by Anthropic Claude
      </p>
    </div>
  );
}
