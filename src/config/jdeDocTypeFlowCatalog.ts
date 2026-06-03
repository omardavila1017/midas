/**
 * Catálogo declarativo: tipo de documento JDE (`Tipo_Docto`) → categoría de flujo.
 *
 * Complementa `glAccountFlowCatalog.ts` (cuenta contable → categoría) con una
 * segunda señal — el tipo de documento — que para el subconjunto que toca
 * efectivo suele ser **más limpia y determinista** que el rango de cuenta:
 * `P*` = pagos a proveedor, `R*` = cobranza, `T1`/`PQ`/`P8` = nómina, `JT` =
 * impuestos, `Q*` = gasto operativo con concepto propio.
 *
 * Fuente: "TIPO_DE_DOCTOS_EN_JDE.xlsx" (catálogo maestro JDE). De ~460 códigos,
 * la mayoría son asientos de inventario/manufactura/diario que NUNCA tocan
 * banco/caja — sólo se mapea el **subconjunto de efectivo de alta confianza**.
 * Lo que NO toca efectivo se deja SIN mapear a propósito (cae al comportamiento
 * previo): `X*` (autorización de presupuesto / bonificaciones), ganancias-
 * pérdidas cambiarias (`PG`/`RG`), efectivo no aplicado / fondos insuficientes
 * (`RU`/`RV`), ajustes de inventario, asientos de diario, etc.
 *
 * Códigos confirmados con el negocio (antes ambiguos): `PU` Comprobación gastos
 * de viaje → OPEX/Viáticos; `PW` Retención de requisiciones no almacenables →
 * TAX (retención al SAT); `RA` Nota de cargo / `RM` Nota de crédito → cobranza;
 * `Q7`/`Q8`/`Q9` IVA suspendido → TAX.
 *
 * Como toda la categorización, **sólo reescribe `category`/`subcategory` — nunca
 * monto/fecha**: es invariante en totales (la caja sigue anclada al banco).
 *
 * Precedencia (ver `historicalReconciledEngine.ts`): cobranza-factura >
 * pagoProveedor > proveedor por monto > **tipo_docto (este catálogo)** >
 * cuenta contable (GL) > impuesto-por-concepto > `TRANSFER`.
 *
 * Restricciones sobre los valores (para que `planningRowTaxonomy` rutee la fila):
 *  - `category` debe ser un `FinancialMovementCategory` real.
 *  - Para OPEX/PAYROLL/TAX, `subcategory` es la etiqueta de fila (concepto).
 *  - Para AP_PAYMENT/AR_COLLECTION NO se fija `subcategory`: la contraparte
 *    (proveedor/cliente) decide la fila.
 */

import type { GlFlowMapping } from './glAccountFlowCatalog';

/**
 * Mapa tipo_docto → categoría de flujo. Sólo el subconjunto de efectivo de alta
 * confianza. Código en MAYÚSCULAS (igual que `Tipo_Docto` normalizado).
 */
