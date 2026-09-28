/**
 * agent-commands.js — Agente IA para consultas CRM vía WhatsApp
 *
 * Los agentes registrados envían mensajes con prefijo # al número del negocio.
 * Este servicio usa Claude Haiku para interpretar lenguaje natural:
 *   - Preguntas de datos → dirige al panel con acceso por organización
 *   - Acciones de gestión → PAUSAR/ACTIVAR/MSG/PAGAR/etc.
 *   - Preguntas generales → responde directamente con IA
 *
 * Ejemplo: "#cuántos pedidos tenemos pendientes?"
 *          "#pausar 56987654321"
 *          "#quién compró más este mes?"
 */

const db           = require('../db/database');
const kapsoService = require('./kapso-whatsapp');
const Anthropic    = require('@anthropic-ai/sdk');
const { activateDivaForAutomatedMessage } = require('./conversation-mode');
const {
  buildBodyTemplateComponent,
  getTemplateVariables,
  renderTemplate,
} = require('../utils/template-renderer.mjs');

const aiClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const ASSISTANT_NAME = 'Diva';

const campaignSessions = new Map();
const CAMPAIGN_SESSION_MS = 45 * 60 * 1000;
const adminDialogueSessions = new Map();
const ADMIN_DIALOGUE_SESSION_MS = 45 * 60 * 1000;
const ADMIN_DIALOGUE_MAX_MESSAGES = 8;

function sessionKey(orgId, agent) {
  const phone = typeof db.normalizePhone === 'function'
    ? db.normalizePhone(agent.whatsapp_phone || '')
    : String(agent.whatsapp_phone || '').replace(/\D/g, '');
  return `${orgId}:${agent.id || phone}`;
}

function getCampaignSession(orgId, agent) {
  const key = sessionKey(orgId, agent);
  const session = campaignSessions.get(key);
  if (!session) return null;
  if (Date.now() - session.updatedAt > CAMPAIGN_SESSION_MS) {
    campaignSessions.delete(key);
    return null;
  }
  return session;
}

function saveCampaignSession(orgId, agent, patch) {
  const key = sessionKey(orgId, agent);
  const next = { ...(campaignSessions.get(key) || {}), ...patch, updatedAt: Date.now() };
  campaignSessions.set(key, next);
  return next;
}

function clearCampaignSession(orgId, agent) {
  campaignSessions.delete(sessionKey(orgId, agent));
}

function hasActiveCampaign(orgId, agent) {
  return !!getCampaignSession(orgId, agent);
}

function getAdminDialogue(orgId, agent) {
  const key = sessionKey(orgId, agent);
  const session = adminDialogueSessions.get(key);
  if (!session || Date.now() - session.updatedAt > ADMIN_DIALOGUE_SESSION_MS) {
    adminDialogueSessions.delete(key);
    return [];
  }
  return session.messages || [];
}

function rememberAdminDialogue(orgId, agent, userText, assistantPayload) {
  const key = sessionKey(orgId, agent);
  const messages = [
    ...getAdminDialogue(orgId, agent),
    { role: 'user', content: userText },
    { role: 'assistant', content: JSON.stringify(assistantPayload) },
  ].slice(-ADMIN_DIALOGUE_MAX_MESSAGES);
  adminDialogueSessions.set(key, { messages, updatedAt: Date.now() });
}

function buildSystemPrompt() {
  return `Tu nombre es ${ASSISTANT_NAME}. Eres la asistente de gestión de la tienda y conversas con su administrador como una colega competente.

FORMA DE CONVERSAR:
- Recuerda los turnos anteriores: entiende referencias como "ese cliente", "el anterior", "hazlo" o "¿y los pendientes?" usando el contexto disponible.
- Responde primero lo esencial y luego propone un único siguiente paso útil si corresponde.
- Usa español natural, cercano y profesional. Evita saludos repetidos, frases de relleno, tono robótico y explicaciones largas.
- Si falta un dato indispensable, haz UNA pregunta concreta. No vuelvas a mostrar toda la ayuda.
- Distingue entre explicar, preparar y ejecutar. Nunca digas que una acción se realizó si no fue ejecutada por un comando permitido.
- Conserva exactamente teléfonos, IDs, montos, fechas y nombres aportados; no los completes ni corrijas por intuición.

Devuelve únicamente JSON. Para acciones explícitas usa {"action":"manage","command":"PAUSAR|ACTIVAR|MSG|PAGAR|CHATS|PEDIDOS|ESTADO|TEMPLATES|CAMPANA","params":{"phone":"...","text":"...","orderId":123}}. TEMPLATES consulta templates reales aprobados. CAMPANA inicia una campaña guiada que siempre exige vista previa y confirmación. Para ayuda usa {"action":"help"}. Para preguntas generales o aclaraciones usa {"action":"answer","text":"..."}. No tienes acceso a SQL ni consultas libres. Deriva preguntas analíticas al panel de Estadísticas. Si no puedes ejecutar algo, explícalo con amabilidad e indica una alternativa concreta. Nunca inventes templates, datos ni capacidades.`;
}

