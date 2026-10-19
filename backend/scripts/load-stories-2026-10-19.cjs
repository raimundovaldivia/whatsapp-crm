// Carga las historias de Instagram de la semana del 19 al 25 de octubre de 2026.
// Crea cada historia como borrador vía API: el CRM ejecuta los chequeos previos y deja en
// "review" las que pasan. NO aprueba nada: la aprobación se hace en Facebook e Instagram → Historias.
//
// Uso (el token es la sesión de un usuario owner/admin, se copia desde el navegador; no lo guardes en el repo):
//   CRM_API_URL=https://whatsapp-crm-api-production-f804.up.railway.app CRM_TOKEN=... \
//     node backend/scripts/load-stories-2026-10-19.cjs
//   node backend/scripts/load-stories-2026-10-19.cjs --dry-run      (solo muestra lo que enviaría)

const RAW = 'https://raw.githubusercontent.com/raimundovaldivia/whatsapp-crm/main/assets/social/2026-10-19/png';

// Hora de publicación: 12:00 hora de Santiago (UTC-03:00 en octubre).
// Lunes 19 a las 12:00 queda a más de 5 minutos de ahora, por lo que pasa el chequeo de fecha.
const STORIES = [
  { day: 'Lunes 19',    title: 'Lunes 19 - Huevos de campo (despachos)',        file: '01-lunes-19.png',     at: '2026-10-19T12:00:00-03:00' },
  { day: 'Martes 20',   title: 'Martes 20 - ¿XL o Jumbo? (precios)',            file: '02-martes-20.png',    at: '2026-10-20T12:00:00-03:00' },
  { day: 'Miércoles 21',title: 'Miércoles 21 - Del campo a tu mesa',            file: '03-miercoles-21.png', at: '2026-10-21T12:00:00-03:00' },
  { day: 'Jueves 22',   title: 'Jueves 22 - Pide antes de las 14:00 (CONFIRMAR ANTES DE APROBAR)', file: '04-jueves-22.png', at: '2026-10-22T12:00:00-03:00' },
  { day: 'Viernes 23',  title: 'Viernes 23 - Lleva más y paga menos (40 Jumbo)', file: '05-viernes-23.png',   at: '2026-10-23T12:00:00-03:00' },
  { day: 'Sábado 24',   title: 'Sábado 24 - ¿Nos rompen los huevos?',           file: '06-sabado-24.png',    at: '2026-10-24T12:00:00-03:00' },
  { day: 'Domingo 25',  title: 'Domingo 25 - Gracias por preferir local',       file: '07-domingo-25.png',   at: '2026-10-25T12:00:00-03:00' },
];

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const base = (process.env.CRM_API_URL || '').replace(/\/$/, '');
  const token = process.env.CRM_TOKEN || '';
  if (!dryRun && (!base || !token)) {
    console.error('Faltan CRM_API_URL y CRM_TOKEN (o usa --dry-run).');
    process.exit(1);
  }

  for (const s of STORIES) {
    const body = { title: s.title, image_url: `${RAW}/${s.file}`, scheduled_for: new Date(s.at).toISOString() };
    if (dryRun) { console.log(s.day.padEnd(14), JSON.stringify(body)); continue; }

    const res = await fetch(`${base}/api/social-stories`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.log(`${s.day.padEnd(14)} ERROR ${res.status}: ${data.error || 'sin detalle'}`);
      continue;
    }
    const failed = (data.checks?.items || []).filter(i => !i.ok).map(i => `${i.name}(${i.detail})`);
    console.log(`${s.day.padEnd(14)} ${data.post.status.padEnd(7)} id=${data.post.id}${failed.length ? '  falla: ' + failed.join(', ') : ''}`);
  }
  console.log('\nListo. Revisa cada historia en Facebook e Instagram → Historias y aprueba las que estén bien.');
}

main().catch(error => { console.error(error); process.exit(1); });
