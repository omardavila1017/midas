/**
 * Refresh del dato HORNEADO de clasificación de proveedores desde el Excel de
 * Mayte ("clasificacion de proveedores jde.xlsx", hoja "Relacion proveedores").
 *
 * ── Contexto (leer antes de correrlo) ──────────────────────────────────────
 * Midas NO parsea Excel en runtime ni en build (exceljs/xlsx están fuera del
 * repo a propósito). Todo dato de Excel se hornea a JSON/TS. ANTES de esta
 * entrega NO existía un generador formal Excel→JSON para los catálogos de
 * proveedor: `src/assets/providerCatalog.json` y
 * `src/data/proveedores-clasificacion.json` se generaron a mano desde OTROS
 * Excel (Proveedores_AB2026.xlsx / Plantilla de Alberto), y
 * `scripts/analyze-provider-categories.ts` solo ANALIZA cobertura, no genera.
 *
 * Este script es ese generador reproducible + idempotente para la parte de
 * CLASIFICACIÓN que trae el Excel de Mayte. Como el repo no parsea .xlsx,
 * consume un CSV (exporta la hoja 1 desde Excel: "Guardar como" → CSV UTF-8).
 *
 * ── Qué hace ────────────────────────────────────────────────────────────────
 *   1. Lee el CSV de la hoja 1 (Clave_Proveedor, Nombre_Proveedor,
 *      Tipo_Busqueda, Clasificacion_Proveedor, Importe_Pagado).
 *   2. Valida cada Clasificacion_Proveedor contra el vocabulario conocido =
 *      catálogo maestro de industria (hoja 2, horneado en
 *      scripts/data/provider-industry-catalog.json) ∪ vocabulario que Midas ya
 *      usa (providerCatalog.json). Marca filas: vacía / 'NULL' / no-mapeable.
 *   3. Escribe un REPORTE CSV de las filas marcadas para devolvérselas a Mayte
 *      reclasificadas (scripts/out/provider-classification-issues.csv).
 *   4. Con `--write`: MERGE idempotente de la clasificación de las filas válidas
 *      a `providerCatalog.json` (name→clasificación/clave), PRESERVANDO todos
 *      los demás campos y proveedores no presentes en el Excel. Default OFF.
 *
 * ⚠️ Fuera de alcance: la MISMA clasificación fluye también directo a JDE
 * (proceso de Mayte/Yezid) y se refleja en Midas vía la API de JDE que YA
 * existe — ese lado NO se toca aquí. `--write` cambia el dato que alimenta la
 * categorización financiera (`generalizeCategoria`), cuyo test data-driven
 * (`providerCategoryGeneralization.test.ts`) es el guardrail: si `--write`
 * introduce categorías nuevas sin patrón, ese test falla. Por eso el default es
 * solo-reporte; revisa la cobertura antes de `--write`.
 *
 * ── Uso ─────────────────────────────────────────────────────────────────────
 *   node scripts/refresh-provider-classification.mjs <relacion.csv> [opts]
 *     --catalog=<industria.csv>   catálogo de industria alterno (default: horneado)
 *     --out=<reporte.csv>         ruta del reporte (default: scripts/out/…)
 *     --write                     escribe el merge a providerCatalog.json
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptDir, '..');
const PROVIDER_CATALOG_PATH = join(repoRoot, 'src', 'assets', 'providerCatalog.json');
const INDUSTRY_CATALOG_PATH = join(scriptDir, 'data', 'provider-industry-catalog.json');

// ── Helpers puros (exportados para test) ─────────────────────────────────────

/** Normaliza para comparar clasificaciones: sin acentos, mayúsculas, espacios colapsados. */
export function classKey(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase();
}

/** Parser CSV mínimo y robusto (comillas, comas embebidas, CRLF, BOM). Devuelve string[][]. */
export function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else if (c === '\r') {
      // ignora; el \n cierra la fila
    } else field += c;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0].trim() !== ''));
}

