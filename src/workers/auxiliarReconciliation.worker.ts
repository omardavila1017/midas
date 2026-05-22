import { reconcileAuxiliar } from '../domain/auxiliarReconciliationEngine';
import type {
  AuxiliarReconciliationWorkerRequest,
  AuxiliarReconciliationWorkerResponse,
} from './auxiliarReconciliationWorkerTypes';

self.onmessage = (event: MessageEvent<AuxiliarReconciliationWorkerRequest>) => {
  const { jobId, records, bankStatements, ciaFilter } = event.data;
  try {
    const result = reconcileAuxiliar(records, bankStatements, {
      ciaFilter: ciaFilter?.length ? new Set(ciaFilter) : undefined,
    });
    const response: AuxiliarReconciliationWorkerResponse = { jobId, result };
    self.postMessage(response);
  } catch (error) {
    const response: AuxiliarReconciliationWorkerResponse = {
      jobId,
      error: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(response);
  }
};

export {};
