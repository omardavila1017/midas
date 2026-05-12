/**
 * Enriquecimiento del cruce bancos↔cobranza con datos del catálogo de
 * clientes. El engine (realReconciliationEngine.ts) solo conoce `noCliente`
 * de JDE; aquí inyectamos `catalogClientId` / `catalogClientName` cuando
 * existe un enlace `Client.jdeAccounts`.
 */

import type { Client } from './types';
import type {
  AbonoEnrichment,
  RealReconciliationMatch,
  RealReconciliationResult,
} from './realReconciliationEngine';

export type CatalogClientByNoCliente = Map<string, { id: string; name: string }>;

/** Construye el índice `${cia}::${noCliente}` → catálogo a partir de los clients. */
export function buildCatalogClientMap(clients: Client[]): CatalogClientByNoCliente {
  const map: CatalogClientByNoCliente = new Map();
  for (const c of clients) {
    if (!c.jdeAccounts) continue;
    for (const a of c.jdeAccounts) {
      map.set(`${a.cia}::${a.noCliente}`, { id: c.id, name: c.name });
    }
  }
  return map;
}

function enrichMatch(m: RealReconciliationMatch, map: CatalogClientByNoCliente): RealReconciliationMatch {
  const k = `${m.cia}::${m.noCliente}`;
  const hit = map.get(k);
  if (!hit) return m;
  return { ...m, catalogClientId: hit.id, catalogClientName: hit.name };
}

function enrichAbono(a: AbonoEnrichment, map: CatalogClientByNoCliente): AbonoEnrichment {
  // Si el abono tiene exactamente una factura asociada, mapeamos por su
  // noCliente. Para subsets multi-cliente se deja sin enriquecer (UI sigue
  // mostrando el nombre JDE crudo).
  if (!a.facturas || a.facturas.length === 0) return a;
  const noClienteSet = new Set(a.facturas.map(f => `${f.cia}::${f.noCliente}`));
  if (noClienteSet.size !== 1) return a;
  const k = a.facturas[0] ? `${a.facturas[0].cia}::${a.facturas[0].noCliente}` : '';
  const hit = map.get(k);
  if (!hit) return a;
  return { ...a, catalogClientId: hit.id, catalogClientName: hit.name };
}

/**
 * Enriquecimiento end-to-end sobre el resultado completo del engine. No muta
 * los objetos originales; devuelve copias decoradas con `catalogClient*`.
 */
export function enrichReconciliationResult(
  result: RealReconciliationResult,
  clients: Client[],
): RealReconciliationResult {
  const map = buildCatalogClientMap(clients);
  if (map.size === 0) return result;
  return {
    ...result,
    matches: result.matches.map(m => enrichMatch(m, map)),
    abonoEnrichments: result.abonoEnrichments.map(a => enrichAbono(a, map)),
  };
}