// ─── Texto de ayuda ───────────────────────────────────────────────────────────
const HELP_TEXT = `✨ *Soy Diva, tu asistente de administración*

Estoy aquí para ayudarte a resolver dudas y realizar tareas de gestión desde WhatsApp.
Cuando un cliente necesite apoyo, también puedo coordinar contigo una respuesta sin confundirlo con el modo humano.

Puedes solicitar acciones de gestión en lenguaje natural:

📊 Para análisis de ventas y clientes, usa Estadísticas en el CRM.

📣 *Promociones:*
• _templates disponibles_ — consulta los aprobados en WhatsApp
• _crear campaña_ — elige template, público y revisa una vista previa
• Ninguna campaña se ejecuta sin que escribas *CONFIRMAR ENVÍO*

⚙️ *Gestión:*
• _pausar 56987654321_ — pausa el bot
• _activar 56987654321_ — reactiva el bot
• _msg 56987654321 Hola!_ — envía un mensaje individual
• _pagar 42_ — marca un pedido como pagado
• _chats_ — conversaciones activas
• _pedidos_ — pedidos pendientes`;

// ─── Función principal ────────────────────────────────────────────────────────
async function handleAgentCommand(org, wc, agent, text) {
  if (!['owner','admin','supervisor'].includes(agent.role)) return;
  const raw = (text || '').trim();
  try {
    const reply = await processAICommand(org, wc, agent, raw);
    if (reply) {
      await kapsoService.sendTextMessage(agent.whatsapp_phone, reply, wc).catch(err =>
        console.warn('[AgentCmd] No se pudo enviar respuesta al agente:', err.message)
      );
    }
  } catch (err) {
    console.error('[AgentCmd] Error procesando comando:', err.message);
    await kapsoService.sendTextMessage(
      agent.whatsapp_phone,
      `Lo siento, no pude completar tu solicitud por este error: ${err.message.slice(0, 100)}. Puedes intentarlo nuevamente y con gusto te ayudaré.`,
      wc
    ).catch(() => {});
  }
}

