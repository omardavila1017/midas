// Clasifica un movimiento bancario CARGO sin match en PagoProveedor a un
// cubo legible para Planeación. Sin esto, cada folio único (`342?20/EI/0977251`,
// etc.) genera su propia fila de "Otros Egresos", saturando la cuadrícula.
//
// Estrategia: regex sobre `concepto + infAdi1 + infAdi2 + infAdi3` en
// mayúsculas. Cuando algún patrón fiscal o bancario empata, devolvemos una
// categoría limpia y un counterpartyName canónico (`SAT — IVA`, `Comisiones
// bancarias`, etc.) para que `planningRowTaxonomy` agrupe por `conceptKey`
// estable. El detalle crudo permanece en `movement.concept` y se muestra al
// abrir la celda — no se carga eagerly.

import type { FinancialMovementCategory } from '../modules/shared-finance/types';

export interface BankConceptClassification {
  category: FinancialMovementCategory;
  subcategory?: string;
  counterpartyName: string;
}

const UNKNOWN: BankConceptClassification = {
  category: 'TRANSFER',
  counterpartyName: 'Sin identificar',
};

type Rule = {
  pattern: RegExp;
  result: BankConceptClassification;
};

const BANK_FEE_RESULT: BankConceptClassification = {
  category: 'OPEX',
  subcategory: 'Bancario',
  counterpartyName: 'Comisiones bancarias',
};

// Comisiones/cargos bancarios. Banamex/Banorte/Santander los mandan en
// concepto o InF_ADI con redacciones distintas ("MANEJO DE CUENTA",
// "ANUALIDAD TARJETA", "CARGO POR SERVICIO", "CHEQUE DEVUELTO", abreviado
// "COMIS"). Sin cubrir las variantes, miles de CARGOs sin match a proveedor
// caen a "Otros egresos" (TRANSFER). `\b` y los sufijos acotados
// (ANUALIDAD/REPOSICION sólo con TARJETA/CUENTA) evitan tragarse pagos
// reales (p.ej. "ANUALIDAD SEGURO").
const BANK_FEE_PATTERN =
  /\bCOMISI[OÓ]N|\bCOMIS\b|MANEJO\s+(?:DE\s+)?(?:CUENTA|CTA)|MEMBRES[IÍ]A|ANUALIDAD\s+(?:DE\s+)?(?:TARJETA|CUENTA)|CARGO\s+POR\s+SERVICIOS?|CHEQUE\s+DEVUELTO|REPOSICI[OÓ]N\s+(?:DE\s+)?TARJETA/i;

// Orden importa: reglas específicas (IEPS antes que IVA, INFONAVIT antes que
// patrones genéricos) primero. `\b` para evitar falsos positivos en cadenas
// pegadas (`SERVIVA` no debe empatar `IVA`).
const RULES: Rule[] = [
  // IVA sobre comisión bancaria — ANTES que la regla de IVA fiscal, si no
  // "IVA COMISION" se etiquetaría como SAT — IVA. Requiere IVA + token de
  // comisión, así "PAGO IVA MAYO" (sin comisión) sigue cayendo a TAX.
  { pattern: /(?=[\s\S]*\bIVA\b)(?=[\s\S]*(?:\bCOMIS|MANEJO\s+(?:DE\s+)?(?:CUENTA|CTA)|MEMBRES[IÍ]A))/i, result: BANK_FEE_RESULT },
  { pattern: /\bIEPS\b/i, result: { category: 'TAX', subcategory: 'IEPS', counterpartyName: 'SAT — IEPS' } },
  { pattern: /\bISR\b/i, result: { category: 'TAX', subcategory: 'ISR', counterpartyName: 'SAT — ISR' } },
  { pattern: /\bIVA\b/i, result: { category: 'TAX', subcategory: 'IVA', counterpartyName: 'SAT — IVA' } },
  { pattern: /INFONAVIT/i, result: { category: 'TAX', subcategory: 'INFONAVIT', counterpartyName: 'INFONAVIT' } },
  { pattern: /\bIMSS\b|SEGURO\s+SOCIAL/i, result: { category: 'TAX', subcategory: 'IMSS', counterpartyName: 'IMSS' } },
  { pattern: /\bSAT\b|SERVICIO\s+ADMINISTRACI[OÓ]N\s+TRIBUTARIA/i, result: { category: 'TAX', subcategory: 'SAT', counterpartyName: 'SAT — Otros' } },
  { pattern: BANK_FEE_PATTERN, result: BANK_FEE_RESULT },
  { pattern: /INTERES|INTER[EÉ]S|RENDIMIENTO/i, result: { category: 'OPEX', subcategory: 'Bancario', counterpartyName: 'Intereses bancarios' } },
  { pattern: /N[OÓ]MINA|PAGO\s+EMPLEADO|SUELDOS/i, result: { category: 'PAYROLL', counterpartyName: 'Nómina (banco)' } },
];

export function classifyBankConcept(parts: {
  concepto?: string | null;
  infAdi1?: string | null;
  infAdi2?: string | null;
  infAdi3?: string | null;
}): BankConceptClassification {
  const haystack = [parts.concepto, parts.infAdi1, parts.infAdi2, parts.infAdi3]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join(' | ')
    .toUpperCase();
  if (!haystack) return UNKNOWN;
  for (const rule of RULES) {
    if (rule.pattern.test(haystack)) return rule.result;
  }
  return UNKNOWN;
}
