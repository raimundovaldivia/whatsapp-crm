/**
 * Fuente única de verdad para variables numeradas de templates de WhatsApp.
 * Los valores son texto plano: no se recortan ni se transforman sus saltos de línea.
 */
export function getTemplateVariables(templateBody = '') {
  const found = new Set();
  for (const match of String(templateBody).matchAll(/\{\{(\d+)\}\}/g)) found.add(String(Number(match[1])));
  return [...found].sort((a, b) => Number(a) - Number(b));
}

export function hasTemplateVariableValue(variables, number) {
  return !!variables
    && Object.prototype.hasOwnProperty.call(variables, String(number))
    && variables[String(number)] !== undefined
    && variables[String(number)] !== null;
}

export function renderTemplate(templateBody = '', variables = {}, options = {}) {
  const missing = options.missing || 'placeholder';
  return String(templateBody).replace(/\{\{(\d+)\}\}/g, (placeholder, rawNumber) => {
    const number = String(Number(rawNumber));
    if (hasTemplateVariableValue(variables, number)) return String(variables[number]);
    if (typeof missing === 'function') return String(missing(number, placeholder));
    if (missing === 'empty') return '';
    if (missing === 'brackets') return `[{{${number}}}]`;
    return placeholder;
  });
}

export function getBodyComponent(template) {
  return (template?.components || []).find(component => String(component?.type || '').toUpperCase() === 'BODY') || null;
}

export function valuesFromBodyParameters(templateBody = '', components = []) {
  const body = (components || []).find(component => String(component?.type || '').toLowerCase() === 'body');
  const parameters = body?.parameters || [];
  return Object.fromEntries(getTemplateVariables(templateBody).map((number, index) => [
    number,
    parameters[index]?.text === undefined || parameters[index]?.text === null ? '' : String(parameters[index].text),
  ]));
}

export function getMissingBodyParameters(templateBody = '', components = []) {
  const body = (components || []).find(component => String(component?.type || '').toLowerCase() === 'body');
  const parameters = body?.parameters || [];
  return getTemplateVariables(templateBody).filter((number, index) =>
    parameters[index]?.text === undefined
    || parameters[index]?.text === null
    || String(parameters[index].text) === ''
  );
}

export function buildBodyTemplateComponent(templateBody = '', variables = {}) {
  const numbers = getTemplateVariables(templateBody);
  if (!numbers.length) return [];
  return [{
    type: 'body',
    parameters: numbers.map(number => ({
      type: 'text',
      text: hasTemplateVariableValue(variables, number) ? String(variables[number]) : '',
    })),
  }];
}

export function renderTemplateFromComponents(templateBody = '', components = [], options = {}) {
  return renderTemplate(templateBody, valuesFromBodyParameters(templateBody, components), options);
}

/**
 * Reconstruye los parámetros a partir del cuerpo aprobado y del texto exacto
 * que se guardó en el chat. Se usa sólo para campañas antiguas cuya auditoría
 * perdió template_components; no inventa valores si el texto no coincide.
 */
export function recoverBodyTemplateComponent(templateBody = '', renderedText = '') {
  const body = String(templateBody);
  const rendered = String(renderedText);
  const token = /\{\{(\d+)\}\}/g;
  const numbers = [];
  let cursor = 0;
  let pattern = '^';
  const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const match of body.matchAll(token)) {
    pattern += escape(body.slice(cursor, match.index));
    pattern += '([\\s\\S]*?)';
    numbers.push(String(Number(match[1])));
    cursor = match.index + match[0].length;
  }
  if (!numbers.length) return [];
  pattern += escape(body.slice(cursor)) + '$';
  const values = rendered.match(new RegExp(pattern));
  if (!values) return [];
  const byNumber = {};
  for (let index = 0; index < numbers.length; index++) {
    const number = numbers[index];
    const value = values[index + 1];
    if (Object.hasOwn(byNumber, number) && byNumber[number] !== value) return [];
    byNumber[number] = value;
  }
  return buildBodyTemplateComponent(body, byNumber);
}
