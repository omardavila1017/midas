/**
 * Parse the free-text "Día de pago" source field
 * into a structured PaymentDayPattern.
 *
 * Recognized forms (Spanish, case-insensitive, accent-insensitive):
 *   "Viernes"                       → DOW[Fri]
 *   "Miercoles y Jueves"            → DOW[Wed, Thu]
 *   "Jueves-Quincenal"              → DOW[Thu]    (frequency lives on Client)
 *   "semanal"                       → ANY
 *   "dia 16 del mes" / "dia 16"     → DOM[16]
 *   "10 y 25"                       → DOM_LIST[10, 25]
 *   "entre 15 y 20 de cada mes"     → DOM_LIST[15, 16, 17, 18, 19, 20]
 *   "Primer Viernes de mes"         → NTH_DOW[1, Fri]
 *   "Segundo y Cuarto Jueves"       → NTH_DOW_SET[2, 4, Thu]
 *   "1er y 3er semana"              → WOM[1, 3]
 *   "cualquier dia de la semana"    → ANY
 *   "Ultimo Viernes"                → NTH_DOW[-1, Fri]
 *   "Factoraje-Viernes"             → DOW[Fri]  (caller must set factoraje=true)
 *   "Factoraje"                     → ANY       (factoraje short-circuits dates)
 *
 * Returns `null` when the string can't be parsed; caller is expected to
 * surface this to the user as a data-quality issue rather than silently
 * guessing.
 */

import { PaymentDayPattern, DayOfWeek, NthOfMonth, WeekOfMonth } from './types';

const DOW_MAP: Record<string, DayOfWeek> = {
  domingo: 0,
  lunes: 1,
  martes: 2,
  miercoles: 3,
  jueves: 4,
  viernes: 5,
  sabado: 6,
};

const NTH_MAP: Record<string, 1 | 2 | 3 | 4 | -1> = {
  primer: 1,
  primero: 1,
  primera: 1,
  '1': 1,
  '1a': 1,
  '1er': 1,
  segundo: 2,
  '2': 2,
  '2do': 2,
  '2da': 2,
  tercer: 3,
  tercero: 3,
  tercera: 3,
  '3': 3,
  '3er': 3,
  '3a': 3,
  cuarto: 4,
  '4': 4,
  '4to': 4,
  '4ta': 4,
  ultimo: -1,
  ultima: -1,
};

