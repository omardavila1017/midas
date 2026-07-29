import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  saveStore,
  saveLightStore,
  loadStore,
  loadLightStore,
  importStore,
  exportStore,
  getDefaultStore,
  clearStore,
} from './persistence';

describe('persistence v12', () => {
  beforeEach(() => {
    clearStore();
  });

  it('round-trips catalogs and assumptions through save/load', async () => {
    const store = {
      ...getDefaultStore(),
      providers: [{ id: 'prov1', name: 'Prov' } as never],
      clients: [{ id: 'c1', name: 'Cliente' } as never],
    };
    saveStore(store);
    const loaded = await loadStore();
    expect(loaded).not.toBeNull();
    expect(loaded!.providers).toHaveLength(1);
    expect(loaded!.clients).toHaveLength(1);
  });

  it('export/import round-trip', () => {
    const store = getDefaultStore();
    const json = exportStore(store);
    const imported = importStore(json);
    expect(imported.assumptions.year).toBe(store.assumptions.year);
  });

  it('migrates midas-v5 store: drops proposals/scenarios/activeScenarioId, keeps the rest', async () => {
    const v5Payload = {
      version: 5,
      data: {
        proposals: [{ id: 'p1', name: 'Old', kind: 'expense_saving', amount: 1, startYearMonth: '2026-01', frequency: 'monthly', enabled: true, createdAt: 'x', updatedAt: 'x' }],
        scenarios: [{ id: 's1', name: 'Old', proposalStates: { p1: true }, createdAt: 'x', updatedAt: 'x' }],
        activeScenarioId: 's1',
        providers: [{ id: 'prov1', name: 'Prov' }],
        clients: [{ id: 'c1', name: 'Cliente' }],
        assumptions: { year: 2026, globalCompliance: 1, factorajeDays: 30 },
        confirmedPayments: [],
        cxpRecords: [],
        cxpLoadedCias: {},
        cashFlowOverrides: { '2026-05': { income: 1000 } },
        lastSaved: '2026-04-01T00:00:00Z',
      },
    };
    localStorage.setItem('midas-v5', JSON.stringify(v5Payload));

    const loaded = await loadStore();
    expect(loaded).not.toBeNull();
    expect((loaded as unknown as Record<string, unknown>).proposals).toBeUndefined();
    expect((loaded as unknown as Record<string, unknown>).scenarios).toBeUndefined();
    expect(loaded!.providers).toHaveLength(1);
    expect(loaded!.clients).toHaveLength(1);
    expect(loaded!.cashFlowOverrides['2026-05']).toEqual({ income: 1000 });
    expect(localStorage.getItem('midas-v5')).toBeNull();
    expect(localStorage.getItem('midas-v12')).not.toBeNull();
  });

  it('migrates legacy v4 store: keeps clients/providers, drops everything simulation-y', async () => {
    const legacyPayload = {
      version: 4,
      data: {
        plan: null,
        simulations: [{ id: 'legacy-sim' }],
        scenarios: [{ id: 'legacy-scen' }],
        proposals: [{ id: 'legacy-prop', category: 'ahorro' }],
        providers: [{ id: 'prov1', name: 'Prov' }],
        clients: [{ id: 'c1', name: 'Cliente' }],
        assumptions: { year: 2026, globalCompliance: 1, factorajeDays: 30 },
        confirmedPayments: [],
        cxpRecords: [],
        lastSaved: '2026-04-01T00:00:00Z',
      },
    };
    localStorage.setItem('flowsense-v4', JSON.stringify(legacyPayload));

    const loaded = await loadStore();
    expect(loaded).not.toBeNull();
    expect(loaded!.clients).toHaveLength(1);
    expect(loaded!.providers).toHaveLength(1);
    expect(localStorage.getItem('flowsense-v4')).toBeNull();
  });

  it('clamps invalid assumptions back to sane defaults', async () => {
    const payload = {
      version: 6,
      data: {
        ...getDefaultStore(),
        assumptions: {
          year: -7,
          globalCompliance: 42,
          factorajeDays: 'no number',
        },
      },
    };
    localStorage.setItem('midas-v6', JSON.stringify(payload));
    const loaded = await loadStore();
    expect(loaded).not.toBeNull();
    expect(loaded!.assumptions.year).toBeGreaterThan(1900);
    expect(loaded!.assumptions.globalCompliance).toBe(1);
    expect(loaded!.assumptions.factorajeDays).toBe(30);
  });

  it('drops providers/clients without a string id', async () => {
    const payload = {
      version: 6,
      data: {
        ...getDefaultStore(),
        providers: [
          { id: 'ok', name: 'OK' },
          { name: 'no id' },
          null,
        ],
        clients: [
          { id: 'c1', name: 'Cliente' },
          { id: 123 },
        ],
      },
    };
    localStorage.setItem('midas-v6', JSON.stringify(payload));
    const loaded = await loadStore();
    expect(loaded!.providers).toHaveLength(1);
    expect(loaded!.clients).toHaveLength(1);
  });

  it('drops malformed confirmedPayments but keeps the valid ones', async () => {
    const valid = {
      key: 'c1::2026-05-01::2026-04-01',
      clientId: 'c1',
      realDate: '2026-05-01',
      invoiceDate: '2026-04-01',
      amount: 1000,
      confirmedAt: '2026-04-21T00:00:00Z',
    };
    const payload = {
      version: 6,
      data: {
        ...getDefaultStore(),
        confirmedPayments: [
          valid,
          { key: 'x' },
          null,
        ],
      },
    };
    localStorage.setItem('midas-v6', JSON.stringify(payload));
    const loaded = await loadStore();
    expect(loaded!.confirmedPayments).toHaveLength(1);
    expect(loaded!.confirmedPayments[0].key).toBe(valid.key);
  });

  it('does not let unknown fields leak into the store', async () => {
    const payload = {
      version: 6,
      data: {
        ...getDefaultStore(),
        maliciousField: { drop: 'me' },
        __proto__: { polluted: true },
      },
    };
    localStorage.setItem('midas-v6', JSON.stringify(payload));
    const loaded = await loadStore();
    expect(loaded).not.toBeNull();
    expect((loaded as unknown as Record<string, unknown>).maliciousField).toBeUndefined();
  });
});

