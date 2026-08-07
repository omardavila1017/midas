import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FinancialProjectionSourceData, FinancialProjectionSourceInput } from './financialProjectionService';
import {
  __clearFinancialProjectionPersistentCacheForTests,
  loadProjectionSourceFromPersistentCache,
  saveProjectionSourceToPersistentCache,
} from './financialProjectionPersistentCache';

describe('financialProjectionPersistentCache', () => {
  beforeEach(() => {
    localStorage.clear();
    __clearFinancialProjectionPersistentCacheForTests();
  });

  it('roundtrips projection source data without storing the payload in localStorage', async () => {
    const input = projectionInput({ startingBalance: 10_000 });
    const source = projectionSource('heavy-source-marker');

    saveProjectionSourceToPersistentCache(input, source);

    await expect(loadProjectionSourceFromPersistentCache(input)).resolves.toEqual(source);
    expect(allLocalStorageText()).not.toContain('heavy-source-marker');
  });

  it('misses when a source fingerprint changes', async () => {
    const input = projectionInput({ startingBalance: 10_000 });
    saveProjectionSourceToPersistentCache(input, projectionSource('cached'));

    await expect(loadProjectionSourceFromPersistentCache(projectionInput({ startingBalance: 20_000 }))).resolves.toBeNull();
  });

  it('returns null when IndexedDB has no saved metadata', async () => {
    await expect(loadProjectionSourceFromPersistentCache(projectionInput({ startingBalance: 10_000 }))).resolves.toBeNull();
  });

  // Lo persistido son SALIDAS del motor con una llave que sólo describe los
  // INPUTS: un fix del motor (prorrateo Citi, PR #239) no movía la llave y la
  // entrada pre-fix seguía sirviéndose tras el deploy. La identidad del motor
  // (hash del código, `BUILD_ID`) entra en la llave para que un cambio de
  // código invalide las salidas viejas. NO se usa la versión de app: el deploy
  // real recibe los archivos sin `.git` y esa versión queda congelada.
  it('namespaces the keys by build id so a code change invalidates engine output', async () => {
    const input = projectionInput({ startingBalance: 10_000 });

    const keys: { source: string; run: string; forecast: string }[] = [];
    for (const buildId of ['a1b2c3d4e5f6', 'f6e5d4c3b2a1']) {
      vi.resetModules();
      vi.doMock('../../../config/buildId', () => ({ BUILD_ID: buildId }));
      const mod = await import('./financialProjectionPersistentCache');
      keys.push({
        source: mod.projectionSourcePersistentCacheKey(input),
        run: mod.scenarioRunPersistentCacheKey('raw'),
        forecast: mod.probabilisticForecastPersistentCacheKey('raw'),
      });
    }

    expect(keys[0].source).not.toBe(keys[1].source);
    expect(keys[0].run).not.toBe(keys[1].run);
    expect(keys[0].forecast).not.toBe(keys[1].forecast);
    vi.doUnmock('../../../config/buildId');
    vi.resetModules();
  });

  // El cruce PagoProveedor ↔ CARGO decide el bucket del egreso HISTÓRICO, así
  // que tiene que mover la llave. `size` solo NO alcanza: el motor de pagos
  // cierra marcando ORPHAN todo CARGO no asignado, de modo que el tamaño del
  // mapa es el conteo de CARGOs del banco y no dice nada de los pagos — con más
  // pagos cruzados sobre los MISMOS estados de cuenta la llave no se movía y
  // IDB servía la entrada vieja, sin clasificar.
  describe('cruce PagoProveedor ↔ CARGO en la llave', () => {
    const cargoMap = (entries: Array<'MATCHED' | 'ORPHAN'>) =>
      new Map(entries.map((status, i) => [
        `k${i}`,
        status === 'MATCHED'
          ? { status, payments: [{ nombreProveedor: 'PROVEEDOR', importe: 1 }] }
          : { status },
      ]));

    it('mismo tamaño con más CARGOs cruzados NO reusa la entrada anterior', async () => {
      const antes = {
        ...projectionInput({ startingBalance: 10_000 }),
        paymentCargoEnrichments: cargoMap(['MATCHED', 'ORPHAN', 'ORPHAN']),
      };
      const despues = {
        ...projectionInput({ startingBalance: 10_000 }),
        paymentCargoEnrichments: cargoMap(['MATCHED', 'MATCHED', 'ORPHAN']),
      };

      saveProjectionSourceToPersistentCache(antes, projectionSource('sin-clasificar'));

      // El caso positivo (misma huella → sí pega) lo fija el test de abajo, así
      // que este null es "la llave se movió", no "el cache nunca sirve nada".
      await expect(loadProjectionSourceFromPersistentCache(despues)).resolves.toBeNull();
    });

    it('el mismo cruce sigue pegando (la huella es estable)', async () => {
      const input = () => ({
        ...projectionInput({ startingBalance: 10_000 }),
        paymentCargoEnrichments: cargoMap(['MATCHED', 'ORPHAN']),
      });

      saveProjectionSourceToPersistentCache(input(), projectionSource('clasificado'));

      await expect(loadProjectionSourceFromPersistentCache(input())).resolves.toEqual(
        projectionSource('clasificado'),
      );
    });
  });

  // La llave ya impide servir una entrada de otro motor; esto fija que además
  // se DESECHE el índice, para que no se queden pegadas en disco para siempre.
  it('descarta el índice guardado por un motor anterior', async () => {
    const input = projectionInput({ startingBalance: 10_000 });

    vi.resetModules();
    vi.doMock('../../../config/buildId', () => ({ BUILD_ID: 'motor-viejo' }));
    const viejo = await import('./financialProjectionPersistentCache');
    viejo.saveProjectionSourceToPersistentCache(input, projectionSource('motor-viejo'));
    await Promise.resolve();
    expect(localStorage.getItem('midas.financialProjection.cache.index.v1')).toContain('projection-source:');

    vi.resetModules();
    vi.doMock('../../../config/buildId', () => ({ BUILD_ID: 'motor-nuevo' }));
    const nuevo = await import('./financialProjectionPersistentCache');
    await expect(nuevo.loadProjectionSourceFromPersistentCache(input)).resolves.toBeNull();
    expect(localStorage.getItem('midas.financialProjection.cache.index.v1')).not.toContain('projection-source:');

    vi.doUnmock('../../../config/buildId');
    vi.resetModules();
  });
});

