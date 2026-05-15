// ─────────────────────────────────────────────────────────────────────────
// Concurso Mercantil — clasificación de CXP "frozen" por antigüedad.
//
// Regla operativa: cualquier CXP con `fechaFactura` ≤ 2022-12-31 se considera
// parte del Concurso Mercantil y NO debe reflejarse en el módulo CXP normal
// ni proyectarse como egreso en la proyección financiera. Vive solo en el
// módulo Concurso Mercantil donde se muestra como deuda total agregada.
//
// `fechaFactura` viene de JDE en dos formatos posibles según el endpoint:
//   - ISO `YYYY-MM-DD` (canonicalProjection asume esto via `cleanDate`)
//   - DD-MM-YYYY o DD/MM/YYYY (locale mexicano, como llegan algunas filas
//     de antigüedad de saldos cuando JDE las serializa en es-MX)
// Por eso normalizamos antes de comparar, en vez de hacer string-compare
// crudo (que rompía con DD-MM-YYYY al sliciar los primeros 10 chars).
// ─────────────────────────────────────────────────────────────────────────
import type { CXPRecord } from './persistence';

export const CONCURSO_MERCANTIL_CUTOFF = '2022-12-31';

export function normalizeFechaFactura(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const iso = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
  const dmy = trimmed.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (dmy) {
    const day = Number(dmy[1]);
    const month = Number(dmy[2]);
    const year = Number(dmy[3]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }
  return null;
}

export function isConcursoMercantil(record: Pick<CXPRecord, 'fechaFactura'>): boolean {
  const iso = normalizeFechaFactura(record.fechaFactura);
  if (!iso) return false;
  return iso <= CONCURSO_MERCANTIL_CUTOFF;
}

export function excludeConcursoMercantil<T extends Pick<CXPRecord, 'fechaFactura'>>(records: T[]): T[] {
  return records.filter((r) => !isConcursoMercantil(r));
}

export function onlyConcursoMercantil<T extends Pick<CXPRecord, 'fechaFactura'>>(records: T[]): T[] {
  return records.filter((r) => isConcursoMercantil(r));
}

// Lista de `noProveedor` (clave JDE) con AL MENOS una factura clasificada como
// Concurso Mercantil. Esos proveedores se excluyen del modelo predictivo:
// sus pagos viven en el módulo Concurso, no en la proyección de Planeación.
//
// Convención de igualdad: trim + upper. Necesaria porque `noProveedor` puede
// venir con padding o casing distinto entre endpoints JDE. Misma normalización
// usa `providerJdeKey` en canonicalProjection.ts para mapear el catálogo.
export function getConcursoProviderIds(
  records: Pick<CXPRecord, 'fechaFactura' | 'noProveedor'>[],
): Set<string> {
  const set = new Set<string>();
  for (const r of records) {
    if (!isConcursoMercantil(r)) continue;
    const id = (r.noProveedor || '').trim().toUpperCase();
    if (id) set.add(id);
  }
  return set;
}

export function normalizeProviderId(id: string | null | undefined): string {
  return (id || '').trim().toUpperCase();
}

export interface ConcursoProviderTotal {
  noProveedor: string;
  nombre: string;
  total: number;
  count: number;
  oldestFecha: string;
  cias: string[];
}

export function aggregateConcursoByProvider(records: CXPRecord[]): ConcursoProviderTotal[] {
  const map = new Map<string, ConcursoProviderTotal>();
  for (const r of records) {
    const key = (r.noProveedor || r.nombre || 'SIN_PROVEEDOR').trim().toUpperCase();
    const existing = map.get(key);
    const amount = r.importePendientePesos || 0;
    const iso = normalizeFechaFactura(r.fechaFactura) ?? '';
    if (existing) {
      existing.total += amount;
      existing.count += 1;
      if (iso && (!existing.oldestFecha || iso < existing.oldestFecha)) {
        existing.oldestFecha = iso;
      }
      if (r.cia && !existing.cias.includes(r.cia)) existing.cias.push(r.cia);
    } else {
      map.set(key, {
        noProveedor: r.noProveedor,
        nombre: r.nombre,
        total: amount,
        count: 1,
        oldestFecha: iso,
        cias: r.cia ? [r.cia] : [],
      });
    }
  }
  return Array.from(map.values()).sort((a, b) => b.total - a.total);
}

export interface ConcursoCiaTotal {
  cia: string;
  total: number;
  count: number;
  providers: number;
}

export function aggregateConcursoByCia(records: CXPRecord[]): ConcursoCiaTotal[] {
  const map = new Map<string, { total: number; count: number; providerSet: Set<string> }>();
  for (const r of records) {
    const cia = r.cia || 'SIN_CIA';
    const entry = map.get(cia) ?? { total: 0, count: 0, providerSet: new Set<string>() };
    entry.total += r.importePendientePesos || 0;
    entry.count += 1;
    if (r.noProveedor) entry.providerSet.add(r.noProveedor);
    map.set(cia, entry);
  }
  return Array.from(map.entries())
    .map(([cia, v]) => ({ cia, total: v.total, count: v.count, providers: v.providerSet.size }))
    .sort((a, b) => b.total - a.total);
}

export interface ConcursoYearTotal {
  year: string;
  total: number;
  count: number;
}

export function aggregateConcursoByYear(records: CXPRecord[]): ConcursoYearTotal[] {
  const map = new Map<string, { total: number; count: number }>();
  for (const r of records) {
    const iso = normalizeFechaFactura(r.fechaFactura);
    const year = iso ? iso.slice(0, 4) : 'sin-fecha';
    const entry = map.get(year) ?? { total: 0, count: 0 };
    entry.total += r.importePendientePesos || 0;
    entry.count += 1;
    map.set(year, entry);
  }
  return Array.from(map.entries())
    .map(([year, v]) => ({ year, total: v.total, count: v.count }))
    .sort((a, b) => a.year.localeCompare(b.year));
}