async function processAICommand(org, wc, agent, raw) {
  console.log(`[AgentCmd] 🤖 ${agent.name || agent.email}: "${raw.slice(0, 100)}"`);

  const normalized = raw.toLocaleLowerCase('es').trim();
  const activeCampaign = getCampaignSession(org.id, agent);

  // Una campaña es una conversación guiada y determinística. No se deja al
  // modelo decidir si envía: el último paso exige la frase CONFIRMAR ENVÍO.
  if (activeCampaign) {
    return handleCampaignStep(org, wc, agent, raw, activeCampaign);
  }
  if (/\b(cancelar|cancela|salir)\b/.test(normalized)) {
    clearCampaignSession(org.id, agent);
    return 'No hay una campaña en preparación.';
  }
  if (/\b(qui[eé]n eres|c[oó]mo te llamas|cu[aá]l es tu nombre|tu nombre)\b/.test(normalized)) {
    return `Soy *${ASSISTANT_NAME}*, tu asistente de administración. Estoy aquí para ayudarte a resolver dudas y gestionar tareas de la tienda. Puedes preguntarme qué puedo hacer o contarme qué necesitas.`;
  }
  if (/\b(template|plantilla)s?\b/.test(normalized) && /\b(cu[aá]l|qu[eé]|ver|lista|disponible|tienes|tiene)\b/.test(normalized)) {
    return startCampaign(org, wc, agent, { listOnly: true });
  }
  if (/\b(campa[nñ]a|promoci[oó]n|masiv[oa]|varios clientes|m[uú]ltiples mensajes)\b/.test(normalized)) {
    return startCampaign(org, wc, agent);
  }
  if (/puedes?.*enviar.*(m[aá]s|varios|m[uú]ltiples)/.test(normalized)) {
    return `Sí, puedo ayudarte a preparar una campaña usando los templates aprobados de WhatsApp. Primero consulto los templates reales, luego eliges el público y te muestro una vista previa. Solo se ejecuta si escribes *CONFIRMAR ENVÍO*.\n\nEscribe _templates disponibles_ y ${ASSISTANT_NAME} te guiará paso a paso.`;
  }

  // ── Parsear intención con Claude Haiku ──
  let parsed;
  try {
    const dialogueHistory = getAdminDialogue(org.id, agent);
    const aiRes = await aiClient.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      system: buildSystemPrompt(org.id),
      messages: [...dialogueHistory, { role: 'user', content: raw }],
    });
    const jsonText = aiRes.content[0]?.text?.trim() || '{}';
    parsed = JSON.parse(jsonText);
    rememberAdminDialogue(org.id, agent, raw, parsed);
  } catch (err) {
    console.error('[AgentCmd] Error llamando IA:', err.message);
    // Fallback: tratar como ayuda
    return HELP_TEXT;
  }

  const action = parsed.action;

  // ── Ayuda ──
  if (action === 'help') {
    return HELP_TEXT;
  }

  // ── Respuesta directa ──
  if (action === 'answer') {
    return parsed.text || '🤔 No entendí tu consulta.';
  }

  // ── Consulta SQL ──
  if (action === 'sql') {
    // Model-generated SQL cannot enforce tenant isolation. Use the scoped panels.
    return 'Consulta los indicadores desde Estadísticas en el CRM. Las consultas libres por WhatsApp no están disponibles.';
  }

  // ── Acciones de gestión ──
  if (action === 'manage') {
    return await executeManageCommand(org, wc, agent, parsed.command, parsed.params || {});
  }

  return `No alcancé a entender tu consulta. Cuéntame de otra forma qué necesitas o escribe _ayuda_ y con gusto te mostraré lo que puedo hacer.`;
}

// ─── Ejecutar comandos de gestión ─────────────────────────────────────────────
async function executeManageCommand(org, wc, agent, command, params) {
  const key = String(command || '').toUpperCase();
  if (key === 'PAGAR') await require('./commercial').assertModule(org.id,'payments');
  if (key === 'PEDIDOS') await require('./commercial').assertModule(org.id,'orders');
  switch ((command || '').toUpperCase()) {
    case 'PAUSAR':
    case 'PAUSA':
      if (!params.phone) return '❌ Indica el teléfono. Ej: _#pausar 56987654321_';
      return await cmdPausar(org, params.phone, agent);

    case 'ACTIVAR':
    case 'REACTIVAR':
      if (!params.phone) return '❌ Indica el teléfono. Ej: _#activar 56987654321_';
      return await cmdActivar(org, params.phone);

    case 'MSG':
    case 'RESPONDER':
      if (!params.phone || !params.text) return '❌ Indica teléfono y mensaje. Ej: _#msg 56987654321 Hola!_';
      return await cmdMsg(org, params.phone, params.text, agent, wc);

    case 'PAGAR':
      if (!params.orderId) return '❌ Indica el ID del pedido. Ej: _#pagar 42_';
      return await cmdPagar(org, parseInt(params.orderId));

    case 'CHATS':
    case 'CONVERSACIONES':
      return await cmdChats(org);

    case 'PEDIDOS':
      return await cmdPedidos(org);

    case 'ESTADO':
      return cmdEstado(agent);

    case 'TEMPLATES':
    case 'PLANTILLAS':
      return await startCampaign(org, wc, agent, { listOnly: true });

    case 'CAMPANA':
    case 'CAMPAÑA':
    case 'PROMOCION':
    case 'PROMOCIÓN':
      return await startCampaign(org, wc, agent);

    default:
      return `❓ Acción no reconocida: ${command}\n\nEscribe _#ayuda_ para ver las opciones.`;
  }
}

// ─── Campañas guiadas desde el WhatsApp del administrador ───────────────────

function getTemplateBody(template) {
  const component = (template.components || []).find(c => String(c.type || '').toUpperCase() === 'BODY');
  return component?.text || '';
}

function getBodyVariableNumbers(body) {
  return getTemplateVariables(body).map(Number);
}

