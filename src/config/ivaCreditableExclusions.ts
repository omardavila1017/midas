/**
 * Catálogo declarativo: conceptos que se EXCLUYEN del IVA acreditable.
 *
 * ── FUENTE (José Luis Gallegos, Fiscal — 8-jul-2026) ──────────────────────
 * Del reporte de Egresos que se extrae de JDE, Fiscal QUITA estos conceptos
 * para el cálculo del IVA acreditable: JDE los trae en el egreso, pero NO
 * generan IVA acreditable (nómina/empleados/pensiones no llevan IVA; vales,
 * reembolsos y reposiciones son movimientos internos sin IVA acreditable; OCSI
 * y la Asociación Protacio/Protasio son partes relacionadas fuera del cómputo).
 *
 * ── VALIDACIÓN con los Excel de Fiscal (recibidos 2026-07-09) ──────────────
 * Las hojas `Gastos TT`/`Gastos SIR` CONFIRMAN que JDE sí reporta IVA
 * acreditable sobre estos conceptos (por eso hay que quitarlo). Acreditable MXP
 * que caería sin estas exclusiones (columnas `IVA ACREDTABLE …8/…16`):
 *   · OCSI:      TT $181,585 · SIR $745,164   (el mayor)
 *   · Pensiones: TT $214,907 · SIR $18,546
 *   · Empleados: SIR $33,104 · Vales/Reembolsos/Reposiciones: unos miles c/u.
 * Los patrones de abajo (con `\b`) empatan estas líneas sin falsos positivos.
 * PENDIENTE (confirmar con Fiscal, NO incluido — sin instrucción explícita):
 * la clasificación de proveedor **"Recursos Humanos"** (SIR ~$155,874
 * acreditable) y **"Nominas / Reembolsos / Vales"** (SIR ~$1,678) — ¿también se
 * excluyen? Hoy sólo se excluye lo que cae por los 8 conceptos de abajo.
 *
 * Estructura — análoga a `glAccountFlowCatalog.ts` / `coordinadoFiscalCatalog.ts`:
 * catálogo declarativo en código (NO secreto) + predicado. Editar aquí NO toca
 * montos históricos ni el motor: sólo decide qué líneas NO cuentan como
 * acreditable. El match es sobre el TEXTO descriptivo del asiento/proveedor
 * (contraparte + concepto + explicación), tolerante a acentos.
 */

export interface CreditableExclusionRule {
  /** Etiqueta legible del concepto excluido. */
  label: string;
  /** Patrones que identifican el concepto en el texto descriptivo (sin acentos). */
  patterns: RegExp[];
}

/**
 * Los 8 conceptos que Fiscal excluye del acreditable. Los patrones corren
 * contra el texto YA normalizado (sin acentos, cualquier caso); usan límites de
 * palabra para no producir falsos positivos (p.ej. `\bnomina` NO matchea
 * "denominacion", `\bvales?\b` NO matchea "avales"/"valencia").
 */
export const IVA_CREDITABLE_EXCLUSIONS: CreditableExclusionRule[] = [
  { label: 'Empleados', patterns: [/\bemplead/i] },
  { label: 'Asociación Protacio', patterns: [/\bprota[cs]io/i] },
  { label: 'OCSI', patterns: [/\bocsi\b/i] },
  { label: 'Pensiones', patterns: [/\bpension/i] },
  { label: 'Nómina', patterns: [/\bnominas?\b/i] },
  { label: 'Vales', patterns: [/\bvales?\b/i] },
  { label: 'Reembolsos', patterns: [/\breembols/i] },
  { label: 'Reposiciones', patterns: [/\breposicion/i] },
];

/** Normaliza: quita acentos (NFD) para que los patrones sin acento empaten. */
function normalize(text: string): string {
  return (text ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * Devuelve la etiqueta del concepto excluido que empata con `text`, o
 * `undefined` si ninguno aplica. `text` puede combinar varios campos
 * descriptivos (contraparte + concepto + explicación).
 */
export function matchCreditableExclusion(
  text: string,
  exclusions: CreditableExclusionRule[] = IVA_CREDITABLE_EXCLUSIONS,
): string | undefined {
  const normalized = normalize(text);
  if (!normalized.trim()) return undefined;
  for (const rule of exclusions) {
    if (rule.patterns.some((re) => re.test(normalized))) return rule.label;
  }
  return undefined;
}

/** True si el texto describe un concepto que NO computa IVA acreditable. */
export function isCreditableExcludedConcept(
  text: string,
  exclusions: CreditableExclusionRule[] = IVA_CREDITABLE_EXCLUSIONS,
): boolean {
  return matchCreditableExclusion(text, exclusions) !== undefined;
}
