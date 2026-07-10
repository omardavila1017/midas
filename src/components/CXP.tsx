import { useState, useCallback, useRef, useMemo, useEffect, Fragment, type ReactNode } from 'react';
import {
  FileSpreadsheet,
  Loader2,
  AlertCircle,
  Search,
  Building2,
  Clock,
  ChevronDown,
  ChevronRight,
  X,
  ArrowUpDown,
  Receipt,
  Filter,
  Database,
  RefreshCw,
  HelpCircle,
  Download,
} from 'lucide-react';
import { fetchAgedBalances, JdeApiError, type BankAccountStatement, type BankStatementLine, type Company } from '../services/jde';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from 'recharts';
import { hex } from '../theme';
import PageHeader from './ui/PageHeader';
import SourceInfo from './ui/SourceInfo';
import { fmtCompact, fmtCurrency, todayISO } from '../formatters';
import { csvDate, toCSV, downloadFile } from '../utils/export';
import { isCxpOverdue } from '../domain/cxpOverdue';
import type { CashFlowAssumptions, Client, Provider, ProviderFlexibility, ProviderRisk } from '../domain/types';
import { enrichFromCatalog, flexibilityLabel, type Antiguedad } from '../domain/providerCatalog';
import { scoreBucket, SCORE_LABELS, type ScoreBucket } from '../domain/providerScore';
import type { Budget } from '../domain/budget';
import type { CxpPaymentCoverage } from '../domain/paymentReconciliationEngine';
import { excludeConcursoMercantil } from '../domain/concursoMercantil';
import { buildProviderIndex, findProviderByRef, type ProviderIndex } from '../domain/providerIdentity';
import { makeAttribution, sourceOf, type SourceAttribution } from '../domain/sourceAttribution';

/* ═══════════════════════════════════════════════════════════════════════
   Types
   ═══════════════════════════════════════════════════════════════════════ */

interface CXPRecord {
  cia: string;
  noProveedor: string;
  nombre: string;
  noFactura: string;
  fechaFactura: string;
  fechaVence: string;
  fechaProgramacionPago: string;
  diasVencida: number;
  importeBrutoPesos: number;
  importePendientePesos: number;
  importeSubtotalPesos: number;
  importeImpuestosPesos: number;
  importeBrutoDolares: number;
  importePendienteDolares: number;
  moneda: string;
  condPago: string;
  clasifica: string;
  clasificacionProveedor: string;
  edoPago: string;
  tipoCambio: number;
  porVencer: number;
  v1_30: number;
  v31_60: number;
  v61_90: number;
  v91_120: number;
  v121_150: number;
  v151_180: number;
  mas180: number;
}

type PaymentPriority = 'critical' | 'negotiable' | 'highImpact' | 'normal';
type CxpAlertType =
  | 'riskHigh'
  | 'urgentPayment'
  | 'operationalImpact'
  | 'cashImpact'
  | 'criticalProvider'
  | 'overdue'
  | 'blocked'
  | 'incomplete'
  | 'duplicate'
  | 'creditLimit'
  | 'staleProvider';
type AlertTone = 'danger' | 'warning' | 'info';

interface CxpAlert {
  type: CxpAlertType;
  label: string;
  detail: string;
  tone: AlertTone;
}

interface PaymentReference {
  kind: 'Factura' | 'Proveedor' | 'OC' | 'Contrato' | 'Concepto';
  label: string;
}

interface EnrichedCXPRecord extends CXPRecord {
  providerType: string;
  providerRisk: ProviderRisk;
  providerRiskComment?: string;
  providerFlexibility: ProviderFlexibility;
  providerFlexibilityComment?: string;
  providerCreditLimit?: number;
  providerDaysWithoutUpdate: number | null;
  providerDtiArea?: string;
  providerDtiCriticidad?: 'Alta' | 'Media' | 'Baja';
  providerLastPaymentDate?: string;
  providerLastPaymentAmount?: number;
  providerLastPaymentAgeDays?: number | null;
  providerAntiguedad?: Antiguedad | null;
  providerScore?: number;
  providerClasificacion?: ScoreBucket;
  paymentPriority: PaymentPriority;
  referenceLinks: PaymentReference[];
  alerts: CxpAlert[];
}

interface AgingBucket {
  name: string;
  key: keyof CXPRecord;
  color: string;
  total: number;
  count: number;
}

interface SupplierSummary {
  nombre: string;
  noProveedor: string;
  total: number;
  count: number;
  maxDias: number;
  providerType: string;
  providerScore?: number;
  providerClasificacion?: ScoreBucket;
  creditLimit?: number;
  records: EnrichedCXPRecord[];
  bucketTotals: number[];
  vencido: number;
  sortedRecords: EnrichedCXPRecord[];
}

type DashboardTab = 'resumen' | 'proveedores';
type SortKey = 'nombre' | 'total' | 'count' | 'maxDias';
type SortDir = 'asc' | 'desc';

/* ═══════════════════════════════════════════════════════════════════════
   Constants
   ═══════════════════════════════════════════════════════════════════════ */

// Severity ramp: green (within term) → red (most overdue). Monotonic so the
// color always communicates how bad the aging bucket is.
const AGING_COLORS = [
  'oklch(58% 0.14 152)', // Por Vencer — within term
  'oklch(62% 0.15 120)', // 1-30
  'oklch(70% 0.15 95)',  // 31-60
  'oklch(68% 0.16 65)',  // 61-90
  'oklch(63% 0.18 45)',  // 91-120
  'oklch(60% 0.20 30)',  // 121-150
  'oklch(55% 0.21 25)',  // 151-180
  'oklch(45% 0.18 22)',  // 180+
];
const BUCKET_LABELS = ['Por Vencer','1-30','31-60','61-90','91-120','121-150','151-180','180+'];
const BUCKET_KEYS: (keyof CXPRecord)[] = ['porVencer','v1_30','v31_60','v61_90','v91_120','v121_150','v151_180','mas180'];
const PIE_COLORS = [hex.primary, hex.success, hex.warning, 'var(--chart-4)', hex.danger, hex.info, 'var(--chart-5)', 'var(--chart-5)', 'var(--chart-3)', 'var(--chart-5)'];
const PAGE_SIZE = 50;
const DAY_MS = 24 * 60 * 60 * 1000;
const HIGH_IMPACT_AMOUNT = 1_000_000;
const ALERT_LABELS: Record<CxpAlertType, string> = {
  riskHigh: 'Riesgo alto',
  urgentPayment: 'Urgencia de pago',
  operationalImpact: 'Impacto operativo',
  cashImpact: 'Impacto en flujo',
  criticalProvider: 'Proveedor crítico',
  overdue: 'Facturas vencidas',
  blocked: 'Bloqueadas',
  incomplete: 'Datos incompletos',
  duplicate: 'Duplicidad posible',
  creditLimit: 'Límite comprometido',
  staleProvider: 'Proveedor sin actualizar',
};
const BUCKET_CHIP: Record<ScoreBucket, string> = {
  CRITICO: 'bg-[var(--danger-muted)] text-[var(--danger)]',
  ALTO: 'bg-[var(--warning-muted)] text-[var(--warning)]',
  MEDIO: 'bg-[var(--primary-muted)] text-[var(--primary)]',
  BAJO: 'bg-[var(--success-muted)] text-[var(--success)]',
};
/* ═══════════════════════════════════════════════════════════════════════
   Helpers
   ═══════════════════════════════════════════════════════════════════════ */

const parseNum = (val: string): number => {
  if (!val || val.trim() === '') return 0;
  const cleaned = val.replace(/"/g, '').replace(/,/g, '').trim();
  const n = parseFloat(cleaned);
  return isNaN(n) ? 0 : n;
};

/* fmt & fmtFull → imported from ../formatters as fmtCompact & fmtCurrency */
const fmt = fmtCompact;
const fmtFull = fmtCurrency;

const pct = (part: number, whole: number): string =>
  whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : '0%';

const normName = (value: string | undefined | null): string =>
  (value ?? '').trim().replace(/\s+/g, ' ').toUpperCase();

function riskFromFlexibility(flexibility: ProviderFlexibility): ProviderRisk {
  if (flexibility === 'inamovible') return 'Alto';
  if (flexibility === 'flexible') return 'Bajo';
  return 'Medio';
}

function daysSince(value: string | undefined): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return null;
  return Math.max(0, Math.floor((Date.now() - time) / DAY_MS));
}

function parseDateToIso(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const iso = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
  const slash = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slash) {
    const month = Number(slash[1]);
    const day = Number(slash[2]);
    const year = Number(slash[3]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }
  return null;
}

function dueDateForRecord(record: Pick<CXPRecord, 'fechaProgramacionPago' | 'fechaVence' | 'fechaFactura'>): string | null {
  return parseDateToIso(record.fechaProgramacionPago) ?? parseDateToIso(record.fechaVence) ?? parseDateToIso(record.fechaFactura);
}

function isDueThisWeek(record: CXPRecord): boolean {
  const due = dueDateForRecord(record);
  if (!due) return false;
  const dueDate = new Date(`${due}T12:00:00`);
  if (!Number.isFinite(dueDate.getTime())) return false;

  const today = new Date();
  const localNoon = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 12, 0, 0);
  const day = (localNoon.getDay() + 6) % 7;
  const start = new Date(localNoon);
  start.setDate(localNoon.getDate() - day);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return dueDate >= start && dueDate <= end;
}

