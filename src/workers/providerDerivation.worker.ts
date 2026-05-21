import { deriveProvidersFromJde } from '../domain/providerDerivation';
import type {
  ProviderDerivationWorkerRequest,
  ProviderDerivationWorkerResponse,
} from './providerDerivationWorkerTypes';

self.onmessage = (event: MessageEvent<ProviderDerivationWorkerRequest>) => {
  const { jobId, agedBalanceRecords, comprasRecords, pagoProveedorRecords, scoreOverlay } = event.data;
  const t0 = performance.now();
  // eslint-disable-next-line no-console
  console.info(`[providerDerivation.worker] start jobId=${jobId} cxp=${agedBalanceRecords.length} compras=${comprasRecords.length} pago=${pagoProveedorRecords.length}`);
  try {
    const result = deriveProvidersFromJde({
      agedBalanceRecords,
      comprasRecords,
      pagoProveedorRecords,
      scoreOverlay,
    });
    const elapsed = performance.now() - t0;
    // eslint-disable-next-line no-console
    console.info(`[providerDerivation.worker] done jobId=${jobId} ${elapsed.toFixed(0)}ms · providers=${result.length}`);
    const response: ProviderDerivationWorkerResponse = { jobId, result };
    self.postMessage(response);
  } catch (error) {
    const elapsed = performance.now() - t0;
    // eslint-disable-next-line no-console
    console.warn(`[providerDerivation.worker] FAILED jobId=${jobId} ${elapsed.toFixed(0)}ms`, error);
    const response: ProviderDerivationWorkerResponse = {
      jobId,
      error: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(response);
  }
};

export {};
