import { normalizeCia } from './cia';
import type { CXPRecord } from './persistence';
import { isSettledAgedBalance } from './agedBalanceSettled';
import { keepLatestAgedBalanceSnapshot } from './agedBalanceSnapshot';
import { normalizeJdeDate } from './jdeDate';
import { reportDataGap } from '../services/dataHealth';

/**
 * CSV parser del import manual de CXP (Antigüedad de Saldos exportada a CSV).
 * Extraído de `CXP.tsx` para hacerlo testeable — misma lógica byte-idéntica.
 * Maneja campos entrecomillados, comas dentro de números y \r\n.
 */

export function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (c === ',' && !inQ) {
      result.push(cur.trim());
      cur = '';
    } else {
      cur += c;
    }
  }
  result.push(cur.trim());
  return result;
}

export const parseNum = (val: string): number => {
  if (!val || val.trim() === '') return 0;
  const cleaned = val.replace(/"/g, '').replace(/,/g, '').trim();
  const n = parseFloat(cleaned);
  return isNaN(n) ? 0 : n;
};

export function parseCXP(text: string): CXPRecord[] {
  // Normalize line endings
  const raw = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = raw.split('\n').filter(l => l.trim());
  if (lines.length < 2) throw new Error('CSV vacío o sin datos');

  const headers = parseCSVLine(lines[0]).map(h => h.toLowerCase().replace(/"/g, '').trim());
  const colCount = headers.length;

  const idx = (name: string): number => headers.indexOf(name.toLowerCase());

  // Validate critical columns exist
  const required = ['cia','nombre','importe_pendiente_pesos','por_vencer'];
  const missing = required.filter(r => idx(r) < 0);
  if (missing.length) throw new Error(`Columnas faltantes: ${missing.join(', ')}`);

  const records: CXPRecord[] = [];
  // Llave de dedup en paralelo: `nd` (número de documento) NO se persiste en
  // `CXPRecord`, pero sin él la llave no separa pay-items — es el mismo
  // discriminador que usa el fetcher.
  const keys: string[] = [];
  let skipped = 0;

  for (let i = 1; i < lines.length; i++) {
    const fields = parseCSVLine(lines[i]);
    // Tolerate ±2 columns (some CSVs have trailing commas)
    if (fields.length < colCount - 2) { skipped++; continue; }

    const g = (name: string): string => {
      const ci = idx(name);
      return ci >= 0 && ci < fields.length ? fields[ci].replace(/"/g, '').trim() : '';
    };
    const n = (name: string): number => parseNum(g(name));

    records.push({
      // Misma normalización que los fetchers JDE ("150" → "00150"): sin ella,
      // un CSV de una cía ya cargada de JDE no la REEMPLAZA (llave distinta)
      // — coexisten ambas y la proyección la doble-cuenta.
      cia: normalizeCia(g('cia')),
      noProveedor: g('no_prov'),
      nombre: g('nombre'),
      noFactura: g('no_factura'),
      // Mismo normalizador que el fetcher, por la misma razón: esta tabla
      // guarda sus fechas como `DD-MM-YYYY` y los consumidores exigen ISO. Sin
      // esto un CSV exportado del espejo entra con TODA factura sin
      // vencimiento — "Vencido / Por vencer / A pagar este mes" en $0 y los
      // egresos `cxp:` re-fechados al `asOfDate`. Passthrough si ya viene ISO.
      fechaFactura: normalizeJdeDate(g('fecha_factura')),
      fechaVence: normalizeJdeDate(g('fecha_vence')),
      fechaProgramacionPago: normalizeJdeDate(g('fecha_programacion_pago')),
      diasVencida: n('dias_vencida'),
      importeBrutoPesos: n('importe_bruto_pesos'),
      importePendientePesos: n('importe_pendiente_pesos'),
      importeSubtotalPesos: n('importe_subtotal_pesos'),
      importeImpuestosPesos: n('importe_impuestos_pesos'),
      importeBrutoDolares: n('importe_bruto_dolares'),
      importePendienteDolares: n('importe_pendiente_dolares'),
      moneda: g('moneda'),
      condPago: g('cond_pago'),
      clasifica: g('clasifica'),
      clasificacionProveedor: g('clasificacion_proveedor'),
      edoPago: g('edo_pago'),
      tipoCambio: n('tipo_cambio'),
      porVencer: n('por_vencer'),
      v1_30: n('v_1_30'),
      v31_60: n('v_31_60'),
      v61_90: n('v_61_90'),
      v91_120: n('v_91_120'),
      v121_150: n('v_121_150'),
      v151_180: n('v_151_180'),
      mas180: n('mas_180'),
    });
    // Mismos alias que `mapAgedBalance` (jde.ts): un export con otro nombre de
    // columna degradaría la llave a la forma SIN discriminador de pay-item, que
    // es justo la que colapsa documentos hermanos y se lleva pasivo real.
    const nd = g('nd') || g('no_documento') || g('numerodocumento') || g('no_doc') || g('numero_documento');
    keys.push(`${normalizeCia(g('cia'))}::${g('no_prov')}::${g('no_factura')}::${nd}`);
  }

  // Misma regla que el fetcher de JDE, por la misma razón: un documento marcado
  // PAGADO no es pasivo. Un CSV exportado de la tabla envenenada reintroduciría
  // por esta puerta el mismo pasivo fantasma que `fetchAgedBalances` descarta —
  // y el MISMO registro se comportaría distinto según por dónde entró, que es
  // exactamente cómo se desincronizan dos puertas de entrada.
  // El conteo CONTRADICTORIO (pagado CON saldo) es el que se confiesa, igual
  // que en el fetcher: un pagado en 0 es inocuo y reportarlo sería ruido.
  let settled = 0;
  let settledWithBalance = 0;
  let settledWithBalanceAmount = 0;
  const openIdx: number[] = [];
  for (let i = 0; i < records.length; i += 1) {
    if (!isSettledAgedBalance(records[i])) {
      openIdx.push(i);
      continue;
    }
    settled += 1;
    if (records[i].importePendientePesos !== 0) {
      settledWithBalance += 1;
      settledWithBalanceAmount += records[i].importePendientePesos;
    }
  }

  if (openIdx.length === 0) {
    throw new Error(
      records.length === 0
        ? `No se encontraron registros válidos (${skipped} filas omitidas)`
        : `El archivo sólo trae documentos ya PAGADOS (${settled}): no hay saldo abierto que importar.`,
    );
  }

  // Las MISMAS dos defensas que el fetcher, y por la misma razón: un CSV
  // exportado de la tabla envenenada (23 cargas sin truncar, 2.57× filas)
  // reintroduciría por esta puerta el pasivo fantasma que `fetchAgedBalances`
  // descarta, y `replaceCxpForCias` trata este archivo como igual de
  // autoritativo que el API. Con el origen sano ambas son no-op.
  //
  // **El corte va POR CÍA, y eso es load-bearing** (2026-09-21). El fetcher es
  // inmune por construcción —`/antiguedadsaldos` acepta UNA sola compañía por
  // request—, pero el CSV es multi-cía por diseño: `replaceCxpForCias` deriva
  // `ciasInCsv` de los propios registros parseados. Dos compañías del mismo
  // archivo pueden traer sellos distintos sin que nada esté corrupto (medido en
  // la BD el 2026-09-21: las cías 11/01/42 sellan al 21-sep mientras 30/43/21
  // siguen en el 14-sep). Con un corte global, la cía del sello más viejo se
  // lee como "resto de una carga anterior" y se descarta ENTERA — desaparece
  // pasivo real, la dirección peor, y encima `replaceCxpForCias` reemplaza esa
  // cía, así que su saldo quedaría en cero.
  const cxpCia = (r: CXPRecord) => normalizeCia(r.cia);
  const byCia = new Map<string, CXPRecord[]>();
  for (const i of openIdx) {
    const cia = cxpCia(records[i]);
    const list = byCia.get(cia);
    if (list) list.push(records[i]);
    else byCia.set(cia, [records[i]]);
  }
  const keptIdx = new Set<CXPRecord>();
  let droppedStale = 0;
  let droppedStaleAmount = 0;
  const staleStamps = new Set<string>();
  let latestStamp: string | null = null;
  for (const group of byCia.values()) {
    const snapshot = keepLatestAgedBalanceSnapshot(group);
    for (const rec of snapshot.kept) keptIdx.add(rec);
    droppedStale += snapshot.dropped;
    droppedStaleAmount += snapshot.droppedAmount;
    for (const stamp of snapshot.staleStamps) staleStamps.add(stamp);
    if (snapshot.latestStamp && (latestStamp === null || snapshot.latestStamp > latestStamp)) {
      latestStamp = snapshot.latestStamp;
    }
  }

  const byKey = new Map<string, CXPRecord>();
  for (const i of openIdx) {
    if (!keptIdx.has(records[i])) continue;
    byKey.set(keys[i], records[i]);
  }

  // Las MISMAS confesiones que el fetcher. Sin ellas un import manual que
  // descarte millones queda invisible en "Salud de datos": el monto sería
  // idéntico entre las dos puertas pero la capa que lo confiesa no, y ahí es
  // donde se rompe la garantía de "mismo documento, mismo comportamiento".
  if (settledWithBalance > 0) {
    reportDataGap(
      'cxp',
      'source-contradiction',
      `import CSV: ${settledWithBalance} documentos marcados PAGADOS traían saldo pendiente `
        + `(${settledWithBalanceAmount.toLocaleString('es-MX', { style: 'currency', currency: 'MXN' })}). `
        + 'Descartados: un documento pagado no es pasivo. Corregir en el origen.',
    );
  }
  if (droppedStale > 0) {
    reportDataGap(
      'cxp',
      'source-contradiction',
      `import CSV: ${droppedStale} documentos venían de cargas anteriores `
        + `(${Array.from(staleStamps).sort().reverse().slice(0, 3).join(', ')}) y no del snapshot `
        + `del ${latestStamp} de su cía `
        + `(${droppedStaleAmount.toLocaleString('es-MX', { style: 'currency', currency: 'MXN' })}). `
        + 'El origen debe truncar antes de insertar.',
    );
  }
  return Array.from(byKey.values());
}
