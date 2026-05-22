import type { AuxiliarContableRecord, BankAccountStatement } from '../services/jdeTypes';
import type { AuxiliarReconResult } from '../domain/auxiliarReconciliationEngine';

export interface AuxiliarReconciliationWorkerRequest {
  jobId: number;
  records: AuxiliarContableRecord[];
  bankStatements: BankAccountStatement[];
  ciaFilter?: string[];
}

export interface AuxiliarReconciliationWorkerResponse {
  jobId: number;
  result?: AuxiliarReconResult;
  error?: string;
}