describe('loadStore — payloads ausentes o corruptos', () => {
  beforeEach(() => {
    clearStore();
  });

  it('returns null when nothing is stored anywhere', async () => {
    expect(await loadStore()).toBeNull();
  });

  it('survives corrupt JSON in midas-v12 and falls through to null', async () => {
    localStorage.setItem('midas-v12', '{this is not json');
    expect(await loadStore()).toBeNull();
  });

  it('a v12 payload without `data` is not usable and yields null', async () => {
    localStorage.setItem('midas-v12', JSON.stringify({ version: 12 }));
    expect(await loadStore()).toBeNull();
  });

  it('corrupt legacy payloads are skipped without breaking the next candidate', async () => {
    localStorage.setItem('midas-v11', '{broken');
    localStorage.setItem('midas-v10', JSON.stringify({
      version: 10,
      data: { ...getDefaultStore(), providers: [{ id: 'p1', name: 'Prov' }] },
    }));
    const loaded = await loadStore();
    expect(loaded).not.toBeNull();
    expect(loaded!.providers).toHaveLength(1);
    expect(localStorage.getItem('midas-v10')).toBeNull();
  });
});

describe('migración v11 (heavies inline) → v12 light-only', () => {
  beforeEach(() => {
    clearStore();
  });

  it('devuelve los heavies migrados en memoria y re-escribe v12 SIN heavies', async () => {
    const cobranzaRec = {
      cia: '00010', noCliente: '100', nombreCliente: 'CLIENTE', noFactura: 'F1',
      noClientePadre: '99',
    };
    const v11Payload = {
      version: 11,
      data: {
        ...getDefaultStore(),
        providers: [{ id: 'p1', name: 'Prov' }],
        cobranzaRecords: [cobranzaRec],
        cobranzaLoadedCias: { '00010': '2026-05-01T00:00:00Z' },
        comprasRecords: [{ cia: '00010', noOrden: 'OC1', lineaOrden: 1 }],
      },
    };
    localStorage.setItem('midas-v11', JSON.stringify(v11Payload));

    const loaded = await loadStore();
    expect(loaded).not.toBeNull();
    // Heavies presentes en el store devuelto (memoria).
    expect(loaded!.cobranzaRecords).toHaveLength(1);
    expect(loaded!.comprasRecords).toHaveLength(1);
    expect(loaded!.cobranzaLoadedCias['00010']).toBe('2026-05-01T00:00:00Z');
    // v11 borrado; v12 escrito light-only (heavies vaciados).
    expect(localStorage.getItem('midas-v11')).toBeNull();
    const v12 = JSON.parse(localStorage.getItem('midas-v12')!) as { data: Record<string, unknown> };
    expect(v12.data.cobranzaRecords).toEqual([]);
    expect(v12.data.comprasRecords).toEqual([]);
    expect(v12.data.providers).toHaveLength(1);
  });

  it('migra flowsense-v5 (rebrand, mismo shape) preservando catálogos', async () => {
    localStorage.setItem('flowsense-v5', JSON.stringify({
      version: 5,
      data: {
        ...getDefaultStore(),
        clients: [{ id: 'c1', name: 'Cliente' }],
        cashFlowOverrides: { '2026-03': { expense: 42 } },
      },
    }));
    const loaded = await loadStore();
    expect(loaded).not.toBeNull();
    expect(loaded!.clients).toHaveLength(1);
    expect(loaded!.cashFlowOverrides['2026-03']).toEqual({ expense: 42 });
    expect(localStorage.getItem('flowsense-v5')).toBeNull();
  });

  it('migra flowsense-v1 SIN wrapper {version,data} (payload plano)', async () => {
    // Los stores v1 más viejos se guardaban sin el sobre {version, data}.
    localStorage.setItem('flowsense-v1', JSON.stringify({
      providers: [{ id: 'p1', name: 'Prov' }],
      clients: [{ id: 'c1', name: 'Cliente' }],
      simulations: [{ id: 'drop-me' }],
    }));
    const loaded = await loadStore();
    expect(loaded).not.toBeNull();
    expect(loaded!.providers).toHaveLength(1);
    expect(loaded!.clients).toHaveLength(1);
    expect((loaded as unknown as Record<string, unknown>).simulations).toBeUndefined();
    expect(localStorage.getItem('flowsense-v1')).toBeNull();
  });
});