export const DOC_TYPE_FLOW: Record<string, GlFlowMapping> = {
  // ── Pagos a proveedor (la contraparte decide la fila → sin subcategory) ──
  P: { category: 'AP_PAYMENT', label: 'Cuentas por pagar' },
  PN: { category: 'AP_PAYMENT', label: 'Cheque manual' },
  PK: { category: 'AP_PAYMENT', label: 'Cheques automatizados' },
  PV: { category: 'AP_PAYMENT', label: 'Comprobante' },
  P9: { category: 'AP_PAYMENT', label: 'Comprobante' },
  PM: { category: 'AP_PAYMENT', label: 'Comprobante manual' },
  PR: { category: 'AP_PAYMENT', label: 'Comprobante recurrente' },
  PY: { category: 'AP_PAYMENT', label: 'Orden de pago EDI' },
  PB: { category: 'AP_PAYMENT', label: 'BACS / transferencia electrónica' },
  P7: { category: 'AP_PAYMENT', label: 'Pago en moneda alternativa' },
  PA: { category: 'AP_PAYMENT', label: 'Reembolsos notas crédito' },
  P1: { category: 'AP_PAYMENT', label: 'Giros C/P' },
  PZ: { category: 'AP_PAYMENT', label: 'Contabilidad caja C/P' },

  // ── Nómina (concepto propio → subcategory) ──
  T1: { category: 'PAYROLL', subcategory: 'Nómina', label: 'Asientos desembolso nómina' },
  PQ: { category: 'PAYROLL', subcategory: 'Aguinaldo', label: 'Aguinaldo' },
  P8: { category: 'PAYROLL', subcategory: 'Bonos despensa', label: 'Bonos despensa' },

  // ── Cobranza (la contraparte/cliente decide la fila → sin subcategory) ──
  RI: { category: 'AR_COLLECTION', label: 'Factura' },
  RC: { category: 'AR_COLLECTION', label: 'Cobros - CC' },
  RK: { category: 'AR_COLLECTION', label: 'Cobro - resumido' },
  RY: { category: 'AR_COLLECTION', label: 'Cobro EDI' },
  R7: { category: 'AR_COLLECTION', label: 'Cobro en moneda alternativa' },
  RP: { category: 'AR_COLLECTION', label: 'Pagos directos' },
  R1: { category: 'AR_COLLECTION', label: 'Giros C/C' },
  RR: { category: 'AR_COLLECTION', label: 'Factura recurrente' },
  RZ: { category: 'AR_COLLECTION', label: 'Contabilidad caja C/C' },
  R2: { category: 'AR_COLLECTION', label: 'Facturación contratos' },
  R3: { category: 'AR_COLLECTION', label: 'Borrador factura' },
  R4: { category: 'AR_COLLECTION', label: 'Factura final' },

  // ── Viáticos (gasto operativo con concepto propio) ──
  PU: { category: 'OPEX', subcategory: 'Viáticos', label: 'Comprobación gastos de viaje' },

  // ── Notas de cargo/crédito (familia R / ajuste de cobranza) ──
  RA: { category: 'AR_COLLECTION', label: 'Nota de cargo' },
  RM: { category: 'AR_COLLECTION', label: 'Nota de crédito' },

  // ── Impuestos ──
  JT: { category: 'TAX', subcategory: 'Impuestos', label: 'Impuestos' },
  // Retención al SAT (confirmado con el negocio): impuesto, no pago a proveedor.
  PW: { category: 'TAX', subcategory: 'Retenciones', label: 'Retención requisiciones no almacenables' },
  Q7: { category: 'TAX', subcategory: 'IVA suspendido', label: 'IVA suspendido - reconocido' },
  Q8: { category: 'TAX', subcategory: 'IVA suspendido', label: 'IVA suspendido y reconocido' },
  Q9: { category: 'TAX', subcategory: 'IVA suspendido', label: 'IVA suspendido' },

  // ── Gasto operativo con concepto propio (fila por concepto dentro de OPEX) ──
  QD: { category: 'OPEX', subcategory: 'Arrendamiento', label: 'Arrendamiento' },
  QF: { category: 'OPEX', subcategory: 'Aseo y limpieza', label: 'Aseo y limpieza de equipo' },
  QL: { category: 'OPEX', subcategory: 'Capacitación', label: 'Capacitación y adiestramiento' },
  Q1: { category: 'OPEX', subcategory: 'Comedores', label: 'Comedores' },
  QU: { category: 'OPEX', subcategory: 'Comisiones sobre ventas', label: 'Comisiones sobre ventas' },
  QB: { category: 'OPEX', subcategory: 'Cuotas y suscripciones', label: 'Cuotas y suscripciones' },
  QQ: { category: 'OPEX', subcategory: 'Donativos', label: 'Donativos' },
};

/**
 * Resuelve la categoría/subcategoría de flujo para un tipo de documento JDE.
 * Regresa `undefined` cuando el código no está en el subconjunto de efectivo
 * mapeado (el caller cae a su lógica previa: cuenta contable / proveedor /
 * concepto / TRANSFER). `rules` es inyectable para tests herméticos.
 */
export function resolveCategoryForDocType(
  tipoDocto: string | null | undefined,
  rules: Record<string, GlFlowMapping> = DOC_TYPE_FLOW,
): GlFlowMapping | undefined {
  const code = (tipoDocto ?? '').trim().toUpperCase();
  if (!code) return undefined;
  return rules[code];
}
