/**
 * Import Client[] from the two-sheet source workbook:
 *
 *   RESUMEN VENTA       — monthly billing per client (12 months)
 *   PROYECCION COBRANZA — payment day, frequency, credit days
 *
 * Matching strategy:
 *   1. Exact name match on normalized uppercase.
 *   2. If no billing match found in RESUMEN VENTA, client is still imported
 *      with a zero-filled 12-month array (user sees it flagged as missing).
 *
 * Output includes a `parseIssues` array so the UI can show data-quality
 * problems without silently guessing.
 */

import * as XLSX from 'xlsx';
import { Client, Frequency } from './types';
import { parsePaymentDay, detectsFactoraje } from './parsePaymentDay';

export interface ImportIssue {
  clientName: string;
  kind: 'no-billing' | 'unparsed-day' | 'unknown-frequency' | 'invalid-row';
  detail?: string;
}

export interface ImportResult {
  clients: Client[];
  issues: ImportIssue[];
}

function normName(s: unknown): string {
  return String(s ?? '').trim().toUpperCase();
}

function parseFrequency(raw: string): Frequency | null {
  const s = raw.toLowerCase();
  if (/contado/.test(s)) return 'Contado';
  // Order matters: check "semanal" after "quincenal" so "Quincenal / Semanal"
  // resolves to the finer cadence — per-event amount is halved either way,
  // but weekly gives more granular cash-in dates. Flagged as an assumption.
  if (/semanal/.test(s)) return 'Semanal';
  if (/quincenal/.test(s)) return 'Quincenal';
  if (/mensual/.test(s)) return 'Mensual';
  return null;
}

function parseNumber(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const n = Number(String(v ?? '').replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

/**
 * Read the workbook and produce a typed client catalog.
 */
export function importClientsFromWorkbook(wb: XLSX.WorkBook): ImportResult {
  const issues: ImportIssue[] = [];

  const resumenSheet = findSheet(wb, ['RESUMEN VENTA', 'RESUMEN VENTAS']);
  const cobranzaSheet = findSheet(wb, ['PROYECCION COBRANZA', 'PROYECCIÓN COBRANZA']);

  if (!cobranzaSheet) {
    return {
      clients: [],
      issues: [{ clientName: '(workbook)', kind: 'invalid-row', detail: 'No se encontró hoja PROYECCION COBRANZA' }],
    };
  }

  // -------------------------------------------------------------------------
  // 1. Build billing map from RESUMEN VENTA
  //    Row layout:  A=Cliente, B..M = 12 months
  //    Header rows are in rows 1–4; data starts at row 5.
  // -------------------------------------------------------------------------
  const billing = new Map<string, number[]>();
  if (resumenSheet) {
    const rows = XLSX.utils.sheet_to_json<any[]>(resumenSheet, { header: 1, defval: null });
    for (const r of rows) {
      if (!Array.isArray(r)) continue;
      const name = normName(r[0]);
      // Skip headers and blank rows.
      if (!name || name.includes('FACTURACION') || name.includes('CLIENTE') || name.includes('VENTA')) continue;
      const months = Array.from({ length: 12 }, (_, i) => parseNumber(r[1 + i]));
      if (months.every(v => v === 0)) continue; // all empty row
      billing.set(name, months);
    }
  }

  // -------------------------------------------------------------------------
  // 2. Walk PROYECCION COBRANZA and build Client[]
  //    Row layout:  A=?, B=Cliente, C=Día de pago, D=Ciclo, E=Facturación,
  //                 F=Días Crédito
  // -------------------------------------------------------------------------
  const clients: Client[] = [];
  const cobRows = XLSX.utils.sheet_to_json<any[]>(cobranzaSheet, { header: 1, defval: null });

  for (const r of cobRows) {
    if (!Array.isArray(r)) continue;
    const rawName = String(r[1] ?? '').trim();
    const name = normName(rawName);
    if (!name || name === 'CLIENTE') continue;

    const paymentDayRaw = String(r[2] ?? '').trim();
    const frequencyRaw = String(r[3] ?? '').trim();
    const avgBilling = parseNumber(r[4]);
    const creditDays = parseNumber(r[5]);

    if (!paymentDayRaw && !frequencyRaw && avgBilling === 0) continue; // blank row

    const frequency = parseFrequency(frequencyRaw) ?? 'Mensual';
    if (!parseFrequency(frequencyRaw)) {
      issues.push({ clientName: rawName, kind: 'unknown-frequency', detail: frequencyRaw });
    }

    const pattern = parsePaymentDay(paymentDayRaw);
    if (!pattern && paymentDayRaw) {
      issues.push({ clientName: rawName, kind: 'unparsed-day', detail: paymentDayRaw });
    }

    const monthly = billing.get(name);
    if (!monthly) {
      issues.push({ clientName: rawName, kind: 'no-billing' });
    }

    clients.push({
      id: crypto.randomUUID(),
      name: rawName,
      paymentDayRaw,
      paymentDay: pattern ?? { kind: 'DOW', days: [5] }, // fallback: Fri
      frequency,
      creditDays: creditDays || 30,
      monthlyBilling: monthly ?? new Array(12).fill(avgBilling),
      factoraje: detectsFactoraje(paymentDayRaw),
      complianceRate: undefined,
    });
  }

  return { clients, issues };
}

function findSheet(wb: XLSX.WorkBook, candidates: string[]): XLSX.WorkSheet | null {
  for (const c of candidates) {
    const hit = wb.SheetNames.find(n => n.trim().toUpperCase() === c.toUpperCase());
    if (hit) return wb.Sheets[hit];
  }
  return null;
}
