import type {
  FinancialProjectionSourceData,
  FinancialProjectionSourceInput,
} from '../modules/financial-projection/services/financialProjectionService';
import type { CitiAttributionDiagnostic } from '../modules/shared-finance/calculation-engine/canonicalProjection';

export interface FinancialProjectionSourceWorkerRequest {
  jobId: number;
  input: FinancialProjectionSourceInput;
}

export interface FinancialProjectionSourceWorkerResponse {
  jobId: number;
  result?: FinancialProjectionSourceData;
  error?: string;
  /**
   * Diagnóstico del prorrateo Citi de ESTA corrida, para que el hilo principal
   * lo republique en `window.__midas__.citiProrrateo`. Va en el sobre y NO
   * dentro de `result`: `result` se persiste en el cache de proyección y este
   * dato es de la corrida, no del contenido. Ausente cuando el job pegó en el
   * memo (el motor no volvió a correr) o cuando no hubo depósitos Citi.
   */
  citiDiagnostics?: CitiAttributionDiagnostic[];
}
