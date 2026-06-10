/* eslint-disable no-console */
// Análisis de cobertura de generalizeCategoria sobre el vocabulario REAL de
// categorías de proveedor que trae el repo (catálogo estático + plantilla de
// Alberto). Ejecutar: npx vite-node scripts/analyze-provider-categories.ts
import { readFileSync } from 'node:fs';
import { generalizeCategoria, UNCATEGORIZED_PROVIDER_BUCKET } from '../src/modules/financial-planning/services/providerCategoryGeneralization';

const catalog = JSON.parse(readFileSync('src/assets/providerCatalog.json', 'utf8')) as {
  providerTypeByName: Record<string, string>;
};
const plantilla = JSON.parse(readFileSync('src/data/proveedores-clasificacion.json', 'utf8')) as {
  proveedores: Array<{ nombre: string; categoria?: string | null }>;
};

const counts = new Map<string, number>();
for (const t of Object.values(catalog.providerTypeByName)) {
  counts.set(t, (counts.get(t) ?? 0) + 1);
}
for (const p of plantilla.proveedores) {
  const c = (p.categoria ?? '').trim();
  if (c) counts.set(c, (counts.get(c) ?? 0) + 1);
}

const byBucket = new Map<string, Array<[string, number]>>();
for (const [raw, n] of counts) {
  const bucket = generalizeCategoria(raw);
  const list = byBucket.get(bucket) ?? [];
  list.push([raw, n]);
  byBucket.set(bucket, list);
}

let totalProviders = 0;
let uncategorized = 0;
for (const [bucket, list] of [...byBucket.entries()].sort()) {
  const subtotal = list.reduce((s, [, n]) => s + n, 0);
  totalProviders += subtotal;
  if (bucket === UNCATEGORIZED_PROVIDER_BUCKET) uncategorized = subtotal;
  console.log(`\n=== ${bucket} — ${list.length} categorías crudas, ${subtotal} proveedores ===`);
  if (bucket === UNCATEGORIZED_PROVIDER_BUCKET) {
    for (const [raw, n] of list.sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${raw}`);
  }
}
console.log(`\nTOTAL proveedores con categoría: ${totalProviders}`);
console.log(`SIN bucket (caen a "${UNCATEGORIZED_PROVIDER_BUCKET}"): ${uncategorized} (${((uncategorized / totalProviders) * 100).toFixed(1)}%)`);
