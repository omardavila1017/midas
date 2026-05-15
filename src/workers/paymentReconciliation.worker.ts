import { reconcilePayments } from '../domain/paymentReconciliationEngine';
import type {
  PaymentReconciliationWorkerRequest,
  PaymentReconciliationWorkerResponse,
} from './paymentReconciliationWorkerTypes';

self.onmessage = (event: MessageEvent<PaymentReconciliationWorkerRequest>) => {
  const { jobId, payments, cxpRecords, bankStatements } = event.data;
  try {
    const result = reconcilePayments({ payments, cxpRecords, bankStatements });
    const response: PaymentReconciliationWorkerResponse = { jobId, result };
    self.postMessage(response);
  } catch (error) {
    const response: PaymentReconciliationWorkerResponse = {
      jobId,
      error: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(response);
  }
};

export {};
