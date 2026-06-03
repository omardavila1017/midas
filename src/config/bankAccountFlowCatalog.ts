/**
 * Catálogo declarativo: rol/subRol de la CUENTA DE BANCO → categoría de flujo.
 *
 * Tercera señal de categorización del histórico, derivada del catálogo de
 * cuentas de banco que YA existe (`src/assets/bankAccountsCatalog.json`,
 * `src/domain/bankAccountsCatalog.ts`). Ese catálogo ya clasifica cada cuenta
 * (`role` + `subRole` + `flow` + `unidadNegocio`) y el motor ya lo usa para la
 * *subcategoría*; aquí lo promovemos a *categoría* de tope para el lado de
 * EGRESOS. Cierra el hueco que `GL_FLOW_RULES` (rangos del plan de cuentas)
 * pretendía llenar — sin pedir datos nuevos: el propósito de la cuenta ya es la
 * verdad ("una pagadora de proveedores paga proveedores").
 *
 * Sólo EGRESOS: los ingresos ya se bucketizan por `resolveInflowSubcategory`
 * (concentradora → AC/Federal/Citi/Viajes Especiales…). Cuentas neutras
 * (reserva/por_cancelar/garantía) ya se excluyen como internas aguas arriba.
 *
 * Precedencia (ver `historicalReconciledEngine.ts`): cobranza-factura >
 * pagoProveedor > proveedor por monto > tipo_docto > cuenta contable (GL) >
 * **rol de cuenta de banco (este catálogo)** > impuesto-por-concepto > TRANSFER.
 * Por eso una cuenta MIXTA "Proveedores y Nómina" se mapea aquí a AP_PAYMENT,
 * pero el tipo_docto (T1/PQ/P8, de mayor precedencia) levanta la nómina real a
 * PAYROLL — la cuenta mixta no fuerza mal.
 *
 * Sólo reescribe `category` — nunca monto/fecha (invariante en totales).
 */

import type { GlFlowMapping } from './glAccountFlowCatalog';

/**
 * `role|subRole` → categoría, sólo para cuentas de EGRESO de propósito claro.
 * Cuentas ambiguas (`dotacion_efectivo`, `dolares`) se dejan SIN mapear a
 * propósito → caen al tipo_docto o a TRANSFER.
 */
const BANK_ACCOUNT_OUTFLOW_FLOW: Record<string, GlFlowMapping> = {
  // "PAGADORA - PROVEEDORES CM" — puras de proveedores.
  'pagadora|proveedores': { category: 'AP_PAYMENT', label: 'Pagadora de proveedores' },
  // "PAGADORA - PROVEEDORES Y NOMINA" — mixtas. Default AP; el tipo_docto
  // (T1/PQ/P8), de mayor precedencia, levanta la nómina real a PAYROLL.
  'pagadora|proveedores_nomina': { category: 'AP_PAYMENT', label: 'Pagadora de proveedores y nómina' },
};

/**
 * Resuelve la categoría de flujo para un EGRESO a partir del rol/subRol de su
 * cuenta de banco. Regresa `undefined` cuando la cuenta no está en el
 * subconjunto de propósito claro (el caller cae a su lógica previa).
 * `rules` es inyectable para tests herméticos.
 */
export function resolveCategoryForBankAccountRole(
  role: string | null | undefined,
  subRole: string | null | undefined,
  rules: Record<string, GlFlowMapping> = BANK_ACCOUNT_OUTFLOW_FLOW,
): GlFlowMapping | undefined {
  if (!role) return undefined;
  return rules[`${role}|${subRole ?? ''}`];
}
