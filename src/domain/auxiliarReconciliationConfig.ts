/**
 * Parámetros fijos del API /JDEdwards/AuxiliarContable.
 *
 *   tl      = "AA"   → libro mayor real (Tipo de Libro "General Accounting").
 *   nr      = 999    → parámetro numérico del API (valor documentado).
 *   objetos = [...]  → pares {ini, fin} de objeto contable a traer.
 *
 * Catálogo de objeto contable JDE (confirmado con Palomo 2026-05-25):
 *
 *   1000-1999  ACTIVOS                  (incl. 1010 Caja + 1020 Bancos)
 *   2000-2999  PASIVOS
 *   3000-3999  CAPITAL
 *   4000-4999  INGRESOS
 *   5000-5999  GASTOS DE OPERACIÓN
 *   6000-6999  LOGÍSTICA / MANTENIMIENTO
 *   7000-7999  GASTOS DE VENTA
 *   8000-8999  GASTOS ADMINISTRATIVOS
 *   9000       GASTOS FINANCIEROS
 *   9100       GASTOS DE DEPRECIACIÓN
 *   9300       OTROS GASTOS
 *
 * El API SÍ acepta `objIni ≠ objFin` (rango por categoría). Una request por
 * rango por día por cía. La conciliación banco↔ERP solo cruza 1010+1020,
 * pero traemos el libro completo para alimentar dashboards futuros (P&L,
 * gastos por categoría) sin tener que re-pegarle al API.
 */
export const AUX_RECON_PARAMS = {
  tl: 'AA',
  nr: 999,
  // Un solo rango total (1000-9999) por día por cía. Cubre TODAS las
  // categorías del catálogo en una sola request:
  //   1000-1999 ACTIVOS · 2000-2999 PASIVOS · 3000-3999 CAPITAL
  //   4000-4999 INGRESOS · 5000-5999 OPERACIÓN · 6000-6999 LOGÍSTICA
  //   7000-7999 VENTAS · 8000-8999 ADMIN · 9000/9100/9300 FIN/DEPR/OTROS
  // Confirmado con Palomo 2026-05-25: el API acepta `objIni ≠ objFin`.
  // Si JDE alguna vez rebota este rango, expandir a pares por categoría.
  objetos: [
    { ini: '1000', fin: '9999' },
  ] as const,
} as const;

/**
 * Allowlist de cías a fetchear para AuxiliarContable (decisión 2026-05-25).
 *
 *   00001 TAMAULIPAS · 00011 SIR · 00033 MULTICARGA · 00038 STDN
 *   00043 SES · 00042 TICH
 *
 * Las demás cías se ignoran. Cía 33 (multicarga) está en la exclusión global
 * pero para auxiliar contable se incluye explícitamente — el bypass vive en
 * el boot loader (AppCore) y en `fetchAuxiliarContable` (jde.ts), no se toca
 * `EXCLUSION_RULES`.
 */
export const AUXILIAR_CIA_ALLOWLIST: readonly string[] = [
  '00001', '00011', '00033', '00038', '00042', '00043',
] as const;

/** Numeric form (padding-agnostic) for membership checks. */
export const AUXILIAR_CIA_ALLOWLIST_NUMS: ReadonlySet<number> = new Set(
  AUXILIAR_CIA_ALLOWLIST.map(s => parseInt(s, 10)),
);

export function isAuxiliarAllowlistedCia(cia: unknown): boolean {
  if (cia == null) return false;
  const n = typeof cia === 'number' ? cia : parseInt(String(cia).trim(), 10);
  return Number.isFinite(n) && AUXILIAR_CIA_ALLOWLIST_NUMS.has(n);
}