function hasUnsupportedTemplateVariables(template) {
  return (template.components || []).some(component =>
    String(component.type || '').toUpperCase() !== 'BODY' && /\{\{\d+\}\}/.test(component.text || '')
  );
}

function renderTemplateBody(body, values, recipient) {
  const variables = Object.fromEntries(getBodyVariableNumbers(body).map((number, index) => {
    const configured = values?.[index] ?? '';
    const value = /^\{?nombre\}?$/i.test(configured.trim())
      ? (recipient?.name || 'Cliente').trim().split(/\s+/)[0]
      : configured;
    return [String(number), value];
  }));
  return renderTemplate(body, variables);
}

function formatTemplateList(templates) {
  return templates.slice(0, 12).map((template, index) => {
    const body = getTemplateBody(template).replace(/\s+/g, ' ').trim();
    return `${index + 1}. *${template.name}* (${template.language || 'es'})\n_${body.slice(0, 150)}${body.length > 150 ? '…' : ''}_`;
  }).join('\n\n');
}

async function startCampaign(org, wc, agent, { listOnly = false } = {}) {
  await require('./commercial').assertModule(org.id, 'marketing');
  const templates = (await kapsoService.getTemplates(wc)).filter(template =>
    String(template.status || 'APPROVED').toUpperCase() === 'APPROVED'
  );
  if (!templates.length) {
    clearCampaignSession(org.id, agent);
    return 'No encontré templates aprobados en tu cuenta de WhatsApp. Puedes crearlos y revisar su estado desde *Configuración → Templates* en el CRM. Cuando estén aprobados, vuelve a escribirme y con gusto te ayudaré a preparar la campaña.';
  }

  saveCampaignSession(org.id, agent, { stage: 'template', templates });
  return [
    `✨ *Diva encontró ${templates.length} template${templates.length === 1 ? '' : 's'} aprobado${templates.length === 1 ? '' : 's'}*`,
    '',
    formatTemplateList(templates),
    templates.length > 12 ? `\n_Mostrando 12 de ${templates.length}._` : '',
    '',
    listOnly
      ? 'Para preparar una promoción, responde con el *número o nombre exacto* del template.'
      : 'Responde con el *número o nombre exacto* del template que quieres usar.',
    '_Escribe cancelar para salir._',
  ].filter(Boolean).join('\n');
}

function selectTemplate(templates, raw) {
  const trimmed = raw.trim();
  const ordinal = Number((trimmed.match(/^(?:usar\s+)?(?:template|plantilla)?\s*(\d{1,2})\s*$/i) || [])[1]);
  if (ordinal >= 1 && ordinal <= templates.length) return templates[ordinal - 1];
  const normalized = trimmed.toLocaleLowerCase('es');
  return templates.find(template =>
    normalized === String(template.name).toLocaleLowerCase('es') ||
    normalized.includes(String(template.name).toLocaleLowerCase('es'))
  ) || null;
}

async function getCampaignAudience(orgId, raw) {
  const normalized = raw.toLocaleLowerCase('es').trim();
  const digits = raw.replace(/\D/g, '');
  const pool = db.getPool();

  if (digits.length >= 8 && !/todos|clientes|leads|contactos/.test(normalized)) {
    const phone = db.normalizePhone(digits);
    const { rows } = await pool.query(
      `SELECT phone, COALESCE(NULLIF(name, ''), 'Cliente') AS name
         FROM contacts WHERE organization_id = $1 AND phone IN ($2, $3) LIMIT 1`,
      [orgId, phone, '+' + phone]
    );
    return { label: phone, recipients: rows.length ? rows : [{ phone, name: 'Cliente' }] };
  }

  let contactType = null;
  let label = '';
  if (/\bleads?\b/.test(normalized)) { contactType = 'lead'; label = 'Leads de WhatsApp'; }
  else if (/todos.*contactos|contactos.*todos/.test(normalized)) { label = 'Todos los contactos'; }
  else if (/todos|clientes|compradores/.test(normalized)) { contactType = 'customer'; label = 'Todos los clientes'; }
  else return null;

  const params = [orgId];
  let typeCondition = '';
  if (contactType) {
    params.push(contactType);
    typeCondition = `AND c.contact_type = $${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT c.phone, COALESCE(NULLIF(c.name, ''), 'Cliente') AS name
       FROM contacts c
      WHERE c.organization_id = $1
        ${typeCondition}
        AND COALESCE(c.opt_out, FALSE) = FALSE
        AND c.phone IS NOT NULL AND c.phone <> ''
        AND (c.last_template_sent_at IS NULL OR c.last_template_sent_at < DATE_TRUNC('day', NOW()))
        AND NOT EXISTS (
          SELECT 1 FROM conversations cv
           WHERE cv.organization_id = c.organization_id
             AND regexp_replace(cv.phone_number, '[^0-9]', '', 'g') = regexp_replace(c.phone, '[^0-9]', '', 'g')
             AND cv.pipeline_state = 'opted_out'
        )
      ORDER BY c.last_order_at DESC NULLS LAST, c.updated_at DESC
      LIMIT 500`,
    params
  );
  return { label, recipients: rows };
}

