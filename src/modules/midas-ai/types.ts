import type {
  FinancialAdjustment,
  FinancialMovement,
  ProjectionSummary,
} from '../shared-finance/types';

export type MidasRole = 'user' | 'midas' | 'system';

export interface MidasProposalDraft {
  name: string;
  type: FinancialAdjustment['type'];
  targetType: FinancialAdjustment['targetType'];
  targetExpression: string;
  reasonCode: FinancialAdjustment['reasonCode'];
  justification: string;
  deltaAmount?: number;
  deltaDays?: number;
  percentageChange?: number;
  adjustedValue?: unknown;
}

export interface MidasProposalSuggestion {
  id: string;
  draft: MidasProposalDraft;
  estimatedCashImpact: number;
  citedSuppliers: string[];
}

export interface MidasMessage {
  id: string;
  role: MidasRole;
  content: string;
  proposals?: MidasProposalSuggestion[];
  timestamp: string;
  error?: string;
}

export interface MidasSupplierContext {
  id: string;
  name: string;
  risk: string;
  flexibility: string;
  pendingAmount: number;
  staleDays?: number;
  priority?: string;
}

/** Agregado por periodo del run activo (bucket) — habilita análisis de
 *  tendencias, comparación de periodos y detección de outliers sin mandar
 *  los movimientos crudos. */
export interface MidasBucketContext {
  date: string;
  label: string;
  inflows: number;
  outflows: number;
  net: number;
  closingCash: number;
  deficit: number;
}

/** Alerta ya detectada por el motor de proyección — la IA la explica y
 *  prioriza, no la re-detecta. */
export interface MidasAlertContext {
  date: string;
  severity: 'INFO' | 'WARNING' | 'CRITICAL';
  title: string;
  description: string;
}

export interface MidasContext {
  cia: string;
  asOfDate: string;
  forecastSummary: ProjectionSummary;
  upcomingMovements: Pick<
    FinancialMovement,
    'id' | 'concept' | 'type' | 'category' | 'projectedAmount' | 'projectedDate' | 'counterpartyName' | 'counterpartyId'
  >[];
  suppliers: MidasSupplierContext[];
  buckets: MidasBucketContext[];
  alerts: MidasAlertContext[];
  existingAdjustmentsCount: number;
  activeScenarioId: string;
  activeScenarioKind: string;
}