/** Filas de la hoja 1 → objetos {clave, nombre, tipoBusqueda, clasificacion, importe}. */
export function parseRelacionRows(csvText) {
  const rows = parseCsv(csvText);
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => classKey(h));
  const idx = (name) => header.indexOf(classKey(name));
  const iClave = idx('Clave_Proveedor');
  const iNombre = idx('Nombre_Proveedor');
  const iTipo = idx('Tipo_Busqueda');
  const iClas = idx('Clasificacion_Proveedor');
  const iImp = idx('Importe_Pagado');
  const missing = [
    ['Clave_Proveedor', iClave],
    ['Nombre_Proveedor', iNombre],
    ['Tipo_Busqueda', iTipo],
    ['Clasificacion_Proveedor', iClas],
    ['Importe_Pagado', iImp],
  ].filter(([, i]) => i === -1).map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(`CSV sin los encabezados esperados: ${missing.join(', ')} (fila 1: ${rows[0].join(', ')})`);
  }
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    out.push({
      clave: (cells[iClave] ?? '').trim(),
      nombre: (cells[iNombre] ?? '').trim(),
      tipoBusqueda: (cells[iTipo] ?? '').trim(),
      clasificacion: (cells[iClas] ?? '').trim(),
      importe: (cells[iImp] ?? '').trim(),
    });
  }
  return out;
}

/** Construye el set normalizado de clasificaciones VÁLIDAS. */
export function buildKnownVocabulary({ industryCatalog, providerCatalog }) {
  const known = new Set();
  for (const desc of Object.values(industryCatalog?.catalog ?? {})) known.add(classKey(desc));
  for (const mapName of ['providerTypeByName', 'classificationByName']) {
    for (const v of Object.values(providerCatalog?.[mapName] ?? {})) {
      if (v) known.add(classKey(v));
    }
  }
  for (const cls of Object.keys(providerCatalog?.flexibilityByClass ?? {})) known.add(classKey(cls));
  known.delete(''); // nunca es válido
  return known;
}

/**
 * Valida la clasificación de una fila. Devuelve `{ ok, motivo }`:
 *   - 'vacia'        → sin clasificación (típico de personas / Employees).
 *   - 'null-literal' → el string literal "NULL".
 *   - 'no-mapeable'  → no está en el vocabulario conocido.
 *   - ok:true        → clasificación válida.
 */
export function validateRow(row, known) {
  const raw = (row.clasificacion ?? '').trim();
  if (!raw) return { ok: false, motivo: 'vacia' };
  if (raw.toUpperCase() === 'NULL') return { ok: false, motivo: 'null-literal' };
  if (!known.has(classKey(raw))) return { ok: false, motivo: 'no-mapeable' };
  return { ok: true, motivo: null };
}

/**
 * Merge idempotente: refresca los mapas de clasificación de `providerCatalog`
 * con las filas VÁLIDAS (name→clasificación/clave). Preserva todo lo demás y
 * los proveedores no presentes en el Excel. Devuelve un nuevo objeto + stats.
 */
export function buildRefreshedCatalog(providerCatalog, validRows, { generated, sourceLabel } = {}) {
  const next = JSON.parse(JSON.stringify(providerCatalog));
  next.providerTypeByName ??= {};
  next.classificationByName ??= {};
  next.providerNoByName ??= {};
  let updated = 0;
  let added = 0;
  for (const row of validRows) {
    const name = row.nombre.trim();
    if (!name) continue;
    const existed = name in next.providerTypeByName;
    if (existed) updated++; else added++;
    next.providerTypeByName[name] = row.clasificacion.trim();
    next.classificationByName[name] = row.clasificacion.trim();
    if (row.clave) next.providerNoByName[name] = row.clave.trim();
  }
  // Orden estable de las llaves para un diff determinista (idempotencia).
  for (const map of ['providerTypeByName', 'classificationByName', 'providerNoByName']) {
    next[map] = Object.fromEntries(Object.entries(next[map]).sort(([a], [b]) => a.localeCompare(b)));
  }
  if (generated) next.generated = generated;
  if (sourceLabel && Array.isArray(next.sources) && !next.sources.includes(sourceLabel)) {
    next.sources = [...next.sources, sourceLabel];
  }
  return { catalog: next, updated, added };
}

