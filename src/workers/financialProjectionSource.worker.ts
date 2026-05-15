import { buildFinancialProjectionSourceData } from '../modules/financial-projection/services/financialProjectionService';
import type {
  FinancialProjectionSourceWorkerRequest,
  FinancialProjectionSourceWorkerResponse,
} from './financialProjectionSourceWorkerTypes';

self.onmessage = (event: MessageEvent<FinancialProjectionSourceWorkerRequest>) => {
  const { jobId, input } = event.data;
  const t0 = performance.now();
  // eslint-disable-next-line no-console
  console.info(`[financialProjection.worker] start jobId=${jobId} cxp=${input.cxpRecords.length} cobranza=${input.cobranzaRecords?.length ?? 0} payroll=${input.payrollCosts?.length ?? 0} purchaseReceipts=${input.purchaseReceipts?.length ?? 0} bankStmts=${input.bankStatements.length}`);
  try {
    const result = buildFinancialProjectionSourceData(input);
    const elapsed = performance.now() - t0;
    // eslint-disable-next-line no-console
    console.info(`[financialProjection.worker] done jobId=${jobId} ${elapsed.toFixed(0)}ms · movements=${result.movements.length} suppliers=${result.suppliers.length} customers=${result.customers.length}`);
    const response: FinancialProjectionSourceWorkerResponse = { jobId, result };
    self.postMessage(response);
  } catch (error) {
    const elapsed = performance.now() - t0;
    // eslint-disable-next-line no-console
    console.warn(`[financialProjection.worker] FAILED jobId=${jobId} ${elapsed.toFixed(0)}ms`, error);
    const response: FinancialProjectionSourceWorkerResponse = {
      jobId,
      error: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(response);
  }
};

export {};
