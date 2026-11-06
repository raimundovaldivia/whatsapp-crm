import { useEffect, useMemo, useState } from 'react';
import './justo-casero.css';

const API = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001';
const CRM_STORE_SLUG = 'justo-casero-mvg75kb0';
const FALLBACK_WHATSAPP = '56926082545';
const PRICE_VOTES_KEY = 'justo_casero_price_votes_v2';

const productTests = [
  { id: 'lacteos', icon: '🧀', label: 'Quesos y lácteos locales', detail: 'Productos cercanos, frescos y con buena procedencia.' },
  { id: 'conservas', icon: '🫒', label: 'Aceitunas y conservas', detail: 'Alternativas locales elegidas por sabor y origen.' },
  { id: 'despensa', icon: '🍚', label: 'Despensa a buen precio', detail: 'Arroz, fideos, aceite y otros básicos que realmente convengan.' },
  { id: 'otra', icon: '+', label: 'Otra idea', detail: 'Cuéntanos qué producto te gustaría encontrar.' },
];

const eggBoxes = [
  {
    size: 'Extra',
    units: 30,
    sku: 'JC-EXTRA-30',
    title: 'Huevos Extra de color · Bandeja de 30',
    text: '30 huevos de color por bandeja, calibre Extra de 61–68 g.',
  },
  {
    size: 'Súper Extra',
    units: 20,
    sku: 'JC-SUPER-EXTRA-20',
    title: 'Huevos Súper Extra de color · Bandeja de 20',
    text: '20 huevos de color por bandeja, calibre Súper Extra / Especial de 69–76 g.',
  },
];

function onlyDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function whatsappHref(phone, message) {
  return `https://wa.me/${onlyDigits(phone)}?text=${encodeURIComponent(message)}`;
}

function savedPriceVotes() {
  try {
    const votes = JSON.parse(localStorage.getItem(PRICE_VOTES_KEY) || '{}');
    return votes && typeof votes === 'object' ? votes : {};
  } catch {
    return {};
  }
}

