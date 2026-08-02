import { buildFinancialProjectionSourceData } from '../modules/financial-projection/services/financialProjectionService';
import { takeCitiAttributionDiagnostics } from '../modules/shared-finance/calculation-engine/canonicalProjection';
import type {
  FinancialProjectionSourceWorkerRequest,
  FinancialProjectionSourceWorkerResponse,
} from './financialProjectionSourceWorkerTypes';

self.onmessage = (event: MessageEvent<FinancialProjectionSourceWorkerRequest>) => {
  const { jobId, input } = event.data;
  const t0 = performance.now();
  performance.mark?.(`projectionSource:${jobId}:start`);
  // eslint-disable-next-line no-console
  console.info(`[financialProjection.worker] start jobId=${jobId} cxp=${input.cxpRecords.length} cobranza=${input.cobranzaRecords?.length ?? 0} rol=${input.rolRecords?.length ?? 0} payroll=${input.payrollCosts?.length ?? 0} purchaseReceipts=${input.purchaseReceipts?.length ?? 0} bankStmts=${input.bankStatements.length}`);
  try {
    const result = buildFinancialProjectionSourceData(input);
    const elapsed = performance.now() - t0;
    performance.mark?.(`projectionSource:${jobId}:end`);
    performance.measure?.(`projectionSource:${jobId}`, `projectionSource:${jobId}:start`, `projectionSource:${jobId}:end`);
    // eslint-disable-next-line no-console
    console.info(`[financialProjection.worker] done jobId=${jobId} ${elapsed.toFixed(0)}ms · movements=${result.movements.length} suppliers=${result.suppliers.length} customers=${result.customers.length}`);
    // Sin `window` en el worker, la publicación del motor es no-op: el
    // diagnóstico viaja en el sobre para que el hub lo republique.
    const citiDiagnostics = takeCitiAttributionDiagnostics() ?? undefined;
    const response: FinancialProjectionSourceWorkerResponse = { jobId, result, citiDiagnostics };
    self.postMessage(response);
  } catch (error) {
    const elapsed = performance.now() - t0;
    // Un fallo posterior al prorrateo deja el buzón lleno: se descarta para que
    // el siguiente job no reporte como suyo el diagnóstico de esta corrida.
    takeCitiAttributionDiagnostics();
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
