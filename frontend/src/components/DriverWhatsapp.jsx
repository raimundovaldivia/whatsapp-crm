import { useEffect, useState } from 'react';
import { api } from '../utils/api';

export default function DriverWhatsapp({ user, phone, colors }) {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    const check = async () => {
      try {
        const response = await api.get(`/users/${user.id}/whatsapp`);
        if (active) setData(previous => ({ ...response.data.data, qr: previous?.qr }));
      } catch { /* Explicit connection actions display errors. */ }
    };
    check();
    const timer = setInterval(check, 15000);
    return () => { active = false; clearInterval(timer); };
  }, [user.id]);
  const connect = async () => {
    setBusy(true); setError('');
    try {
      const response = await api.post(`/users/${user.id}/whatsapp/connect`, { phone });
      setData(response.data.data);
    } catch (e) { setError(e.response?.data?.error || 'No se pudo preparar la conexión'); }
    finally { setBusy(false); }
  };
  const connected = data?.channel?.status === 'connected';
  const wrong = data?.channel?.status === 'wrong_number';
  const qr = data?.qr?.base64;
  return <section style={{ padding: 16, marginBottom: 16, border: `1px solid ${colors.border}`, borderRadius: 10, color: colors.textPrimary }}>
    <strong>WhatsApp para conversar con clientes</strong>
    <p style={{ fontSize: 13 }}>Los mensajes de la app de despachos saldrán desde el WhatsApp de {user.name}. El bot de ventas no responde en esta conexión.</p>
    <p>{connected ? `Conectado · +${data.channel.phone_number}` : wrong
      ? `Se vinculó otro número (+${data.channel.phone_number}). Desvincúlalo desde ese teléfono y conecta +${data.channel.expected_phone}.`
      : data?.channel ? `Pendiente de vincular · +${data.channel.expected_phone}` : 'Aún no conectado'}</p>
    {!connected && !wrong && <button type="button" disabled={busy || !phone} onClick={connect}
      style={{ padding: '9px 16px', border: 0, borderRadius: 8, background: colors.green, color: 'white', cursor: 'pointer' }}>
      {busy ? 'Preparando…' : qr ? 'Renovar QR' : 'Conectar WhatsApp del despachador'}
    </button>}
    {error && <p role="alert" style={{ color: colors.danger }}>{error}</p>}
    {!connected && !wrong && qr && <div>
      <p>En el teléfono de {user.name}: WhatsApp → Dispositivos vinculados → Vincular un dispositivo. Escanea este QR.</p>
      <img src={qr.startsWith('data:image/') ? qr : `data:image/png;base64,${qr}`} alt={`QR para conectar WhatsApp de ${user.name}`} width={260} height={260} style={{ maxWidth: '100%', background: '#fff' }} />
    </div>}
  </section>;
}
