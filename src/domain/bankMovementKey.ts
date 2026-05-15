import type { BankStatementLine } from '../services/jdeTypes';

/** Stable key for a bank movement shared by reconciliation engines and UI indexes. */
export function bankMovementKey(mov: BankStatementLine): string {
  return [
    mov.cia,
    mov.cuenta,
    mov.fechaOperacion,
    mov.referencia,
    mov.tipoMovimiento,
    mov.importe,
    mov.concepto,
  ].join('|');
}
