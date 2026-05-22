/**
 * Parámetros fijos del API /JDEdwards/AuxiliarContable para la conciliación
 * histórica banco↔ERP.
 *
 *   tl     = "AA"   → libro mayor real (Tipo de Libro "General Accounting").
 *   nr     = 999    → parámetro numérico del API (valor documentado).
 *   objIni = "1010" → objeto contable inicial (Caja).
 *   objFin = "1020" → objeto contable final (Bancos).
 *
 * El rango 1010-1020 trae Caja + Bancos. Las cuentas de objeto 1020 tienen
 * estado de cuenta bancario para cruzar; las de 1010 (caja) no — el motor
 * las aparta en un bucket propio en vez de contarlas como cruce fallido.
 */
export const AUX_RECON_PARAMS = {
  tl: 'AA',
  nr: 999,
  objIni: '1010',
  objFin: '1020',
} as const;
