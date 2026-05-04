import type { BankAccountStatement, CobranzaRecord } from '../services/jdeTypes';
import type { RealReconciliationResult } from '../domain/realReconciliationEngine';

export interface RealReconciliationWorkerRequest {
  jobId: number;
  cobranzaRecords: CobranzaRecord[];
  bankStatements: BankAccountStatement[];
  ciaFilter?: string[];
}

export interface RealReconciliationWorkerResponse {
  jobId: number;
  result?: RealReconciliationResult;
  error?: string;
}
