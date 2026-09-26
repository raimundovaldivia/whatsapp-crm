# Atención humana por WhatsApp

El aviso identifica la conversación. El encargado responde `TOMAR 123` para atenderla. `TOMAR` sin número solo funciona si existe exactamente una conversación pendiente.

La asignación se guarda en PostgreSQL y sobrevive a reinicios. Cada teléfono del equipo puede tener un cliente activo; un cliente solo puede estar asignado a un encargado. Las respuestas y archivos del cliente se registran en el CRM y se notifican al encargado asignado; los archivos se revisan desde el CRM.

## Secretaria privada y roles por teléfono

Los teléfonos registrados entran a una conversación privada con la secretaria, sin prefijo `#`. Los números no registrados siguen el flujo de clientes. El rol se consulta en el CRM en cada mensaje, nunca se acepta un rol declarado dentro del chat. Si un teléfono figura en varios usuarios, el acceso se detiene para corregir la asociación. La edición de teléfonos impide nuevos duplicados.

Propietarios, administradores, supervisores y agentes pueden tomar una conversación, consultar su historial y pedido activo, preparar una respuesta, cerrar la atención y devolverla al bot. El teléfono de avisos configurado conserva acceso de encargado de atención; no obtiene permisos de propietario. Repartidores y coordinadores se reconocen como equipo y reciben orientación hacia su panel, sin acceso a chats de clientes por WhatsApp.

Ejemplo: “¿Qué pidió este cliente?” genera una respuesta privada. “Dile que llegará mañana” prepara una propuesta con destinatario y texto; `CONFIRMAR` la ejecuta y `CANCELAR` la descarta. Una propuesta caduca tras 15 minutos o al cambiar la asignación. `TOMAR 123`, `CERRAR` y `BOT` siguen disponibles como comandos explícitos.

El historial privado persiste separado por organización y teléfono. Al cambiar la identidad o el rol, se ignora el historial anterior. Los errores de interpretación nunca reenvían el mensaje interno al cliente. La secretaria consulta datos del cliente asignado y no puede modificar pedidos, direcciones, pagos, roles ni permisos; esas operaciones se realizan desde el CRM. La conversación con IA respeta la habilitación comercial de `sales_ai`, y el contexto de pedidos la de `orders`.

- `CERRAR`: libera la asignación y deja el bot pausado. Se puede reactivar desde el CRM.
- `BOT` o `DEVOLVER AL BOT`: libera la asignación y reactiva el bot.
- Activar IA desde el CRM también libera la asignación y descarta avisos pendientes de esa atención.
- No se cambia a otro cliente ni se reactiva el bot por inactividad mientras exista asignación.

## Entrega de avisos

El panel de avisos muestra los últimos 30 intentos, con cliente y fecha. El registro distingue `accepted` (proveedor aceptó el envío), `sent` (enviado sin confirmación de entrega), `delivered`, `read`, `queued` y `failed`. Sin confirmación del proveedor nunca se presenta como entregado. Una solicitud interrumpida puede permanecer en `sending`, sin confirmación.

Los callbacks se correlacionan por organización e identificador de mensaje. Se toleran callbacks duplicados, fuera de orden y anteriores a la respuesta HTTP del envío. Un callback antiguo no degrada un aviso leído a enviado. Los fallos de configuración y envío también quedan registrados. La cola por ventana cerrada conserva su mecanismo de reenvío cuando el encargado vuelve a escribir.

## Publicación y verificación

Esta corrección necesita publicar backend y frontend. La migración `backend/src/db/admin-handoff.sql` se ejecuta desde `setupDatabase` y es idempotente. El webhook Kapso debe recibir, además de `whatsapp.message.received`, los eventos `whatsapp.message.sent`, `whatsapp.message.delivered`, `whatsapp.message.read` y `whatsapp.message.failed`. Sin ellos, los envíos permanecen sin confirmación de entrega.

Validación local: pruebas con PostgreSQL embebido para asignación, reinicio, respuestas sucesivas, selección entre varios clientes, aislamiento entre organizaciones, cierre, devolución al bot, recepción de archivos, duplicados, fallos y estados de entrega. No se envían mensajes reales en esas pruebas.

## Seguimiento de chats manuales

Todo mensaje entrante por Kapso en un chat manual se conserva y avisa al responsable, o al teléfono administrador si no hay uno autorizado. Incluye archivos, audios e imágenes; no ejecuta automáticamente el flujo de comprobantes ni el bot. No existe reactivación por antigüedad de 24 horas.

La bandeja de avisos incluye conversaciones manuales con mensajes entrantes posteriores al último cierre y sin respuesta humana enviada posterior. Incluye chats históricos, ordenados por último mensaje entrante, sin reprocesarlos ni enviar mensajes masivos a los clientes. Se pueden abrir aunque no estén entre los 300 chats inicialmente cargados. Una respuesta humana fallida no resuelve el pendiente. Una respuesta enviada retira el pendiente pero conserva la asignación; CERRAR fija `human_closed_at` y una nueva respuesta del cliente vuelve a abrir el pendiente.

En Ajustes → IA & Bot se configura `human_attention_hours` con días (0=domingo), horas enteras de inicio/fin y zona America/Santiago. Sin horario definido, solo funcionan los avisos iniciales y la bandeja; los recordatorios quedan desactivados. El job revisa cada minuto: a los 10 minutos de atención avisa al encargado y a los 30 al administrador. No envía recordatorios al cliente. Los registros `human_attention_reminders` evitan repetir cada etapa por ciclo de mensajes sin respuesta, incluso entre réplicas; un fallo puede reintentarse después de cinco minutos. El primer mensaje pendiente identifica el ciclo para que nuevos mensajes no reinicien la espera. Los casos antiguos pueden escalar directamente a 30 minutos al activar el horario.

El teléfono administrador fue configurado en el CRM publicado a petición del usuario el 26-09-2026. Esto no demuestra entrega de un aviso ni publicación de las mejoras locales. Validación local: 53 pruebas de backend y compilación del frontend; regresiones relacionadas repetidas después de ampliar la recuperación en la secretaria.
