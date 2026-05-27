/**
 * Auto-poblado del grupo "Viajes Especiales" en el catálogo de clientes.
 *
 * El grupo `group-viajes-especiales` históricamente se llenaba manualmente
 * o via heurística por nombre (`isPersonName` para personas físicas). Con
 * el API de Viajes Especiales tenemos la lista AUTORITATIVA — cualquier
 * `K_Cliente` / `Clave_JDE` que aparece en el endpoint ES un cliente de
 * viajes especiales por definición de negocio.
 *
 * Reglas:
 *   1. Si el cliente tiene `manualGroupOverride === true`, NO tocar.
 *      Movimientos manuales del usuario mandan sobre la inferencia.
 *   2. Si el cliente ya está en `group-viajes-especiales`, no-op.
 *   3. Si no, sobrescribir `commercialGroupId` y `commercialGroupName`.
 *
 * Llave de match: `${cia}::${noCliente}` contra `Client.jdeAccounts[]`.
 * Esto cubre clientes ya enlazados por el grouping engine; clientes sin
 * jdeAccounts (huérfanos) NO se promueven aquí — se quedan al cuidado del
 * matcher automático de AppCore que corre al cargar cobranza.
 */

import type { Client } from './types';
import type { ViajeEspecialRecord } from '../services/jdeTypes';

export const VIAJES_ESPECIALES_GROUP_ID = 'group-viajes-especiales';
export const VIAJES_ESPECIALES_GROUP_NAME = 'Viajes Especiales';

export interface ApplyViajesEspecialesGroupResult {
  /** Clients (mutables) con `commercialGroupId` reasignado. */
  clients: Client[];
  /** Cuántos clientes se promovieron al grupo en esta pasada. */
  promotedCount: number;
  /** Cuántos K_Cliente del API no encontraron Client en el catálogo. */
  unmatchedClaveJdeCount: number;
}

function viajeKey(cia: string, claveJDE: string): string {
  return `${cia.trim()}::${(claveJDE ?? '').trim()}`;
}

export function applyViajesEspecialesGroup(
  clients: Client[],
  viajes: ViajeEspecialRecord[],
): ApplyViajesEspecialesGroupResult {
  if (viajes.length === 0) {
    return { clients, promotedCount: 0, unmatchedClaveJdeCount: 0 };
  }

  // Set de (cia, claveJDE) que aparecen en el API.
  const apiKeys = new Set<string>();
  for (const v of viajes) {
    if (!v.claveJDE) continue;
    apiKeys.add(viajeKey(v.cia, v.claveJDE));
  }
  if (apiKeys.size === 0) {
    return { clients, promotedCount: 0, unmatchedClaveJdeCount: 0 };
  }

  let promotedCount = 0;
  const matchedKeys = new Set<string>();
  const out = clients.map((c) => {
    if (c.manualGroupOverride === true) return c;
    const accounts = c.jdeAccounts ?? [];
    let hit = false;
    for (const acc of accounts) {
      const k = viajeKey(acc.cia, acc.noCliente);
      if (apiKeys.has(k)) {
        hit = true;
        matchedKeys.add(k);
        // No break — registrar todas las cuentas que empatan; útil para
        // diagnóstico cuando un cliente tiene cuentas en varias cías.
      }
    }
    if (!hit) return c;
    if (c.commercialGroupId === VIAJES_ESPECIALES_GROUP_ID) return c;
    promotedCount += 1;
    return {
      ...c,
      commercialGroupId: VIAJES_ESPECIALES_GROUP_ID,
      commercialGroupName: VIAJES_ESPECIALES_GROUP_NAME,
    };
  });

  const unmatchedClaveJdeCount = apiKeys.size - matchedKeys.size;

  return { clients: out, promotedCount, unmatchedClaveJdeCount };
}
