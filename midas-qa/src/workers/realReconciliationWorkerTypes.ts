import type { BankAccountStatement, CobranzaPayment, CobranzaRecord } from '../services/jdeTypes';
import type { RealReconciliationResult } from '../domain/realReconciliationEngine';

export interface RealReconciliationWorkerRequest {
  jobId: number;
  cobranzaRecords: CobranzaRecord[];
  cobranzaPayments?: CobranzaPayment[];
  bankStatements: BankAccountStatement[];
  ciaFilter?: string[];
}

export interface RealReconciliationWorkerResponse {
  jobId: number;
  result?: RealReconciliationResult;
  error?: string;
}
