import { useEffect, useState } from 'react';
import { api } from '../utils/api.js';

export function addressDetails(source = {}) {
  return { address2: source?.address2 ?? '', addressDescription: source?.addressDescription ?? source?.address_description ?? '' };
}

export function AddressDetailFields({ details, onChange, style, disabled = false }) {
  return <>
    <input aria-label="Casa / Depto." placeholder="Casa / Depto. (opcional)" autoComplete="address-line2"
      maxLength={150} value={details.address2 || ''} disabled={disabled} style={style}
      onChange={event => onChange({ ...details, address2: event.target.value })} />
    <textarea aria-label="Descripción de la dirección" placeholder="Descripción o referencia para llegar (opcional)"
      rows={2} maxLength={500} value={details.addressDescription || ''} disabled={disabled} style={{ ...style, resize: 'vertical' }}
      onChange={event => onChange({ ...details, addressDescription: event.target.value })} />
  </>;
}

export default function ClientAddressFields({
  phone,
  address,
  city,
  onAddressChange,
  onCityChange,
  details, onDetailsChange,
  colors,
  compact = false,
}) {
  const [options, setOptions] = useState([]);

  useEffect(() => {
    let alive = true;
    const cleanPhone = String(phone || '').trim();
    if (!cleanPhone) { setOptions([]); return () => { alive = false; }; }
    setOptions([]);
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
            onDetailsChange(addressDetails(option));
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
      <AddressDetailFields details={details} onChange={onDetailsChange} style={inputStyle} />
    </div>
  );
}
