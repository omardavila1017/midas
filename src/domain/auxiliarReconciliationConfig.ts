/**
 * Parámetros fijos del API /JDEdwards/AuxiliarContable para la conciliación
 * histórica banco↔ERP.
 *
 *   tl      = "AA"            → libro mayor real (Tipo de Libro "General Accounting").
 *   nr      = 999             → parámetro numérico del API (valor documentado).
 *   objetos = ["1010","1020"] → objetos contables a traer: Caja + Bancos.
 *
 * IMPORTANTE: el API NO acepta un rango — `objIni` debe ser IGUAL a `objFin`
 * en cada request (rebota si difieren). Para traer Caja Y Bancos se hace una
 * llamada por objeto (objIni=objFin=objeto) y se mergean. Las cuentas de
 * objeto 1020 tienen estado de cuenta bancario para cruzar; las de 1010
 * (caja) no — el motor las aparta en un bucket propio.
 */
export const AUX_RECON_PARAMS = {
  tl: 'AA',
  nr: 999,
  objetos: ['1010', '1020'],
} as const;
