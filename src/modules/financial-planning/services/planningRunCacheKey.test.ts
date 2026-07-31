import { describe, expect, it } from 'vitest';
import type { AuxiliarReconResult } from '../../../domain/auxiliarReconciliationEngine';
import type { CxpPaymentCoverage } from '../../../domain/paymentReconciliationEngine';
import type { Provider } from '../../../domain/types';
import type { CobranzaPayment } from '../../../services/jdeTypes';
import type { TaxStore } from '../../taxes/services/taxModuleService';
import type { FinancialAdjustment, FinancialMovement, ManualPlanningEntry, ProjectionGranularity } from '../../shared-finance/types';
import { projectionWindowFor } from '../../financial-projection/services/projectionWindow';
import {
  PLANNING_DEFAULT_GRANULARITY,
  planningRunCacheKey,
  planningSharedRunInputsKey,
  planningWindowFor,
  type PlanningSharedRunInputs,
} from './planningRunCacheKey';

const movement = (over: Partial<FinancialMovement> = {}): FinancialMovement => ({
  id: 'bank:00150:2026-02-01:1',
  type: 'INFLOW',
  category: 'AR_COLLECTION',
  projectedAmount: 1000,
  date: '2026-02-01',
  status: 'REAL',
  concept: 'Cobro',
  companyId: '00150',
  lockState: 'EDITABLE',
  ...(over as Partial<FinancialMovement>),
} as FinancialMovement);

const taxStore = (over: Partial<TaxStore> = {}): TaxStore => ({
  obligations: [],
  adjustments: [],
  taxRateOverrides: [],
  overdueBalance: 0,
  settings: {},
  ...(over as Partial<TaxStore>),
} as TaxStore);

const baseInputs = (over: Partial<PlanningSharedRunInputs> = {}): PlanningSharedRunInputs => ({
  movements: [movement()],
  adjustments: [],
  manualEntries: [],
  taxStore: taxStore(),
  providers: [],
  cobranzaPayments: undefined,
  bajioStatements: undefined,
  auxiliarReconciliation: undefined,
  cxpPaymentCoverage: undefined,
  yearStart: '2026-01-01',
  yearEnd: '2026-12-31',
  today: '2026-07-31',
  initialCash: 85_800_000,
  supplierInitialCash: 85_800_000,
  minimumCash: 20_000_000,
  granularity: PLANNING_DEFAULT_GRANULARITY,
  ...over,
});

describe('planningSharedRunInputsKey', () => {
  it('is deterministic for the same inputs', () => {
    expect(planningSharedRunInputsKey(baseInputs())).toBe(planningSharedRunInputsKey(baseInputs()));
  });

  it('emits the 16 segments the run key depends on', () => {
    // La llave se dobla dentro de `planningRunCacheKey`. El conteo de tramos es
    // el guardrail: agregar o quitar un input sin pensarlo mueve la llave de
    // TODAS las corridas persistidas (cache miss masivo), y omitir uno hace que
    // dos estados distintos compartan llave (números de otro estado).
    expect(planningSharedRunInputsKey(baseInputs()).split('|')).toHaveLength(16);
  });

  /**
   * Cada input DEBE participar en la llave. Si uno deja de hacerlo, dos estados
   * distintos comparten entrada de cache y Planeación sirve la corrida del
   * estado viejo — el modo de falla caro (números plausibles pero de otro
   * input), no un simple recompute.
   */
  const mutations: Array<[string, Partial<PlanningSharedRunInputs>]> = [
    ['movements', { movements: [movement({ projectedAmount: 2000 })] }],
    ['movements (adjustedAmount)', { movements: [movement({ adjustedAmount: 999 })] }],
    ['adjustments', {
      adjustments: [{ id: 'adj-1', status: 'ACTIVE', createdAt: '2026-07-01' } as unknown as FinancialAdjustment],
    }],
    ['manualEntries', { manualEntries: [{ id: 'man-1', createdAt: '2026-07-01' } as unknown as ManualPlanningEntry] }],
    // Los 4 sub-fingerprints del taxStore van unidos en UN tramo (`taxKey`), así
    // que el conteo de 16 no los protege: si uno deja de participar, la llave
    // sigue teniendo 16 tramos y el resto de la matriz sigue verde.
    ['taxStore.overdueBalance', { taxStore: taxStore({ overdueBalance: 1 }) }],
    ['taxStore.obligations', {
      taxStore: taxStore({
        obligations: [{ id: 'ob-1', pendingAmount: 100, status: 'PENDING', paymentPlan: [] } as never],
      }),
    }],
    ['taxStore.adjustments', {
      taxStore: taxStore({
        adjustments: [{ id: 'tadj-1', kind: 'IVA', amount: 50, createdAt: '2026-07-01' } as never],
      }),
    }],
    ['taxStore.taxRateOverrides', {
      taxStore: taxStore({
        taxRateOverrides: [{ targetType: 'provider', targetKey: 'PROV-1', rate: 0.08, updatedAt: '2026-07-01' } as never],
      }),
    }],
    ['providers', { providers: [{ id: 'prov-1', score: 5 } as Provider] }],
    ['cobranzaPayments', { cobranzaPayments: [{ idPago: 'p1', importeRecibo: 10, pendienteAplicar: 0 } as CobranzaPayment] }],
    ['bajioStatements', {
      bajioStatements: [{ cia: '00033', cuenta: '123', fechaEstadoCuenta: '2026-07-01', movimientos: [] } as never],
    }],
    ['auxiliarReconciliation', {
      auxiliarReconciliation: { summary: { totalLineas: 1 }, lines: [{ cia: '00150', flujo: 'ingreso', matchTier: 'exact', source: { kind: 'cobranza', ref: 'x' }, bankDate: '2026-02-01', fechaContable: '2026-02-01', importe: 1 }] } as unknown as AuxiliarReconResult,
    }],
    ['cxpPaymentCoverage', {
      cxpPaymentCoverage: new Map<string, CxpPaymentCoverage>([
        ['k', { status: 'PAID', totalPaidPesos: 10, payments: [] } as unknown as CxpPaymentCoverage],
      ]),
    }],
    ['yearStart', { yearStart: '2025-01-01' }],
    ['yearEnd', { yearEnd: '2025-12-31' }],
    ['today', { today: '2026-08-01' }],
    ['initialCash', { initialCash: 1 }],
    ['supplierInitialCash', { supplierInitialCash: 1 }],
    ['minimumCash', { minimumCash: 1 }],
    ['granularity', { granularity: 'daily' as ProjectionGranularity }],
  ];

  it.each(mutations)('changes when %s changes', (_label, mutation) => {
    expect(planningSharedRunInputsKey(baseInputs(mutation))).not.toBe(planningSharedRunInputsKey(baseInputs()));
  });
});