function campaignPreview(session) {
  const sample = session.recipients[0] || { name: 'Cliente' };
  const body = renderTemplateBody(getTemplateBody(session.template), session.variableValues, sample);
  return [
    '📋 *Vista previa de campaña*',
    `Template: *${session.template.name}*`,
    `Público: *${session.audienceLabel}*`,
    `Destinatarios aptos: *${session.recipients.length}*`,
    '',
    `_${body.slice(0, 600)}${body.length > 600 ? '…' : ''}_`,
    '',
    'Todavía no se envió nada.',
    'Para ejecutarla escribe exactamente: *CONFIRMAR ENVÍO*',
    '_También puedes escribir cancelar._',
  ].join('\n');
}

async function handleCampaignStep(org, wc, agent, raw, session) {
  const normalized = raw.toLocaleLowerCase('es').trim();
  if (/^(cancelar|cancela|salir|no)$/.test(normalized)) {
    clearCampaignSession(org.id, agent);
    return '✅ Campaña cancelada. No se envió ningún mensaje.';
  }

  if (session.stage === 'template') {
    if (/\b(template|plantilla)s?\b/.test(normalized) && /\b(ver|lista|disponible|tienes|tiene)\b/.test(normalized)) {
      return `📣 *Templates aprobados*\n\n${formatTemplateList(session.templates)}\n\nResponde con el *número o nombre exacto* del que quieres usar.`;
    }
    const template = selectTemplate(session.templates, raw);
    if (!template) return 'No reconocí ese template. Responde con el número o el nombre exacto de la lista, o escribe *cancelar*.';
    if (hasUnsupportedTemplateVariables(template)) {
      return `El template *${template.name}* tiene variables fuera del texto principal. Por seguridad, prepáralo desde *Mensajería* en el CRM. Elige otro template o escribe cancelar.`;
    }
    const variables = getBodyVariableNumbers(getTemplateBody(template));
    if (variables.length) {
      saveCampaignSession(org.id, agent, { stage: 'variables', template, variables });
      return [
        `Elegiste *${template.name}*. Tiene ${variables.length} variable${variables.length === 1 ? '' : 's'}: ${variables.map(number => `{{${number}}}`).join(', ')}.`,
        '',
        `Responde con ${variables.length} valor${variables.length === 1 ? '' : 'es'} separado${variables.length === 1 ? '' : 's'} por *|*.`,
        'Usa *{nombre}* si quieres personalizar con el nombre de cada cliente.',
        `Ejemplo: _valores: ${variables.map((_, index) => index === 0 ? '{nombre}' : `valor ${index + 1}`).join(' | ')}_`,
      ].join('\n');
    }
    saveCampaignSession(org.id, agent, { stage: 'audience', template, variableValues: [] });
    return `Elegiste *${template.name}*.\n\n¿A quién quieres enviarlo? Responde *todos los clientes*, *leads*, *todos los contactos* o un número de teléfono.`;
  }

  if (session.stage === 'variables') {
    const valueText = raw.replace(/^valores?\s*:\s*/i, '').trim();
    const values = valueText.split('|').map(value => value.trim()).filter(Boolean);
    if (values.length !== session.variables.length) {
      return `Necesito exactamente ${session.variables.length} valor${session.variables.length === 1 ? '' : 'es'}, separado${session.variables.length === 1 ? '' : 's'} por *|*. Puedes usar *{nombre}* para personalizar.`;
    }
    saveCampaignSession(org.id, agent, { stage: 'audience', variableValues: values });
    return '¿A quién quieres enviarlo? Responde *todos los clientes*, *leads*, *todos los contactos* o un número de teléfono.';
  }

  if (session.stage === 'audience') {
    const audience = await getCampaignAudience(org.id, raw);
    if (!audience) return 'No reconocí el público. Responde *todos los clientes*, *leads*, *todos los contactos* o un número de teléfono.';
    if (!audience.recipients.length) return `No hay destinatarios aptos en *${audience.label}*. Se excluyen quienes no aceptan mensajes y quienes ya recibieron un template hoy.`;
    const ready = saveCampaignSession(org.id, agent, {
      stage: 'confirm', audienceLabel: audience.label, recipients: audience.recipients,
    });
    return campaignPreview(ready);
  }

  if (session.stage === 'confirm') {
    if (!/^confirmar\s+env[ií]o[.!]?$/i.test(raw.trim())) {
      return 'La campaña sigue pendiente y no se envió nada. Para ejecutarla escribe exactamente *CONFIRMAR ENVÍO* o escribe *cancelar*.';
    }
    await kapsoService.sendTextMessage(
      agent.whatsapp_phone,
      `⏳ Iniciando campaña para ${session.recipients.length} destinatario${session.recipients.length === 1 ? '' : 's'}. Te avisaré cuando termine.`,
      wc
    ).catch(() => {});
    const result = await executeCampaign(org, wc, session);
    clearCampaignSession(org.id, agent);
    return result;
  }

  clearCampaignSession(org.id, agent);
  return 'La preparación anterior venció. Escribe *crear campaña* para comenzar de nuevo.';
}

