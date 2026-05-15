import type {
  FinancialProjectionSourceData,
  FinancialProjectionSourceInput,
} from '../modules/financial-projection/services/financialProjectionService';

export interface FinancialProjectionSourceWorkerRequest {
  jobId: number;
  input: FinancialProjectionSourceInput;
}

export interface FinancialProjectionSourceWorkerResponse {
  jobId: number;
  result?: FinancialProjectionSourceData;
  error?: string;
}
