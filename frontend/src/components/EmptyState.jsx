import { MessageSquare, Bot, ShoppingBag } from 'lucide-react';

export default function EmptyState({ orgName }) {
  return (
    <div style={{
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: '#0b141a',
      gap: '24px',
    }}>
      {/* Icono central */}
      <div style={{
        width: '120px',
        height: '120px',
        borderRadius: '50%',
        backgroundColor: '#202c33',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        border: '2px solid #2a3942',
      }}>
        <MessageSquare size={52} color="#00a884" strokeWidth={1.5} />
      </div>

      {/* Texto principal */}
      <div style={{ textAlign: 'center', maxWidth: '400px' }}>
        <h2 style={{ color: '#e9edef', fontSize: '22px', fontWeight: 300, marginBottom: '12px' }}>
          WhatsApp CRM
        </h2>
        <p style={{ color: '#8696a0', fontSize: '14px', lineHeight: '1.6' }}>
          Selecciona una conversación para comenzar.<br />
          El agente IA responde automáticamente usando<br />
          el catálogo de tu tienda Shopify.
        </p>
      </div>

      {/* Features */}
      <div style={{
        display: 'flex',
        gap: '20px',
        marginTop: '8px',
      }}>
        {[
          { icon: <Bot size={20} color="#00a884" />, label: 'Agente IA con Claude' },
          { icon: <ShoppingBag size={20} color="#00a884" />, label: 'Productos de Shopify' },
          { icon: <MessageSquare size={20} color="#00a884" />, label: 'CRM en tiempo real' },
        ].map(({ icon, label }) => (
          <div key={label} style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '8px',
            backgroundColor: '#202c33',
            padding: '14px 18px',
            borderRadius: '12px',
            border: '1px solid #2a3942',
          }}>
            {icon}
            <span style={{ fontSize: '12px', color: '#8696a0', textAlign: 'center' }}>{label}</span>
          </div>
        ))}
      </div>

      <p style={{ color: '#374045', fontSize: '12px', marginTop: '8px' }}>
        Cifrado de extremo a extremo · Powered by Anthropic Claude
      </p>
    </div>
  );
}
