import { reconcileRealCollections } from '../domain/realReconciliationEngine';
import type {
  RealReconciliationWorkerRequest,
  RealReconciliationWorkerResponse,
} from './realReconciliationWorkerTypes';

self.onmessage = (event: MessageEvent<RealReconciliationWorkerRequest>) => {
  const { jobId, cobranzaRecords, cobranzaPayments, bankStatements, ciaFilter } = event.data;
  try {
    const result = reconcileRealCollections(cobranzaRecords, bankStatements, {
      ciaFilter: ciaFilter?.length ? new Set(ciaFilter) : undefined,
      cobranzaPayments,
    });
    const response: RealReconciliationWorkerResponse = { jobId, result };
    self.postMessage(response);
  } catch (error) {
    const response: RealReconciliationWorkerResponse = {
      jobId,
      error: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(response);
  }
};

export {};
