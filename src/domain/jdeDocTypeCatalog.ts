/**
 * Catálogo de tipos de documento JDE (`Tipo_Docto`) relevantes para el
 * libro mayor de cuentas de banco/caja. Subconjunto curado del catálogo
 * completo "Tipos de documentos" de JDE — cubre los documentos que aparecen
 * posteados contra objeto 1010-1020. Para códigos fuera de la lista,
 * `describeDocType` devuelve el código crudo.
 *
 * Fuente: Excel "Cruces y APIs.xlsx" · hoja "Tipos de documentos".
 */
const DOC_TYPE_DESC: Record<string, string> = {
  // Cobranza / ingresos
  RI: 'Factura',
  RC: 'Cobros - CC',
  RK: 'Cobro - resumido',
  RY: 'Cobro EDI',
  RU: 'Efectivo no aplicado',
  RP: 'Pagos directos',
  R7: 'Cobro en moneda alternativa',
  RB: 'Contracargo',
  RA: 'Nota crédito',
  RM: 'Nota crédito',
  RF: 'Cargo financiero',
  RV: 'Fondos insuficientes',
  RG: 'Pérdida/ganancia tipo cambio',
  RR: 'Factura recurrente',
  // Cuentas por pagar / egresos
  P: 'Cuentas por pagar',
  PN: 'Cheque manual',
  PO: 'Cheque nulo',
  PK: 'Cheques automatizados',
  PV: 'Comprobante',
  P9: 'Comprobante',
  PM: 'Comprobante manual',
  PD: 'Nota débito',
  PE: 'Cambio importe comprobante',
  PG: 'Pérdida/ganancia tipo cambio',
  PY: 'Orden de pago: sólo EDI',
  PB: 'BACS - transferencia electrónica de fondos',
  P7: 'Pago en moneda alternativa',
  PR: 'Comprobante recurrente',
  PW: 'Retención',
  PZ: 'Contabilidad caja C/P',
  // Asientos / contabilidad general
  JE: 'Asientos diario',
  JT: 'Impuestos / registro de IVA y comisión',
  JZ: 'Asiento diario contabilidad caja',
  JG: 'Ajustes por conciliación bancaria',
  JA: 'Asignación presupuesto o costo',
  JX: 'Revaluación moneda extranjera',
  AE: 'Asientos automáticos',
  AF: 'Asientos de ajuste',
  CZ: 'Contabilidad caja',
  T1: 'Asientos desembolso nómina',
  BA: 'Ajustes facturación',
  EX: 'Compensación conversión moneda',
};

/** Descripción del tipo de documento JDE; cae al código crudo si no se conoce. */
export function describeDocType(tipoDocto: string | null | undefined): string {
  const code = (tipoDocto ?? '').trim().toUpperCase();
  if (!code) return '';
  return DOC_TYPE_DESC[code] ?? code;
}