describe('normalizeStore (vía importStore) — payloads parciales/corruptos', () => {
  it('un payload data no-objeto cae al default completo', () => {
    const imported = importStore(JSON.stringify({ version: 12, data: 'garbage' }));
    expect(imported.providers).toEqual([]);
    expect(imported.cobranzaRecords).toEqual([]);
    expect(imported.assumptions.globalCompliance).toBe(1);
  });

  it('importStore lanza con formatos de respaldo inválidos', () => {
    expect(() => importStore('null')).toThrow('Formato de respaldo inválido.');
    expect(() => importStore(JSON.stringify({ version: 12 }))).toThrow('Formato de respaldo inválido.');
    expect(() => importStore('[]')).toThrow('Formato de respaldo inválido.');
    expect(() => importStore('{oops')).toThrow(); // JSON.parse revienta
  });

  it('elimina el campo `raw` heredado de los cobranzaRecords al cargar', () => {
    const imported = importStore(JSON.stringify({
      version: 12,
      data: {
        cobranzaRecords: [
          { cia: '00010', noFactura: 'F1', noClientePadre: '99', raw: { inflate: 'me' } },
          { cia: '00010', noFactura: 'F2', noClientePadre: '99' },
        ],
      },
    }));
    expect(imported.cobranzaRecords).toHaveLength(2);
    expect('raw' in (imported.cobranzaRecords[0] as unknown as Record<string, unknown>)).toBe(false);
    expect((imported.cobranzaRecords[0] as unknown as Record<string, unknown>).noFactura).toBe('F1');
  });

  it('invalida cobranzaLoadedCias cuando la cache es pre-2026-05-14 (sin noClientePadre)', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const imported = importStore(JSON.stringify({
      version: 12,
      data: {
        cobranzaRecords: [{ cia: '00010', noFactura: 'F1' }], // sin noClientePadre
        cobranzaLoadedCias: { '00010': '2026-05-01T00:00:00Z' },
      },
    }));
    expect(imported.cobranzaRecords).toHaveLength(1);
    expect(imported.cobranzaLoadedCias).toEqual({}); // timestamps invalidados → refetch
    expect(info).toHaveBeenCalled();
    info.mockRestore();
  });

  it('conserva cobranzaLoadedCias cuando la cache YA trae noClientePadre', () => {
    const imported = importStore(JSON.stringify({
      version: 12,
      data: {
        cobranzaRecords: [{ cia: '00010', noFactura: 'F1', noClientePadre: '99' }],
        cobranzaLoadedCias: { '00010': '2026-05-01T00:00:00Z', bad: 123 },
      },
    }));
    expect(imported.cobranzaLoadedCias).toEqual({ '00010': '2026-05-01T00:00:00Z' });
  });

  it('filtra companies malformadas y descarta companiesLoadedAt no-string', () => {
    const imported = importStore(JSON.stringify({
      version: 12,
      data: {
        companies: [
          { cia: '00010', nombre: 'Empresa Buena' },
          { cia: 10, nombre: 'cia numérica' },
          { nombre: 'sin cia' },
          'not-an-object',
          null,
        ],
        companiesLoadedAt: 12345,
      },
    }));
    expect(imported.companies).toHaveLength(1);
    expect(imported.companies[0].cia).toBe('00010');
    expect(imported.companiesLoadedAt).toBeUndefined();
  });

  it('valida el meta de auxiliarIvaLoadedCias campo por campo', () => {
    const valid = { version: 'v2', loadedThrough: '2026-06-30', refreshedAt: '2026-07-01T00:00:00Z' };
    const imported = importStore(JSON.stringify({
      version: 12,
      data: {
        auxiliarIvaLoadedCias: {
          '00010': valid,
          '00020': { version: 'v2' },        // incompleto → fuera
          '00030': 'not-an-object',           // → fuera
          '00040': null,                      // → fuera
        },
      },
    }));
    expect(imported.auxiliarIvaLoadedCias).toEqual({ '00010': valid });
  });

  it('normalizeOverrides descarta llaves no YYYY-MM, valores no finitos y entradas vacías', () => {
    const imported = importStore(JSON.stringify({
      version: 12,
      data: {
        cashFlowOverrides: {
          '2026-05': { income: 100, expense: 'not-a-number' },
          '2026-06': {},                       // ni income ni expense → fuera
          '2026-07': { income: null },         // → fuera
          '2026-08': { expense: 50 },
          'bad-key': { income: 1 },            // llave inválida → fuera
          '2026-9': { income: 1 },             // sin zero-pad → fuera
        },
      },
    }));
    expect(imported.cashFlowOverrides).toEqual({
      '2026-05': { income: 100 },
      '2026-08': { expense: 50 },
    });
  });

  it('mapas de timestamps (cxp/nomina/rol/viajes/auxiliar) solo aceptan valores string', () => {
    const imported = importStore(JSON.stringify({
      version: 12,
      data: {
        cxpLoadedCias: { a: 'x', b: 1, c: null },
        nominaLoadedKeys: { '10:S:2026:1': 'ts', bad: {} },
        rolLoadedKeys: { '2026:full': 'ts', nope: 9 },
        viajesEspecialesLoadedKeys: { '2026:full': 'ts', nope: [] },
        auxiliarContableLoadedCias: { '00010': 'ts', nope: false },
        pagoProveedorLoadedCias: 'not-an-object',
      },
    }));
    expect(imported.cxpLoadedCias).toEqual({ a: 'x' });
    expect(imported.nominaLoadedKeys).toEqual({ '10:S:2026:1': 'ts' });
    expect(imported.rolLoadedKeys).toEqual({ '2026:full': 'ts' });
    expect(imported.viajesEspecialesLoadedKeys).toEqual({ '2026:full': 'ts' });
    expect(imported.auxiliarContableLoadedCias).toEqual({ '00010': 'ts' });
    expect(imported.pagoProveedorLoadedCias).toEqual({});
  });

  it('colecciones heavy no-array caen a [] y filtran entradas no-objeto', () => {
    const imported = importStore(JSON.stringify({
      version: 12,
      data: {
        comprasRecords: 'garbage',
        pagoProveedorRecords: [{ cia: '00010', noPago: 'P1' }, null, 'x'],
        nominaRecords: { not: 'array' },
        rolRecords: [null],
        viajesEspecialesRecords: [{ kRenta: 1 }],
        auxiliarContableRecords: 7,
        auxiliarIvaRecords: [{ cia: '00010' }, false],
      },
    }));
    expect(imported.comprasRecords).toEqual([]);
    expect(imported.pagoProveedorRecords).toHaveLength(1);
    expect(imported.nominaRecords).toEqual([]);
    expect(imported.rolRecords).toEqual([]);
    expect(imported.viajesEspecialesRecords).toHaveLength(1);
    expect(imported.auxiliarContableRecords).toEqual([]);
    expect(imported.auxiliarIvaRecords).toHaveLength(1);
  });

  it('lastSaved no-string cae al default (ISO fresco)', () => {
    const imported = importStore(JSON.stringify({ version: 12, data: { lastSaved: 12345 } }));
    expect(typeof imported.lastSaved).toBe('string');
    expect(Number.isNaN(Date.parse(imported.lastSaved))).toBe(false);
  });
});