function toCsvValue(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function main(argv) {
  const args = argv.slice(2);
  const positional = args.filter((a) => !a.startsWith('--'));
  const flags = new Map(
    args.filter((a) => a.startsWith('--')).map((a) => {
      const [k, ...rest] = a.slice(2).split('=');
      return [k, rest.length ? rest.join('=') : true];
    }),
  );
  const relacionCsvPath = positional[0];
  if (!relacionCsvPath) {
    console.error('Uso: node scripts/refresh-provider-classification.mjs <relacion.csv> [--catalog=<industria.csv>] [--out=<reporte.csv>] [--write]');
    process.exit(2);
    return;
  }

  const rows = parseRelacionRows(readFileSync(resolve(relacionCsvPath), 'utf8'));
  const providerCatalog = JSON.parse(readFileSync(PROVIDER_CATALOG_PATH, 'utf8'));

  let industryCatalog = { catalog: {} };
  if (flags.get('catalog')) {
    // Catálogo de industria alterno como CSV (Código,Descripción).
    const catRows = parseCsv(readFileSync(resolve(String(flags.get('catalog'))), 'utf8'));
    for (let i = 1; i < catRows.length; i++) {
      const [code, desc] = catRows[i];
      if (code && desc) industryCatalog.catalog[code.trim()] = desc.trim();
    }
  } else if (existsSync(INDUSTRY_CATALOG_PATH)) {
    industryCatalog = JSON.parse(readFileSync(INDUSTRY_CATALOG_PATH, 'utf8'));
  }

  const known = buildKnownVocabulary({ industryCatalog, providerCatalog });

  const flagged = [];
  const valid = [];
  const byMotivo = { vacia: 0, 'null-literal': 0, 'no-mapeable': 0 };
  for (const row of rows) {
    const { ok, motivo } = validateRow(row, known);
    if (ok) valid.push(row);
    else { flagged.push({ ...row, motivo }); byMotivo[motivo]++; }
  }

  // Reporte de filas marcadas.
  const outPath = resolve(String(flags.get('out') ?? join(scriptDir, 'out', 'provider-classification-issues.csv')));
  mkdirSync(dirname(outPath), { recursive: true });
  const header = ['Clave_Proveedor', 'Nombre_Proveedor', 'Tipo_Busqueda', 'Clasificacion_Proveedor', 'Importe_Pagado', 'Motivo'];
  const lines = [header.join(',')];
  for (const f of flagged) {
    lines.push([f.clave, f.nombre, f.tipoBusqueda, f.clasificacion, f.importe, f.motivo].map(toCsvValue).join(','));
  }
  writeFileSync(outPath, `﻿${lines.join('\n')}\n`, 'utf8');

  console.log('── Refresh clasificación de proveedores ──');
  console.log(`Filas leídas:            ${rows.length}`);
  console.log(`Clasificaciones válidas: ${valid.length}`);
  console.log(`Filas marcadas:          ${flagged.length}  (vacía ${byMotivo.vacia} · NULL ${byMotivo['null-literal']} · no-mapeable ${byMotivo['no-mapeable']})`);
  console.log(`Reporte:                 ${outPath}`);

  if (flags.get('write')) {
    const { catalog, updated, added } = buildRefreshedCatalog(providerCatalog, valid, {
      generated: new Date().toISOString().slice(0, 10),
      sourceLabel: 'clasificacion de proveedores jde.xlsx',
    });
    writeFileSync(PROVIDER_CATALOG_PATH, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');
    console.log(`\n✍  providerCatalog.json actualizado (${updated} actualizados, ${added} nuevos).`);
    console.log('   Verifica DESPUÉS: `npm test -- providerCategoryGeneralization` (cobertura) y Providers.tsx.');
  } else {
    console.log('\n(solo-reporte; agrega --write para aplicar el merge a providerCatalog.json)');
  }
}

// Ejecución directa desde CLI (no cuando se importa desde un test).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv);
}
