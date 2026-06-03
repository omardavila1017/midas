/**
 * Catálogo declarativo: cuenta contable → categoría de flujo.
 *
 * Propósito: categorizar el HISTÓRICO de Planeación Financiera por la **verdad
 * contable** (el Auxiliar Contable cruzado contra Bancos), no por heurísticas
 * de leyenda/concepto. Cada línea del libro mayor trae su cuenta contable
 * (`BU.Objeto.Subsidiaria`, p.ej. "42.1020.0010409"), su objeto (`1010` caja /
 * `1020` bancos) y su `idCuenta`. Con eso resolvemos a qué categoría/fila del
 * flujo pertenece el gasto (Nómina, Impuestos, Flota, etc.), validando que el
 * egreso es real y dejándolo en la fila correcta de la hoja.
 *
 * Esto NO altera montos ni fechas — sólo `category`/`subcategory`. Por
 * construcción es invariante en totales: la caja sigue anclada al banco; sólo
 * redistribuye los movimientos entre filas (ver canonicalProjection.ts y la
 * precedencia documentada ahí).
 *
 * Estructura — análoga a `roles.ts`: catálogo declarativo en código (NO
 * secreto) + resolver con `console.warn` para cuentas sin mapear (como
 * `userRoles.ts` con roles desconocidos). Primer match gana.
 *
 * IMPORTANTE — RANGOS PENDIENTES: `GL_FLOW_RULES` arranca **vacío** a propósito.
 * Los rangos reales del plan de cuentas los provee el equipo (ver el skeleton
 * comentado al final). Mientras esté vacío, `resolveCategoryForGlAccount`
 * regresa `undefined` siempre → el comportamiento es **idéntico al actual**
 * (cada movimiento cae a la lógica existente de proveedor/impuesto/`TRANSFER`).
 * Esto hace el cambio seguro de mergear antes de que lleguen los rangos.
 *
 * RESTRICCIONES sobre los valores del mapeo (para que `planningRowTaxonomy`
 * rutee la fila correctamente):
 *  - `category` debe ser un `FinancialMovementCategory` real.
 *  - Para INFLOWS, `subcategory` debe ser uno de los `INCOME_BUCKETS`
 *    (`'AC' | 'Clientes Citi' | 'Federal' | 'Viajes Especiales' | ...`).
 *  - Para OUTFLOWS `AP_PAYMENT`, `subcategory` se usa como etiqueta de subrol.
 */

import type { FinancialMovementCategory } from '../modules/shared-finance/types';

/** Categoría/subcategoría destino para una línea del mayor. */
export interface GlFlowMapping {
  /** Categoría de flujo destino — debe ser un `FinancialMovementCategory` real. */
  category: FinancialMovementCategory;
  /**
   * Subcategoría / etiqueta de fila opcional consumida por planningRowTaxonomy.
   * INFLOW → un valor de `INCOME_BUCKETS`; OUTFLOW AP_PAYMENT → subrol.
   */
  subcategory?: string;
  /** Nota legible para auditar el rango (no se muestra al usuario final). */
  label: string;
}

/**
 * Una regla de mapeo. Empata por `cuentaObjeto` (opcional) + rango numérico
 * inclusivo sobre `idCuenta` y/o prefijo de `cuentaContable`. Todos los
 * criterios presentes deben cumplirse (AND). Primer match en `GL_FLOW_RULES`
 * gana.
 */
export interface GlFlowRule {
  /** `'1010'` caja | `'1020'` bancos | omitido = cualquier objeto. */
  cuentaObjeto?: string;
  /** Rango inclusivo sobre `Number(idCuenta)` (omitir extremo = sin cota). */
  idCuentaFrom?: number;
  idCuentaTo?: number;
  /** Prefijo de `cuentaContable` (BU.Objeto.Subsidiaria). */
  cuentaContablePrefix?: string;
  mapping: GlFlowMapping;
}

/**
 * Reglas cuenta contable → categoría de flujo.
 *
 * <<< PENDIENTE: poblar con los rangos reales del plan de cuentas. >>>
 *
 * Skeleton de ejemplo (PLACEHOLDER — rangos inventados, NO usar tal cual):
 *
 *   { cuentaObjeto: '1020', idCuentaFrom: 4000000, idCuentaTo: 4099999,
 *     mapping: { category: 'PAYROLL', label: 'Cuentas de nómina' } },
 *   { cuentaContablePrefix: '80.',
 *     mapping: { category: 'TAX', subcategory: 'IVA', label: 'Impuestos federales' } },
 *   { cuentaObjeto: '1020', idCuentaFrom: 6000000, idCuentaTo: 6099999,
 *     mapping: { category: 'OPEX', label: 'Servicios operativos' } },
 */
export const GL_FLOW_RULES: GlFlowRule[] = [];

/** Cuentas ya advertidas (dedup del warn, como `userRoles.ts`). */
const warnedAccounts = new Set<string>();

/**
 * Resuelve la categoría/subcategoría de flujo para una línea del mayor a partir
 * de su cuenta contable. Regresa `undefined` cuando ninguna regla aplica (el
 * caller cae a su lógica previa). Las cuentas sin mapeo se reportan una vez con
 * `console.warn`.
 *
 * `rules` es inyectable para tests herméticos (default: `GL_FLOW_RULES`).
 */
export function resolveCategoryForGlAccount(
  cuentaContable: string,
  cuentaObjeto: string,
  idCuenta?: string,
  rules: GlFlowRule[] = GL_FLOW_RULES,
): GlFlowMapping | undefined {
  for (const rule of rules) {
    if (rule.cuentaObjeto && rule.cuentaObjeto !== cuentaObjeto) continue;
    if (rule.cuentaContablePrefix && !cuentaContable.startsWith(rule.cuentaContablePrefix)) continue;
    if (rule.idCuentaFrom != null || rule.idCuentaTo != null) {
      const n = Number(idCuenta);
      if (!Number.isFinite(n)) continue;
      if (rule.idCuentaFrom != null && n < rule.idCuentaFrom) continue;
      if (rule.idCuentaTo != null && n > rule.idCuentaTo) continue;
    }
    return rule.mapping;
  }
  // Sólo advierte cuando hay reglas configuradas: con el catálogo vacío el
  // comportamiento es idéntico al previo y no tiene sentido inundar la consola.
  if (rules.length > 0 && cuentaContable && !warnedAccounts.has(cuentaContable)) {
    warnedAccounts.add(cuentaContable);
    console.warn(
      `[gl-flow-catalog] cuenta contable sin mapeo: ${cuentaContable} `
      + `(objeto ${cuentaObjeto}) — cae al fallback por proveedor/concepto.`,
    );
  }
  return undefined;
}

/** Sólo para tests: limpia la cache de advertencias. */
export function __resetGlFlowWarnings(): void {
  warnedAccounts.clear();
}
