const express = require('express');

const router = express.Router();

const styles = `
  :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  body { margin: 0; background: #f7f8fa; color: #172033; line-height: 1.6; }
  main { max-width: 820px; margin: 0 auto; padding: 48px 22px 72px; }
  article { background: white; border: 1px solid #e5e8ef; border-radius: 18px; padding: 34px; box-shadow: 0 12px 34px rgba(23,32,51,.06); }
  h1 { margin: 0 0 8px; font-size: clamp(2rem, 5vw, 3rem); line-height: 1.1; }
  h2 { margin-top: 30px; font-size: 1.25rem; }
  p, li { color: #465168; }
  a { color: #0b63ce; }
  .eyebrow { color: #0b63ce; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; font-size: .78rem; }
  .updated { color: #6b7486; font-size: .92rem; margin-bottom: 30px; }
  nav { margin-top: 26px; display: flex; gap: 18px; flex-wrap: wrap; }
  @media (max-width: 560px) { main { padding: 22px 12px 44px; } article { padding: 24px 20px; } }
`;

function page(title, body) {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="index,follow">
  <title>${title} · Diez Ríos CRM</title>
  <style>${styles}</style>
</head>
<body>
  <main><article>
    <div class="eyebrow">Diez Ríos CRM</div>
    ${body}
    <nav>
      <a href="/privacy">Política de privacidad</a>
      <a href="/data-deletion">Eliminación de datos</a>
    </nav>
  </article></main>
</body>
</html>`;
}

router.use((_req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  next();
});

router.get('/privacy', (_req, res) => {
  res.type('html').send(page('Política de privacidad', `
    <h1>Política de privacidad</h1>
    <p class="updated">Última actualización: 5 de octubre de 2026</p>
    <p>Diez Ríos CRM es una herramienta privada de gestión comercial que permite a organizaciones autorizadas administrar conversaciones, contenido y actividad publicitaria de Facebook e Instagram desde un solo lugar.</p>

    <h2>Información que tratamos</h2>
    <ul>
      <li>Identificadores y datos básicos de las páginas de Facebook, cuentas profesionales de Instagram y cuentas publicitarias que un administrador decide conectar.</li>
      <li>Mensajes y eventos de conversación necesarios para mostrar y responder comunicaciones de clientes.</li>
      <li>Contenido que un usuario autorizado prepara para publicar, junto con los identificadores y resultados devueltos por Meta.</li>
      <li>Métricas de campañas y anuncios solicitadas por usuarios autorizados.</li>
      <li>Tokens de acceso y permisos concedidos por Meta. Los tokens se almacenan cifrados y no se muestran a otros usuarios.</li>
    </ul>

    <h2>Cómo usamos la información</h2>
    <p>Usamos estos datos exclusivamente para prestar las funciones solicitadas por la organización conectada: gestionar mensajería, seleccionar activos, consultar resultados publicitarios y publicar contenido. No vendemos datos personales ni los usamos para elaborar perfiles publicitarios propios.</p>

    <h2>Acceso, seguridad y conservación</h2>
    <p>El acceso al CRM requiere autenticación y está limitado por roles de la organización. Aplicamos controles técnicos para proteger credenciales y separar los datos de cada organización. Conservamos la información mientras la integración permanezca activa o durante el tiempo necesario para operar y cumplir obligaciones legales. Tras una solicitud verificada de eliminación, los datos vinculados se eliminan o anonimizan dentro de un plazo máximo de 30 días, salvo obligación legal de conservación.</p>

    <h2>Proveedores</h2>
    <p>La aplicación utiliza Meta Platforms para Facebook, Instagram y publicidad, y proveedores de infraestructura para alojar de forma segura el servicio y su base de datos. Cada proveedor trata únicamente los datos necesarios para prestar su servicio.</p>

    <h2>Opciones y derechos</h2>
    <p>Los administradores pueden desconectar Meta desde la sección de integraciones del CRM o revocar el acceso desde la configuración de Facebook. También pueden solicitar acceso, corrección o eliminación al administrador responsable de su organización.</p>

    <h2>Contacto</h2>
    <p>Para consultas sobre privacidad o para ejercer derechos, comunícate con el administrador de Diez Ríos que te proporcionó acceso al CRM, indicando tu nombre, la organización y el activo de Meta relacionado. El equipo confirmará la identidad antes de procesar solicitudes que afecten datos o accesos.</p>
  `));
});

router.get('/data-deletion', (_req, res) => {
  res.type('html').send(page('Eliminación de datos', `
    <h1>Eliminación de datos de usuario</h1>
    <p class="updated">Última actualización: 5 de octubre de 2026</p>
    <p>Puedes eliminar la conexión y solicitar la eliminación de los datos asociados a Facebook e Instagram mediante cualquiera de estas opciones:</p>
    <ol>
      <li>En Diez Ríos CRM, abre <strong>Configuración → Integraciones → Meta</strong> y selecciona <strong>Desconectar</strong>. Esto elimina las credenciales de acceso guardadas por el CRM.</li>
      <li>En Facebook, abre <strong>Configuración y privacidad → Configuración → Integraciones comerciales</strong>, busca <strong>Diez Ríos CRM</strong> y elimina la integración.</li>
      <li>Para solicitar también la eliminación o anonimización del historial importado, comunícate con el administrador de Diez Ríos que te proporcionó acceso al CRM. Incluye tu nombre, organización y página o cuenta de Instagram relacionada.</li>
    </ol>
    <p>Después de verificar la solicitud, eliminaremos o anonimizaremos los datos asociados en un plazo máximo de 30 días, excepto los registros que debamos conservar por una obligación legal. Te comunicaremos la finalización a través del mismo canal utilizado para la solicitud.</p>
  `));
});

module.exports = router;

