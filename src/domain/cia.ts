/**
 * Normalización canónica de la clave de compañía (cia) — ÚNICA fuente de verdad.
 *
 * Las fuentes traen la cia en formas distintas:
 *   - "00011"                                   → JDE /empresas, /antiguedadsaldos
 *   - "00011 - SERVICIO INDUSTRIAL REGIOMONTANO" → /antiguedadsaldos en algunos casos
 *   - "00011,"                                   → /cobranza (eco del request body)
 *   - "00001   "                                 → char(8) con espacios (BD espejo)
 *   - 33 (int)                                   → tress.Nomina.IDEmpresa
 *
 * Para poder agrupar/filtrar registros por compañía hay que reducir todas
 * estas a un código canónico de 5 dígitos. Estrategia:
 *   1. Tomar la PRIMERA secuencia de dígitos consecutivos de la cadena.
 *      Esto cubre todos los casos sin bifurcarnos por cada formato.
 *   2. Pad a 5 dígitos.
 *   3. Si no hay dígitos (raro, p.ej. cia="MX"), devolver el head limpio.
 *
 * Consumidores: services/jde.ts (re-export para no romper imports), motores de
 * dominio (paymentReconciliationEngine), shared-finance/sourceRecords y UI.
 * NO dupliques esta lógica localmente — el mismatch de padding entre copias ya
 * causó doble conteo por cía (corrida de mantenimiento 2026-07-21).
 */
export function normalizeCia(v: unknown): string {
  if (v === null || v === undefined) return '';
  const raw = String(v).trim();
  if (!raw) return '';
  const digitMatch = raw.match(/\d+/);
  if (digitMatch) return digitMatch[0].padStart(5, '0');
  // Sin dígitos: caer al patrón antiguo (split por espacio/guion/coma).
  const head = raw.split(/[\s\-,]/)[0].trim();
  return head;
}
