import { useEffect, useMemo, useState } from 'react';
import './justo-casero.css';

const API = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001';
const CRM_STORE_SLUG = 'diez-rios-mrs96z69';
const FALLBACK_WHATSAPP = '56942876413';

const productTests = [
  { id: 'despensa', icon: '🍚', label: 'Arroz y fideos', detail: 'Básicos rendidores para la despensa.' },
  { id: 'aceite', icon: '🫗', label: 'Aceite', detail: 'Un esencial que siempre hace falta.' },
  { id: 'papel', icon: '🧻', label: 'Papel higiénico', detail: 'Compra práctica para el hogar o negocio.' },
  { id: 'otra', icon: '+', label: 'Otra idea', detail: 'Cuéntanos qué producto te gustaría encontrar.' },
];

const eggBoxes = [
  {
    size: 'XL',
    title: 'Caja de huevos café XL',
    text: 'Huevos café grandes y rendidores, vendidos únicamente por caja.',
  },
  {
    size: 'Jumbo',
    title: 'Caja de huevos café Jumbo',
    text: 'Nuestra alternativa de mayor tamaño, vendida únicamente por caja.',
  },
];

function onlyDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function whatsappHref(phone, message) {
  return `https://wa.me/${onlyDigits(phone)}?text=${encodeURIComponent(message)}`;
}

export default function JustoCaseroLanding() {
  const [whatsapp, setWhatsapp] = useState(FALLBACK_WHATSAPP);
  const [selection, setSelection] = useState('');
  const [otherIdea, setOtherIdea] = useState('');

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

    const previousTitle = document.title;
    const description = document.querySelector('meta[name="description"]');
    const previousDescription = description?.getAttribute('content') || '';
    document.title = 'Justo Casero | Huevos café XL y Jumbo por caja';
    description?.setAttribute('content', 'Cajas de huevos café XL y Jumbo con atención directa en La Serena y Coquimbo.');

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
            <a href="#proximo-producto">Tu voto</a>
          </nav>
          <a className="jc-button jc-button-small" href={orderLink('Hola, quiero consultar por las cajas de huevos café XL y Jumbo de Justo Casero.')} target="_blank" rel="noreferrer">
            Pedir por WhatsApp
          </a>
        </div>
      </header>

      <main>
        <section className="jc-hero">
          <div className="jc-container jc-hero-grid">
            <div className="jc-hero-copy">
              <div className="jc-eyebrow"><span /> Huevos café por caja</div>
              <h1>XL y Jumbo <em>al precio justo.</em></h1>
              <p className="jc-hero-lead">Una oferta simple: vendemos solamente huevos café, en cajas XL y Jumbo.</p>
              <div className="jc-hero-actions">
                <a className="jc-button jc-button-primary" href={orderLink('Hola, quiero conocer el precio y disponibilidad de las cajas de huevos café XL y Jumbo.')} target="_blank" rel="noreferrer">
                  Consultar precio por caja <span aria-hidden="true">→</span>
                </a>
                <a className="jc-button jc-button-ghost" href="#productos">Ver tamaños</a>
              </div>
              <p className="jc-coverage"><span className="jc-icon" aria-hidden="true">⌖</span> Atención en La Serena y Coquimbo</p>
            </div>
            <div className="jc-hero-visual" aria-label="Cajas de huevos café XL y Jumbo">
              <div className="jc-price-note">Huevos café<br /><strong>XL + Jumbo</strong></div>
              <img src="/store-assets/justo-casero/hero-huevos.png" alt="Dos cajas de huevos café en tamaños XL y Jumbo" />
              <div className="jc-hero-stamp">Venta<br />por caja</div>
            </div>
          </div>
        </section>

        <section className="jc-benefits" aria-label="Características de la oferta">
          <div className="jc-container jc-benefit-grid">
            <article><span className="jc-icon" aria-hidden="true">●</span><div><h2>Solo huevos café</h2><p>Una oferta precisa, sin variedades que puedan confundir.</p></div></article>
            <article><span className="jc-icon" aria-hidden="true">▦</span><div><h2>Venta por caja</h2><p>Formato pensado para hogares, emprendedores y negocios.</p></div></article>
            <article><span className="jc-icon" aria-hidden="true">→</span><div><h2>Pedido directo</h2><p>La conversación y el pedido quedan gestionados en ReSell.</p></div></article>
          </div>
        </section>

        <section className="jc-section" id="productos">
          <div className="jc-container">
            <div className="jc-section-heading">
              <div><span className="jc-kicker">Nuestra oferta inicial</span><h2>Un color.<br />Dos tamaños.</h2></div>
              <p>Por ahora Justo Casero vende únicamente cajas de huevos café. Elige XL o Jumbo y consulta disponibilidad.</p>
            </div>
            <div className="jc-egg-grid">
              {eggBoxes.map((product, index) => (
                <article className={`jc-egg-card jc-egg-card-${index + 1}`} key={product.size}>
                  <span className="jc-card-number">0{index + 1}</span>
                  <span className="jc-size-label" aria-hidden="true">{product.size}</span>
                  <h3>{product.title}</h3>
                  <p>{product.text}</p>
                  <a href={orderLink(`Hola, quiero consultar precio y disponibilidad de la ${product.title}.`)} target="_blank" rel="noreferrer">Consultar por {product.size} <span>→</span></a>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="jc-how" id="como-comprar">
          <div className="jc-container">
            <div className="jc-centered-heading"><span className="jc-kicker">Comprar será así de fácil</span><h2>Tres pasos y listo.</h2></div>
            <ol className="jc-steps">
              <li><span>1</span><h3>Consulta</h3><p>Pide el precio vigente de las cajas de huevos café.</p></li>
              <li><span>2</span><h3>Elige</h3><p>Indica si necesitas XL o Jumbo y cuántas cajas.</p></li>
              <li><span>3</span><h3>Coordina</h3><p>ReSell recibe la conversación y gestiona tu pedido por WhatsApp.</p></li>
            </ol>
          </div>
        </section>

        <section className="jc-contact" id="contacto">
          <div className="jc-container jc-contact-card">
            <div><span className="jc-kicker">XL O JUMBO</span><h2>Tu caja de huevos café.</h2><p>Escríbenos para consultar el precio y la disponibilidad vigente.</p></div>
            <a className="jc-button jc-button-dark" href={orderLink('Hola, quiero pedir una caja de huevos café. ¿Qué disponibilidad tienen en XL y Jumbo?')} target="_blank" rel="noreferrer">Abrir WhatsApp <span>→</span></a>
          </div>
        </section>

        <section className="jc-radar" id="proximo-producto">
          <div className="jc-container jc-radar-card">
            <div className="jc-radar-heading">
              <span className="jc-kicker">Radar Casero · Test postcompra</span>
              <h2>¿Qué debería llegar después?</h2>
              <p>Si ya compraste tus huevos, ayúdanos a escoger el próximo producto. Son ideas en evaluación: todavía no están a la venta.</p>
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

      <footer className="jc-footer"><div className="jc-container jc-footer-inner"><img src="/store-assets/justo-casero/logo.png" alt="Justo Casero" /><p>Huevos café por caja, al precio justo.</p><a href={orderLink('Hola, quiero comprar huevos café en caja.')} target="_blank" rel="noreferrer">Comprar por WhatsApp</a></div></footer>
    </div>
  );
}
