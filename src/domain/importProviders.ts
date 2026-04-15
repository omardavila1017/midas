/**
 * Import Provider[] from the "Resumen proveedores 2025" sheet.
 *
 * Source layout (row 17 header, data from row 18):
 *   A: Nombre, B: Clasificación, C: Frecuencia de pago, D: # pagos,
 *   E: Monto total, F: Monto promedio, G-H: fechas.
 *
 * Mapping:
 *   - Nombre        → Provider.name
 *   - Clasificación → Provider.type (free-form, kept verbatim)
 *   - Risk          → 'Medio' (default; not available in source)
 *   - PaymentPeriod → '30 días' (default; the source has pay FREQUENCY,
 *     not credit-terms — those are two different things, so we don't map)
 *
 * Returns issues for rows that couldn't be fully parsed.
 */

import * as XLSX from 'xlsx';
import { Provider } from './types';

export interface ProviderImportIssue {
  providerName: string;
  kind: 'missing-type' | 'invalid-row';
}

export interface ProviderImportResult {
  providers: Provider[];
  issues: ProviderImportIssue[];
}

export function importProvidersFromWorkbook(wb: XLSX.WorkBook): ProviderImportResult {
  const issues: ProviderImportIssue[] = [];

  const sheet = findSheet(wb, ['Resumen proveedores 2025', 'RESUMEN PROVEEDORES 2025']);
  if (!sheet) {
    return {
      providers: [],
      issues: [{ providerName: '(workbook)', kind: 'invalid-row' }],
    };
  }

  const rows = XLSX.utils.sheet_to_json<any[]>(sheet, { header: 1, defval: null });
  const providers: Provider[] = [];
  let inDataBlock = false;

  for (const r of rows) {
    if (!Array.isArray(r)) continue;
    const first = String(r[0] ?? '').trim();

    // The header row for the detail block contains "NOMBRE DEL PROVEEDOR".
    // Once we see it, every subsequent row with a value in column A is data.
    if (!inDataBlock) {
      if (first.toUpperCase().includes('NOMBRE DEL PROVEEDOR')) {
        inDataBlock = true;
      }
      continue;
    }

    if (!first || first.toUpperCase().includes('TOTAL')) continue;

    const type = String(r[1] ?? '').trim();
    if (!type) {
      issues.push({ providerName: first, kind: 'missing-type' });
    }

    providers.push({
      id: crypto.randomUUID(),
      name: first,
      type: type || 'Otro',
      risk: 'Medio',
      paymentPeriod: '30 días',
    });
  }

  return { providers, issues };
}

function findSheet(wb: XLSX.WorkBook, candidates: string[]): XLSX.WorkSheet | null {
  for (const c of candidates) {
    const hit = wb.SheetNames.find(n => n.trim().toUpperCase() === c.toUpperCase());
    if (hit) return wb.Sheets[hit];
  }
  return null;
}
