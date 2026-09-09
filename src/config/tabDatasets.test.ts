import { describe, expect, it } from 'vitest';
import { ALL_DATASETS, TAB_DATASETS, type DatasetKey } from './tabDatasets';
import { GRANTABLE_TABS } from './appTabs';
import type { TabId } from '../types';

/**
 * Guardrail del contrato de datos por tab. Ya reincidió tres veces (ver el
 * docblock de `tabDatasets.ts`), siempre igual: alguien agrega o mueve un prop
 * con registros de una API y no declara su dataset. Un admin nunca lo nota
 * (tiene todos los tabs → baja todo); el usuario acotado ve números plausibles
 * y equivocados. `AppCore.tsx` no tiene harness, así que la única defensa que
 * puede tronar está aquí.
 */
describe('TAB_DATASETS — contrato de datos por tab', () => {
  it('Proyección y Planeación declaran `banks`: la caja se ANCLA al estado de cuenta', () => {
    // Sin bancos, `calculateInitialCash` cae al `startingBalance` y el
    // `bankCoverage` de MOTOR 1 queda vacío → todo mes cerrado se rellena con
    // los sintéticos `cobranza-historic:`/`auxiliar-historic:`. Y NO se ve
    // vacío: `hasProjectionInputs` pasa con cxp/cobranza, así que el tablero
    // pinta completo con la caja equivocada.
    for (const tab of ['financialProjection', 'financialPlanning'] as TabId[]) {
      expect(TAB_DATASETS[tab]).toContain('banks');
    }
  });

  it('ningún tab que consume registros queda con la lista vacía', () => {
    // `providers` y `clients` estuvieron en `[]`: el catálogo de proveedores lo
    // DERIVA `deriveProvidersFromJde(cxp, compras, pagoProveedor)` y el de
    // clientes se alimenta de cobranza (jerarquía, historial, pronóstico,
    // matcher), así que los dos tabs salían prácticamente en blanco.
    const empty = (Object.keys(TAB_DATASETS) as TabId[])
      .filter((tab) => (TAB_DATASETS[tab] ?? []).length === 0);
    expect(empty).toEqual([]);
  });

  it.each([
    ['clients', 'cobranza'],
    ['providers', 'cxp'],
    ['providers', 'compras'],
    ['providers', 'pagos'],
    ['taxes', 'banks'],
    ['cxp', 'banks'],
    ['collections', 'banks'],
    ['pagos', 'banks'],
    ['concursoMercantil', 'banks'],
    ['kpisObjectives', 'auxiliar'],
  ] as Array<[TabId, DatasetKey]>)('%s declara %s', (tab, dataset) => {
    expect(TAB_DATASETS[tab]).toContain(dataset);
  });

  it('la unión sobre todos los tabs cubre los 8 datasets (un admin baja todo)', () => {
    // Un dataset que ningún tab reclama nunca se bajaría para nadie.
    const union = new Set<DatasetKey>(Object.values(TAB_DATASETS).flatMap((d) => d ?? []));
    expect(Array.from(union).sort()).toEqual([...ALL_DATASETS].sort());
  });

  it('ninguna lista trae duplicados ni un dataset fuera del vocabulario', () => {
    for (const [tab, datasets] of Object.entries(TAB_DATASETS)) {
      const list = datasets ?? [];
      expect(new Set(list).size, `${tab} tiene duplicados`).toBe(list.length);
      for (const d of list) expect(ALL_DATASETS, `${tab} → ${d}`).toContain(d);
    }
  });

  it('todo tab declarado es un tab otorgable o admin-only, nunca un id muerto', () => {
    // Un id que ya no existe en la navegación jamás entra a `allowedDatasets`:
    // la declaración quedaría inerte sin que nada avise.
    const known = new Set<string>([...GRANTABLE_TABS, 'users', 'permisos']);
    for (const tab of Object.keys(TAB_DATASETS)) expect(known, tab).toContain(tab);
  });
});