describe('saveLightStore / loadLightStore', () => {
  beforeEach(() => {
    clearStore();
  });

  it('saveLightStore silencia QuotaExceeded con warn y no revienta', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => saveLightStore(getDefaultStore())).not.toThrow();
    expect(warn).toHaveBeenCalledWith('[persistence] saveLightStore failed:', expect.any(Error));
    setItem.mockRestore();
    warn.mockRestore();
  });

  it('loadLightStore lee el light de v12 sin requerir heavies', async () => {
    saveLightStore({ ...getDefaultStore(), providers: [{ id: 'p1', name: 'Prov' } as never] });
    const light = await loadLightStore();
    expect(light).not.toBeNull();
    expect(light!.providers).toHaveLength(1);
  });

  it('loadLightStore sin v12 delega al loader completo (null si no hay nada)', async () => {
    expect(await loadLightStore()).toBeNull();
  });

  it('loadLightStore con v12 corrupto delega a la ruta de migración', async () => {
    localStorage.setItem('midas-v12', '{broken');
    localStorage.setItem('midas-v7', JSON.stringify({
      version: 7,
      data: { ...getDefaultStore(), clients: [{ id: 'c1', name: 'Cliente' }] },
    }));
    const light = await loadLightStore();
    expect(light).not.toBeNull();
    expect(light!.clients).toHaveLength(1);
    expect(localStorage.getItem('midas-v7')).toBeNull();
  });
});