export default function JustoCaseroLanding() {
  const [whatsapp, setWhatsapp] = useState(FALLBACK_WHATSAPP);
  const [catalog, setCatalog] = useState(null);
  const [quantities, setQuantities] = useState({});
  const [purchaseInstructions, setPurchaseInstructions] = useState('');
  const [shippingRule, setShippingRule] = useState(null);
  const [selection, setSelection] = useState('');
  const [otherIdea, setOtherIdea] = useState('');
  const [priceVotes, setPriceVotes] = useState(savedPriceVotes);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`${API}/store/${CRM_STORE_SLUG}/info`, { signal: controller.signal })
      .then(response => response.ok ? response.json() : Promise.reject(new Error('store unavailable')))
      .then(data => {
        const configured = onlyDigits(data.whatsappPhone);
        if (configured) setWhatsapp(configured);
        setShippingRule(data.shippingRule || null);
        setPurchaseInstructions(typeof data.howToBuy === 'string' ? data.howToBuy.trim() : '');
      })
      .catch(error => {
        if (error.name !== 'AbortError') console.warn('[Justo Casero] Se usará el WhatsApp de respaldo');
      });

    fetch(API + '/store/' + CRM_STORE_SLUG + '/products', { signal: controller.signal })
      .then(response => response.ok ? response.json() : Promise.reject(new Error('catalog unavailable')))
      .then(data => setCatalog(Array.isArray(data.products) ? data.products : null))
      .catch(error => {
        if (error.name !== 'AbortError') console.warn('[Justo Casero] Consulta disponibilidad por WhatsApp');
      });

    const previousTitle = document.title;
    const description = document.querySelector('meta[name="description"]');
    const previousDescription = description?.getAttribute('content') || '';
    document.title = 'Justo Casero | Productos locales y precios justos';
    description?.setAttribute('content', 'Huevos Extra y Súper Extra desde una bandeja. Descuento automático por cantidad. La Serena y Coquimbo.');

    return () => {
      controller.abort();
      document.title = previousTitle;
      description?.setAttribute('content', previousDescription);
    };
  }, []);

  const selectedProduct = productTests.find(product => product.id === selection);
  const vote = selection === 'otra' ? otherIdea.trim() : selectedProduct?.label;
  const voteLink = useMemo(() => vote ? whatsappHref(
    whatsapp,
    `Hola, ya compré en Justo Casero y mi voto para el próximo producto es: ${vote}.`,
  ) : '', [vote, whatsapp]);
  const orderLink = message => whatsappHref(whatsapp, message);
  const choosePriceVote = (size, answer) => {
    const next = { ...priceVotes, [size]: answer };
    setPriceVotes(next);
    try { localStorage.setItem(PRICE_VOTES_KEY, JSON.stringify(next)); } catch {}
  };
  const priceVoteLink = (size, answer) => whatsappHref(
    whatsapp,
    `Hola, mi opinión sobre el precio cotizado de los huevos café ${size} es: ${answer === 'fair' ? 'sí, me parece justo 👍' : 'creo que podría ser más bajo 👎'}.`,
  );

  return (
    <div className="jc-landing">
      <header className="jc-header">
        <div className="jc-container jc-header-inner">
          <a className="jc-brand" href="/justo-casero" aria-label="Justo Casero, inicio">
            <img src="/store-assets/justo-casero/logo.png" alt="Justo Casero" />
          </a>
          <nav className="jc-nav" aria-label="Navegación principal">
            <a href="#productos">Productos</a>
            <a href="#como-comprar">Cómo comprar</a>
            <a href="#precio-justo">Precio justo</a>
            <a href="#proximo-producto">Tu voto</a>
          </nav>
          <a className="jc-button jc-button-small" href={orderLink('Hola, quiero comprar bandejas de huevos Extra o Súper Extra en Justo Casero.')} target="_blank" rel="noreferrer">
            Pedir por WhatsApp
          </a>
        </div>
      </header>

      <main>
        <section className="jc-hero">
          <div className="jc-container jc-hero-grid">
            <div className="jc-hero-copy">
              <div className="jc-eyebrow"><span /> Para la casera y el casero</div>
              <h1>Local cuando se puede. <em>Buen precio siempre.</em></h1>
              <p className="jc-hero-lead">Compra desde una bandeja de huevos de color. Elige Extra de 30 o Súper Extra de 20: al llevar más del mismo calibre, pagas menos por bandeja.</p>
              <div className="jc-hero-actions">
                <a className="jc-button jc-button-primary" href="#productos" target="_blank" rel="noreferrer">
                  Elegir mis bandejas <span aria-hidden="true">→</span>
                </a>
                <a className="jc-button jc-button-ghost" href="#productos">Ver tamaños</a>
              </div>
              <p className="jc-coverage"><span className="jc-icon" aria-hidden="true">⌖</span> Reparto en La Serena y Coquimbo</p>
            </div>
            <div className="jc-hero-visual" aria-label="Bandejas de huevos Extra y Súper Extra">
              <div className="jc-price-note">Huevos de color<br /><strong>Extra + Súper Extra</strong></div>
              <img src="/store-assets/justo-casero/hero-huevos.png" alt="Huevos de color en bandejas" />
              <div className="jc-hero-stamp">Desde<br />1 bandeja</div>
            </div>
          </div>
        </section>

        <section className="jc-benefits" aria-label="Características de la oferta">
          <div className="jc-container jc-benefit-grid">
            <article><span className="jc-icon" aria-hidden="true">●</span><div><h2>Partimos con huevos</h2><p>Extra: 30 huevos por bandeja. Súper Extra: 20.</p></div></article>
            <article><span className="jc-icon" aria-hidden="true">▦</span><div><h2>Selección con criterio</h2><p>Cada producto debe ser local o tener un precio que realmente convenga.</p></div></article>
            <article><span className="jc-icon" aria-hidden="true">→</span><div><h2>Ustedes deciden</h2><p>La casera y el casero nos ayudan a elegir qué incorporar después.</p></div></article>
          </div>
        </section>

        <section className="jc-section" id="productos">
          <div className="jc-container">
            <div className="jc-section-heading">
              <div><span className="jc-kicker">Nuestra primera categoría</span><h2>Huevos café.<br />Dos tamaños.</h2></div>
              <p>Elige tus bandejas y el descuento se aplica automáticamente. Revisa el total y cuánto pagas por bandeja antes de pedir.</p>
            </div>
            <div className="jc-egg-grid">
              {eggBoxes.map((product, index) => {
                const activeProduct = catalog?.find(item => item?.sku === product.sku);
                const tiers = activeProduct?.quantity_prices;
                const quantity = quantities[product.sku] || 1;
                const total = Array.isArray(tiers) ? tiers[quantity - 1] : null;
                const available = activeProduct && (Number(activeProduct.stock) === -1 || Number(activeProduct.stock) >= quantity);
                const ready = available && Number.isFinite(total) && total > 0 && shippingRule;
                const deliveryFee = shippingRule && total < shippingRule.freeFrom ? shippingRule.fee : 0;
                const finalTotal = total + deliveryFee;
                const money = value => '$' + Math.round(value).toLocaleString('es-CL');
                const shipping = shippingRule
                  ? `Despacho ${money(shippingRule.fee)} en compras de productos menores a ${money(shippingRule.freeFrom)}. Desde ${money(shippingRule.freeFrom)}, gratis. La Serena y Coquimbo; confirma cobertura de tu dirección.`
                  : 'Consultando las condiciones de despacho…';
                return (
                <article className={`jc-egg-card jc-egg-card-${index + 1}`} key={product.size}>
                  <span className="jc-card-number">0{index + 1}</span>
                  <span className="jc-size-label" aria-hidden="true">{product.units}</span>
                  <h3>{product.title}</h3>
                  <p>{product.text}</p>
                  {tiers?.length > 0 && <>
                    <label className="jc-quantity-label">Cantidad de bandejas
                      <select aria-label={`Bandejas de ${product.size}`} value={quantity} onChange={event => setQuantities(previous => ({ ...previous, [product.sku]: Number(event.target.value) }))}>
                        {tiers.map((_, i) => <option key={i} value={i + 1}>{i + 1} {i === 0 ? 'bandeja' : 'bandejas'} · {(i + 1) * product.units} huevos</option>)}
                      </select>
                    </label>
                    <div className="jc-tray-total" aria-live="polite">
                      <strong>{money(total)}</strong><span>Total de productos · {quantity * product.units} huevos</span>
                      {shippingRule && <><span>Despacho: {deliveryFee ? money(deliveryFee) : 'Gratis'}</span><b>Total a pagar: {money(finalTotal)}</b></>}
                      <b>{quantity > 1 ? '≈ ' : ''}{money(total / quantity)} por bandeja</b>
                      {quantity > 1 && <small>Ahorras {money(tiers[0] * quantity - total)} frente a comprarlas individualmente.</small>}
                    </div>
                    <details className="jc-tier-details"><summary>Ver todos los precios por cantidad</summary>
                      <table><thead><tr><th>Bandejas</th><th>Total</th><th>Por bandeja</th></tr></thead><tbody>
                        {tiers.map((amount, i) => <tr key={i}><td>{i + 1}</td><td>{money(amount)}</td><td>{money(amount / (i + 1))}</td></tr>)}
                      </tbody></table>
                    </details>
                  </>}
                  <p className="jc-shipping-note">{shipping}</p>
                  <p>{catalog === null ? 'Cargando precios y disponibilidad…' : available ? '' : 'Temporalmente no disponible. Consulta por el próximo ingreso.'}</p>
                  {ready ? <a href={orderLink(`Hola, quiero ${quantity} ${quantity === 1 ? 'bandeja' : 'bandejas'} de huevos ${product.size} de color de ${product.units} huevos cada una (${quantity * product.units} huevos en total). Precio de productos: ${money(total)}. Despacho: ${deliveryFee ? money(deliveryFee) : 'gratis'}. Total a pagar: ${money(finalTotal)}. Quiero completar el pedido.`)} target="_blank" rel="noreferrer">Pedir {quantity} {quantity === 1 ? 'bandeja' : 'bandejas'} · {money(finalTotal)} <span>→</span></a>
                    : <a href={orderLink(`Hola, quiero consultar la disponibilidad de huevos ${product.size} por bandeja.`)} target="_blank" rel="noreferrer">Consultar disponibilidad <span>→</span></a>}
                </article>
                );
              })}
            </div>
          </div>
        </section>

        <section className="jc-price-check" id="precio-justo">
          <div className="jc-container jc-price-check-card">
            <div className="jc-price-check-heading">
              <span className="jc-kicker">El precio también se vota</span>
              <h2>¿Te pareció justo?</h2>
              <p>Después de recibir tu cotización, cuéntanos cómo sentiste el precio. Tu respuesta nos ayuda a mantener una oferta honesta.</p>
            </div>
            <div className="jc-price-vote-grid">
              {eggBoxes.map(product => {
                const answer = priceVotes[product.size];
                return (
                  <article className="jc-price-vote-card" key={product.size}>
                    <div><span>Huevos café por bandeja</span><strong>{product.size}</strong></div>
                    <p>¿El precio cotizado está bien?</p>
                    <div className="jc-price-vote-buttons" role="group" aria-label={`Evaluar precio de ${product.size}`}>
                      <button type="button" className={answer === 'fair' ? 'is-selected is-fair' : ''} aria-pressed={answer === 'fair'} onClick={() => choosePriceVote(product.size, 'fair')}><span aria-hidden="true">👍</span> Sí, está justo</button>
                      <button type="button" className={answer === 'high' ? 'is-selected is-high' : ''} aria-pressed={answer === 'high'} onClick={() => choosePriceVote(product.size, 'high')}><span aria-hidden="true">👎</span> Está un poco alto</button>
                    </div>
                    {answer && (
                      <div className="jc-price-vote-result" role="status">
                        <span>¡Gracias! Tu opinión quedó marcada.</span>
                        <a href={priceVoteLink(product.size, answer)} target="_blank" rel="noreferrer">Registrarla por WhatsApp <span aria-hidden="true">→</span></a>
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
            <p className="jc-price-privacy">Guardamos una respuesta por tamaño en este dispositivo. Al enviarla por WhatsApp queda asociada a tu conversación con nuestro equipo.</p>
          </div>
        </section>

        <section className="jc-how" id="como-comprar">
          <div className="jc-container">
            <div className="jc-centered-heading"><span className="jc-kicker">Comprar será así de fácil</span><h2>Tres pasos y listo.</h2></div>
            <ol className="jc-steps">
              <li><span>1</span><h3>Consulta</h3><p>Elige Extra de 30 o Súper Extra de 20 huevos por bandeja.</p></li>
              <li><span>2</span><h3>Elige</h3><p>Selecciona desde una bandeja. Verás automáticamente el descuento y el total según tu cantidad.</p></li>
              <li><span>3</span><h3>Confirma</h3><p>Revisa el resumen y confírmalo por WhatsApp. Recibirás el número de tu pedido. Pagas en efectivo o transferencia al recibir.</p></li>
            </ol>
            {purchaseInstructions && (
              <article className="jc-price-vote-card" style={{ marginTop: 24 }} aria-labelledby="jc-payment-heading">
                <h3 id="jc-payment-heading" style={{ marginTop: 0 }}>Pago contra entrega y datos para transferir</h3>
                <p style={{ whiteSpace: 'pre-line', overflowWrap: 'anywhere', lineHeight: 1.8, fontWeight: 400 }}>{purchaseInstructions}</p>
              </article>
            )}
          </div>
        </section>

        <section className="jc-contact" id="contacto">
          <div className="jc-container jc-contact-card">
            <div><span className="jc-kicker">EXTRA O SÚPER EXTRA</span><h2>Tus bandejas de huevos de color.</h2><p>Repartimos de lunes a sábado, de 15:00 a 21:00. Pedidos hasta las 15:00 inclusive; después, para el siguiente día de reparto disponible. Despacho de $1.500 para compras de productos menores a $15.000; desde $15.000, gratis en La Serena y Coquimbo, según cobertura de tu dirección.</p></div>
            <a className="jc-button jc-button-dark" href={orderLink('Hola, quiero pedir huevos de color por bandeja. ¿Qué disponibilidad tienen en Extra y Súper Extra?')} target="_blank" rel="noreferrer">Abrir WhatsApp <span>→</span></a>
          </div>
        </section>

        <section className="jc-radar" id="proximo-producto">
          <div className="jc-container jc-radar-card">
            <div className="jc-radar-heading">
              <span className="jc-kicker">Radar Casero · Próximos productos</span>
              <h2>¿Qué debería llegar después?</h2>
              <p>Queremos sumar productos locales o alternativas de buen precio. Ayúdanos a escoger qué probar primero: estas ideas todavía no están a la venta.</p>
            </div>
            <div className="jc-vote-grid" role="group" aria-label="Opciones para el próximo producto">
              {productTests.map(product => (
                <button className={`jc-vote-option${selection === product.id ? ' is-selected' : ''}`} key={product.id} type="button" aria-pressed={selection === product.id} onClick={() => setSelection(product.id)}>
                  <span className="jc-vote-icon" aria-hidden="true">{product.icon}</span><strong>{product.label}</strong><small>{product.detail}</small>
                </button>
              ))}
            </div>
            {selection === 'otra' && (
              <label className="jc-other-idea"><span>¿Qué producto tienes en mente?</span><input type="text" maxLength={80} value={otherIdea} onChange={event => setOtherIdea(event.target.value)} placeholder="Ejemplo: harina, café, alimento para mascotas..." /></label>
            )}
            <div className="jc-radar-action">
              {voteLink ? <a className="jc-button jc-button-primary" href={voteLink} target="_blank" rel="noreferrer">Enviar mi voto por WhatsApp <span>→</span></a> : <span className="jc-radar-status" aria-live="polite">Elige una opción para enviar tu voto.</span>}
              <p>Este mensaje entra al mismo CRM y queda asociado a la conversación del cliente.</p>
            </div>
          </div>
        </section>
      </main>

      <footer className="jc-footer"><div className="jc-container jc-footer-inner"><img src="/store-assets/justo-casero/logo.png" alt="Justo Casero" /><p>Para la casera y el casero: productos locales o de buen precio.</p><a href={orderLink('Hola, quiero comprar huevos café por bandeja.')} target="_blank" rel="noreferrer">Comprar por WhatsApp</a></div></footer>
    </div>
  );
}

