/**
 * Parse the free-text "Día de pago" column (Column C of the source Excel)
 * into a structured PaymentDayPattern.
 *
 * Recognized forms (Spanish, case-insensitive, accent-insensitive):
 *   "Viernes"                       → DOW[Fri]
 *   "Miercoles y Jueves"            → DOW[Wed, Thu]
 *   "Jueves-Quincenal" / "semanal"  → DOW[<day>]  (frequency lives on Client)
 *   "dia 16 del mes" / "dia 16"     → DOM[16]
 *   "10 y 25"                       → DOM_LIST[10, 25]
 *   "Primer Viernes de mes"         → NTH_DOW[1, Fri]
 *   "Ultimo Viernes"                → NTH_DOW[-1, Fri]
 *   "Factoraje-Viernes"             → DOW[Fri]  (caller must set factoraje=true)
 *
 * Returns `null` when the string can't be parsed; caller is expected to
 * surface this to the user as a data-quality issue rather than silently
 * guessing.
 */

import { PaymentDayPattern, DayOfWeek } from './types';

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
  segundo: 2,
  tercer: 3,
  tercero: 3,
  cuarto: 4,
  ultimo: -1,
};

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

export function parsePaymentDay(raw: string): PaymentDayPattern | null {
  if (!raw) return null;
  const s = normalize(raw);

  // Nth weekday of month: "primer viernes de mes", "ultimo jueves"
  const nthMatch = s.match(/(primer|primero|segundo|tercer|tercero|cuarto|ultimo)\s+(\w+)/);
  if (nthMatch && DOW_MAP[nthMatch[2]] !== undefined) {
    return { kind: 'NTH_DOW', nth: NTH_MAP[nthMatch[1]], day: DOW_MAP[nthMatch[2]] };
  }

  // Day(s) of month: "dia 16", "10 y 25", "16 del mes"
  const domNumbers = [...s.matchAll(/\b(\d{1,2})\b/g)]
    .map(m => Number(m[1]))
    .filter(n => n >= 1 && n <= 31);
  const mentionsDia = /\bdia\b|\bdias\b|del mes/.test(s) || /^\d/.test(s);
  if (domNumbers.length > 0 && mentionsDia && !hasWeekdayMention(s)) {
    if (domNumbers.length === 1) return { kind: 'DOM', day: domNumbers[0] };
    return { kind: 'DOM_LIST', days: domNumbers };
  }

  // Weekday list: "miercoles y jueves", "viernes", "factoraje-viernes"
  const weekdays = Object.keys(DOW_MAP).filter(k => new RegExp(`\\b${k}\\b`).test(s));
  if (weekdays.length > 0) {
    return { kind: 'DOW', days: weekdays.map(w => DOW_MAP[w]) };
  }

  return null;
}

function hasWeekdayMention(s: string): boolean {
  return Object.keys(DOW_MAP).some(k => new RegExp(`\\b${k}\\b`).test(s));
}

/** True when the raw string implies factoraje. */
export function detectsFactoraje(raw: string): boolean {
  return /factoraje/i.test(raw);
}
