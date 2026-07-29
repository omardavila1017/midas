import { normalizeCia } from './cia';
import type { CXPRecord } from './persistence';

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
      fechaFactura: g('fecha_factura'),
      fechaVence: g('fecha_vence'),
      fechaProgramacionPago: g('fecha_programacion_pago'),
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
  }

  if (records.length === 0) throw new Error(`No se encontraron registros válidos (${skipped} filas omitidas)`);
  return records;
}