async function executeCampaign(org, wc, session) {
  await require('./commercial').assertModule(org.id, 'marketing');
  const body = getTemplateBody(session.template);
  const variables = getBodyVariableNumbers(body);
  let accepted = 0;
  let failed = 0;
  const errors = new Map();

  for (let index = 0; index < session.recipients.length; index++) {
    const recipient = session.recipients[index];
    const values = Object.fromEntries(variables.map((number, valueIndex) => {
      const configured = session.variableValues?.[valueIndex] || '';
      const value = /^\{?nombre\}?$/i.test(configured.trim())
        ? (recipient.name || 'Cliente').trim().split(/\s+/)[0]
        : configured;
      return [String(number), String(value || 'Cliente').slice(0, 900)];
    }));
    const components = buildBodyTemplateComponent(body, values);

    try {
      const sent = await kapsoService.sendTemplate(
        db.normalizePhone(recipient.phone),
        session.template.name,
        session.template.language || 'es',
        components,
        wc
      );
      const preview = renderTemplateBody(body, session.variableValues, recipient);
      const conv = await db.upsertConversation(org.id, recipient.phone, recipient.name || 'Cliente');
      await db.saveMessage({
        conversationId: conv.id,
        whatsappMessageId: sent?.messages?.[0]?.id || null,
        direction: 'outbound',
        content: `[Template: ${session.template.name}]\n\n${preview}`,
        type: 'template',
        sentBy: 'human',
        agentType: 'admin_campaign',
        status: 'pending',
      });
      await db.updateConversationLastMessage(conv.id, `[Template: ${session.template.name}]`);
      await activateDivaForAutomatedMessage(conv.id, db);
      await db.updatePipelineState(conv.id, 'template_sent').catch(() => {});
      await db.getPool().query(
        'UPDATE contacts SET last_template_sent_at = NOW() WHERE organization_id = $1 AND phone = $2',
        [org.id, recipient.phone]
      );
      accepted++;
    } catch (error) {
      failed++;
      const detail = error.response?.data?.error?.message || error.response?.data?.message || error.message || 'Error desconocido';
      errors.set(detail, (errors.get(detail) || 0) + 1);
    }

    if (index < session.recipients.length - 1) await new Promise(resolve => setTimeout(resolve, 250));
  }

  const errorLines = [...errors.entries()].slice(0, 3).map(([message, amount]) => `• ${amount} × ${message.slice(0, 120)}`);
  return [
    '📣 *Campaña procesada*',
    `✅ Aceptados por WhatsApp: *${accepted}*`,
    `❌ Fallos inmediatos: *${failed}*`,
    '',
    accepted ? 'Los aceptados quedan pendientes de confirmación de entrega. Su estado real se actualizará con los comprobantes de WhatsApp.' : '',
    errorLines.length ? `\n*Errores:*\n${errorLines.join('\n')}` : '',
  ].filter(Boolean).join('\n');
}

// ─── Implementaciones de acciones ─────────────────────────────────────────────

