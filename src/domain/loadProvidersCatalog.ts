/**
 * loadProvidersCatalog — antes leía `proveedores-clasificacion.json` y
 * `providerCatalog.json` enteros para emitir el catálogo de proveedores.
 *
 * Ahora el catálogo se DERIVA en tiempo real desde la API JDE (antigüedad de
 * saldos + compras + pagoProveedor) en `providerDerivation.ts`. Este archivo
 * sólo expone:
 *   1. `loadProvidersCatalog()` — devuelve `[]` (el seed real ocurre cuando
 *      cargan los datos JDE en App.tsx → `recomputeProvidersFromJde`).
 *   2. `loadProviderScoreOverlay()` — extrae sólo el `score` (y sub-criterios)
 *      del JSON manual de Alberto, indexado por número JDE / nombre. La
 *      clasificación automática (CRÍTICO/ALTO/MEDIO/BAJO) se deriva del score.
 *
 * Decisión de negocio (2026-05-19): los catálogos no permiten registros
 * manuales. El JSON de Alberto sobrevive sólo como score overlay para juzgar
 * negociabilidad. Lo demás (categoría, nombre, flexibilidad, riesgo, frecuencia,
 * dtiCatalog, lastPayment, etc.) se ignora — sale del API.
 */

import clasificacionRaw from '../data/proveedores-clasificacion.json';
import { buildScoreOverlay, type ScoreEntry, type ScoreOverlay } from './providerDerivation';
import type { Provider } from './types';

interface ClasificacionRawEntry {
  numProveedor: string;
  nombre: string;
  score: number | null;
  scoreCriterios?: {
    sustituibilidad: number;
    impactoOperativo: number;
    riesgoLegal: number;
    diasCredito: number;
  } | null;
  frecuencia?: string | null;
  montoPromedioPago?: number | null;
  numPagos2025?: number | null;
  montoTotal2025?: number | null;
  gastoMinimoMensual?: number | null;
}

interface ClasificacionShape {
  proveedores: ClasificacionRawEntry[];
}

const clasificacion = clasificacionRaw as unknown as ClasificacionShape;

/**
 * Score overlay. Solo entradas con `score` válido entran al overlay;
 * proveedores del JSON sin score quedan fuera (el sistema los marcará como
 * "Sin score" cuando aparezcan en los datos transaccionales). Además del score
 * se arrastra el gasto operativo precalculado (montoPromedioPago × frecuencia)
 * que alimenta el piso "Gasto mínimo operativo" — sin esto los críticos salen
 * en $0 al derivarse desde JDE.
 */
export function loadProviderScoreOverlay(): ScoreOverlay {
  const entries: ScoreEntry[] = [];
  for (const raw of clasificacion.proveedores) {
    if (raw.score === null || raw.score === undefined || !Number.isFinite(raw.score)) continue;
    entries.push({
      numProveedor: raw.numProveedor?.trim() ?? '',
      nombre: raw.nombre?.trim() ?? '',
      score: raw.score,
      scoreCriterios: raw.scoreCriterios ?? null,
      frecuencia: raw.frecuencia ?? null,
      montoPromedioPago: raw.montoPromedioPago ?? null,
      numPagos2025: raw.numPagos2025 ?? null,
      montoTotal2025: raw.montoTotal2025 ?? null,
      gastoMinimoMensual: raw.gastoMinimoMensual ?? null,
    });
  }
  return buildScoreOverlay(entries);
}

/**
 * Compatibilidad: el catálogo cold (sin datos JDE cargados) está vacío.
 * `App.tsx` lo rellena al hidratar CXP/compras/pagoProveedor.
 */
export function loadProvidersCatalog(): Provider[] {
  return [];
}