const ORDINAL_KEYS = Object.keys(NTH_MAP).sort((a, b) => b.length - a.length);
const DOW_MATCHERS = Object.entries(DOW_MAP).map(([word, day]) => ({
  matcher: new RegExp(`\\b${word}\\b`),
  day,
}));
const ORDINAL_MATCHERS = ORDINAL_KEYS.map((word) => ({
  matcher: new RegExp(`\\b${escapeRegExp(word)}\\b`),
  nth: NTH_MAP[word],
}));
const DECORATOR_RE = /\b(?:factoraje|al vencimiento|quincenal|mensual|semanal)\b/g;
const WHITESPACE_RE = /\s+/g;

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[.,/]+/g, ' ')
    .replace(/\s*-\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parsePaymentDay(raw: string): PaymentDayPattern | null {
  if (!raw) return null;
  const s = normalize(raw);

  if (isAnyDayPattern(s)) return { kind: 'ANY' };

  const cleaned = stripDecorators(s);
  if (!cleaned) return { kind: 'ANY' };

  const weekdays = extractWeekdays(cleaned);
  const ordinals = extractOrdinals(cleaned);

  // Nth weekday of month: "primer viernes de mes", "segundo y cuarto jueves"
  if (weekdays.length === 1 && ordinals.length > 0) {
    if (ordinals.length === 1) {
      return { kind: 'NTH_DOW', nth: ordinals[0], day: weekdays[0] };
    }
    return { kind: 'NTH_DOW_SET', nths: ordinals, day: weekdays[0] };
  }

  // Week windows of the month: "1er y 3er semana", "1a y ultima semana del mes"
  if (/\bsemana\b/.test(cleaned) && weekdays.length === 0 && ordinals.length > 0) {
    return { kind: 'WOM', weeks: ordinals as WeekOfMonth[] };
  }

  // Day range of month: "entre 15 y 20 de cada mes"
  const rangeMatch = cleaned.match(/\bentre\s+(\d{1,2})\s+y\s+(\d{1,2})\b/);
  if (rangeMatch && /\b(?:de cada mes|del mes|mes)\b/.test(cleaned)) {
    const start = Number(rangeMatch[1]);
    const end = Number(rangeMatch[2]);
    if (start >= 1 && end <= 31 && start <= end) {
      return { kind: 'DOM_LIST', days: expandRange(start, end) };
    }
  }

  // Day(s) of month: "dia 16", "10 y 25", "16 del mes"
  const domNumbers = [...cleaned.matchAll(/\b(\d{1,2})\b/g)]
    .map(m => Number(m[1]))
    .filter(n => n >= 1 && n <= 31);
  const mentionsDia = /\bdia\b|\bdias\b|\bmes\b/.test(cleaned) || /^\d/.test(cleaned);
  if (domNumbers.length > 0 && mentionsDia && weekdays.length === 0) {
    if (domNumbers.length === 1) return { kind: 'DOM', day: domNumbers[0] };
    return { kind: 'DOM_LIST', days: uniqueNumbers(domNumbers) };
  }

  // Weekday list: "miercoles y jueves", "viernes", "factoraje-viernes"
  if (weekdays.length > 0) {
    return { kind: 'DOW', days: weekdays };
  }

  return null;
}

function isAnyDayPattern(s: string): boolean {
  return (
    /\bcualquier dia(?: de la semana)?\b/.test(s) ||
    /^factoraje$/.test(s) ||
    /^semanal$/.test(s) ||
    /^1 vez al mes$/.test(s)
  );
}

function stripDecorators(s: string): string {
  return s
    .replace(DECORATOR_RE, ' ')
    .replace(WHITESPACE_RE, ' ')
    .trim();
}

function extractWeekdays(s: string): DayOfWeek[] {
  return uniqueNumbers(
    DOW_MATCHERS
      .filter(({ matcher }) => matcher.test(s))
      .map(({ day }) => day),
  ) as DayOfWeek[];
}

function extractOrdinals(s: string): NthOfMonth[] {
  const hits = ORDINAL_MATCHERS
    .filter(({ matcher }) => matcher.test(s))
    .map(({ nth }) => nth);
  return uniquePatternNumbers(hits) as NthOfMonth[];
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

function uniquePatternNumbers(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => sortPatternNumber(a) - sortPatternNumber(b));
}

function expandRange(start: number, end: number): number[] {
  return Array.from({ length: end - start + 1 }, (_, i) => start + i);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sortPatternNumber(value: number): number {
  return value === -1 ? 99 : value;
}

/** True when the raw string implies factoraje. */
export function detectsFactoraje(raw: string): boolean {
  return /factoraje/i.test(raw);
}

/**
 * Expande la forma corta del catálogo JDE CC13 (`Nombre_Dia_Pago_CC13`,
 * p.ej. "LUN", "VIE") al nombre completo en español que `parsePaymentDay`
 * sabe interpretar. Si la cadena ya viene completa ("Viernes") o no es un
 * código conocido, se regresa tal cual.
 */
export function expandCc13PaymentDay(raw: string): string {
  const value = raw.trim().toUpperCase();
  const map: Record<string, string> = {
    DOM: 'domingo',
    LUN: 'lunes',
    MAR: 'martes',
    MIE: 'miercoles',
    MIÉ: 'miercoles',
    JUE: 'jueves',
    VIE: 'viernes',
    SAB: 'sabado',
    SÁB: 'sabado',
  };
  return map[value] ?? raw;
}

/**
 * Parsea el día de pago tal como lo expone el API de cobranza/ROL en
 * `Nombre_Dia_Pago_CC13`. Solo acepta el NOMBRE (no la clave numérica
 * `Clave_Dia_Pago_CC13` tipo "027", que `parsePaymentDay` confundiría con
 * un día del mes). Regresa `null` cuando no hay regla parseable.
 */
export function parseCc13PaymentDay(raw: string | undefined | null): PaymentDayPattern | null {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return null;
  // Una clave puramente numérica del catálogo no es un día parseable.
  if (/^\d+$/.test(trimmed)) return null;
  return parsePaymentDay(expandCc13PaymentDay(trimmed));
}
