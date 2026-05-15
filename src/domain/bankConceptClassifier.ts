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

// Orden importa: reglas específicas (IEPS antes que IVA, INFONAVIT antes que
// patrones genéricos) primero. `\b` para evitar falsos positivos en cadenas
// pegadas (`SERVIVA` no debe empatar `IVA`).
const RULES: Rule[] = [
  { pattern: /\bIEPS\b/i, result: { category: 'TAX', subcategory: 'IEPS', counterpartyName: 'SAT — IEPS' } },
  { pattern: /\bISR\b/i, result: { category: 'TAX', subcategory: 'ISR', counterpartyName: 'SAT — ISR' } },
  { pattern: /\bIVA\b/i, result: { category: 'TAX', subcategory: 'IVA', counterpartyName: 'SAT — IVA' } },
  { pattern: /INFONAVIT/i, result: { category: 'TAX', subcategory: 'INFONAVIT', counterpartyName: 'INFONAVIT' } },
  { pattern: /\bIMSS\b|SEGURO\s+SOCIAL/i, result: { category: 'TAX', subcategory: 'IMSS', counterpartyName: 'IMSS' } },
  { pattern: /\bSAT\b|SERVICIO\s+ADMINISTRACI[OÓ]N\s+TRIBUTARIA/i, result: { category: 'TAX', subcategory: 'SAT', counterpartyName: 'SAT — Otros' } },
  { pattern: /COMISI[OÓ]N|COMISION/i, result: { category: 'OPEX', subcategory: 'Bancario', counterpartyName: 'Comisiones bancarias' } },
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
