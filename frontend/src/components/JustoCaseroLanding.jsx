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
    units: 180,
    sku: 'JC-EXTRA-180',
    title: 'Huevos Extra de color · Caja de 180',
    text: '180 huevos de color, calibre Extra de 61–68 g. Venta por caja.',
  },
  {
    size: 'Súper Extra',
    units: 100,
    sku: 'JC-SUPER-EXTRA-100',
    title: 'Huevos Súper Extra de color · Caja de 100',
    text: '100 huevos de color, calibre Súper Extra / Especial de 69–76 g. Venta por caja.',
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
    description?.setAttribute('content', 'Justo Casero: huevos Extra en cajas de 180 y Súper Extra en cajas de 100. Reparto en La Serena urbana y pedidos por WhatsApp.');

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
    `Hola, mi opinión sobre el precio cotizado de la caja de huevos café ${size} es: ${answer === 'fair' ? 'sí, me parece justo 👍' : 'creo que podría ser más bajo 👎'}.`,
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
          <a className="jc-button jc-button-small" href={orderLink('Hola, quiero consultar por las cajas Extra de 180 y Súper Extra de 100 de Justo Casero.')} target="_blank" rel="noreferrer">
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
              <p className="jc-hero-lead">Huevos de color en dos formatos: Extra de 180 y Súper Extra de 100. Después iremos sumando productos locales o alternativas que realmente convengan.</p>
              <div className="jc-hero-actions">
                <a className="jc-button jc-button-primary" href={orderLink('Hola, quiero conocer el precio y disponibilidad de Extra de 180 y Súper Extra de 100 huevos.')} target="_blank" rel="noreferrer">
                  Consultar precio por caja <span aria-hidden="true">→</span>
                </a>
                <a className="jc-button jc-button-ghost" href="#productos">Ver tamaños</a>
              </div>
              <p className="jc-coverage"><span className="jc-icon" aria-hidden="true">⌖</span> Reparto incluido en La Serena urbana</p>
            </div>
            <div className="jc-hero-visual" aria-label="Cajas Extra de 180 y Súper Extra de 100 huevos">
              <div className="jc-price-note">Huevos de color<br /><strong>Extra + Súper Extra</strong></div>
              <img src="/store-assets/justo-casero/hero-huevos.png" alt="Huevos de color vendidos por caja" />
              <div className="jc-hero-stamp">Venta<br />por caja</div>
            </div>
          </div>
        </section>

        <section className="jc-benefits" aria-label="Características de la oferta">
          <div className="jc-container jc-benefit-grid">
            <article><span className="jc-icon" aria-hidden="true">●</span><div><h2>Partimos con huevos</h2><p>Extra de 180 y Súper Extra de 100 huevos de color.</p></div></article>
            <article><span className="jc-icon" aria-hidden="true">▦</span><div><h2>Selección con criterio</h2><p>Cada producto debe ser local o tener un precio que realmente convenga.</p></div></article>
            <article><span className="jc-icon" aria-hidden="true">→</span><div><h2>Ustedes deciden</h2><p>La casera y el casero nos ayudan a elegir qué incorporar después.</p></div></article>
          </div>
        </section>

        <section className="jc-section" id="productos">
          <div className="jc-container">
            <div className="jc-section-heading">
              <div><span className="jc-kicker">Nuestra primera categoría</span><h2>Huevos café.<br />Dos tamaños.</h2></div>
              <p>Elige el calibre y la cantidad que necesitas: Extra en cajas de 180 o Súper Extra en cajas de 100. Precios por caja, con reparto incluido en La Serena urbana.</p>
            </div>
            <div className="jc-egg-grid">
              {eggBoxes.map((product, index) => {
                const activeProduct = catalog?.find(item => item?.sku === product.sku);
                const price = Number(activeProduct?.price);
                const available = activeProduct && (Number(activeProduct.stock) === -1 || Number(activeProduct.stock) > 0);
                return (
                <article className={`jc-egg-card jc-egg-card-${index + 1}`} key={product.size}>
                  <span className="jc-card-number">0{index + 1}</span>
                  <span className="jc-size-label" aria-hidden="true">{product.units}</span>
                  <h3>{product.title}</h3>
                  <p>{product.text}</p>
                  {activeProduct && Number.isFinite(price) && price > 0 && <strong className="jc-box-price">${price.toLocaleString('es-CL')} por caja</strong>}
                  <p>{catalog === null ? 'Consulta precio y disponibilidad por WhatsApp.' : available ? 'Disponible. Reparto incluido en La Serena urbana.' : 'Temporalmente no disponible. Consulta por el próximo ingreso.'}</p>
                  <a href={orderLink(`Hola, quiero consultar precio y disponibilidad de la ${product.title}.`)} target="_blank" rel="noreferrer">Consultar por {product.size} <span>→</span></a>
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
                    <div><span>Caja de huevos café</span><strong>{product.size}</strong></div>
                    <p>¿El precio cotizado está bien?</p>
                    <div className="jc-price-vote-buttons" role="group" aria-label={`Evaluar precio de caja ${product.size}`}>
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
              <li><span>1</span><h3>Consulta</h3><p>Pide el precio vigente de las cajas de huevos café.</p></li>
              <li><span>2</span><h3>Elige</h3><p>Indica Extra de 180 o Súper Extra de 100, la cantidad de cajas y tu dirección.</p></li>
              <li><span>3</span><h3>Confirma</h3><p>Revisa el resumen y confírmalo por WhatsApp. Recibirás el número de tu pedido. Pagas en efectivo o transferencia al recibir.</p></li>
            </ol>
          </div>
        </section>

        <section className="jc-contact" id="contacto">
          <div className="jc-container jc-contact-card">
            <div><span className="jc-kicker">EXTRA O SÚPER EXTRA</span><h2>Tu caja de huevos de color.</h2><p>Repartimos de lunes a sábado, de 15:00 a 21:00. Pedidos hasta las 15:00 inclusive; después, para el siguiente día de reparto disponible. Fuera de La Serena urbana, consulta cobertura y costo antes de comprar.</p></div>
            <a className="jc-button jc-button-dark" href={orderLink('Hola, quiero pedir una caja de huevos de color. ¿Qué disponibilidad tienen en Extra de 180 y Súper Extra de 100?')} target="_blank" rel="noreferrer">Abrir WhatsApp <span>→</span></a>
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

      <footer className="jc-footer"><div className="jc-container jc-footer-inner"><img src="/store-assets/justo-casero/logo.png" alt="Justo Casero" /><p>Para la casera y el casero: productos locales o de buen precio.</p><a href={orderLink('Hola, quiero comprar huevos café en caja.')} target="_blank" rel="noreferrer">Comprar por WhatsApp</a></div></footer>
    </div>
  );
}