function projectionInput(patch: Partial<FinancialProjectionSourceInput>): FinancialProjectionSourceInput {
  return {
    companyCode: 'all',
    bankStatements: [],
    clients: [],
    providers: [],
    cxpRecords: [],
    assumptions: { year: 2026, globalCompliance: 1, factorajeDays: 30 },
    budget: null,
    startingBalance: patch.startingBalance ?? 0,
    asOfDate: '2026-05-18',
  };
}

function projectionSource(marker: string): FinancialProjectionSourceData {
  return {
    movements: [{
      id: 'm-1',
      sourceSystem: 'FORECAST',
      type: 'INFLOW',
      category: 'AR_COLLECTION',
      counterpartyType: 'CUSTOMER',
      concept: marker,
      currency: 'MXN',
      originalAmount: 1,
      baseAmount: 1,
      projectedAmount: 1,
      projectedDate: '2026-05-18',
      confidenceScore: 80,
      confidenceBand: 'HIGH',
      forecastMethod: 'RULE',
      status: 'PROJECTED_BASE',
      lockState: 'UNLOCKED',
      createdAt: '2026-05-18T00:00:00.000Z',
      updatedAt: '2026-05-18T00:00:00.000Z',
    }],
    scenarios: [],
    adjustments: [],
    suppliers: [],
    customers: [],
    canonical: {
      monthly: [],
      movements: [],
      initialCash: 0,
      fromYearMonth: '2026-05',
      toYearMonth: '2026-05',
      predictive: null,
    },
    paidPurchaseOrderKeys: new Set(),
    hasData: true,
  };
}

function allLocalStorageText(): string {
  const parts: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key) continue;
    parts.push(key, localStorage.getItem(key) ?? '');
  }
  return parts.join('\n');
}