describe('planningRunCacheKey', () => {
  const args = {
    scenarioId: 'base',
    includeManualEntries: true,
    sharedRunInputsKey: 'shared',
    customKey: '0',
    overrideKey: '0',
    trendTag: 'trend:0',
    granularity: PLANNING_DEFAULT_GRANULARITY,
  };

  it('pins the persisted key shape', () => {
    expect(planningRunCacheKey(args)).toBe('planning-run:base:m1|shared|0|0|trend:0|g=monthly');
  });

  it('distinguishes manual-entry inclusion, trend and granularity', () => {
    expect(planningRunCacheKey({ ...args, includeManualEntries: false })).toContain(':m0|');
    expect(planningRunCacheKey({ ...args, trendTag: 'trend:1' })).not.toBe(planningRunCacheKey(args));
    expect(planningRunCacheKey({ ...args, granularity: 'weekly' })).toContain('g=weekly');
  });

  /**
   * El precalentado (`preloadPlanningScenarioRuns`) arma la llave con la
   * granularidad DEFAULT y el dashboard con su estado inicial. Si el default se
   * mueve en un lado y no en el otro, el warm-start desde IndexedDB vuelve a
   * quedar inerte en silencio — el defecto que PRs #173→#244 arrastraron.
   */
  it('keeps the preload default aligned with the granularity Planeación opens in', () => {
    expect(PLANNING_DEFAULT_GRANULARITY).toBe('monthly');
  });
});

describe('planningWindowFor', () => {
  const today = '2026-07-31';

  it('monthly es el año natural completo (Planeación arranca en enero)', () => {
    // Difiere a propósito del monthly de Proyección (`today+364`). Si esta regla
    // cambia, tiene que cambiar en UN lugar — antes vivía duplicada entre el
    // precalentado y el memo del dashboard.
    expect(planningWindowFor(today, 'monthly')).toEqual({ yearStart: '2026-01-01', yearEnd: '2026-12-31' });
    expect(planningWindowFor(today, 'monthly')).not.toEqual(projectionWindowFor(today, 'monthly'));
  });

  it('sub-mes delega en la ventana acotada de Proyección', () => {
    // Mantiene ambos dashboards en la misma vista y el conteo de buckets chico
    // (weekly/daily sobre el año entero → OOM del renderer).
    for (const granularity of ['weekly', 'daily'] as ProjectionGranularity[]) {
      expect(planningWindowFor(today, granularity)).toEqual(projectionWindowFor(today, granularity));
    }
  });

  it('da una ventana distinta por granularidad (por qué el pipeline no se reusa al cambiarla)', () => {
    const windows = (['monthly', 'weekly', 'daily'] as ProjectionGranularity[]).map(
      (g) => JSON.stringify(planningWindowFor(today, g)),
    );
    expect(new Set(windows).size).toBe(3);
  });

  /**
   * La ventana es DOS tramos de la llave compartida. El precalentado la arma con
   * la granularidad default y el dashboard con su estado inicial: si divergen,
   * el warm-start desde IndexedDB queda inerte en silencio.
   */
  it('la ventana del precalentado empata la de la granularidad de apertura', () => {
    expect(planningWindowFor(today, PLANNING_DEFAULT_GRANULARITY))
      .toEqual(planningWindowFor(today, 'monthly'));
  });
});
