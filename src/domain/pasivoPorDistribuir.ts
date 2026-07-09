/**
 * Pasivo por Distribuir — OCs con material/servicio RECIBIDO pero SIN factura
 * todavía (la "cuenta puente" de JDE). El proveedor ya entregó, pero como no ha
 * mandado su factura el monto NO está en cuentas por pagar (Antigüedad de
 * Saldos) ni en el backlog de OCs por recibir: "desaparece" porque la línea de
 * OC se consumió al dar entrada. Finanzas necesita verlo con importe +
 * antigüedad para proyectarlo como gasto futuro latente (~27-29M).
 *
 * Display-only sobre `ComprasRecord`: reusa el estado de línea `compraEstado`
 * (la línea `porPagar` = recibida sin factura es exactamente el pasivo por
 * distribuir) y agrega por OC. NO toca el motor ni la proyección.
 */

import type { ComprasRecord } from '../services/jdeTypes';
import { csvDate } from '../utils/export';
import {
  compraEstado,
  comprasImporteMxn,
  comprasRecordKey,
  daysSinceIso,
} from './comprasInsights';

/** Una línea es pasivo por distribuir si está recibida y aún sin factura. */
export function isPasivoPorDistribuir(r: ComprasRecord): boolean {
  return compraEstado(r) === 'porPagar';
}

export interface PasivoItem {
  cia: string;
  noOrden: string;
  noProveedor: string;
  nombreProveedor: string;
  /** Σ importe MXN de las líneas recibidas-sin-factura de la OC. */
  importeMxn: number;
  lineCount: number;
  /** Recepción más antigua entre sus líneas (ancla de la antigüedad). */
  fechaRecepcion: string;
  /** Días desde la recepción más antigua. */
  antiguedadDias: number | null;
  categoria: string;
  /** Claves de línea — para enfocar/exportar/cruzar. */
  keys: string[];
}

/**
 * Agrega las líneas `porPagar` a una fila por OC (cia::noOrden), con importe y
 * antigüedad. Ordena por antigüedad descendente (lo más viejo primero: es lo
 * que lleva más tiempo sin convertirse en factura).
 */
export function buildPasivoPorDistribuir(
  records: ComprasRecord[],
  asOfDate: string,
): PasivoItem[] {
  const map = new Map<string, PasivoItem>();
  for (const r of records) {
    if (!isPasivoPorDistribuir(r)) continue;
    const key = `${r.cia}::${r.noOrden}`;
    let item = map.get(key);
    if (!item) {
      item = {
        cia: r.cia,
        noOrden: r.noOrden,
        noProveedor: r.noProveedor,
        nombreProveedor: r.nombreProveedor,
        importeMxn: 0,
        lineCount: 0,
        fechaRecepcion: '',
        antiguedadDias: null,
        categoria: '',
        keys: [],
      };
      map.set(key, item);
    }
    item.importeMxn += comprasImporteMxn(r);
    item.lineCount += 1;
    item.keys.push(comprasRecordKey(r));
    if (!item.categoria) item.categoria = r.descCategoria || r.descFamilia || r.categoria || r.familia || '';
    if (r.fechaRecepcion && (!item.fechaRecepcion || r.fechaRecepcion < item.fechaRecepcion)) {
      item.fechaRecepcion = r.fechaRecepcion;
    }
  }
  const out = Array.from(map.values());
  for (const item of out) {
    item.antiguedadDias = item.fechaRecepcion ? daysSinceIso(item.fechaRecepcion, asOfDate) : null;
  }
  return out.sort((a, b) => (b.antiguedadDias ?? -1) - (a.antiguedadDias ?? -1) || b.importeMxn - a.importeMxn);
}

// ───────────────────────────────────────────────────────────────
// Envejecimiento (aging) por días desde recepción
// ───────────────────────────────────────────────────────────────

export interface PasivoAgingBucket {
  label: string;
  /** Cota inferior inclusiva en días (la superior es la del siguiente bucket). */
  minDays: number;
  total: number;
  count: number;
}

/** Cortes de envejecimiento del pasivo (espejo de la antigüedad de saldos CXP). */
export const PASIVO_AGING_CUTS: { label: string; minDays: number }[] = [
  { label: '0-30 días', minDays: 0 },
  { label: '31-60 días', minDays: 31 },
  { label: '61-90 días', minDays: 61 },
  { label: '+90 días', minDays: 91 },
];

export function buildPasivoAging(items: PasivoItem[]): PasivoAgingBucket[] {
  const buckets: PasivoAgingBucket[] = PASIVO_AGING_CUTS.map((c) => ({ ...c, total: 0, count: 0 }));
  for (const item of items) {
    const days = item.antiguedadDias ?? 0;
    // Último bucket cuyo minDays no supera la antigüedad.
    let idx = 0;
    for (let i = 0; i < buckets.length; i++) {
      if (days >= buckets[i].minDays) idx = i;
    }
    buckets[idx].total += item.importeMxn;
    buckets[idx].count += 1;
  }
  return buckets;
}

export function pasivoTotalMxn(items: PasivoItem[]): number {
  return items.reduce((s, i) => s + i.importeMxn, 0);
}

// ───────────────────────────────────────────────────────────────
// Export CSV
// ───────────────────────────────────────────────────────────────

function csvCell(value: string | number): string {
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function pasivoToCsv(items: PasivoItem[]): string {
  const header = [
    'Compañía', 'No. proveedor', 'Proveedor', 'OC', 'Líneas',
    'Importe MXN', 'Recepción', 'Antigüedad (días)', 'Categoría',
  ];
  const rows = items.map((i) =>
    [
      i.cia,
      i.noProveedor,
      i.nombreProveedor,
      i.noOrden,
      i.lineCount,
      i.importeMxn.toFixed(2),
      csvDate(i.fechaRecepcion),
      i.antiguedadDias ?? '',
      i.categoria,
    ]
      .map(csvCell)
      .join(','),
  );
  return [header.map(csvCell).join(','), ...rows].join('\n');
}
