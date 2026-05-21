import type { Provider } from '../domain/types';
import type {
  AgedRecordLike,
  ScoreOverlay,
} from '../domain/providerDerivation';
import type { ComprasRecord, PagoProveedorRecord } from '../services/jdeTypes';

export interface ProviderDerivationWorkerRequest {
  jobId: number;
  agedBalanceRecords: AgedRecordLike[];
  comprasRecords: ComprasRecord[];
  pagoProveedorRecords: PagoProveedorRecord[];
  scoreOverlay?: ScoreOverlay;
}

export interface ProviderDerivationWorkerResponse {
  jobId: number;
  result?: Provider[];
  error?: string;
}
