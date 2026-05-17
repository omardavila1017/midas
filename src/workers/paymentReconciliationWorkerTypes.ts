import type { BankAccountStatement } from '../services/jdeTypes';
import type { CXPRecord } from '../domain/persistence';
import type { PagoProveedorRecord } from '../services/jdeTypes';
import type { PaymentReconciliationResult } from '../domain/paymentReconciliationEngine';

export interface PaymentReconciliationWorkerRequest {
  jobId: number;
  payments: PagoProveedorRecord[];
  cxpRecords: CXPRecord[];
  bankStatements: BankAccountStatement[];
}

export interface PaymentReconciliationWorkerResponse {
  jobId: number;
  result?: PaymentReconciliationResult;
  error?: string;
}