function inferReferences(record: CXPRecord): PaymentReference[] {
  const refs: PaymentReference[] = [];
  if (record.noFactura) refs.push({ kind: 'Factura', label: record.noFactura });
  if (record.noProveedor || record.nombre) {
    refs.push({ kind: 'Proveedor', label: record.noProveedor || record.nombre });
  }

  const text = [
    record.noFactura,
    record.clasifica,
    record.clasificacionProveedor,
    record.edoPago,
  ].join(' ');
  const oc = text.match(/\b(?:OC|PO|ORDEN(?:\s+DE\s+COMPRA)?)\s*[:#-]?\s*([A-Z0-9-]{3,})/i);
  if (oc?.[1]) refs.push({ kind: 'OC', label: oc[1] });
  const contract = text.match(/\b(?:CONTRATO|CONTR|CTO)\s*[:#-]?\s*([A-Z0-9-]{3,})/i);
  if (contract?.[1]) refs.push({ kind: 'Contrato', label: contract[1] });
  if (record.clasifica || record.clasificacionProveedor) {
    refs.push({ kind: 'Concepto', label: record.clasifica || record.clasificacionProveedor });
  }
  return refs;
}

function invoiceKey(record: Pick<CXPRecord, 'cia' | 'noProveedor' | 'nombre' | 'noFactura' | 'fechaFactura' | 'importePendientePesos'>): string {
  return [
    record.cia,
    normName(record.noProveedor || record.nombre),
    normName(record.noFactura),
    record.fechaFactura,
    Math.round(record.importePendientePesos * 100) / 100,
  ].join('|');
}

function isBlocked(record: Pick<CXPRecord, 'edoPago' | 'clasifica' | 'clasificacionProveedor'>): boolean {
  const text = normName(`${record.edoPago} ${record.clasifica} ${record.clasificacionProveedor}`);
  return /\b(BLOQ|BLOQUE|RETEN|DETEN|APROB|RECHAZ|HOLD)\b/.test(text);
}

function alertItem(type: CxpAlertType, detail: string, tone: AlertTone): CxpAlert {
  return { type, label: ALERT_LABELS[type], detail, tone };
}

function buildCxpAlerts(
  record: EnrichedCXPRecord,
  duplicateCount: number,
  supplierExposure: number,
): CxpAlert[] {
  const alerts: CxpAlert[] = [];
  if (record.providerRisk === 'Alto') alerts.push(alertItem('riskHigh', 'Proveedor con riesgo alto en catálogo.', 'danger'));
  if (record.paymentPriority === 'critical') alerts.push(alertItem('urgentPayment', priorityReason(record), 'danger'));
  if (record.providerFlexibility === 'inamovible') alerts.push(alertItem('operationalImpact', 'Proveedor inamovible; mover el pago puede afectar operación.', 'danger'));
  if (record.importePendientePesos >= HIGH_IMPACT_AMOUNT) alerts.push(alertItem('cashImpact', `Factura de ${fmtFull(record.importePendientePesos)} con impacto material en caja.`, 'warning'));
  if (record.providerDtiCriticidad === 'Alta') alerts.push(alertItem('criticalProvider', `Proveedor crítico DTI${record.providerDtiArea ? ` (${record.providerDtiArea})` : ''}.`, 'danger'));
  if (record.diasVencida > 0) alerts.push(alertItem('overdue', agingTooltip(record.diasVencida), record.diasVencida > 90 ? 'danger' : 'warning'));
  if (isBlocked(record)) alerts.push(alertItem('blocked', `Estatus o clasificación: ${record.edoPago || record.clasifica || record.clasificacionProveedor || 'sin detalle'}.`, 'warning'));
  if (!record.noFactura || !record.fechaFactura || !dueDateForRecord(record) || record.importePendientePesos <= 0) {
    alerts.push(alertItem('incomplete', 'Falta factura, fecha, vencimiento o monto pendiente.', 'warning'));
  }
  if (duplicateCount > 1) alerts.push(alertItem('duplicate', `${duplicateCount} registros con misma factura/proveedor/monto.`, 'warning'));
  if (record.providerCreditLimit && record.providerCreditLimit > 0 && supplierExposure >= record.providerCreditLimit * 0.9) {
    alerts.push(alertItem('creditLimit', `Exposición ${fmtFull(supplierExposure)} vs límite ${fmtFull(record.providerCreditLimit)}.`, 'warning'));
  }
  if (record.providerDaysWithoutUpdate !== null && record.providerDaysWithoutUpdate > 90) {
    alerts.push(alertItem('staleProvider', `${record.providerDaysWithoutUpdate} días sin actualización del proveedor.`, 'warning'));
  }
  return alerts;
}

function isCritical(record: Pick<EnrichedCXPRecord, 'providerRisk' | 'providerFlexibility' | 'diasVencida'>): boolean {
  return record.providerRisk === 'Alto' || record.providerFlexibility === 'inamovible' || record.diasVencida > 30;
}

function isNegotiable(record: Pick<EnrichedCXPRecord, 'providerFlexibility' | 'diasVencida'>): boolean {
  return record.providerFlexibility === 'flexible' && record.diasVencida <= 30;
}

function isHighImpact(record: Pick<EnrichedCXPRecord, 'importePendientePesos'>): boolean {
  return record.importePendientePesos >= HIGH_IMPACT_AMOUNT;
}

function paymentPriority(record: EnrichedCXPRecord): PaymentPriority {
  if (isCritical(record)) return 'critical';
  if (isHighImpact(record)) return 'highImpact';
  if (isNegotiable(record)) return 'negotiable';
  return 'normal';
}

function enrichCxpRecord(
  record: CXPRecord,
  providerIndex: ProviderIndex,
): EnrichedCXPRecord {
  const provider: Provider | undefined = findProviderByRef(providerIndex, {
    jdeCode: record.noProveedor,
    name: record.nombre,
  }).provider ?? undefined;
  const catalog = enrichFromCatalog({
    supplier: record.nombre,
    classification: record.clasificacionProveedor,
  });
  const providerFlexibility = provider?.flexibility ?? catalog.flexibility;
  const providerRisk = provider?.risk ?? riskFromFlexibility(providerFlexibility);
  const providerType = catalog.providerType || (provider?.type && provider.type !== 'Otro' ? provider.type : '') || record.clasificacionProveedor?.trim() || 'Sin clasificar';
  const enriched: EnrichedCXPRecord = {
    ...record,
    providerType,
    providerRisk,
    providerRiskComment: provider?.riskComment,
    providerFlexibility,
    providerFlexibilityComment: provider?.flexibilityComment,
    providerCreditLimit: provider?.creditLimit ?? catalog.creditLimit ?? undefined,
    providerDaysWithoutUpdate: daysSince(provider?.lastUpdatedAt),
    providerDtiArea: provider?.dtiArea ?? catalog.dtiArea ?? undefined,
    providerDtiCriticidad: provider?.dtiCriticidad ?? catalog.criticidad ?? undefined,
    providerLastPaymentDate: catalog.lastPayment?.ultimaFecha,
    providerLastPaymentAmount: catalog.lastPayment?.ultimoMonto,
    providerLastPaymentAgeDays: catalog.lastPaymentAgeDays,
    providerAntiguedad: catalog.antiguedad,
    providerScore: provider?.score,
    providerClasificacion: provider?.clasificacionAutomatica,
    paymentPriority: 'normal',
    referenceLinks: inferReferences(record),
    alerts: [],
  };
  enriched.paymentPriority = paymentPriority(enriched);
  return enriched;
}

function priorityLabel(priority: PaymentPriority): string {
  switch (priority) {
    case 'critical': return 'Critico';
    case 'negotiable': return 'Negociable';
    case 'highImpact': return 'Impacto alto';
    default: return 'Normal';
  }
}

/** Severidad para ordenar "qué pagar primero": crítico antes que normal. */
const PRIORITY_RANK: Record<PaymentPriority, number> = {
  critical: 0,
  highImpact: 1,
  negotiable: 2,
  normal: 3,
};

function priorityTone(priority: PaymentPriority): string {
  switch (priority) {
    case 'critical': return 'bg-[var(--danger-muted)] text-[var(--danger)]';
    case 'negotiable': return 'bg-[var(--success-muted)] text-[var(--success)]';
    case 'highImpact': return 'bg-[var(--warning-muted)] text-[var(--warning)]';
    default: return 'bg-[var(--gray-100)] text-[var(--gray-500)]';
  }
}

function CxpTotalCard({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  tone: 'neutral' | 'danger' | 'warning';
}) {
  const toneColor = tone === 'danger' ? 'var(--danger)' : tone === 'warning' ? 'var(--warning)' : 'var(--gray-700)';
  return (
    <div className="bg-white border border-[var(--gray-200)] rounded-[var(--radius-lg)] p-4 shadow-sm animate-card-in">
      <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--gray-400)]">{label}</p>
      <p className="mt-1.5 font-mono text-[20px] font-bold tabular-nums leading-none" style={{ color: toneColor }}>{value}</p>
      <p className="mt-1.5 text-[11px] text-[var(--gray-400)] truncate" title={sub}>{sub}</p>
    </div>
  );
}

function antiguedadLabel(a: Antiguedad): string {
  switch (a) {
    case 'reciente': return 'Pago reciente';
    case 'media': return 'Pago intermedio';
    case 'aneja': return 'Pago añejo';
  }
}

function antiguedadToneClass(a: Antiguedad): string {
  switch (a) {
    case 'reciente': return 'bg-[var(--success-muted)] text-[var(--success)]';
    case 'media': return 'bg-[var(--warning-muted)] text-[var(--warning)]';
    case 'aneja': return 'bg-[var(--danger-muted)] text-[var(--danger)]';
  }
}

function priorityReason(record: EnrichedCXPRecord): string {
  const reasons: string[] = [];
  if (record.providerDtiCriticidad) {
    reasons.push(`DTI = ${record.providerDtiCriticidad}${record.providerDtiArea ? ` (${record.providerDtiArea})` : ''}`);
  } else {
    reasons.push(`riesgo = ${record.providerRisk}`);
  }

  reasons.push(`flexibilidad = ${flexibilityLabel(record.providerFlexibility).toLowerCase()}`);

  if (record.diasVencida > 0) reasons.push(`vence con ${record.diasVencida} dias de atraso`);
  else if (isDueThisWeek(record)) reasons.push('vence esta semana');
  else reasons.push('esta por vencer');

  if (record.importePendientePesos >= HIGH_IMPACT_AMOUNT) reasons.push(`monto >= ${fmt(HIGH_IMPACT_AMOUNT)}`);

  if (record.paymentPriority === 'critical') return `Critico porque ${reasons.join(', ')}.`;
  if (record.paymentPriority === 'highImpact') return `Impacto alto porque ${reasons.join(', ')}.`;
  if (record.paymentPriority === 'negotiable') return `Negociable porque ${reasons.join(', ')}.`;
  return `Normal porque ${reasons.join(', ')}.`;
}

function agingTooltip(days: number): string {
  if (days <= 0) return 'Por vencer: aun esta dentro del plazo operativo.';
  if (days <= 30) return `${days} dias vencido: seguimiento operativo; puede afectar la relacion si se acumula.`;
  if (days <= 60) return `${days} dias vencido: tension con proveedor y posible bloqueo de credito.`;
  if (days <= 90) return `${days} dias vencido: riesgo alto de suspension de servicio o condiciones mas estrictas.`;
  return `${days} dias vencido: riesgo legal/comercial; requiere decision prioritaria.`;
}

function flattenBankMovements(bankStatements: BankAccountStatement[], cia?: string): BankStatementLine[] {
  return bankStatements
    .filter(statement => !cia || cia === 'all' || statement.cia === cia)
    .flatMap(statement => statement.movimientos);
}

function findPossibleBankPayments(record: EnrichedCXPRecord, bankStatements: BankAccountStatement[]): BankStatementLine[] {
  const target = record.importePendientePesos;
  if (target <= 0 || bankStatements.length === 0) return [];
  const provider = normName(record.nombre);
  const invoice = normName(record.noFactura);
  return flattenBankMovements(bankStatements, record.cia)
    .filter(movement => movement.tipoMovimiento === 'CARGO')
    .filter((movement) => {
      const amountOk = Math.abs(Math.abs(movement.importe) - target) <= Math.max(500, target * 0.05);
      const text = normName(`${movement.concepto} ${movement.referencia}`);
      const textOk = (provider && text.includes(provider.slice(0, Math.min(provider.length, 18)))) || (invoice && text.includes(invoice));
      return amountOk || textOk;
    })
    .sort((a, b) => b.fechaOperacion.localeCompare(a.fechaOperacion))
    .slice(0, 6);
}

/**
 * Fuente de un renglón de factura CxP. La base SIEMPRE es CxP (Antigüedad de
 * saldos); si además tiene cobertura de pago conciliada (PagoProveedor × banco),
 * el renglón es un CRUCE de tres fuentes.
 */
function attributeCxpRow(record: CXPRecord, coverage?: CxpPaymentCoverage): SourceAttribution {
  if (coverage && (coverage.status === 'PAID' || coverage.status === 'PARTIAL')) {
    return makeAttribution(['cxp', 'pagoproveedor', 'bancos'], {
      crossKey: coverage.payments.map(p => p.noPago).join(', '),
      note: 'Cobertura de pago conciliada',
    });
  }
  return sourceOf('cxp');
}

/* ═══════════════════════════════════════════════════════════════════════
   CSV Parser — handles quoted fields, commas-in-numbers, \r\n
   ═══════════════════════════════════════════════════════════════════════ */

function parseCSVLine(line: string): string[] {
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

function parseCXP(text: string): CXPRecord[] {
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
      cia: g('cia'),
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


/* ═══════════════════════════════════════════════════════════════════════
   Custom Tooltip
   ═══════════════════════════════════════════════════════════════════════ */

const ChartTooltip = ({ active, payload }: any) => {
  if (!active || !payload?.[0]) return null;
  const item = payload[0].payload;
  return (
    <div className="bg-white border border-[var(--gray-200)] rounded-[var(--radius)] px-3 py-2 shadow-lg">
      <p className="text-[12px] font-bold text-[var(--gray-950)]">{item.name || payload[0].name}</p>
      <p className="text-[12px] font-mono text-[var(--gray-500)]">{fmtFull(payload[0].value)}</p>
    </div>
  );
};

/* ═══════════════════════════════════════════════════════════════════════
   Dashboard
   ═══════════════════════════════════════════════════════════════════════ */

const CXPDashboard = ({
  records,
  companies: compCatalog,
  providers,
  bankStatements,
  paymentCoverage,
}: {
  records: CXPRecord[];
  onReset: () => void;
  companies?: Company[];
  providers: Provider[];
  clients: Client[];
  assumptions: CashFlowAssumptions;
  bankStatements: BankAccountStatement[];
  paymentCoverage?: Map<string, CxpPaymentCoverage>;
}) => {
  /** Resolve a cia code (e.g. "00011") to its short name from the catalog. */
  const ciaName = useCallback((code: string): string => {
    if (!compCatalog) return code;
    const found = compCatalog.find(c => c.cia === code);
    if (!found) return code;
    // Strip the code prefix if the nombre already starts with it (e.g. "00011 - Servicio Industrial...")
    const nombre = found.nombre;
    const prefix = `${code} - `;
    return nombre.startsWith(prefix) ? nombre.slice(prefix.length).trim() : nombre;
  }, [compCatalog]);
  const [tab, setTab] = useState<DashboardTab>('resumen');
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCia, setSelectedCia] = useState('all');
  const [expandedSupplier, setExpandedSupplier] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('total');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [provPage, setProvPage] = useState(0);
  const [selectedRecord, setSelectedRecord] = useState<EnrichedCXPRecord | null>(null);
  const [showPagarDetail, setShowPagarDetail] = useState(false);
  const [pagarDetailRows, setPagarDetailRows] = useState(20);

  const clearAllFilters = () => {
    setSearchTerm('');
    setSelectedRecord(null);
    setProvPage(0);
  };
  const hasDrill = Boolean(searchTerm);

  // Reset local filters when parent switches company (records no longer include the selected cia)
  useEffect(() => {
    if (selectedCia !== 'all' && !records.some(r => r.cia === selectedCia)) {
      setSelectedCia('all');
      setSelectedRecord(null);
      setExpandedSupplier(null);
      setProvPage(0);
    }
  }, [records, selectedCia]);

  const providerIndex = useMemo(() => buildProviderIndex(providers), [providers]);

  const enrichedRecords = useMemo(() => {
    const base = records.map((record) => enrichCxpRecord(record, providerIndex));
    const duplicateCounts = new Map<string, number>();
    const exposureBySupplier = new Map<string, number>();
    base.forEach((record) => {
      const key = invoiceKey(record);
      duplicateCounts.set(key, (duplicateCounts.get(key) ?? 0) + 1);
      const supplierKey = normName(record.nombre || record.noProveedor);
      exposureBySupplier.set(supplierKey, (exposureBySupplier.get(supplierKey) ?? 0) + record.importePendientePesos);
    });
    return base.map((record) => {
      const supplierExposure = exposureBySupplier.get(normName(record.nombre || record.noProveedor)) ?? record.importePendientePesos;
      return {
        ...record,
        alerts: buildCxpAlerts(record, duplicateCounts.get(invoiceKey(record)) ?? 0, supplierExposure),
      };
    });
  }, [providerIndex, records]);

  // ── Filtered Records ──
  const filtered = useMemo(() => {
    let f = enrichedRecords;
    if (selectedCia !== 'all') f = f.filter(r => r.cia === selectedCia);
    if (searchTerm) {
      const t = searchTerm.toLowerCase();
      f = f.filter(r => {
        const haystack = [
          r.nombre,
          r.noFactura,
          r.noProveedor,
          r.providerType,
          r.providerRisk,
          flexibilityLabel(r.providerFlexibility),
          r.referenceLinks.map(ref => `${ref.kind} ${ref.label}`).join(' '),
        ].join(' ').toLowerCase();
        return haystack.includes(t);
      });
    }
    return f;
  }, [enrichedRecords, selectedCia, searchTerm]);

  // ── Derived Data ──
  const companies = useMemo(() => Array.from(new Set(records.map(r => r.cia))).sort(), [records]);

  const agingBuckets: AgingBucket[] = useMemo(() => {
    const buckets = BUCKET_KEYS.map((key, i) => ({
      name: BUCKET_LABELS[i],
      key,
      color: AGING_COLORS[i],
      total: 0,
      count: 0,
    }));
    filtered.forEach((record) => {
      BUCKET_KEYS.forEach((key, index) => {
        const value = record[key] as number;
        if (value <= 0) return;
        buckets[index].total += value;
        buckets[index].count += 1;
      });
    });
    return buckets;
  }, [filtered]);

  const totalPendiente = useMemo(() => filtered.reduce((s, r) => s + r.importePendientePesos, 0), [filtered]);

  // Totales de cabecera (petición de finanzas: "¿cuánto debo?" + "¿cuánto debo
  // pagar este mes según la prioridad de mis proveedores?"). "A pagar este mes"
  // = ya vencido (debías pagar) + lo que vence dentro del mes corriente.
  const cxpTotals = useMemo(() => {
    const now = new Date();
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    const endOfMonth = `${lastDay.getFullYear()}-${String(lastDay.getMonth() + 1).padStart(2, '0')}-${String(lastDay.getDate()).padStart(2, '0')}`;
    let total = 0;
    let vencido = 0;
    let porVencer = 0;
    let aPagarEsteMes = 0;
    const porPrioridad: Record<PaymentPriority, number> = { critical: 0, highImpact: 0, negotiable: 0, normal: 0 };
    const today = todayISO();
    for (const r of filtered) {
      const amt = r.importePendientePesos;
      total += amt;
      const due = dueDateForRecord(r);
      const overdue = isCxpOverdue(r.diasVencida, due, today);
      if (overdue) vencido += amt;
      else porVencer += amt;
      if (overdue || (due !== null && due <= endOfMonth)) {
        aPagarEsteMes += amt;
        porPrioridad[r.paymentPriority] += amt;
      }
    }
    return { total, vencido, porVencer, aPagarEsteMes, porPrioridad };
  }, [filtered]);

  // "A pagar este mes" desglosado por PROVEEDOR, ordenado por prioridad y luego
  // por monto: la lista accionable que pidió Romo — qué proveedores pagar este
  // mes según su categoría/prioridad, con cuánto de eso ya está vencido.
  const aPagarProviders = useMemo(() => {
    const now = new Date();
    const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    const endOfMonth = `${lastDay.getFullYear()}-${String(lastDay.getMonth() + 1).padStart(2, '0')}-${String(lastDay.getDate()).padStart(2, '0')}`;
    const map = new Map<string, { nombre: string; noProveedor: string; total: number; vencido: number; count: number; priority: PaymentPriority; priorityRank: number }>();
    const today = todayISO();
    for (const r of filtered) {
      const due = dueDateForRecord(r);
      const overdue = isCxpOverdue(r.diasVencida, due, today);
      if (!(overdue || (due !== null && due <= endOfMonth))) continue;
      const key = r.noProveedor || r.nombre || 'SIN';
      let e = map.get(key);
      if (!e) {
        e = { nombre: r.nombre || r.noProveedor || 'Sin nombre', noProveedor: r.noProveedor || '', total: 0, vencido: 0, count: 0, priority: 'normal', priorityRank: 99 };
        map.set(key, e);
      }
      e.total += r.importePendientePesos;
      if (overdue) e.vencido += r.importePendientePesos;
      e.count += 1;
      const rank = PRIORITY_RANK[r.paymentPriority];
      if (rank < e.priorityRank) { e.priorityRank = rank; e.priority = r.paymentPriority; }
    }
    return Array.from(map.values()).sort((a, b) => a.priorityRank - b.priorityRank || b.total - a.total);
  }, [filtered]);

  // Supplier aggregation
  const supplierData = useMemo(() => {
    const map = new Map<string, SupplierSummary>();
    filtered.forEach(r => {
      const k = r.nombre || 'SIN NOMBRE';
      if (!map.has(k)) {
        map.set(k, {
          nombre: k,
          noProveedor: r.noProveedor || '',
          total: 0,
          count: 0,
          maxDias: 0,
          providerType: r.providerType,
          providerScore: r.providerScore,
          providerClasificacion: r.providerClasificacion,
          creditLimit: r.providerCreditLimit,
          records: [],
          bucketTotals: new Array(BUCKET_KEYS.length).fill(0),
          vencido: 0,
          sortedRecords: [],
        });
      }
      const e = map.get(k)!;
      e.total += r.importePendientePesos;
      e.count++;
      e.maxDias = Math.max(e.maxDias, r.diasVencida);
      BUCKET_KEYS.forEach((key, index) => {
        const value = r[key] as number;
        e.bucketTotals[index] += value;
        if (index > 0) e.vencido += value;
      });
      e.records.push(r);
    });
    const arr = Array.from(map.values()).map((supplier) => ({
      ...supplier,
      sortedRecords: [...supplier.records].sort((a, b) => b.diasVencida - a.diasVencida),
    }));
    arr.sort((a, b) => {
      const mul = sortDir === 'desc' ? -1 : 1;
      if (sortKey === 'nombre') return mul * a.nombre.localeCompare(b.nombre);
      return mul * ((a[sortKey] as number) - (b[sortKey] as number));
    });
    return arr;
  }, [filtered, sortKey, sortDir]);

  // Company breakdown — show names instead of codes
  const ciaData = useMemo(() => {
    const map = new Map<string, number>();
    filtered.forEach(r => map.set(r.cia, (map.get(r.cia) || 0) + r.importePendientePesos));
    return Array.from(map.entries())
      .map(([code, value]) => ({ name: ciaName(code), value }))
      .sort((a, b) => b.value - a.value);
  }, [filtered, ciaName]);

  // Pagination
  const totalPages = Math.ceil(supplierData.length / PAGE_SIZE);
  const pagedSuppliers = supplierData.slice(provPage * PAGE_SIZE, (provPage + 1) * PAGE_SIZE);

  const toggleSort = (k: SortKey) => {
    if (sortKey === k) setSortDir(d => d === 'desc' ? 'asc' : 'desc');
    else { setSortKey(k); setSortDir('desc'); }
    setProvPage(0);
  };

  const tabs: { id: DashboardTab; label: string; count?: number }[] = [
    { id: 'resumen', label: 'Resumen' },
    { id: 'proveedores', label: 'Proveedores', count: supplierData.length },
  ];

  const activeFilterChips = [
    ...(searchTerm ? [{ key: 'search', label: `Busqueda: ${searchTerm}`, onRemove: () => setSearchTerm('') }] : []),
  ];

  // CSV of the currently filtered rows — same csvDate (dd/mm/aaaa) + BOM
  // convention as the other Egresos tabs (Compras/Pagos/Pasivo), which CXP
  // was the only one missing.
  const handleExportCsv = () => {
    const rows = filtered.map((r) => ({
      Empresa: ciaName(r.cia),
      'No. Proveedor': r.noProveedor,
      Proveedor: r.nombre,
      'No. Factura': r.noFactura,
      'Fecha Factura': csvDate(r.fechaFactura),
      'Fecha Vence': csvDate(r.fechaVence),
      'Días Vencida': r.diasVencida,
      Moneda: r.moneda,
      'Importe Bruto (MXN)': Math.round(r.importeBrutoPesos),
      'Importe Pendiente (MXN)': Math.round(r.importePendientePesos),
      'Clasificación Proveedor': r.clasificacionProveedor,
      'Estado Pago': r.edoPago,
      'Cond. Pago': r.condPago,
    }));
    downloadFile(toCSV(rows), 'cxp-antiguedad-saldos.csv');
  };

  /* ── Render ── */
  return (
    <div className="relative space-y-4">
      {/* ── Header Bar ── */}
      <div className="rounded-[var(--radius-lg)] border border-[var(--gray-200)] bg-white px-3 py-2.5 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex min-w-[240px] flex-1 items-center rounded-full border border-[var(--gray-200)] bg-[var(--gray-50)] px-3 py-1.5 gap-2">
            <Search className="w-3.5 h-3.5 text-[var(--gray-400)]" />
            <input type="text" placeholder="Buscar proveedor, factura, # prov..."
              value={searchTerm} onChange={e => { setSearchTerm(e.target.value); setProvPage(0); }}
              className="min-w-0 flex-1 text-[13px] bg-transparent border-none outline-none placeholder:text-[var(--gray-300)]" />
            {searchTerm && <button onClick={() => setSearchTerm('')}><X className="w-3.5 h-3.5 text-[var(--gray-400)]" /></button>}
          </div>

          <select value={selectedCia} onChange={e => { setSelectedCia(e.target.value); setProvPage(0); }}
            className="max-w-[220px] text-[13px] bg-white rounded-full border border-[var(--gray-200)] px-3 py-1.5 text-[var(--gray-950)] cursor-pointer">
            <option value="all">Todas las compañías</option>
            {companies.map(c => <option key={c} value={c}>{ciaName(c)}</option>)}
          </select>

          <div className="flex items-center gap-1 text-[12px] text-[var(--gray-400)] bg-[var(--gray-50)] rounded-full px-3 py-1.5">
            <Receipt className="w-3.5 h-3.5" />
            {filtered.length.toLocaleString()} facturas
          </div>

          <button
            onClick={handleExportCsv}
            disabled={filtered.length === 0}
            className="flex items-center gap-1 text-[12px] text-[var(--gray-400)] hover:text-[var(--primary)] disabled:opacity-40 transition bg-[var(--gray-50)] rounded-full px-3 py-1.5"
            title="Exportar las facturas filtradas a CSV"
          >
            <Download className="w-3.5 h-3.5" /> Exportar CSV
          </button>

          {hasDrill && (
            <button onClick={clearAllFilters} className="text-[12px] text-[var(--gray-400)] hover:text-[var(--primary)] flex items-center gap-1 transition">
              <X className="w-3 h-3" /> Limpiar filtros
            </button>
          )}

          {/* Sub-tabs — right aligned */}
          <div className="ml-auto flex items-center bg-[var(--gray-50)]/80 rounded-full p-[3px] gap-[2px]">
            {tabs.map(t => {
              const isActive = tab === t.id;
              return (
                <button key={t.id} onClick={() => setTab(t.id)}
                  aria-current={isActive ? 'page' : undefined}
                  className={`px-3.5 py-[6px] rounded-full text-[12.5px] font-medium transition-colors duration-150 flex items-center gap-1.5 ${
                    isActive
                      ? 'bg-white text-[var(--gray-950)] shadow-[0_1px_3px_rgba(0,0,0,0.08),0_0_1px_rgba(0,0,0,0.04)]'
                      : 'text-[var(--gray-400)] hover:text-[var(--gray-700)]'
                  }`}>
                  <span className="flex items-center gap-1.5">
                    {t.label}
                    {t.count !== undefined && <span className="text-[11px] text-[var(--gray-400)]">({t.count})</span>}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── Active filter chips ── */}
      {hasDrill && (
        <div className="bg-[var(--primary-muted)] border border-[var(--primary)]/20 rounded-[var(--radius)] px-4 py-2.5 flex items-center justify-between gap-3 animate-slide-down">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-[12px] text-[var(--primary)] font-medium">
            <Filter className="w-3.5 h-3.5 flex-shrink-0" />
            {activeFilterChips.map(chip => (
              <button
                key={chip.key}
                onClick={chip.onRemove}
                className="inline-flex max-w-[260px] items-center gap-1 rounded-full bg-white px-2 py-1 text-[11px] text-[var(--gray-700)] shadow-sm transition-colors hover:text-[var(--danger)]"
                title="Quitar filtro"
              >
                <span className="truncate">{chip.label}</span>
                <X className="h-3 w-3 flex-shrink-0" />
              </button>
            ))}
            <span className="ml-1 text-[var(--gray-500)]">{filtered.length.toLocaleString()} registros</span>
          </div>
          <button onClick={clearAllFilters} className="flex flex-shrink-0 items-center gap-1 text-[13px] font-medium text-[var(--primary)] hover:text-[var(--primary-hover)] hover-press">
            <X className="w-3.5 h-3.5" /> Limpiar
          </button>
        </div>
      )}

      {/* ════════════════════════════════════════════════════════════════
         RESUMEN TAB
         ════════════════════════════════════════════════════════════════ */}
      {tab === 'resumen' && (
        <>
          {/* ── Totales: ¿cuánto debo? + ¿cuánto pagar este mes? ── */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <CxpTotalCard label="Total adeudado" value={fmtFull(cxpTotals.total)} sub={`${filtered.length.toLocaleString()} facturas`} tone="neutral" />
            <CxpTotalCard label="Vencido" value={fmtFull(cxpTotals.vencido)} sub="Ya debías pagar" tone="danger" />
            <CxpTotalCard label="Por vencer" value={fmtFull(cxpTotals.porVencer)} sub="Aún en plazo" tone="neutral" />
            <CxpTotalCard label="A pagar este mes" value={fmtFull(cxpTotals.aPagarEsteMes)} sub="Vencido + vence este mes" tone="warning" />
          </div>

          {/* ── A pagar este mes, por prioridad de proveedor ── */}
          {cxpTotals.aPagarEsteMes > 0 && (
            <div className="bg-white rounded-[var(--radius-lg)] border border-[var(--gray-200)] p-4 shadow-sm animate-card-in">
              <div className="flex items-center justify-between gap-3 mb-2.5">
                <h2 className="text-[12px] font-bold uppercase tracking-[0.06em] text-[var(--gray-500)]">
                  A pagar este mes · por prioridad de proveedor
                </h2>
                <button
                  type="button"
                  onClick={() => { setShowPagarDetail(v => !v); setPagarDetailRows(20); }}
                  className="text-[12px] font-medium text-[var(--primary)] hover:underline whitespace-nowrap"
                >
                  {showPagarDetail ? 'Ocultar proveedores' : `Ver proveedores (${aPagarProviders.length})`}
                </button>
              </div>
              <div className="flex flex-wrap gap-2">
                {(['critical', 'highImpact', 'negotiable', 'normal'] as PaymentPriority[])
                  .filter((p) => cxpTotals.porPrioridad[p] > 0)
                  .map((p) => (
                    <div key={p} className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-[12px] font-medium ${priorityTone(p)}`}>
                      <span>{priorityLabel(p)}</span>
                      <span className="font-mono font-bold">{fmtFull(cxpTotals.porPrioridad[p])}</span>
                    </div>
                  ))}
              </div>

              {showPagarDetail && (
                <div className="mt-3 overflow-x-auto border-t border-[var(--gray-100)] pt-3">
                  <table className="w-full text-[12px]">
                    <thead className="text-[var(--gray-400)] text-left text-[11px] uppercase tracking-wide">
                      <tr>
                        <th className="py-1.5 font-medium">Proveedor</th>
                        <th className="py-1.5 font-medium">Prioridad</th>
                        <th className="py-1.5 text-right font-medium">Vencido</th>
                        <th className="py-1.5 text-right font-medium">A pagar este mes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {aPagarProviders.slice(0, pagarDetailRows).map((prov) => (
                        <tr key={prov.noProveedor || prov.nombre} className="border-t border-[var(--gray-100)]">
                          <td className="py-1.5 pr-2">
                            <span className="font-medium text-[var(--gray-950)] truncate max-w-[280px] inline-block align-middle" title={prov.nombre}>{prov.nombre}</span>
                            {prov.count > 1 && <span className="ml-1.5 text-[10px] text-[var(--gray-400)]">{prov.count} facturas</span>}
                          </td>
                          <td className="py-1.5">
                            <span className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ${priorityTone(prov.priority)}`}>
                              {priorityLabel(prov.priority)}
                            </span>
                          </td>
                          <td className="py-1.5 text-right font-mono" style={{ color: prov.vencido > 0 ? 'var(--danger)' : 'var(--gray-400)' }}>
                            {prov.vencido > 0 ? fmtFull(prov.vencido) : '—'}
                          </td>
                          <td className="py-1.5 text-right font-mono font-bold text-[var(--gray-950)]">{fmtFull(prov.total)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {aPagarProviders.length > pagarDetailRows && (
                    <button
                      type="button"
                      onClick={() => setPagarDetailRows(n => n + 20)}
                      className="mt-2 text-[12px] font-medium text-[var(--primary)] hover:underline"
                    >
                      Ver más ({(aPagarProviders.length - pagarDetailRows).toLocaleString()} proveedores)
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Aging distribution */}
          <div className="bg-white rounded-[var(--radius-lg)] border border-[var(--gray-200)] p-5 shadow-sm animate-card-in stagger-5">
            <h2 className="text-[15px] font-bold text-[var(--gray-950)] mb-4">Distribución por Antigüedad</h2>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart layout="vertical" data={agingBuckets} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
                <CartesianGrid className="recharts-cartesian-grid" strokeDasharray="0" horizontal={false} />
                <XAxis type="number" tick={{ fill: 'var(--gray-400)', fontSize: 11 }} axisLine={{ stroke: 'var(--gray-100)' }} tickLine={false} tickFormatter={v => fmt(v)} />
                <YAxis type="category" dataKey="name" width={86} tick={{ fill: 'var(--gray-400)', fontSize: 11 }} axisLine={false} tickLine={false} />
                <Tooltip content={<ChartTooltip />} cursor={{ fill: 'var(--gray-50)' }} />
                <Bar dataKey="total" radius={[0, 6, 6, 0]} fill="var(--primary)">
                  {agingBuckets.map((b, i) => (
                    <Cell key={i} fill={b.color} fillOpacity={0.9} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            <div className="flex gap-2 mt-3 flex-wrap">
              {agingBuckets.filter(b => b.total > 0).map((b, i) => (
                <div key={i} className="flex items-center gap-1.5 bg-[var(--gray-50)] rounded-full px-2.5 py-1 text-[11px]">
                  <div className="w-2 h-2 rounded-full" style={{ backgroundColor: b.color }} />
                  <span className="text-[var(--gray-500)]">{b.name}:</span>
                  <span className="font-mono font-bold text-[var(--gray-950)]">{fmt(b.total)}</span>
                  <span className="text-[var(--gray-400)]">({b.count})</span>
                </div>
              ))}
            </div>
          </div>

          <AgingMatrix
            supplierData={supplierData}
            agingBuckets={agingBuckets}
            totalPendiente={totalPendiente}
            filteredCount={filtered.length}
          />

          {/* Company breakdown (if multiple) */}
          {ciaData.length > 1 && (
            <div className="bg-white rounded-[var(--radius-lg)] border border-[var(--gray-200)] p-5 shadow-sm animate-card-in stagger-9">
              <h2 className="text-[15px] font-bold text-[var(--gray-950)] mb-4">Desglose por Compañía</h2>
              <div className="grid grid-cols-2 gap-3">
                {ciaData.map((c, i) => (
                  <div key={i} className="flex items-center gap-3 p-3 bg-[var(--surface-alt)] rounded-[var(--radius)]">
                    <div className="w-2 h-8 rounded-full" style={{ backgroundColor: PIE_COLORS[i % PIE_COLORS.length] }} />
                    <div className="flex-1 min-w-0">
                      <p className="text-[12px] font-medium text-[var(--gray-950)] truncate">{c.name}</p>
                      <p className="text-[11px] text-[var(--gray-400)]">{pct(c.value, totalPendiente)}</p>
                    </div>
                    <p className="text-[13px] font-mono font-bold text-[var(--gray-950)]">{fmt(c.value)}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* ════════════════════════════════════════════════════════════════
         PROVEEDORES TAB
         ════════════════════════════════════════════════════════════════ */}
      {tab === 'proveedores' && (
        <div className="bg-white rounded-[var(--radius-lg)] border border-[var(--gray-200)] shadow-sm overflow-hidden">
          {/* Header with sort controls */}
          <div className="p-4 border-b border-[var(--gray-100)] flex items-center justify-between">
            <h2 className="text-[15px] font-bold text-[var(--gray-950)]">
              Proveedores
              <span className="text-[var(--gray-400)] font-normal ml-1">({supplierData.length.toLocaleString()})</span>
            </h2>
            <div className="flex items-center gap-1">
              {([
                ['total', 'Monto'],
                ['count', 'Facturas'],
                ['maxDias', 'Días'],
                ['nombre', 'Nombre'],
              ] as [SortKey, string][]).map(([k, label]) => (
                <button key={k} onClick={() => toggleSort(k)}
                  className={`px-2.5 py-1 rounded-[var(--radius-md)] text-[11px] font-medium transition flex items-center gap-1 ${
                    sortKey === k ? 'bg-[var(--primary)] text-white' : 'bg-[var(--gray-50)] text-[var(--gray-500)] hover:bg-[var(--gray-100)]'
                  }`}>
                  {label}
                  {sortKey === k && <ArrowUpDown className="w-2.5 h-2.5" />}
                </button>
              ))}
            </div>
          </div>

          {/* Supplier list */}
          <div className="divide-y divide-[var(--gray-50)]">
            {pagedSuppliers.map(s => {
              const isExpanded = expandedSupplier === s.nombre;
              const severity = s.maxDias > 120 ? hex.danger : s.maxDias > 60 ? hex.warning : s.maxDias > 0 ? hex.primary : hex.success;

              return (
                <div key={s.nombre}>
                  <button onClick={() => setExpandedSupplier(isExpanded ? null : s.nombre)}
                    className="w-full flex items-center gap-3 px-4 py-3 hover:bg-[var(--gray-50)] transition text-left">
                    {isExpanded ? <ChevronDown className="w-4 h-4 text-[var(--gray-400)]" /> : <ChevronRight className="w-4 h-4 text-[var(--gray-400)]" />}

                    <div className="flex-1 min-w-0">
                      <p className="text-[13px] font-medium text-[var(--gray-950)] truncate">{s.nombre}</p>
                      <div className="flex items-center gap-2 mt-0.5">
                        {s.noProveedor && (
                          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[var(--gray-100)] text-[var(--gray-500)]" title="Número de proveedor JDE">
                            JDE {s.noProveedor}
                          </span>
                        )}
                        <span className="text-[11px] text-[var(--gray-400)]">{s.count} factura{s.count !== 1 ? 's' : ''}</span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--gray-100)] text-[var(--gray-500)]">{s.providerType}</span>
                        {(() => {
                          const bucket = scoreBucket({ clasificacionAutomatica: s.providerClasificacion, score: s.providerScore });
                          return (
                            <span
                              className={`text-[10px] px-1.5 py-0.5 rounded-full ${BUCKET_CHIP[bucket]}`}
                              title={`Catálogo de proveedores · ${SCORE_LABELS[bucket]}${s.providerScore != null ? ` · score ${s.providerScore}` : ''}`}
                            >
                              {SCORE_LABELS[bucket]}{s.providerScore != null ? ` · ${s.providerScore}` : ''}
                            </span>
                          );
                        })()}
                        {s.maxDias > 0 && (
                          <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-[var(--warning-muted)]" style={{ color: severity }} title={agingTooltip(s.maxDias)}>
                            máx {s.maxDias}d
                          </span>
                        )}
                      </div>
                    </div>

                    {/* Mini aging bar */}
                    <div className="w-40 flex h-2.5 rounded-full overflow-hidden bg-[var(--gray-100)]" title={agingTooltip(s.maxDias)}>
                      {BUCKET_KEYS.map((key, bi) => {
                        const bval = s.bucketTotals[bi] ?? 0;
                        const bpct = s.total > 0 ? (bval / s.total) * 100 : 0;
                        return bpct > 0 ? <div key={bi} style={{ width: `${bpct}%`, backgroundColor: AGING_COLORS[bi] }} /> : null;
                      })}
                    </div>

                    <div className="text-right w-28">
                      <p className="text-[13px] font-mono font-bold text-[var(--gray-950)]">{fmt(s.total)}</p>
                      {s.vencido > 0 && <p className="text-[10px] font-mono text-[var(--danger)]">{fmt(s.vencido)} vencido</p>}
                      {s.creditLimit !== undefined && s.creditLimit > 0 && (
                        <p className={`text-[10px] font-mono ${s.total > s.creditLimit ? 'text-[var(--warning)]' : 'text-[var(--gray-400)]'}`}>
                          lim {fmt(s.creditLimit)}
                        </p>
                      )}
                    </div>
                  </button>

                  {/* Expanded detail */}
                  {isExpanded && (
                    <div className="bg-[var(--surface-alt)] px-4 pb-3">
                      {/* Aging summary for this supplier */}
                      <div className="flex gap-1.5 mb-3 flex-wrap">
                        {BUCKET_KEYS.map((key, bi) => {
                          const bval = s.bucketTotals[bi] ?? 0;
                          if (bval === 0) return null;
                          return (
                            <div key={bi} className="flex items-center gap-1 bg-white rounded-full px-2 py-0.5 text-[10px] border border-[var(--gray-100)]">
                              <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: AGING_COLORS[bi] }} />
                              <span className="text-[var(--gray-500)]">{BUCKET_LABELS[bi]}:</span>
                              <span className="font-mono font-medium text-[var(--gray-950)]">{fmt(bval)}</span>
                            </div>
                          );
                        })}
                      </div>

                      <div className="overflow-x-auto">
                        <table className="w-full text-[11px]">
                          <thead>
                            <tr className="border-b border-[var(--gray-100)]">
                              <th className="text-left py-2 text-[var(--gray-400)] font-semibold">Factura</th>
                              <th className="text-left py-2 text-[var(--gray-400)] font-semibold">F. Factura</th>
                              <th className="text-left py-2 text-[var(--gray-400)] font-semibold">Vence</th>
                              <th className="text-right py-2 text-[var(--gray-400)] font-semibold">Días</th>
                              <th className="text-right py-2 text-[var(--gray-400)] font-semibold">Score</th>
                              <th className="text-right py-2 text-[var(--gray-400)] font-semibold">Pendiente</th>
                              <th className="text-left py-2 text-[var(--gray-400)] font-semibold">Fecha plan</th>
                              <th className="text-left py-2 text-[var(--gray-400)] font-semibold pl-3">Mon.</th>
                              <th className="text-left py-2 text-[var(--gray-400)] font-semibold">Cond. Pago</th>
                              <th className="text-left py-2 text-[var(--gray-400)] font-semibold">Prioridad</th>
                              <th className="text-left py-2 text-[var(--gray-400)] font-semibold">Referencias</th>
                            </tr>
                          </thead>
                          <tbody>
                            {s.sortedRecords.map((r, ri) => (
                              <tr
                                key={ri}
                                onClick={() => setSelectedRecord(r)}
                                className="cursor-pointer border-b border-[var(--gray-50)] hover:bg-white"
                              >
                                <td className="py-1.5 font-mono text-[var(--gray-950)]">
                                  <div className="flex items-center gap-1.5">
                                    <span>{r.noFactura}</span>
                                    {paymentCoverage?.get(`${r.cia}::${r.noFactura}::${r.noProveedor}`)?.status === 'PAID' && (
                                      <span className="inline-flex items-center gap-0.5 rounded-full bg-[var(--success-muted)] px-1.5 py-0.5 text-[9px] font-medium text-[var(--success)] uppercase tracking-wide" title="Pagada según PagoProveedor JDE">
                                        Pagada
                                      </span>
                                    )}
                                    {paymentCoverage?.get(`${r.cia}::${r.noFactura}::${r.noProveedor}`)?.status === 'PARTIAL' && (
                                      <span className="inline-flex items-center gap-0.5 rounded-full bg-[var(--warning-muted)] px-1.5 py-0.5 text-[9px] font-medium text-[var(--warning)] uppercase tracking-wide" title="Pago parcial registrado">
                                        Parcial
                                      </span>
                                    )}
                                    <SourceInfo attribution={attributeCxpRow(r, paymentCoverage?.get(`${r.cia}::${r.noFactura}::${r.noProveedor}`))} />
                                  </div>
                                </td>
                                <td className="py-1.5 text-[var(--gray-500)]">{r.fechaFactura}</td>
                                <td className="py-1.5 text-[var(--gray-500)]">{r.fechaVence}</td>
                                <td className="py-1.5 text-right font-mono">
                                  <span
                                    className={r.diasVencida > 90 ? 'text-[var(--danger)] font-bold' : r.diasVencida > 30 ? 'text-[var(--warning)]' : 'text-[var(--gray-950)]'}
                                    title={agingTooltip(r.diasVencida)}
                                  >
                                    {r.diasVencida}
                                  </span>
                                </td>
                                <td className="py-1.5 text-right font-mono font-semibold text-[var(--gray-950)]">{r.providerScore ?? '—'}</td>
                                <td className="py-1.5 text-right font-mono font-medium text-[var(--gray-950)]">{fmtFull(r.importePendientePesos)}</td>
                                <td className="py-1.5 text-[var(--gray-500)]">{dueDateForRecord(r) ?? '-'}</td>
                                <td className="py-1.5 pl-3 text-[var(--gray-400)]">{r.moneda}</td>
                                <td className="py-1.5 text-[var(--gray-400)]">{r.condPago}</td>
                                <td className="py-1.5">
                                  <span
                                    className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${priorityTone(r.paymentPriority)}`}
                                    title={priorityReason(r)}
                                  >
                                    {priorityLabel(r.paymentPriority)}
                                    <HelpCircle className="h-3 w-3" />
                                  </span>
                                </td>
                                <td className="py-1.5">
                                  <div className="flex max-w-[260px] flex-wrap gap-1">
                                    {r.referenceLinks.slice(0, 4).map((ref, refIndex) => (
                                      <span key={`${r.noFactura}-${ref.kind}-${refIndex}`} className="rounded-full bg-white px-1.5 py-0.5 text-[10px] text-[var(--gray-500)] border border-[var(--gray-100)]">
                                        {ref.kind}: {ref.label}
                                      </span>
                                    ))}
                                  </div>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="px-4 py-3 border-t border-[var(--gray-100)] flex items-center justify-between">
              <p className="text-[12px] text-[var(--gray-400)]">
                Mostrando {provPage * PAGE_SIZE + 1}–{Math.min((provPage + 1) * PAGE_SIZE, supplierData.length)} de {supplierData.length.toLocaleString()}
              </p>
              <div className="flex gap-1">
                <button onClick={() => setProvPage(p => Math.max(0, p - 1))} disabled={provPage === 0}
                  className="px-3 py-1 rounded-[var(--radius-md)] text-[12px] font-medium bg-[var(--gray-50)] text-[var(--gray-500)] hover:bg-[var(--gray-100)] disabled:opacity-30 transition">
                  Anterior
                </button>
                <span className="px-3 py-1 text-[12px] text-[var(--gray-400)]">{provPage + 1} / {totalPages}</span>
                <button onClick={() => setProvPage(p => Math.min(totalPages - 1, p + 1))} disabled={provPage >= totalPages - 1}
                  className="px-3 py-1 rounded-[var(--radius-md)] text-[12px] font-medium bg-[var(--gray-50)] text-[var(--gray-500)] hover:bg-[var(--gray-100)] disabled:opacity-30 transition">
                  Siguiente
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {selectedRecord && (
        <InvoiceDetailPanel
          record={selectedRecord}
          companyName={ciaName(selectedRecord.cia)}
          bankMatches={findPossibleBankPayments(selectedRecord, bankStatements)}
          onClose={() => setSelectedRecord(null)}
        />
      )}
    </div>
  );
};

function alertToneClass(tone: AlertTone): string {
  if (tone === 'danger') return 'bg-[var(--danger-muted)] text-[var(--danger)]';
  if (tone === 'warning') return 'bg-[var(--warning-muted)] text-[var(--warning)]';
  return 'bg-[var(--primary-muted)] text-[var(--primary)]';
}

interface AgingCategory {
  name: string;
  rows: SupplierSummary[];
  total: number;
  invoiceCount: number;
  bucketTotals: number[];
  avgScore: number;
  hasScore: boolean;
}

function AgingMatrix({
  supplierData,
  agingBuckets,
  totalPendiente,
  filteredCount,
}: {
  supplierData: SupplierSummary[];
  agingBuckets: AgingBucket[];
  totalPendiente: number;
  filteredCount: number;
}) {
  const colSpan = 3 + BUCKET_LABELS.length;
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (name: string) =>
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  // Group by provider category. Category-level aggregates are cheap; the
  // per-provider rows are only rendered when a category is expanded.
  const categories: AgingCategory[] = useMemo(() => {
    const map = new Map<string, AgingCategory>();
    for (const s of supplierData) {
      const name = s.providerType || 'Sin clasificar';
      let cat = map.get(name);
      if (!cat) {
        cat = {
          name,
          rows: [],
          total: 0,
          invoiceCount: 0,
          bucketTotals: new Array(BUCKET_KEYS.length).fill(0),
          avgScore: 0,
          hasScore: false,
        };
        map.set(name, cat);
      }
      cat.rows.push(s);
      cat.total += s.total;
      cat.invoiceCount += s.count;
      s.bucketTotals.forEach((v, i) => { cat!.bucketTotals[i] += v; });
    }
    for (const cat of map.values()) {
      let sum = 0;
      let n = 0;
      for (const s of cat.rows) {
        if (typeof s.providerScore === 'number' && Number.isFinite(s.providerScore)) {
          sum += s.providerScore;
          n += 1;
        }
      }
      cat.hasScore = n > 0;
      cat.avgScore = n > 0 ? sum / n : 0;
      cat.rows.sort((a, b) => b.total - a.total);
    }
    return Array.from(map.values()).sort(
      (a, b) => b.avgScore - a.avgScore || b.total - a.total,
    );
  }, [supplierData]);

  return (
    <div className="bg-white rounded-[var(--radius-lg)] border border-[var(--gray-200)] shadow-sm overflow-hidden animate-card-in stagger-8">
      <div className="p-4 border-b border-[var(--gray-100)] flex items-center justify-between">
        <h2 className="text-[15px] font-bold text-[var(--gray-950)]">Matriz de Antigüedad por Proveedor</h2>
        <p className="text-[12px] text-[var(--gray-400)]">{categories.length} categorías · {supplierData.length} proveedores · ordenadas por score de catálogo · click para ver detalle</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[11px]">
          <thead className="sticky top-0 bg-white z-10">
            <tr className="border-b-2 border-[var(--gray-200)]">
              <th className="text-left py-2.5 px-3 text-[var(--gray-400)] font-bold w-[260px] min-w-[260px]">Categoría / Proveedor</th>
              <th className="text-right py-2.5 px-2 text-[var(--gray-400)] font-bold w-[90px]">Total</th>
              <th className="text-center py-2.5 px-1 text-[var(--gray-400)] font-bold w-[40px]">#</th>
              {BUCKET_LABELS.map((label, i) => (
                <th key={i} className="text-right py-2.5 px-2 font-bold w-[85px]" style={{ color: AGING_COLORS[i] }}>{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {categories.map((cat) => {
              const isOpen = expanded.has(cat.name);
              const bucket = scoreBucket({ score: Math.round(cat.avgScore) });
              const maxCatBucket = Math.max(...cat.bucketTotals);
              return (
                <Fragment key={cat.name}>
                  <tr
                    className="border-b border-[var(--gray-100)] bg-[var(--gray-50)] hover:bg-[var(--gray-100)] transition cursor-pointer"
                    onClick={() => toggle(cat.name)}
                  >
                    <td className="py-2.5 px-3 font-bold text-[var(--gray-950)]">
                      <div className="flex items-center gap-2">
                        {isOpen ? <ChevronDown className="w-4 h-4 text-[var(--gray-400)]" /> : <ChevronRight className="w-4 h-4 text-[var(--gray-400)]" />}
                        <span className="truncate" title={cat.name}>{cat.name}</span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${cat.hasScore ? BUCKET_CHIP[bucket] : 'bg-[var(--gray-100)] text-[var(--gray-500)]'}`}>
                          {cat.hasScore ? `${SCORE_LABELS[bucket]} · ${Math.round(cat.avgScore)}` : 'sin score'}
                        </span>
                        <span className="text-[10px] font-normal text-[var(--gray-400)]">{cat.rows.length} prov.</span>
                      </div>
                    </td>
                    <td className="py-2.5 px-2 text-right font-mono font-bold text-[var(--gray-950)]">{fmt(cat.total)}</td>
                    <td className="py-2.5 px-1 text-center text-[var(--gray-400)]">{cat.invoiceCount}</td>
                    {cat.bucketTotals.map((val, bi) => (
                      <td key={bi} className="py-2.5 px-2 text-right font-mono font-bold" style={{ color: AGING_COLORS[bi] }}>
                        {val > 0 ? fmt(val) : <span className="text-[var(--gray-200)]">-</span>}
                      </td>
                    ))}
                  </tr>
                  {isOpen && cat.rows.map((s, si) => {
                    const bucketVals = s.bucketTotals;
                    return (
                      <tr key={si} className="border-b border-[var(--gray-50)] hover:bg-[var(--gray-50)] transition">
                        <td className="py-2 pl-9 pr-3 font-medium text-[var(--gray-700)] truncate max-w-[260px]" title={s.nombre}>{s.nombre}</td>
                        <td className="py-2 px-2 text-right font-mono font-bold text-[var(--gray-950)]">{fmt(s.total)}</td>
                        <td className="py-2 px-1 text-center text-[var(--gray-400)]">{s.count}</td>
                        {bucketVals.map((val, bi) => {
                          const intensity = maxCatBucket > 0 ? Math.min(val / maxCatBucket, 1) : 0;
                          return (
                            <td key={bi} className="py-2 px-2 text-right font-mono">
                              {val > 0 ? (
                                <span
                                  className="inline-block px-1.5 py-0.5 rounded"
                                  style={{
                                    color: AGING_COLORS[bi],
                                    backgroundColor: bi === 0
                                      ? 'var(--success-muted)'
                                      : intensity > 0.5
                                        ? 'var(--warning-muted)'
                                        : 'var(--gray-50)',
                                    fontWeight: intensity > 0.5 ? 600 : 400,
                                  }}
                                  title={agingTooltip(BUCKET_LABELS[bi] === 'Por Vencer' ? 0 : Number(BUCKET_LABELS[bi].split('-')[0]) || 181)}
                                >
                                  {fmt(val)}
                                </span>
                              ) : (
                                <span className="text-[var(--gray-200)]">-</span>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </Fragment>
              );
            })}
            {categories.length === 0 && (
              <tr>
                <td colSpan={colSpan} className="py-8 text-center text-[12px] text-[var(--gray-400)]">
                  Sin proveedores con los filtros actuales.
                </td>
              </tr>
            )}
            <tr className="border-t-2 border-[var(--gray-200)] bg-[var(--gray-50)] font-bold sticky bottom-0">
              <td className="py-2.5 px-3 text-[var(--gray-950)]">TOTAL</td>
              <td className="py-2.5 px-2 text-right font-mono text-[var(--gray-950)]">{fmt(totalPendiente)}</td>
              <td className="py-2.5 px-1 text-center text-[var(--gray-400)]">{filteredCount}</td>
              {agingBuckets.map((b, i) => (
                <td key={i} className="py-2.5 px-2 text-right font-mono font-bold" style={{ color: b.color }}>{fmt(b.total)}</td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

function InvoiceDetailPanel({
  record,
  companyName,
  bankMatches,
  onClose,
}: {
  record: EnrichedCXPRecord;
  companyName: string;
  bankMatches: BankStatementLine[];
  onClose: () => void;
}) {
  const lastPaymentDate = parseDateToIso(record.providerLastPaymentDate ?? undefined) ?? record.providerLastPaymentDate ?? 'Sin dato';
  const lastPaymentAmount = record.providerLastPaymentAmount && record.providerLastPaymentAmount > 0
    ? fmtFull(record.providerLastPaymentAmount)
    : 'Sin dato';

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/10" onClick={onClose}>
      <div className="flex min-h-full justify-end">
        <aside
          className="min-h-screen w-full max-w-xl border-l border-[var(--gray-200)] bg-white shadow-xl"
          onClick={e => e.stopPropagation()}
        >
        <header className="border-b border-[var(--gray-100)] bg-white px-5 py-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="inline-flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide text-[var(--gray-400)]">
                Detalle de factura
                <SourceInfo attribution={sourceOf('cxp')} />
              </p>
              <h2 className="mt-1 truncate text-[18px] font-bold text-[var(--gray-950)]">{record.noFactura || 'Sin factura'}</h2>
              <p className="mt-1 truncate text-[12px] text-[var(--gray-500)]">{record.nombre}</p>
            </div>
            <button onClick={onClose} className="rounded-[var(--radius-md)] p-1.5 text-[var(--gray-400)] hover:bg-[var(--gray-50)] hover:text-[var(--gray-950)]">
              <X className="h-4 w-4" />
            </button>
          </div>
        </header>

        <div className="space-y-5 p-5">
          <div className="grid grid-cols-2 gap-3">
            <DetailMetric label="Pendiente" value={fmtFull(record.importePendientePesos)} />
            <DetailMetric label="Días vencida" value={`${record.diasVencida}d`} />
            <DetailMetric label="Score proveedor" value={record.providerScore != null ? String(record.providerScore) : '—'} />
            <DetailMetric label="Fecha plan" value={dueDateForRecord(record) ?? '-'} />
          </div>

          <DetailSection title="Causa de triage">
            <div className="flex flex-wrap gap-1.5">
              {record.alerts.length === 0 ? (
                <span className="text-[12px] text-[var(--gray-400)]">Sin alertas detectadas con los datos actuales.</span>
              ) : record.alerts.map(alert => (
                <span key={alert.type} className={`rounded-full px-2 py-1 text-[11px] font-medium ${alertToneClass(alert.tone)}`} title={alert.detail}>
                  {alert.label}
                </span>
              ))}
            </div>
            <p className="mt-2 text-[12px] text-[var(--gray-500)]">{priorityReason(record)}</p>
          </DetailSection>

          <DetailSection title="Proveedor">
            {record.providerAntiguedad && (
              <div className="mb-2">
                <span
                  className={`rounded-full px-2 py-1 text-[11px] font-medium ${antiguedadToneClass(record.providerAntiguedad)}`}
                  title={
                    record.providerLastPaymentAgeDays != null
                      ? `${record.providerLastPaymentAgeDays} días desde el último pago al proveedor`
                      : undefined
                  }
                >
                  {antiguedadLabel(record.providerAntiguedad)}
                  {record.providerLastPaymentAgeDays != null
                    ? ` · ${record.providerLastPaymentAgeDays} d`
                    : ''}
                </span>
              </div>
            )}
            <DetailGrid rows={[
              ['Tipo', record.providerType],
              ['Riesgo', record.providerRisk],
              ['Score', record.providerScore != null ? String(record.providerScore) : 'Sin score'],
              ['Flexibilidad', flexibilityLabel(record.providerFlexibility)],
              ['Fecha último pago proveedor', lastPaymentDate],
              ['Monto último pago proveedor', lastPaymentAmount],
              ['Antigüedad último pago', record.providerLastPaymentAgeDays != null ? `${record.providerLastPaymentAgeDays} días` : 'Sin dato'],
              ['Límite crédito', record.providerCreditLimit ? fmtFull(record.providerCreditLimit) : 'No configurado'],
              ['Última actualización', record.providerDaysWithoutUpdate === null ? 'Sin dato' : `${record.providerDaysWithoutUpdate} días`],
              ['DTI', record.providerDtiCriticidad ? `${record.providerDtiCriticidad}${record.providerDtiArea ? ` · ${record.providerDtiArea}` : ''}` : 'No aplica'],
            ]} />
          </DetailSection>

          <DetailSection title="Factura y flujo">
            <DetailGrid rows={[
              ['Empresa', companyName],
              ['Proveedor #', record.noProveedor || '-'],
              ['Fecha factura', record.fechaFactura || '-'],
              ['Fecha vencimiento', record.fechaVence || '-'],
              ['Fecha programada JDE', record.fechaProgramacionPago || '-'],
              ['Fecha usada por planeación', dueDateForRecord(record) ?? '-'],
              ['Condición de pago', record.condPago || '-'],
              ['Subtotal', fmtFull(record.importeSubtotalPesos)],
              ['IVA / impuestos', fmtFull(record.importeImpuestosPesos)],
              ['Bruto', fmtFull(record.importeBrutoPesos)],
            ]} />
          </DetailSection>

          <DetailSection title="Compras, contratos y referencias">
            <div className="flex flex-wrap gap-1.5">
              {record.referenceLinks.map((ref, index) => (
                <span key={`${ref.kind}-${index}`} className="rounded-full border border-[var(--gray-200)] px-2 py-1 text-[11px] text-[var(--gray-600)]">
                  {ref.kind}: {ref.label}
                </span>
              ))}
            </div>
          </DetailSection>

          <DetailSection title="Bancos / pagos posibles">
            {bankMatches.length === 0 ? (
              <p className="text-[12px] text-[var(--gray-400)]">Sin pagos bancarios relacionados detectados en el rango cargado.</p>
            ) : (
              <div className="space-y-2">
                {bankMatches.map((movement, index) => (
                  <div key={`${movement.referencia}-${index}`} className="rounded-[var(--radius-md)] border border-[var(--gray-200)] px-3 py-2">
                    <div className="flex items-center justify-between gap-3">
                      <span className="inline-flex items-center gap-1">
                        <span className="text-[12px] font-medium text-[var(--gray-950)]">{movement.fechaOperacion}</span>
                        <SourceInfo attribution={sourceOf('bancos', 'Cargo bancario candidato (cruce heurístico por monto/concepto).')} />
                      </span>
                      <span className="font-mono text-[12px] font-bold text-[var(--gray-950)]">{fmtFull(movement.importe)}</span>
                    </div>
                    <p className="mt-1 text-[11px] text-[var(--gray-500)]">{movement.referencia} · {movement.concepto}</p>
                  </div>
                ))}
              </div>
            )}
          </DetailSection>

          <DetailSection title="Auditoría">
            <p className="text-[12px] text-[var(--gray-400)]">El historial de comentarios, responsables y aprobaciones todavía no viene en la fuente de CXP cargada.</p>
          </DetailSection>
        </div>
        </aside>
      </div>
    </div>
  );
}

function DetailMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[var(--radius)] bg-[var(--gray-50)] px-3 py-2">
      <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--gray-400)]">{label}</p>
      <p className="mt-1 truncate font-mono text-[15px] font-bold text-[var(--gray-950)]" title={value}>{value}</p>
    </div>
  );
}

function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-[12px] font-bold uppercase tracking-wide text-[var(--gray-400)]">{title}</h3>
      <div className="rounded-[var(--radius)] border border-[var(--gray-200)] p-3">{children}</div>
    </section>
  );
}

function DetailGrid({ rows }: { rows: Array<[string, string]> }) {
  return (
    <dl className="grid grid-cols-1 gap-2 text-[12px]">
      {rows.map(([label, value]) => (
        <div key={label} className="grid grid-cols-[140px_1fr] gap-3">
          <dt className="text-[var(--gray-400)]">{label}</dt>
          <dd className="min-w-0 truncate font-medium text-[var(--gray-950)]" title={value}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   Main CXP Component — per-cia cache + background fetch
   ═══════════════════════════════════════════════════════════════════════ */

interface CXPProps {
  records: CXPRecord[];
  loadedCias: Record<string, string>;
  companies: Company[];
  selectedCia: string;
  providers: Provider[];
  clients: Client[];
  assumptions: CashFlowAssumptions;
  bankStatements: BankAccountStatement[];
  /**
   * Map de `${cia}::${noFactura}::${noProveedor}` → coverage de pagos
   * ya ejecutados (PagoProveedor). Si una CXP aparece como PAID, se
   * muestra chip "Pagada" para que el controller financiero no la
   * vuelva a proyectar/programar.
   */
  paymentCoverage?: Map<string, CxpPaymentCoverage>;
  budget: Budget | null;
  onMergeCia: (cia: string, records: CXPRecord[]) => void;
  onReplaceAll: (records: CXPRecord[], cias: string[]) => void;
  onReset: () => void;
}

const CXP = ({
  records,
  loadedCias,
  companies,
  selectedCia,
  providers,
  clients,
  assumptions,
  bankStatements,
  paymentCoverage,
  onMergeCia,
  onReplaceAll,
  onReset,
}: CXPProps) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const csvInput = useRef<HTMLInputElement>(null);
  const autoFetchAttempted = useRef<Set<string>>(new Set());

  const activeCias = useMemo(
    () => companies.filter(c => c.activa !== false).map(c => c.cia),
    [companies],
  );
  const loadedCiaList = useMemo(() => Object.keys(loadedCias), [loadedCias]);

  // Visible records = filtered by header's selectedCia, excluding Concurso
  // Mercantil (fechaFactura ≤ 2022-12-31). Esos saldos viven en su propio
  // módulo (Operación → Concurso Mercantil) y no se reflejan acá.
  const visibleRecords = useMemo(() => {
    const scoped = selectedCia === 'all' ? records : records.filter(r => r.cia === selectedCia);
    return excludeConcursoMercantil(scoped);
  }, [records, selectedCia]);

  const hasData = visibleRecords.length > 0;
  const isCurrentCiaLoaded = selectedCia === 'all'
    ? loadedCiaList.length > 0
    : loadedCias[selectedCia] !== undefined;

  const loadSingle = useCallback(async (cia: string) => {
    setLoading(true); setError(null);
    try {
      const data = await fetchAgedBalances({ cia });
      // Stamp the requested cia so downstream filtering is consistent, even if
      // JDE doesn't echo the field back (or returns it in a different format).
      const stamped = (data as CXPRecord[]).map(r => ({ ...r, cia }));
      onMergeCia(cia, stamped);
    } catch (e) {
      if (e instanceof JdeApiError) {
        const hint = e.status === 401 ? ' — error de autenticación con el servidor' : '';
        setError(`JDE ${e.status}: ${e.message}${hint}`);
      } else {
        setError(e instanceof Error ? e.message : 'Error al consultar JDE');
      }
    } finally {
      setLoading(false);
    }
  }, [onMergeCia]);

  const loadAll = useCallback(async () => {
    if (activeCias.length === 0) {
      setError('No hay compañías activas en el catálogo.');
      return;
    }
    setLoading(true); setError(null);

    // El server JDE solo acepta UNA compañía por request. Llamadas paralelas
    // revientan con 500 por contención, y el batch CSV (`"00011,00038"`)
    // tampoco funciona — Carlos lo sugirió pero no había sido probado.
    // Único patrón que funciona en prod: secuencial, una a la vez. Cada
    // request tarda ~60s, así que mergeamos incrementalmente para que el
    // usuario vea progreso (las compañías van apareciendo conforme cargan
    // en lugar de quedarse en blanco varios minutos).
    const failures: { cia: string; reason: string }[] = [];
    let succeededCount = 0;

    for (const cia of activeCias) {
      try {
        const data = await fetchAgedBalances({ cia });
        const stamped = (data as CXPRecord[]).map(r => ({ ...r, cia }));
        onMergeCia(cia, stamped);
        succeededCount++;
      } catch (e) {
        const reason = e instanceof JdeApiError
          ? `${e.status}: ${e.message}`
          : (e instanceof Error ? e.message : String(e));
        failures.push({ cia, reason });
      }
    }

    setLoading(false);

    if (succeededCount === 0 && failures.length > 0) {
      const summary = failures.slice(0, 3).map(f => `${f.cia} (${f.reason})`).join('; ');
      const more = failures.length > 3 ? ` y ${failures.length - 3} más` : '';
      setError(`Fallaron ${failures.length}/${activeCias.length}: ${summary}${more}`);
    } else if (failures.length > 0) {
      const ciasStr = failures.slice(0, 3).map(f => f.cia).join(', ');
      const more = failures.length > 3 ? ` y ${failures.length - 3} más` : '';
      setError(`Algunas compañías no cargaron: ${ciasStr}${more}. Las demás ya están disponibles.`);
    }
  }, [activeCias, onMergeCia]);

  // When the user switches company, allow background fetch to retry this cia
  // (the attempt-guard is only to prevent infinite retries within one selection).
  useEffect(() => {
    autoFetchAttempted.current.delete(selectedCia);
  }, [selectedCia]);

  // Fetch on cia change when credentials exist and the cia isn't cached yet.
  useEffect(() => {
    if (selectedCia === 'all') return;
    if (loadedCias[selectedCia]) return;
    if (autoFetchAttempted.current.has(selectedCia)) return;
    if (loading) return;
    autoFetchAttempted.current.add(selectedCia);
    loadSingle(selectedCia);
  }, [selectedCia, loadedCias, loading, loadSingle]);

  // Allow re-attempting background fetch after a manual reset.
  useEffect(() => {
    if (loadedCiaList.length === 0 && !loading) {
      autoFetchAttempted.current.clear();
    }
  }, [loadedCiaList.length, loading]);

  const refresh = useCallback(() => {
    if (selectedCia === 'all') {
      loadAll();
    } else {
      loadSingle(selectedCia);
    }
  }, [selectedCia, loadAll, loadSingle]);

  const handleCsvFile = useCallback(async (file: File) => {
    if (!file.name.toLowerCase().endsWith('.csv')) {
      setError('Solo archivos .csv');
      return;
    }
    setLoading(true); setError(null);
    try {
      const text = await file.text();
      const recs = parseCXP(text);
      const ciasInCsv = Array.from(new Set(recs.map(r => r.cia).filter(Boolean)));
      if (ciasInCsv.length > 0) {
        onReplaceAll(recs, ciasInCsv);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al procesar');
    } finally {
      setLoading(false);
    }
  }, [onReplaceAll]);

  const scopeLabel = selectedCia === 'all'
    ? (loadedCiaList.length > 0
        ? `Consolidado · ${loadedCiaList.length} compañía${loadedCiaList.length !== 1 ? 's' : ''}`
        : 'Todas las compañías')
    : `Compañía ${selectedCia}`;

  const lastSyncLabel = selectedCia === 'all'
    ? (loadedCiaList.length > 0 ? 'Última sincronización por compañía' : null)
    : (loadedCias[selectedCia]
        ? `Sincronizado ${new Date(loadedCias[selectedCia]).toLocaleString('es-MX')}`
        : null);

  const missingActiveCias = selectedCia === 'all'
    ? activeCias.filter(c => !loadedCias[c])
    : [];

  // ── Empty state (no data for current scope) ──
  if (!hasData && !isCurrentCiaLoaded) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center p-6">
        <div className="w-full max-w-3xl mx-auto">
          <div className="text-center mb-8">
            <div className="w-14 h-14 rounded-[var(--radius-lg)] bg-[var(--primary)] flex items-center justify-center mx-auto mb-4 shadow-lg shadow-[var(--primary)]/15">
              <Clock className="text-white" size={26} />
            </div>
            <h1 className="text-[28px] font-bold text-white tracking-tight">Antigüedad de Saldos</h1>
          </div>

          <div className="bg-white rounded-[var(--radius-lg)] shadow-sm border border-[var(--gray-200)] p-8">
            {loading ? (
              <div className="text-center py-14">
                <Loader2 className="w-8 h-8 text-[var(--primary)] animate-spin mx-auto mb-3" />
                <p className="text-[15px] font-medium text-[var(--gray-950)]">
                  {selectedCia === 'all'
                    ? `Consultando JDE para ${activeCias.length} compañías…`
                    : `Consultando JDE (compañía ${selectedCia})…`}
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="border-2 border-[var(--primary)]/30 bg-[var(--primary-subtle)] rounded-[var(--radius-lg)] p-10 text-center hover:border-[var(--primary)] hover:bg-[var(--primary-muted)] transition-colors">
                  <Database className="w-10 h-10 mx-auto mb-3 text-[var(--primary)]" />
                  <p className="text-[15px] font-bold text-[var(--gray-950)]">Consultar desde JDE</p>
                  <p className="text-[12px] text-[var(--gray-400)] mt-1">{scopeLabel}</p>
                  <button
                    onClick={() => selectedCia === 'all' ? loadAll() : loadSingle(selectedCia)}
                    disabled={loading || (selectedCia === 'all' && activeCias.length === 0)}
                    className="mt-4 inline-flex items-center gap-2 px-5 h-10 rounded-[var(--radius)] bg-[var(--primary)] text-white text-[13.5px] font-medium hover:bg-[var(--primary-hover)] shadow-sm shadow-[var(--primary)]/20 disabled:opacity-40 disabled:cursor-not-allowed transition"
                  >
                    <Database className="w-4 h-4" />
                    {selectedCia === 'all' ? 'Consultar todas' : 'Consultar antigüedad'}
                  </button>
                </div>

                <div
                  onClick={() => csvInput.current?.click()}
                  className="border-2 border-dashed border-[var(--gray-200)] rounded-[var(--radius-lg)] p-10 text-center cursor-pointer hover:border-[var(--primary)] hover:bg-[var(--gray-50)] transition-colors"
                >
                  <FileSpreadsheet className="w-10 h-10 text-[var(--gray-400)] mx-auto mb-3" />
                  <p className="text-[15px] font-bold text-[var(--gray-950)]">Subir CSV</p>
                  <p className="text-[13px] text-[var(--gray-400)] mt-1">Opcional · si JDE no está disponible</p>
                  <input
                    ref={csvInput} type="file" accept=".csv" className="hidden"
                    onChange={e => e.target.files?.[0] && handleCsvFile(e.target.files[0])}
                  />
                </div>
              </div>
            )}

            {error && !loading && (
              <div className="mt-4 bg-[var(--danger-muted)] border border-red-100 rounded-[var(--radius)] p-4">
                <div className="flex items-start gap-3">
                  <AlertCircle className="text-[var(--danger)] flex-shrink-0 mt-0.5" size={18} />
                  <div className="flex-1">
                    <p className="text-[13px] font-bold text-[var(--gray-950)]">Error al consultar JDE</p>
                    <p className="text-[12px] text-[var(--gray-500)] mt-1">{error}</p>
                    <button
                      onClick={refresh}
                      className="mt-2 text-[12px] font-medium text-[var(--primary)] hover:text-[var(--primary-hover)]"
                    >
                      Intentar de nuevo
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ── Dashboard view ──
  return (
    <div className="space-y-4">
      <PageHeader title="Antigüedad de Saldos" />

      {/* Scope + actions bar */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-[var(--primary-muted)] border border-[var(--primary)]/20 text-[12px] font-medium text-[var(--primary)]">
            <Building2 className="w-3.5 h-3.5" />
            {scopeLabel}
          </div>
          {lastSyncLabel && (
            <span className="text-[11px] text-[var(--gray-400)]">{lastSyncLabel}</span>
          )}
          {missingActiveCias.length > 0 && !loading && (
            <button
              onClick={loadAll}
              className="text-[11px] font-medium text-[var(--primary)] hover:text-[var(--primary-hover)] underline underline-offset-2"
              title={`Faltan: ${missingActiveCias.join(', ')}`}
            >
              Completar {missingActiveCias.length} faltantes
            </button>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={refresh}
            disabled={loading}
            className="flex items-center gap-1.5 text-[12px] text-[var(--gray-500)] hover:text-[var(--primary)] disabled:opacity-40 transition"
          >
            {loading
              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
              : <RefreshCw className="w-3.5 h-3.5" />}
            Actualizar
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-[var(--danger-muted)] border border-red-100 rounded-[var(--radius)] px-4 py-2.5 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-[12.5px] text-[var(--danger)] font-medium">
            <AlertCircle className="w-3.5 h-3.5" /> {error}
          </div>
          <button
            onClick={() => setError(null)}
            className="text-[11px] text-[var(--gray-500)] hover:text-[var(--danger)]"
          >
            Cerrar
          </button>
        </div>
      )}

      <CXPDashboard
        records={visibleRecords}
        onReset={onReset}
        companies={companies}
        providers={providers}
        clients={clients}
        assumptions={assumptions}
        bankStatements={bankStatements}
        paymentCoverage={paymentCoverage}
      />
    </div>
  );
};

export default CXP;
