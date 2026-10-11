const BUSINESS_TIME_ZONE = 'America/Santiago';

const WEEKDAYS = {
  domingo: 0,
  lunes: 1,
  martes: 2,
  miercoles: 3,
  jueves: 4,
  viernes: 5,
  sabado: 6,
};

const MONTHS = {
  enero: 1,
  febrero: 2,
  marzo: 3,
  abril: 4,
  mayo: 5,
  junio: 6,
  julio: 7,
  agosto: 8,
  septiembre: 9,
  setiembre: 9,
  octubre: 10,
  noviembre: 11,
  diciembre: 12,
};

function normalizeWords(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function isValidISODate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function toISODate(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.toISOString().slice(0, 10);
  }
  const match = String(value).trim().match(/^(\d{4}-\d{2}-\d{2})(?:[T\s].*)?$/);
  return match && isValidISODate(match[1]) ? match[1] : null;
}

function todayISOChile(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function addDays(isoDate, days) {
  const base = toISODate(isoDate);
  if (!base) return null;
  const date = new Date(`${base}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + Number(days || 0));
  return date.toISOString().slice(0, 10);
}

function weekdayForISO(isoDate) {
  const value = toISODate(isoDate);
  return value == null ? null : new Date(`${value}T12:00:00Z`).getUTCDay();
}

function nextWeekday(todayISO, weekday) {
  const current = weekdayForISO(todayISO);
  if (current == null) return null;
  const distance = ((weekday - current + 7) % 7) || 7;
  return addDays(todayISO, distance);
}

function dateFromParts(day, month, year, todayISO) {
  const today = toISODate(todayISO);
  if (!today) return null;
  let resolvedYear = year || Number(today.slice(0, 4));
  let candidate = `${String(resolvedYear).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  if (!isValidISODate(candidate)) return null;
  if (!year && candidate < today) {
    resolvedYear += 1;
    candidate = `${resolvedYear}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  return isValidISODate(candidate) ? candidate : null;
}

/**
 * Resuelve solo expresiones explícitas y no ambiguas. Si el mensaje entrega
 * dos señales incompatibles, devuelve conflict para que el bot pregunte.
 */
function resolveExplicitDeliveryDate(message, todayISO = todayISOChile()) {
  const today = toISODate(todayISO);
  if (!today) return { date: null, explicit: false, conflict: true, reason: 'invalid_reference_date' };
  const text = normalizeWords(message);
  const weekdayMatch = text.match(/\b(domingo|lunes|martes|miercoles|jueves|viernes|sabado)\b/);
  const namedWeekday = weekdayMatch ? WEEKDAYS[weekdayMatch[1]] : null;
  let date = null;
  let source = null;

  const numeric = text.match(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2}|\d{4}))?\b/);
  if (numeric) {
    const rawYear = numeric[3] ? Number(numeric[3]) : null;
    const year = rawYear != null && rawYear < 100 ? 2000 + rawYear : rawYear;
    date = dateFromParts(Number(numeric[1]), Number(numeric[2]), year, today);
    source = 'calendar_date';
    if (!date) return { date: null, explicit: true, conflict: true, reason: 'invalid_calendar_date' };
  }

  if (!date) {
    const namedDate = text.match(/\b(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)(?:\s+(?:de\s+)?(\d{4}))?\b/);
    if (namedDate) {
      date = dateFromParts(Number(namedDate[1]), MONTHS[namedDate[2]], namedDate[3] ? Number(namedDate[3]) : null, today);
      source = 'calendar_date';
      if (!date) return { date: null, explicit: true, conflict: true, reason: 'invalid_calendar_date' };
    }
  }

  if (!date) {
    if (/\bpasado manana\b/.test(text)) {
      date = addDays(today, 2);
      source = 'relative';
    } else if (/\bmanana\b/.test(text)) {
      date = addDays(today, 1);
      source = 'relative';
    } else if (/\bhoy\b/.test(text)) {
      date = today;
      source = 'relative';
    } else {
      const daysMatch = text.match(/\ben\s+(\d{1,2})\s+dias?\b/);
      if (daysMatch) {
        date = addDays(today, Number(daysMatch[1]));
        source = 'relative';
      } else if (/\ben\s+una\s+semana\b/.test(text)) {
        date = addDays(today, 7);
        source = 'relative';
      }
    }
  }

  if (!date && namedWeekday != null) {
    date = nextWeekday(today, namedWeekday);
    source = 'weekday';
  }

  if (!date) return { date: null, explicit: false, conflict: false, reason: null };

  if (namedWeekday != null && weekdayForISO(date) !== namedWeekday) {
    return { date: null, explicit: true, conflict: true, reason: 'weekday_date_mismatch' };
  }

  return { date, explicit: true, conflict: false, source };
}

function formatDateEs(value) {
  const iso = toISODate(value);
  if (!iso) return null;
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('es-CL', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  });
}

module.exports = {
  BUSINESS_TIME_ZONE,
  toISODate,
  isValidISODate,
  todayISOChile,
  addDays,
  formatDateEs,
  resolveExplicitDeliveryDate,
};
