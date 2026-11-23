# Destinos autorizados de Evolution

El operador de plataforma debe configurar `EVOLUTION_ALLOWED_ORIGINS` con una lista separada por comas de los orígenes HTTPS de servidores Evolution bajo su control. Ejemplo ficticio: `https://evolution.example,https://second.example:8443`. No admite comodines, credenciales, query strings, fragmentos ni rutas en la lista.

Todas las llamadas Evolution, incluidas las de canales ya existentes, validan el origen antes de construir el cliente HTTP o utilizar la clave global. Los clientes no siguen redirecciones. La creación de canales también valida antes de consultar el proveedor o persistir datos. Un tenant no puede añadir entradas a esta lista desde el CRM.

## Condición de despliegue

**No fusionar ni desplegar sin aprobación de Raimundo.** Inventariar previamente los endpoints actuales y configurar la lista en el entorno correspondiente. Con la lista vacía, mal formada o sin un endpoint existente, ese canal dejará de realizar llamadas Evolution: es un cierre deliberado ante configuración ausente. Las conexiones HTTP tendrán que migrarse a HTTPS o diseñarse una alternativa privada revisada antes del despliegue.

Esta lista autoriza servidores completos; solo deben incluirse hosts administrados por la plataforma, con DNS y certificados bajo control. No autorices dominios de terceros controlados por tenants. No se rotaron claves, se configuraron variables de Railway ni se invocó Evolution real en este PR. La rotación de claves potencialmente expuestas se coordinará por separado para conservar continuidad.
