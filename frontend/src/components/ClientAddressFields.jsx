import { useEffect, useState } from 'react';
import { api } from '../utils/api.js';

export default function ClientAddressFields({
  phone,
  address,
  city,
  onAddressChange,
  onCityChange,
  colors,
  compact = false,
}) {
  const [options, setOptions] = useState([]);

  useEffect(() => {
    let alive = true;
    const cleanPhone = String(phone || '').trim();
    if (!cleanPhone) { setOptions([]); return () => { alive = false; }; }
    api.get(`/contacts/${encodeURIComponent(cleanPhone)}/addresses`)
      .then(response => { if (alive) setOptions(response.data?.data || []); })
      .catch(() => { if (alive) setOptions([]); });
    return () => { alive = false; };
  }, [phone]);

  const inputStyle = {
    minWidth: 0,
    width: '100%',
    boxSizing: 'border-box',
    padding: compact ? '5px 8px' : '9px 10px',
    borderRadius: compact ? '6px' : '8px',
    border: `1px solid ${colors.border}`,
    backgroundColor: compact ? colors.bgPanel : colors.bg,
    color: colors.textPrimary,
    fontSize: compact ? '12px' : undefined,
  };

  return (
    <div style={{ display:'flex', flexDirection:'column', gap: compact ? '6px' : '8px' }}>
      {options.length > 0 && (
        <select
          value=""
          onChange={event => {
            const option = options[Number(event.target.value)];
            if (!option) return;
            onAddressChange(option.address);
            onCityChange(option.city || '');
          }}
          style={inputStyle}>
          <option value="">Elegir una dirección conocida ({options.length})</option>
          {options.map((option, index) => <option key={`${option.address}_${option.city}_${index}`} value={index}>{option.label}</option>)}
        </select>
      )}
      <div style={{ display:'grid', gridTemplateColumns:'minmax(0,2fr) minmax(110px,1fr)', gap: compact ? '6px' : '8px' }}>
        <input value={address} onChange={event => onAddressChange(event.target.value)} placeholder="Calle y número" style={inputStyle} />
        <input value={city} onChange={event => onCityChange(event.target.value)} placeholder="Ciudad / Comuna" style={inputStyle} />
      </div>
    </div>
  );
}
