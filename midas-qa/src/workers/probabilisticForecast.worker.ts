import { buildProbabilisticForecast } from '../modules/shared-finance/calculation-engine/probabilisticForecastEngine';
import type {
  ProbabilisticForecastRequest,
  ProbabilisticForecastResponse,
} from '../modules/shared-finance/types';

self.onmessage = (event: MessageEvent<ProbabilisticForecastRequest>) => {
  try {
    const result = buildProbabilisticForecast(event.data);
    const response: ProbabilisticForecastResponse = {
      jobId: event.data.jobId,
      result,
    };
    self.postMessage(response);
  } catch (error) {
    const response: ProbabilisticForecastResponse = {
      jobId: event.data.jobId,
      error: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(response);
  }
};

export {};