async function cmdChats(org) {
  const convs = await db.getAllConversations(org.id);
  if (!convs.length) return '📭 No hay conversaciones activas.';

  const sorted = [...convs].sort((a, b) => {
    const unreadDiff = (b.unread_count || 0) - (a.unread_count || 0);
    if (unreadDiff !== 0) return unreadDiff;
    return new Date(b.last_message_at || 0) - new Date(a.last_message_at || 0);
  });

  const lines = sorted.slice(0, 10).map(c => {
    const name   = c.contact_name && c.contact_name !== c.phone_number ? c.contact_name : c.phone_number;
    const unread = c.unread_count > 0 ? ` 🔴 ${c.unread_count}` : '';
    const mode   = c.agent_mode === 'human' ? ' 🟡' : c.agent_mode === 'coordinating' ? ' 🟣' : '';
    const last   = c.last_message ? ` — _${c.last_message.slice(0, 50)}_` : '';
    return `• *${name}* (${c.phone_number})${unread}${mode}${last}`;
  });

  const total = convs.length;
  return `💬 *Conversaciones* (${Math.min(10, total)} de ${total})\n🔴 = sin leer  🟣 = Diva coordinando  🟡 = modo humano\n\n` + lines.join('\n');
}

async function cmdPedidos(org) {
  const orders = await db.getOrdersByOrg(org.id);
  const DONE = ['paid', 'entregado', 'cancelled'];
  const pending = orders.filter(o => !DONE.includes(o.status));
  if (!pending.length) return '✅ No hay pedidos pendientes.';

  const STATUS_LABEL = {
    draft: 'borrador', sent: 'confirmado', nuevo: 'nuevo',
    payment_received: '💰 pago recibido', por_despachar: '📦 por despachar',
    en_camino: '🚚 en camino', entregado: '✅ entregado', paid: '✅ pagado',
  };

  const lines = pending.slice(0, 10).map(o => {
    const date  = new Date(o.created_at).toLocaleDateString('es-CL', { day: '2-digit', month: 'short' });
    const total = o.total_price ? `$${Number(o.total_price).toLocaleString('es-CL')}` : '?';
    const name  = o.customer_name || o.customer_phone || '?';
    const st    = STATUS_LABEL[o.status] || o.status;
    return `• *#${o.id}* ${name} — ${total} — _${st}_  (${date})`;
  });

  return `📦 *Pedidos pendientes* (${pending.length})\n\n` + lines.join('\n') + '\n\n_Escribe #pagar <id> para confirmar pago_';
}

async function cmdPagar(org, orderId) {
  const pool = db.getPool();
  const { rows } = await pool.query(
    'SELECT * FROM orders WHERE id = $1 AND organization_id = $2',
    [orderId, org.id]
  );
  if (!rows.length) return `❌ Pedido #${orderId} no encontrado.`;
  const order = rows[0];
  if (order.status === 'completed') return `ℹ️ El pedido #${orderId} ya está completado.`;

  await db.updateOrder(orderId, { status: 'completed' });
  const name = order.customer_name || order.customer_phone || 'cliente';
  return `✅ *Pedido #${orderId}* marcado como pagado.\n👤 ${name}`;
}

async function cmdVer(org, phone) {
  const normalized = db.normalizePhone(phone);
  const pool = db.getPool();

  const { rows: convRows } = await pool.query(
    `SELECT id, contact_name, phone_number, agent_mode, unread_count
     FROM conversations
     WHERE organization_id = $1
       AND phone_number IN ($2, $3, $4)
     LIMIT 1`,
    [org.id, phone, normalized, '+' + normalized]
  );

  if (!convRows.length) return `❌ No encontré conversación con ${phone}.`;
  const conv = convRows[0];

  const messages = await db.getLastMessages(conv.id, 6);
  if (!messages.length) return `📭 No hay mensajes con ${conv.contact_name || phone}.`;

  const name = conv.contact_name && conv.contact_name !== phone ? conv.contact_name : phone;
  const mode = conv.agent_mode === 'human' ? '🟡 Modo humano' : conv.agent_mode === 'coordinating' ? '🟣 Diva coordinando' : '✨ Diva activa';
  const lines = messages.map(m => {
    const dir  = m.direction === 'inbound' ? '←' : '→';
    const who  = m.direction === 'inbound' ? name : 'Bot';
    const text = (m.content || '').slice(0, 100);
    return `${dir} *${who}:* ${text}`;
  });

  return [
    `👤 *${name}* (${conv.phone_number}) | ${mode}`,
    '',
    ...lines,
    '',
    `_Usa #msg ${conv.phone_number} <texto> para responder_`,
  ].join('\n');
}

