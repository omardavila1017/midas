import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ViajeEspecialRecord } from '../../../services/jdeTypes';
import type { FinancialProjectionSourceData, FinancialProjectionSourceInput } from './financialProjectionService';
import {
  __clearFinancialProjectionPersistentCacheForTests,
  loadProjectionSourceFromPersistentCache,
  projectionSourcePersistentCacheKey,
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

  // Viajes Especiales emite INGRESO real (`cxc:especial:viaje:` con
  // Fecha_Factura + Dias_Credito del API) y re-etiqueta los `cxc:` cruzados, así
  // que mueve el DINERO de la proyección y tiene que mover la llave. La colección
  // se upsertea por `kRenta`, de modo que hacen falta las dos señales: el conteo
  // (viajes que entran/salen, incl. el backfill de años previos) y los facturados
  // (un viaje re-fetcheado que ya se facturó reemplaza al anterior EN SITIO — el
  // conteo no se mueve pero cambia su bucket y su fecha proyectada).
  describe('Viajes Especiales en la llave', () => {
    const viaje = (kRenta: number, facturaJDE?: string): ViajeEspecialRecord => ({
      cia: '00011',
      empresaCodigo: 'SIRS2',
      kRenta,
      kCliente: 900,
      dCliente: 'CLIENTE ESPECIAL',
      rfc: 'AAA010101AAA',
      claveJDE: '12345',
      totalNegociado: 1_000,
      diasCredito: 30,
      facturaJDE,
      fechaFactura: facturaJDE ? '2026-05-10' : undefined,
    });

    it('los viajes que aterrizan después NO reusan la entrada previa', async () => {
      const sinViajes = projectionInput({ startingBalance: 10_000 });
      const conViajes = {
        ...projectionInput({ startingBalance: 10_000 }),
        viajesEspecialesRecords: [viaje(1), viaje(2)],
      };

      saveProjectionSourceToPersistentCache(sinViajes, projectionSource('sin-viajes'));

      await expect(loadProjectionSourceFromPersistentCache(conViajes)).resolves.toBeNull();
    });

    it('mismo conteo con un viaje ya facturado NO reusa la entrada previa', async () => {
      const antes = {
        ...projectionInput({ startingBalance: 10_000 }),
        viajesEspecialesRecords: [viaje(1), viaje(2)],
      };
      const despues = {
        ...projectionInput({ startingBalance: 10_000 }),
        viajesEspecialesRecords: [viaje(1, 'RI-301306'), viaje(2)],
      };

      saveProjectionSourceToPersistentCache(antes, projectionSource('sin-facturar'));

      await expect(loadProjectionSourceFromPersistentCache(despues)).resolves.toBeNull();
    });

    // El caso positivo: los dos `null` de arriba son "la llave se movió", no
    // "el cache nunca sirve nada".
    it('la misma colección sigue pegando (la huella es estable)', async () => {
      const input = () => ({
        ...projectionInput({ startingBalance: 10_000 }),
        viajesEspecialesRecords: [viaje(1, 'RI-301306'), viaje(2)],
      });

      saveProjectionSourceToPersistentCache(input(), projectionSource('con-viajes'));

      await expect(loadProjectionSourceFromPersistentCache(input())).resolves.toEqual(
        projectionSource('con-viajes'),
      );
    });
  });

  // GUARDRAIL de la clase de defecto, no de un campo.
  //
  // Lo persistido son SALIDAS del motor bajo una llave que describe los INPUTS,
  // así que un input que NO participa en la llave hace que IDB le sirva al
  // tablero una entrada construida sin él — silenciosamente, sin error y sin
  // test rojo. Ya pasó tres veces: `enablePredictive` (PR #253, en el memo pero
  // no aquí), `paymentCargoEnrichments` (PR #264, ausente hasta que la
  // clasificación JDE del egreso histórico dejó de llegar) y
  // `viajesEspecialesRecords` (hoy, con la interfaz afirmando que sí estaba).
  //
  // La cadena que lo hace imposible de olvidar: `Required<…>` obliga a poblar
  // todo campo nuevo de la interfaz en `FULL_INPUT` (typecheck rojo), el mapped
  // type de `MUTATIONS` obliga a registrarle una mutación (typecheck rojo) y
  // este `it.each` obliga a que esa mutación mueva la llave (test rojo). El
  // orden importa: se rompe al AGREGAR el input, no meses después.
  describe('todo input del motor mueve la llave', () => {
    it.each(Object.keys(MUTATIONS) as Array<keyof FullProjectionInput>)(
      'cambiar %s invalida la entrada persistida',
      (field) => {
        const base = projectionSourcePersistentCacheKey(FULL_INPUT);
        const mutated = projectionSourcePersistentCacheKey(MUTATIONS[field](FULL_INPUT));

        expect(mutated).not.toBe(base);
      },
    );
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

/**
 * `Required<>` es la primera compuerta del guardrail: un campo nuevo en
 * `FinancialProjectionSourceInput` deja de compilar aquí hasta poblarse.
 */
type FullProjectionInput = Required<FinancialProjectionSourceInput>;

/** Los helpers de huella son defensivos (`?? []`, `typeof`), así que un record
 *  parcial es suficiente para probar que el campo participa en la llave. */
const rec = <T,>(partial: Partial<T>): T => partial as T;

const FULL_INPUT: FullProjectionInput = {
  companyCode: 'all',
  bankStatements: [],
  clients: [],
  providers: [],
  cxpRecords: [],
  cobranzaRecords: [],
  rolRecords: [],
  viajesEspecialesRecords: [],
  purchaseReceipts: [],
  payrollCosts: [],
  auxiliarReconciliation: rec<NonNullable<FinancialProjectionSourceInput['auxiliarReconciliation']>>({
    lines: [],
    bankOrphans: [],
  }),
  paymentCargoEnrichments: new Map(),
  assumptions: { year: 2026, globalCompliance: 1, factorajeDays: 30 },
  budget: null,
  startingBalance: 0,
  asOfDate: '2026-05-18',
  enablePredictive: true,
};

/**
 * Segunda compuerta: el mapped type obliga a registrar una mutación por cada
 * campo de la interfaz. Cada una debe mover la llave (tercera compuerta, el
 * `it.each`).
 */
const MUTATIONS: { [K in keyof FullProjectionInput]: (input: FullProjectionInput) => FullProjectionInput } = {
  companyCode: (i) => ({ ...i, companyCode: '00011' }),
  bankStatements: (i) => ({
    ...i,
    bankStatements: [rec<FullProjectionInput['bankStatements'][number]>({ cia: '00011', cuenta: '123', saldoFinal: 1 })],
  }),
  clients: (i) => ({ ...i, clients: [rec<FullProjectionInput['clients'][number]>({ id: 'c-1', name: 'CLIENTE' })] }),
  providers: (i) => ({ ...i, providers: [rec<FullProjectionInput['providers'][number]>({ id: 'p-1', name: 'PROVEEDOR' })] }),
  cxpRecords: (i) => ({ ...i, cxpRecords: [rec<FullProjectionInput['cxpRecords'][number]>({ cia: '00011', noFactura: 'F-1' })] }),
  cobranzaRecords: (i) => ({
    ...i,
    cobranzaRecords: [rec<FullProjectionInput['cobranzaRecords'][number]>({ cia: '00011', noFactura: 'RI-1' })],
  }),
  rolRecords: (i) => ({ ...i, rolRecords: [rec<FullProjectionInput['rolRecords'][number]>({ cia: '00011' })] }),
  viajesEspecialesRecords: (i) => ({
    ...i,
    viajesEspecialesRecords: [rec<FullProjectionInput['viajesEspecialesRecords'][number]>({ cia: '00011', kRenta: 1 })],
  }),
  purchaseReceipts: (i) => ({
    ...i,
    purchaseReceipts: [rec<FullProjectionInput['purchaseReceipts'][number]>({ cia: '00011', purchaseOrderNo: 'OC-1' })],
  }),
  payrollCosts: (i) => ({
    ...i,
    payrollCosts: [rec<FullProjectionInput['payrollCosts'][number]>({ cia: '00011', year: 2026, month: 5 })],
  }),
  auxiliarReconciliation: (i) => ({
    ...i,
    auxiliarReconciliation: rec<NonNullable<FinancialProjectionSourceInput['auxiliarReconciliation']>>({
      lines: [rec<NonNullable<FinancialProjectionSourceInput['auxiliarReconciliation']>['lines'][number]>({})],
      bankOrphans: [],
    }),
  }),
  paymentCargoEnrichments: (i) => ({
    ...i,
    paymentCargoEnrichments: new Map([
      ['k0', rec<NonNullable<FullProjectionInput['paymentCargoEnrichments']> extends Map<string, infer V> ? V : never>({
        status: 'MATCHED',
        payments: [{ nombreProveedor: 'PROVEEDOR', importe: 1 }],
      })],
    ]),
  }),
  assumptions: (i) => ({ ...i, assumptions: { ...i.assumptions, year: 2027 } }),
  budget: (i) => ({
    ...i,
    budget: rec<NonNullable<FullProjectionInput['budget']>>({ year: 2026, uploadedAt: '2026-05-18T00:00:00.000Z' }),
  }),
  startingBalance: (i) => ({ ...i, startingBalance: 1 }),
  asOfDate: (i) => ({ ...i, asOfDate: '2026-05-19' }),
  enablePredictive: (i) => ({ ...i, enablePredictive: false }),
};

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
