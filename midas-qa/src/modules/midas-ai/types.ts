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

export interface MidasContext {
  cia: string;
  asOfDate: string;
  forecastSummary: ProjectionSummary;
  upcomingMovements: Pick<
    FinancialMovement,
    'id' | 'concept' | 'type' | 'category' | 'projectedAmount' | 'projectedDate' | 'counterpartyName' | 'counterpartyId'
  >[];
  suppliers: MidasSupplierContext[];
  existingAdjustmentsCount: number;
  activeScenarioId: string;
  activeScenarioKind: string;
}