async function cmdMsg(org, phone, msgText, agent, wc) {
  const normalized = db.normalizePhone(phone);
  const pool = db.getPool();

  const { rows: convRows } = await pool.query(
    `SELECT id, contact_name, phone_number
     FROM conversations
     WHERE organization_id = $1
       AND phone_number IN ($2, $3, $4)
     LIMIT 1`,
    [org.id, phone, normalized, '+' + normalized]
  );

  const targetPhone = convRows.length ? convRows[0].phone_number : normalized;
  const conv = convRows.length
    ? convRows[0]
    : await db.upsertConversation(org.id, targetPhone, null);

  const sent = await kapsoService.sendTextMessage(targetPhone, msgText, wc).catch(err => {
    console.error('[AgentCmd] Error enviando msg al cliente:', err.message);
    return null;
  });

  if (!sent) return `❌ No se pudo enviar el mensaje a ${targetPhone}.`;

  await db.saveMessage({
    conversationId:    conv.id,
    whatsappMessageId: sent?.messages?.[0]?.id,
    direction:         'outbound',
    content:           msgText,
    sentBy:            'human',
    agentType:         agent.name || agent.email,
  });
  await db.updateConversationLastMessage(conv.id, msgText, false);
  await db.setAgentMode(conv.id, 'human');

  const name = conv.contact_name && conv.contact_name !== targetPhone ? conv.contact_name : targetPhone;
  return `✅ Mensaje enviado a *${name}*:\n_"${msgText.slice(0, 80)}"_`;
}

async function cmdPausar(org, phone, agent) {
  const normalized = db.normalizePhone(phone);
  const pool = db.getPool();

  const { rows } = await pool.query(
    `SELECT id, contact_name, phone_number, agent_mode FROM conversations
     WHERE organization_id = $1 AND phone_number IN ($2, $3, $4) LIMIT 1`,
    [org.id, phone, normalized, '+' + normalized]
  );

  if (!rows.length) return `❌ No encontré conversación con ${phone}.`;
  const conv = rows[0];

  if (conv.agent_mode === 'human') {
    return `ℹ️ El bot ya estaba pausado para *${conv.contact_name || phone}*.\nUsa _#activar ${phone}_ para reactivarlo.`;
  }

  await db.setAgentMode(conv.id, 'human');
  const name = conv.contact_name && conv.contact_name !== phone ? conv.contact_name : phone;
  return `🟡 Bot pausado para *${name}*.\nAhora puedes atenderle directamente. Escribe _#msg ${conv.phone_number} <texto>_ para responder.\nUsa _#activar ${conv.phone_number}_ cuando termines.`;
}

async function cmdActivar(org, phone) {
  const normalized = db.normalizePhone(phone);
  const pool = db.getPool();

  const { rows } = await pool.query(
    `SELECT id, contact_name, phone_number, agent_mode FROM conversations
     WHERE organization_id = $1 AND phone_number IN ($2, $3, $4) LIMIT 1`,
    [org.id, phone, normalized, '+' + normalized]
  );

  if (!rows.length) return `❌ No encontré conversación con ${phone}.`;
  const conv = rows[0];

  if (conv.agent_mode === 'ai') {
    return `ℹ️ El bot ya estaba activo para *${conv.contact_name || phone}*.`;
  }

  await db.setAgentMode(conv.id, 'ai');
  const name = conv.contact_name && conv.contact_name !== phone ? conv.contact_name : phone;
  return `🤖 Bot reactivado para *${name}*. El bot retomará las respuestas automáticas.`;
}

function cmdEstado(agent) {
  const prefs = agent.wa_notifications || {};
  return [
    `👤 *${agent.name || agent.email}* (${agent.role})`,
    '',
    '*Notificaciones activas:*',
    `${prefs.new_messages  ? '✅' : '❌'} Nuevos mensajes`,
    `${prefs.escalations   ? '✅' : '❌'} Escalaciones`,
    `${prefs.payments      ? '✅' : '❌'} Comprobantes de pago`,
  ].join('\n');
}

module.exports = { handleAgentCommand, hasActiveCampaign };
