import { useState, useCallback, useRef, useMemo, useEffect, type ReactNode } from 'react';
import {
  Upload as UploadIcon,
  FileSpreadsheet,
  Loader2,
  AlertCircle,
  Search,
  Building2,
  Clock,
  AlertTriangle,
  TrendingUp,
  ChevronDown,
  ChevronRight,
  X,
  ArrowUpDown,
  Receipt,
  Filter,
  RotateCcw,
  Database,
  RefreshCw,
  HelpCircle,
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
  PieChart,
  Pie,
  Cell,
} from 'recharts';
import { hex } from '../theme';
import { fmtCompact, fmtCurrency } from '../formatters';
import type { CashFlowAssumptions, Client, Provider, ProviderFlexibility, ProviderRisk } from '../domain/types';
import { enrichFromCatalog, flexibilityLabel } from '../domain/providerCatalog';
import { projectYear } from '../domain/collectionEngine';
import type { Budget } from '../domain/budget';

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
  total: number;
  count: number;
  maxDias: number;
  providerType: string;
  providerRisk: ProviderRisk;
  providerFlexibility: ProviderFlexibility;
  creditLimit?: number;
  records: EnrichedCXPRecord[];
}

type DashboardTab = 'resumen' | 'triage' | 'proveedores';
type SortKey = 'nombre' | 'total' | 'count' | 'maxDias';
type SortDir = 'asc' | 'desc';

/* ═══════════════════════════════════════════════════════════════════════
   Constants
   ═══════════════════════════════════════════════════════════════════════ */

const AGING_COLORS = [hex.success, hex.primary, hex.info, hex.warning, 'var(--chart-5)', hex.danger, 'var(--chart-4)', 'var(--chart-5)'];
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
const TRIAGE_ALERT_ORDER: CxpAlertType[] = [
  'riskHigh',
  'urgentPayment',
  'operationalImpact',
  'cashImpact',
  'criticalProvider',
  'overdue',
  'blocked',
  'incomplete',
  'duplicate',
  'creditLimit',
  'staleProvider',
];
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
  providersByName: Map<string, Provider>,
  providersByJde?: Map<string, Provider>,
): EnrichedCXPRecord {
  // Primero matcheamos por número JDE (más confiable); fallback a nombre normalizado.
  const noProveedorTrim = record.noProveedor ? String(record.noProveedor).trim() : '';
  const provider: Provider | undefined =
    (noProveedorTrim ? providersByJde?.get(noProveedorTrim) : undefined)
    ?? providersByName.get(normName(record.nombre));
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

function priorityTone(priority: PaymentPriority): string {
  switch (priority) {
    case 'critical': return 'bg-[var(--danger-muted)] text-[var(--danger)]';
    case 'negotiable': return 'bg-[var(--success-muted)] text-[var(--success)]';
    case 'highImpact': return 'bg-[var(--warning-muted)] text-[var(--warning)]';
    default: return 'bg-[var(--gray-100)] text-[var(--gray-500)]';
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

function toggleListValue<T extends string>(values: T[], value: T): T[] {
  return values.includes(value) ? values.filter(item => item !== value) : [...values, value];
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
    <div className="bg-white border border-[var(--gray-200)] rounded-xl px-3 py-2 shadow-lg">
      <p className="text-[12px] font-semibold text-[var(--gray-950)]">{item.name || payload[0].name}</p>
      <p className="text-[12px] font-mono text-[var(--gray-500)]">{fmtFull(payload[0].value)}</p>
      {typeof item.percent === 'number' && (
        <p className="text-[11px] text-[var(--gray-400)]">{(item.percent * 100).toFixed(1)}% del total</p>
      )}
    </div>
  );
};

/* ═══════════════════════════════════════════════════════════════════════
   Dashboard
   ═══════════════════════════════════════════════════════════════════════ */

const CXPDashboard = ({
  records,
  onReset,
  companies: compCatalog,
  providers,
  clients,
  assumptions,
  bankStatements,
}: {
  records: CXPRecord[];
  onReset: () => void;
  companies?: Company[];
  providers: Provider[];
  clients: Client[];
  assumptions: CashFlowAssumptions;
  bankStatements: BankAccountStatement[];
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
  const [categoryFilters, setCategoryFilters] = useState<string[]>([]);
  const [priorityFilters, setPriorityFilters] = useState<PaymentPriority[]>([]);

  // Drilldown state
  const [activeBucket, setActiveBucket] = useState<string | null>(null);
  const [activeKpi, setActiveKpi] = useState<string | null>(null);
  const [activeTriageAlert, setActiveTriageAlert] = useState<CxpAlertType | null>(null);
  const [selectedRecord, setSelectedRecord] = useState<EnrichedCXPRecord | null>(null);

  const clearDrill = () => {
    setActiveBucket(null);
    setActiveKpi(null);
    setActiveTriageAlert(null);
    setProvPage(0);
  };
  const clearAllFilters = () => {
    setSearchTerm('');
    setCategoryFilters([]);
    setPriorityFilters([]);
    setSelectedRecord(null);
    clearDrill();
  };
  const hasDrill = Boolean(
    searchTerm ||
    activeBucket ||
    activeKpi ||
    activeTriageAlert ||
    categoryFilters.length ||
    priorityFilters.length
  );

  // Reset local filters when parent switches company (records no longer include the selected cia)
  useEffect(() => {
    if (selectedCia !== 'all' && !records.some(r => r.cia === selectedCia)) {
      setSelectedCia('all');
      setActiveBucket(null);
      setActiveKpi(null);
      setActiveTriageAlert(null);
      setSelectedRecord(null);
      setExpandedSupplier(null);
      setProvPage(0);
    }
  }, [records, selectedCia]);

  const providersByName = useMemo(
    () => new Map(providers.map((provider) => [normName(provider.name), provider])),
    [providers],
  );
  const providersByJde = useMemo(() => {
    const map = new Map<string, Provider>();
    providers.forEach((p) => {
      if (p.numProveedorJDE) map.set(String(p.numProveedorJDE).trim(), p);
    });
    return map;
  }, [providers]);

  const enrichedRecords = useMemo(() => {
    const base = records.map((record) => enrichCxpRecord(record, providersByName, providersByJde));
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
  }, [providersByName, providersByJde, records]);

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
    if (activeBucket) {
      const bi = BUCKET_LABELS.indexOf(activeBucket);
      if (bi >= 0) { const k = BUCKET_KEYS[bi]; f = f.filter(r => (r[k] as number) > 0); }
    }
    if (categoryFilters.length) {
      const selected = new Set(categoryFilters);
      f = f.filter(r => selected.has(r.providerType));
    }
    if (activeKpi === 'porVencer') f = f.filter(r => r.porVencer > 0);
    else if (activeKpi === 'vencido') f = f.filter(r => (r.v1_30 + r.v31_60 + r.v61_90 + r.v91_120 + r.v121_150 + r.v151_180 + r.mas180) > 0);
    else if (activeKpi === 'mas90') f = f.filter(r => (r.v91_120 + r.v121_150 + r.v151_180 + r.mas180) > 0);
    if (priorityFilters.length) {
      const selected = new Set(priorityFilters);
      f = f.filter(r => selected.has(r.paymentPriority));
    }
    if (activeTriageAlert) {
      f = f.filter(r => r.alerts.some(alert => alert.type === activeTriageAlert));
    }
    return f;
  }, [enrichedRecords, selectedCia, searchTerm, activeBucket, categoryFilters, activeKpi, priorityFilters, activeTriageAlert]);

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
  const totalVencido = useMemo(() => agingBuckets.slice(1).reduce((s, b) => s + b.total, 0), [agingBuckets]);
  const totalPorVencer = agingBuckets[0]?.total || 0;
  const totalMas90 = useMemo(() => agingBuckets.slice(4).reduce((s, b) => s + b.total, 0), [agingBuckets]);

  const triageBuckets = useMemo(() => {
    const buckets = {
      critical: [] as EnrichedCXPRecord[],
      negotiable: [] as EnrichedCXPRecord[],
      highImpact: [] as EnrichedCXPRecord[],
    };
    filtered.forEach((record) => {
      if (isCritical(record)) buckets.critical.push(record);
      else if (isHighImpact(record)) buckets.highImpact.push(record);
      else if (isNegotiable(record)) buckets.negotiable.push(record);
    });
    Object.values(buckets).forEach((bucket) => {
      bucket.sort((a, b) => b.importePendientePesos - a.importePendientePesos || b.diasVencida - a.diasVencida);
    });
    return buckets;
  }, [filtered]);

  const paymentPlanningSummary = useMemo(() => ({
    criticalCount: triageBuckets.critical.length,
    criticalTotal: triageBuckets.critical.reduce((sum, record) => sum + record.importePendientePesos, 0),
    negotiableCount: triageBuckets.negotiable.length,
    negotiableTotal: triageBuckets.negotiable.reduce((sum, record) => sum + record.importePendientePesos, 0),
    highImpactCount: triageBuckets.highImpact.length,
    highImpactTotal: triageBuckets.highImpact.reduce((sum, record) => sum + record.importePendientePesos, 0),
  }), [triageBuckets]);

  const ivaMonth = useMemo(() => {
    const today = new Date();
    const targetMonth = today.getFullYear() === assumptions.year ? today.getMonth() : 0;
    const ym = `${assumptions.year}-${String(targetMonth + 1).padStart(2, '0')}`;
    const byClient = new Map(clients.map(client => [client.id, client]));
    const cxcEvents = clients.length ? projectYear(clients, assumptions).filter(event => event.realDate.startsWith(ym)) : [];
    const ivaCollected = cxcEvents.reduce((sum, event) => {
      const rate = (byClient.get(event.clientId)?.ivaRate ?? 16) / 100;
      return sum + (event.amount * rate) / (1 + rate);
    }, 0);
    let ivaPaid = 0;
    let cxpCount = 0;
    filtered.forEach((record) => {
      const dueDate = dueDateForRecord(record);
      if (!dueDate?.startsWith(ym)) return;
      ivaPaid += record.importeImpuestosPesos;
      cxpCount += 1;
    });
    return {
      ym,
      ivaCollected,
      ivaPaid,
      net: ivaCollected - ivaPaid,
      cxcCount: cxcEvents.length,
      cxpCount,
    };
  }, [assumptions, clients, filtered]);

  // Supplier aggregation
  const supplierData = useMemo(() => {
    const map = new Map<string, SupplierSummary>();
    filtered.forEach(r => {
      const k = r.nombre || 'SIN NOMBRE';
      if (!map.has(k)) {
        map.set(k, {
          nombre: k,
          total: 0,
          count: 0,
          maxDias: 0,
          providerType: r.providerType,
          providerRisk: r.providerRisk,
          providerFlexibility: r.providerFlexibility,
          creditLimit: r.providerCreditLimit,
          records: [],
        });
      }
      const e = map.get(k)!;
      e.total += r.importePendientePesos;
      e.count++;
      e.maxDias = Math.max(e.maxDias, r.diasVencida);
      e.records.push(r);
    });
    const arr = Array.from(map.values());
    arr.sort((a, b) => {
      const mul = sortDir === 'desc' ? -1 : 1;
      if (sortKey === 'nombre') return mul * a.nombre.localeCompare(b.nombre);
      return mul * ((a[sortKey] as number) - (b[sortKey] as number));
    });
    return arr;
  }, [filtered, sortKey, sortDir]);

  // Provider type — top 7 + "Otros" with source categories preserved for filtering.
  const classData = useMemo(() => {
    const map = new Map<string, { name: string; value: number; count: number }>();
    filtered.forEach(r => {
      const k = r.providerType || 'Sin clasificar';
      const item = map.get(k) ?? { name: k, value: 0, count: 0 };
      item.value += r.importePendientePesos;
      item.count += 1;
      map.set(k, item);
    });
    const total = filtered.reduce((sum, record) => sum + record.importePendientePesos, 0);
    const all = Array.from(map.values())
      .map(item => ({ ...item, categories: [item.name], percent: total > 0 ? item.value / total : 0 }))
      .sort((a, b) => b.value - a.value);
    if (all.length <= 8) return all;
    const top = all.slice(0, 7);
    const other = all.slice(7);
    const otrosVal = other.reduce((s, x) => s + x.value, 0);
    const otrosCount = other.reduce((s, x) => s + x.count, 0);
    return [
      ...top,
      {
        name: `Otros (${other.length})`,
        value: otrosVal,
        count: otrosCount,
        categories: other.flatMap(item => item.categories),
        percent: total > 0 ? otrosVal / total : 0,
      },
    ];
  }, [filtered]);

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
    { id: 'triage', label: 'Triage', count: paymentPlanningSummary.criticalCount + paymentPlanningSummary.negotiableCount + paymentPlanningSummary.highImpactCount },
    { id: 'proveedores', label: 'Proveedores', count: supplierData.length },
  ];

  const activeFilterChips = [
    ...(searchTerm ? [{ key: 'search', label: `Busqueda: ${searchTerm}`, onRemove: () => setSearchTerm('') }] : []),
    ...(activeBucket ? [{ key: 'bucket', label: `Antiguedad: ${activeBucket}`, onRemove: () => setActiveBucket(null) }] : []),
    ...(activeTriageAlert ? [{
      key: 'triage-alert',
      label: `Triage: ${ALERT_LABELS[activeTriageAlert]}`,
      onRemove: () => setActiveTriageAlert(null),
    }] : []),
    ...(activeKpi ? [{
      key: 'kpi',
      label: activeKpi === 'porVencer' ? 'Por vencer' : activeKpi === 'vencido' ? 'Total vencido' : 'Vencido > 90 dias',
      onRemove: () => setActiveKpi(null),
    }] : []),
    ...categoryFilters.map(value => ({ key: `cat-${value}`, label: `Categoria: ${value}`, onRemove: () => setCategoryFilters(prev => prev.filter(item => item !== value)) })),
    ...priorityFilters.map(value => ({ key: `priority-${value}`, label: `Prioridad: ${priorityLabel(value)}`, onRemove: () => setPriorityFilters(prev => prev.filter(item => item !== value)) })),
  ];

  const toggleCategoryGroup = (categories: string[]) => {
    setCategoryFilters(prev => {
      const allSelected = categories.every(category => prev.includes(category));
      if (allSelected) return prev.filter(category => !categories.includes(category));
      return Array.from(new Set([...prev, ...categories]));
    });
    setProvPage(0);
  };

  const triageAlertBuckets = useMemo(() => (
    TRIAGE_ALERT_ORDER
      .map(type => {
        const bucketRecords = filtered.filter(record => record.alerts.some(alert => alert.type === type));
        return {
          type,
          label: ALERT_LABELS[type],
          count: bucketRecords.length,
          total: bucketRecords.reduce((sum, record) => sum + record.importePendientePesos, 0),
        };
      })
      .filter(bucket => bucket.count > 0)
  ), [filtered]);

  const triageDetailRecords = useMemo(() => {
    const base = activeTriageAlert
      ? filtered.filter(record => record.alerts.some(alert => alert.type === activeTriageAlert))
      : filtered.filter(record => record.alerts.length > 0 || record.paymentPriority !== 'normal');
    return base.sort((a, b) => b.importePendientePesos - a.importePendientePesos || b.diasVencida - a.diasVencida);
  }, [activeTriageAlert, filtered]);

  /* ── Render ── */
  return (
    <div className="relative space-y-4">
      {/* ── Header Bar ── */}
      <div className="rounded-2xl border border-[var(--gray-200)] bg-white px-3 py-2.5 shadow-sm">
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

          <button onClick={onReset} className="text-[12px] text-[var(--gray-400)] hover:text-[var(--danger)] flex items-center gap-1 transition">
            <RotateCcw className="w-3 h-3" /> Nuevo archivo
          </button>
        </div>
      </div>

      {/* ── Active filter chips ── */}
      {hasDrill && (
        <div className="bg-[var(--primary-muted)] border border-[var(--primary)]/20 rounded-xl px-4 py-2.5 flex items-center justify-between gap-3 animate-slide-down">
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

      {/* ── KPI Cards ── */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {[
          { label: 'Saldo Total CXP', value: totalPendiente, sub: `${supplierData.length} proveedores · ${filtered.length.toLocaleString()} facturas`, icon: Building2, color: hex.primary, kpi: null as string | null },
          { label: 'Por Vencer', value: totalPorVencer, sub: pct(totalPorVencer, totalPendiente) + ' del total', icon: Clock, color: hex.success, kpi: 'porVencer' },
          { label: 'Total Vencido', value: totalVencido, sub: pct(totalVencido, totalPendiente) + ' del total', icon: AlertTriangle, color: hex.warning, kpi: 'vencido' },
          { label: 'Vencido > 90 días', value: totalMas90, sub: pct(totalMas90, totalPendiente) + ' del total', icon: TrendingUp, color: hex.danger, kpi: 'mas90' },
          { label: 'IVA neto del mes', value: ivaMonth.net, sub: `${fmt(ivaMonth.ivaCollected)} cobrado - ${fmt(ivaMonth.ivaPaid)} pagado`, icon: Receipt, color: ivaMonth.net >= 0 ? hex.warning : hex.success, kpi: null as string | null },
        ].map((kpi, i) => {
          const Icon = kpi.icon;
          const active = activeKpi === kpi.kpi && kpi.kpi !== null;
          return (
            <div key={i}
              onClick={() => {
                if (!kpi.kpi) { clearDrill(); return; }
                clearDrill();
                setActiveKpi(activeKpi === kpi.kpi ? null : kpi.kpi);
                setTab('proveedores');
              }}
              className={`animate-card-in stagger-${i + 1} bg-white rounded-2xl border p-4 shadow-sm hover-lift cursor-pointer ${
                active ? 'border-[var(--primary)] ring-2 ring-[var(--primary)]/20' : 'border-[var(--gray-200)]'
              }`}>
              <div className="flex items-center justify-between mb-2">
                <p className="text-[11px] font-medium text-[var(--gray-400)] uppercase tracking-wider">{kpi.label}</p>
                <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ backgroundColor: kpi.color + '14' }}>
                  <Icon className="w-3.5 h-3.5" style={{ color: kpi.color }} />
                </div>
              </div>
              <p className="text-[22px] font-bold font-mono tracking-tight text-[var(--gray-950)]">
                {fmt(kpi.value as number)}
              </p>
              <p className="text-[11px] text-[var(--gray-400)] mt-0.5">{kpi.sub}</p>
            </div>
          );
        })}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <PlanningCard
          title="Pagos criticos"
          amount={paymentPlanningSummary.criticalTotal}
          count={paymentPlanningSummary.criticalCount}
          detail="Riesgo alto, inamovibles o vencidos relevantes."
          tone="danger"
          active={priorityFilters.includes('critical')}
          onClick={() => { setPriorityFilters(prev => toggleListValue(prev, 'critical')); setTab('triage'); setProvPage(0); }}
        />
        <PlanningCard
          title="Pagos negociables"
          amount={paymentPlanningSummary.negotiableTotal}
          count={paymentPlanningSummary.negotiableCount}
          detail="Flexibles y sin atraso severo; candidatos a reprogramar."
          tone="success"
          active={priorityFilters.includes('negotiable')}
          onClick={() => { setPriorityFilters(prev => toggleListValue(prev, 'negotiable')); setTab('triage'); setProvPage(0); }}
        />
        <PlanningCard
          title="Mayor impacto en flujo"
          amount={paymentPlanningSummary.highImpactTotal}
          count={paymentPlanningSummary.highImpactCount}
          detail={`Facturas de ${fmt(HIGH_IMPACT_AMOUNT)} o mas.`}
          tone="warning"
          active={priorityFilters.includes('highImpact')}
          onClick={() => { setPriorityFilters(prev => toggleListValue(prev, 'highImpact')); setTab('triage'); setProvPage(0); }}
        />
      </div>

      {/* ════════════════════════════════════════════════════════════════
         RESUMEN TAB
         ════════════════════════════════════════════════════════════════ */}
      {tab === 'resumen' && (
        <>
          {/* Aging Bar Chart */}
          <div className="bg-white rounded-2xl border border-[var(--gray-200)] p-5 shadow-sm animate-card-in stagger-5">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-[15px] font-semibold text-[var(--gray-950)]">Distribución por Antigüedad</h2>
              <p className="text-[12px] text-[var(--gray-400)]">Click en barra para filtrar</p>
            </div>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart layout="vertical" data={agingBuckets} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
                <CartesianGrid stroke="var(--gray-100)" strokeDasharray="0" horizontal={false} />
                <XAxis type="number" tick={{ fill: 'var(--gray-400)', fontSize: 11 }} axisLine={{ stroke: 'var(--gray-100)' }} tickLine={false} tickFormatter={v => fmt(v)} />
                <YAxis type="category" dataKey="name" width={86} tick={{ fill: 'var(--gray-400)', fontSize: 11 }} axisLine={false} tickLine={false} />
                <Tooltip content={<ChartTooltip />} />
                <Bar dataKey="total" radius={[0, 6, 6, 0]} cursor="pointer"
                  onClick={(data: any) => { clearDrill(); setActiveBucket(activeBucket === data.name ? null : data.name); setTab('proveedores'); }}>
                  {agingBuckets.map((b, i) => (
                    <Cell key={i} fill={b.color}
                      fillOpacity={activeBucket === b.name ? 1 : activeBucket ? 0.25 : 0.85}
                      stroke={activeBucket === b.name ? b.color : 'none'} strokeWidth={1.5} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
            {/* Bucket summary chips */}
            <div className="flex gap-2 mt-3 flex-wrap">
              {agingBuckets.filter(b => b.total > 0).map((b, i) => (
                <div key={i} className="flex items-center gap-1.5 bg-[var(--gray-50)] rounded-full px-2.5 py-1 text-[11px]">
                  <div className="w-2 h-2 rounded-full" style={{ backgroundColor: b.color }} />
                  <span className="text-[var(--gray-500)]">{b.name}:</span>
                  <span className="font-mono font-semibold text-[var(--gray-950)]">{fmt(b.total)}</span>
                  <span className="text-[var(--gray-400)]">({b.count})</span>
                </div>
              ))}
            </div>
          </div>

          {/* Two columns: Tipo proveedor + Top Proveedores */}
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2 animate-card-in stagger-7">
            {/* Provider Type Donut */}
            <div className="bg-white rounded-2xl border border-[var(--gray-200)] p-5 shadow-sm overflow-hidden hover-lift">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-[15px] font-semibold text-[var(--gray-950)]">Por tipo de proveedor</h2>
                <p className="text-[12px] text-[var(--gray-400)]">Click para filtrar</p>
              </div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-[220px_1fr]">
                <ResponsiveContainer width="100%" height={220}>
                  <PieChart>
                    <Pie
                      data={classData}
                      cx="50%"
                      cy="50%"
                      innerRadius={58}
                      outerRadius={92}
                      paddingAngle={1}
                      dataKey="value"
                      cursor="pointer"
                      onClick={(data: any) => {
                        clearDrill();
                        toggleCategoryGroup(data.categories ?? [data.name]);
                        setTab('proveedores');
                      }}
                    >
                      {classData.map((e, i) => {
                        const active = e.categories.some(category => categoryFilters.includes(category));
                        const anyActive = categoryFilters.length > 0;
                        return (
                          <Cell
                            key={i}
                            fill={PIE_COLORS[i % PIE_COLORS.length]}
                            fillOpacity={active ? 1 : anyActive ? 0.25 : 0.9}
                            stroke={active ? 'var(--gray-950)' : 'var(--card)'}
                            strokeWidth={active ? 1.5 : 1}
                          />
                        );
                      })}
                    </Pie>
                    <Tooltip content={<ChartTooltip />} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="space-y-1.5 self-center">
                  {classData.map((e, i) => {
                    const active = e.categories.some(category => categoryFilters.includes(category));
                    return (
                      <button
                        key={i}
                        onClick={() => {
                          clearDrill();
                          toggleCategoryGroup(e.categories);
                          setTab('proveedores');
                        }}
                        className={`grid w-full grid-cols-[10px_1fr_auto] items-center gap-2 rounded-lg px-2 py-1.5 text-left transition ${
                          active ? 'bg-[var(--primary-muted)]' : 'hover:bg-[var(--gray-50)]'
                        }`}
                        title={`${e.name}: ${fmtFull(e.value)} (${pct(e.value, totalPendiente)})`}
                      >
                        <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: PIE_COLORS[i % PIE_COLORS.length] }} />
                        <span className="min-w-0 truncate text-[12px] font-medium text-[var(--gray-700)]">{e.name}</span>
                        <span className="text-right text-[11px] font-mono text-[var(--gray-500)]">
                          {pct(e.value, totalPendiente)}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Top 10 Proveedores */}
            <div className="bg-white rounded-2xl border border-[var(--gray-200)] p-5 shadow-sm hover-lift">
              <h2 className="text-[15px] font-semibold text-[var(--gray-950)] mb-3">Top 10 Proveedores</h2>
              <div className="space-y-1.5">
                {supplierData.slice(0, 10).map((s, i) => {
                  const barPct = supplierData[0]?.total > 0 ? (s.total / supplierData[0].total) : 0;
                  return (
                    <div key={i}
                      className="flex items-center gap-2.5 py-1.5 px-2 -mx-2 cursor-pointer hover:bg-[var(--gray-50)] rounded-lg transition-colors duration-150"
                      onClick={() => { clearDrill(); setSearchTerm(s.nombre.slice(0, 20)); setTab('proveedores'); setExpandedSupplier(s.nombre); setProvPage(0); }}>
                      <span className="text-[11px] font-mono text-[var(--gray-400)] w-4 text-right">{i + 1}</span>
                      <div className="flex-1 min-w-0">
                        <p className="text-[12px] font-medium text-[var(--primary)] truncate">{s.nombre}</p>
                        <div className="bg-[var(--gray-100)] rounded-full h-1.5 mt-1 overflow-hidden">
                          <div className="h-full rounded-full bg-[var(--primary)]/60" style={{ width: `${barPct * 100}%` }} />
                        </div>
                      </div>
                      <div className="text-right">
                        <p className="text-[12px] font-mono font-semibold text-[var(--gray-950)]">{fmt(s.total)}</p>
                        <p className="text-[10px] text-[var(--gray-400)]">{s.count} fact.</p>
                      </div>
                    </div>
                  );
                })}
              </div>
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
            <div className="bg-white rounded-2xl border border-[var(--gray-200)] p-5 shadow-sm animate-card-in stagger-9">
              <h2 className="text-[15px] font-semibold text-[var(--gray-950)] mb-4">Desglose por Compañía</h2>
              <div className="grid grid-cols-2 gap-3">
                {ciaData.map((c, i) => (
                  <div key={i} className="flex items-center gap-3 p-3 bg-[var(--surface-alt)] rounded-xl">
                    <div className="w-2 h-8 rounded-full" style={{ backgroundColor: PIE_COLORS[i % PIE_COLORS.length] }} />
                    <div className="flex-1 min-w-0">
                      <p className="text-[12px] font-medium text-[var(--gray-950)] truncate">{c.name}</p>
                      <p className="text-[11px] text-[var(--gray-400)]">{pct(c.value, totalPendiente)}</p>
                    </div>
                    <p className="text-[13px] font-mono font-semibold text-[var(--gray-950)]">{fmt(c.value)}</p>
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
        <div className="bg-white rounded-2xl border border-[var(--gray-200)] shadow-sm overflow-hidden">
          {/* Header with sort controls */}
          <div className="p-4 border-b border-[var(--gray-100)] flex items-center justify-between">
            <h2 className="text-[15px] font-semibold text-[var(--gray-950)]">
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
                  className={`px-2.5 py-1 rounded-lg text-[11px] font-medium transition flex items-center gap-1 ${
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
              const vencido = s.records.reduce((sum, r) => sum + r.v1_30 + r.v31_60 + r.v61_90 + r.v91_120 + r.v121_150 + r.v151_180 + r.mas180, 0);
              const severity = s.maxDias > 120 ? hex.danger : s.maxDias > 60 ? hex.warning : s.maxDias > 0 ? hex.primary : hex.success;

              return (
                <div key={s.nombre}>
                  <button onClick={() => setExpandedSupplier(isExpanded ? null : s.nombre)}
                    className="w-full flex items-center gap-3 px-4 py-3 hover:bg-[var(--gray-50)] transition text-left">
                    {isExpanded ? <ChevronDown className="w-4 h-4 text-[var(--gray-400)]" /> : <ChevronRight className="w-4 h-4 text-[var(--gray-400)]" />}

                    <div className="flex-1 min-w-0">
                      <p className="text-[13px] font-medium text-[var(--gray-950)] truncate">{s.nombre}</p>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-[11px] text-[var(--gray-400)]">{s.count} factura{s.count !== 1 ? 's' : ''}</span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--gray-100)] text-[var(--gray-500)]">{s.providerType}</span>
                        <span
                          className={`text-[10px] px-1.5 py-0.5 rounded-full ${s.providerRisk === 'Alto' ? 'bg-[var(--danger-muted)] text-[var(--danger)]' : s.providerRisk === 'Medio' ? 'bg-[var(--warning-muted)] text-[var(--warning)]' : 'bg-[var(--success-muted)] text-[var(--success)]'}`}
                          title={`Riesgo ${s.providerRisk}`}
                        >
                          Riesgo {s.providerRisk}
                        </span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-white border border-[var(--gray-200)] text-[var(--gray-500)]" title={`Flexibilidad ${flexibilityLabel(s.providerFlexibility)}`}>{flexibilityLabel(s.providerFlexibility)}</span>
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
                        const bval = s.records.reduce((sum, r) => sum + (r[key] as number), 0);
                        const bpct = s.total > 0 ? (bval / s.total) * 100 : 0;
                        return bpct > 0 ? <div key={bi} style={{ width: `${bpct}%`, backgroundColor: AGING_COLORS[bi] }} /> : null;
                      })}
                    </div>

                    <div className="text-right w-28">
                      <p className="text-[13px] font-mono font-semibold text-[var(--gray-950)]">{fmt(s.total)}</p>
                      {vencido > 0 && <p className="text-[10px] font-mono text-[var(--danger)]">{fmt(vencido)} vencido</p>}
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
                          const bval = s.records.reduce((sum, r) => sum + (r[key] as number), 0);
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
                              <th className="text-right py-2 text-[var(--gray-400)] font-semibold">Pendiente</th>
                              <th className="text-left py-2 text-[var(--gray-400)] font-semibold pl-3">Mon.</th>
                              <th className="text-left py-2 text-[var(--gray-400)] font-semibold">Cond. Pago</th>
                              <th className="text-left py-2 text-[var(--gray-400)] font-semibold">Prioridad</th>
                              <th className="text-left py-2 text-[var(--gray-400)] font-semibold">Referencias</th>
                            </tr>
                          </thead>
                          <tbody>
                            {s.records.sort((a, b) => b.diasVencida - a.diasVencida).map((r, ri) => (
                              <tr
                                key={ri}
                                onClick={() => setSelectedRecord(r)}
                                className="cursor-pointer border-b border-[var(--gray-50)] hover:bg-white"
                              >
                                <td className="py-1.5 font-mono text-[var(--gray-950)]">{r.noFactura}</td>
                                <td className="py-1.5 text-[var(--gray-500)]">{r.fechaFactura}</td>
                                <td className="py-1.5 text-[var(--gray-500)]">{r.fechaVence}</td>
                                <td className="py-1.5 text-right font-mono">
                                  <span
                                    className={r.diasVencida > 90 ? 'text-[var(--danger)] font-semibold' : r.diasVencida > 30 ? 'text-[var(--warning)]' : 'text-[var(--gray-950)]'}
                                    title={agingTooltip(r.diasVencida)}
                                  >
                                    {r.diasVencida}
                                  </span>
                                </td>
                                <td className="py-1.5 text-right font-mono font-medium text-[var(--gray-950)]">{fmtFull(r.importePendientePesos)}</td>
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
                  className="px-3 py-1 rounded-lg text-[12px] font-medium bg-[var(--gray-50)] text-[var(--gray-500)] hover:bg-[var(--gray-100)] disabled:opacity-30 transition">
                  Anterior
                </button>
                <span className="px-3 py-1 text-[12px] text-[var(--gray-400)]">{provPage + 1} / {totalPages}</span>
                <button onClick={() => setProvPage(p => Math.min(totalPages - 1, p + 1))} disabled={provPage >= totalPages - 1}
                  className="px-3 py-1 rounded-lg text-[12px] font-medium bg-[var(--gray-50)] text-[var(--gray-500)] hover:bg-[var(--gray-100)] disabled:opacity-30 transition">
                  Siguiente
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ════════════════════════════════════════════════════════════════
         TRIAGE TAB
         ════════════════════════════════════════════════════════════════ */}
      {tab === 'triage' && (
        <div className="space-y-4">
          <TriageAlertBoard
            buckets={triageAlertBuckets}
            active={activeTriageAlert}
            onSelect={(type) => setActiveTriageAlert(prev => prev === type ? null : type)}
          />
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            <TriageColumn
              title="Críticos"
              detail="No conviene moverlos sin decisión ejecutiva."
              tone="danger"
              records={triageBuckets.critical}
              onRecordSelect={setSelectedRecord}
            />
            <TriageColumn
              title="Negociables"
              detail="Candidatos a reprogramar o negociar plazo."
              tone="success"
              records={triageBuckets.negotiable}
              onRecordSelect={setSelectedRecord}
            />
            <TriageColumn
              title="Mayor impacto"
              detail={`Montos de ${fmt(HIGH_IMPACT_AMOUNT)} o más.`}
              tone="warning"
              records={triageBuckets.highImpact}
              onRecordSelect={setSelectedRecord}
            />
          </div>
          <TriageDetailTable
            title={activeTriageAlert ? ALERT_LABELS[activeTriageAlert] : 'Todo el triage'}
            records={triageDetailRecords}
            onRecordSelect={setSelectedRecord}
          />
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
  return (
    <div className="bg-white rounded-2xl border border-[var(--gray-200)] shadow-sm overflow-hidden animate-card-in stagger-8">
      <div className="p-4 border-b border-[var(--gray-100)] flex items-center justify-between">
        <h2 className="text-[15px] font-semibold text-[var(--gray-950)]">Matriz de Antigüedad por Proveedor</h2>
        <p className="text-[12px] text-[var(--gray-400)]">Top {Math.min(100, supplierData.length)} proveedores por monto</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[11px]">
          <thead className="sticky top-0 bg-white z-10">
            <tr className="border-b-2 border-[var(--gray-200)]">
              <th className="text-left py-2.5 px-3 text-[var(--gray-400)] font-semibold w-[200px] min-w-[200px]">Proveedor</th>
              <th className="text-right py-2.5 px-2 text-[var(--gray-400)] font-semibold w-[90px]">Total</th>
              <th className="text-center py-2.5 px-1 text-[var(--gray-400)] font-semibold w-[40px]">#</th>
              {BUCKET_LABELS.map((label, i) => (
                <th key={i} className="text-right py-2.5 px-2 font-semibold w-[85px]" style={{ color: AGING_COLORS[i] }}>{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {supplierData.slice(0, 100).map((s, si) => {
              const bucketVals = BUCKET_KEYS.map(key => s.records.reduce((sum, r) => sum + (r[key] as number), 0));
              const maxBucket = Math.max(...bucketVals);
              return (
                <tr key={si} className="border-b border-[var(--gray-50)] hover:bg-[var(--gray-50)] transition">
                  <td className="py-2 px-3 font-medium text-[var(--gray-950)] truncate max-w-[200px]" title={s.nombre}>{s.nombre}</td>
                  <td className="py-2 px-2 text-right font-mono font-semibold text-[var(--gray-950)]">{fmt(s.total)}</td>
                  <td className="py-2 px-1 text-center text-[var(--gray-400)]">{s.count}</td>
                  {bucketVals.map((val, bi) => {
                    const intensity = maxBucket > 0 ? Math.min(val / maxBucket, 1) : 0;
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
            <tr className="border-t-2 border-[var(--gray-200)] bg-[var(--gray-50)] font-semibold sticky bottom-0">
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

function TriageAlertBoard({
  buckets,
  active,
  onSelect,
}: {
  buckets: Array<{ type: CxpAlertType; label: string; count: number; total: number }>;
  active: CxpAlertType | null;
  onSelect: (type: CxpAlertType) => void;
}) {
  return (
    <section className="rounded-2xl border border-[var(--gray-200)] bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-[14px] font-semibold text-[var(--gray-950)]">Clasificación de triage</h2>
        <span className="text-[11px] text-[var(--gray-400)]">Click para ver facturas</span>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-5">
        {buckets.map(bucket => (
          <button
            key={bucket.type}
            onClick={() => onSelect(bucket.type)}
            className={`rounded-xl border px-3 py-2 text-left transition ${
              active === bucket.type
                ? 'border-[var(--primary)] bg-[var(--primary-muted)]'
                : 'border-[var(--gray-200)] hover:border-[var(--primary)] hover:bg-[var(--gray-50)]'
            }`}
            title={`${bucket.label}: ${fmtFull(bucket.total)}`}
          >
            <p className="truncate text-[11px] text-[var(--gray-500)]">{bucket.label}</p>
            <div className="mt-1 flex items-end justify-between gap-2">
              <span className="font-mono text-[18px] font-semibold text-[var(--gray-950)]">{bucket.count}</span>
              <span className="font-mono text-[11px] text-[var(--gray-500)]">{fmt(bucket.total)}</span>
            </div>
          </button>
        ))}
        {buckets.length === 0 && (
          <div className="col-span-full rounded-xl border border-dashed border-[var(--gray-200)] px-3 py-6 text-center text-[12px] text-[var(--gray-400)]">
            No hay alertas con los filtros actuales.
          </div>
        )}
      </div>
    </section>
  );
}

function TriageDetailTable({
  title,
  records,
  onRecordSelect,
}: {
  title: string;
  records: EnrichedCXPRecord[];
  onRecordSelect: (record: EnrichedCXPRecord) => void;
}) {
  return (
    <section className="rounded-2xl border border-[var(--gray-200)] bg-white shadow-sm overflow-hidden">
      <header className="flex items-center justify-between gap-3 border-b border-[var(--gray-100)] px-4 py-3">
        <h2 className="text-[14px] font-semibold text-[var(--gray-950)]">{title}</h2>
        <span className="text-[11px] text-[var(--gray-400)]">{records.length} facturas</span>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead className="bg-[var(--gray-50)] text-[var(--gray-400)]">
            <tr>
              <th className="px-4 py-2 text-left font-medium">Factura</th>
              <th className="px-4 py-2 text-left font-medium">Proveedor</th>
              <th className="px-4 py-2 text-left font-medium">Causa</th>
              <th className="px-4 py-2 text-right font-medium">Días</th>
              <th className="px-4 py-2 text-right font-medium">Monto</th>
              <th className="px-4 py-2 text-left font-medium">Vence</th>
            </tr>
          </thead>
          <tbody>
            {records.slice(0, 150).map((record, index) => (
              <tr
                key={`${record.cia}-${record.noProveedor}-${record.noFactura}-${index}`}
                onClick={() => onRecordSelect(record)}
                className="cursor-pointer border-t border-[var(--gray-100)] hover:bg-[var(--gray-50)]"
              >
                <td className="px-4 py-2 font-mono text-[var(--gray-950)]">{record.noFactura || '-'}</td>
                <td className="px-4 py-2 text-[var(--gray-950)]">{record.nombre || '-'}</td>
                <td className="px-4 py-2">
                  <div className="flex max-w-[420px] flex-wrap gap-1">
                    {record.alerts.slice(0, 3).map(alert => (
                      <span key={`${record.noFactura}-${alert.type}`} className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${alertToneClass(alert.tone)}`} title={alert.detail}>
                        {alert.label}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="px-4 py-2 text-right font-mono text-[var(--gray-950)]">{record.diasVencida}</td>
                <td className="px-4 py-2 text-right font-mono font-semibold text-[var(--gray-950)]">{fmtFull(record.importePendientePesos)}</td>
                <td className="px-4 py-2 text-[var(--gray-500)]">{dueDateForRecord(record) ?? '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function TriageColumn({
  title,
  detail,
  tone,
  records,
  onRecordSelect,
}: {
  title: string;
  detail: string;
  tone: 'danger' | 'success' | 'warning';
  records: EnrichedCXPRecord[];
  onRecordSelect: (record: EnrichedCXPRecord) => void;
}) {
  const total = records.reduce((sum, record) => sum + record.importePendientePesos, 0);
  const toneClass =
    tone === 'danger'
      ? 'bg-[var(--danger-muted)] text-[var(--danger)]'
      : tone === 'success'
        ? 'bg-[var(--success-muted)] text-[var(--success)]'
        : 'bg-[var(--warning-muted)] text-[var(--warning)]';

  return (
    <section className="rounded-2xl border border-[var(--gray-200)] bg-white shadow-sm overflow-hidden">
      <header className="border-b border-[var(--gray-100)] p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-[15px] font-semibold text-[var(--gray-950)]">{title}</h2>
            <p className="mt-1 text-[11px] leading-4 text-[var(--gray-400)]">{detail}</p>
          </div>
          <span className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${toneClass}`}>
            {records.length} fact.
          </span>
        </div>
        <p className="mt-3 font-mono text-[20px] font-bold text-[var(--gray-950)]">{fmt(total)}</p>
      </header>
      <div className="max-h-[620px] space-y-2 overflow-y-auto bg-[var(--surface-alt)] p-3">
        {records.length === 0 ? (
          <div className="rounded-xl border border-dashed border-[var(--gray-200)] bg-white p-5 text-center text-[12px] text-[var(--gray-400)]">
            Sin facturas en este balde.
          </div>
        ) : records.slice(0, 40).map((record) => (
          <button
            key={`${record.noProveedor}-${record.noFactura}-${record.fechaVence}`}
            onClick={() => onRecordSelect(record)}
            className="block w-full rounded-xl border border-[var(--gray-200)] bg-white p-3 text-left shadow-sm transition hover:border-[var(--primary)] hover:bg-[var(--gray-50)]"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-[12px] font-semibold text-[var(--gray-950)]" title={record.nombre}>{record.nombre}</p>
                <p className="mt-0.5 text-[10px] text-[var(--gray-400)]">{record.providerType}</p>
              </div>
              <p className="shrink-0 font-mono text-[12px] font-semibold text-[var(--gray-950)]">{fmt(record.importePendientePesos)}</p>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${priorityTone(record.paymentPriority)}`} title={priorityReason(record)}>
                {priorityLabel(record.paymentPriority)}
                <HelpCircle className="h-3 w-3" />
              </span>
              <span className="rounded-full bg-white px-1.5 py-0.5 text-[10px] text-[var(--gray-500)] border border-[var(--gray-100)]">
                {flexibilityLabel(record.providerFlexibility)}
              </span>
              <span
                className="rounded-full bg-white px-1.5 py-0.5 text-[10px] text-[var(--gray-500)] border border-[var(--gray-100)]"
                title={agingTooltip(record.diasVencida)}
              >
                {record.diasVencida > 0 ? `${record.diasVencida}d vencido` : 'por vencer'}
              </span>
              <span className="rounded-full bg-white px-1.5 py-0.5 text-[10px] text-[var(--gray-500)] border border-[var(--gray-100)]">
                vence {dueDateForRecord(record) ?? 'sin fecha'}
              </span>
            </div>
          </button>
        ))}
        {records.length > 40 && (
          <p className="py-2 text-center text-[11px] text-[var(--gray-400)]">
            {records.length - 40} facturas mas en este balde.
          </p>
        )}
      </div>
    </section>
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
              <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--gray-400)]">Detalle de factura</p>
              <h2 className="mt-1 truncate text-[18px] font-semibold text-[var(--gray-950)]">{record.noFactura || 'Sin factura'}</h2>
              <p className="mt-1 truncate text-[12px] text-[var(--gray-500)]">{record.nombre}</p>
            </div>
            <button onClick={onClose} className="rounded-lg p-1.5 text-[var(--gray-400)] hover:bg-[var(--gray-50)] hover:text-[var(--gray-950)]">
              <X className="h-4 w-4" />
            </button>
          </div>
        </header>

        <div className="space-y-5 p-5">
          <div className="grid grid-cols-2 gap-3">
            <DetailMetric label="Pendiente" value={fmtFull(record.importePendientePesos)} />
            <DetailMetric label="Días vencida" value={`${record.diasVencida}d`} />
            <DetailMetric label="Vence" value={dueDateForRecord(record) ?? '-'} />
            <DetailMetric label="Moneda" value={record.moneda || '-'} />
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
            <DetailGrid rows={[
              ['Tipo', record.providerType],
              ['Riesgo', record.providerRisk],
              ['Flexibilidad', flexibilityLabel(record.providerFlexibility)],
              ['Fecha último pago proveedor', lastPaymentDate],
              ['Monto último pago proveedor', lastPaymentAmount],
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
              ['Fecha programada', record.fechaProgramacionPago || '-'],
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
                  <div key={`${movement.referencia}-${index}`} className="rounded-lg border border-[var(--gray-200)] px-3 py-2">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-[12px] font-medium text-[var(--gray-950)]">{movement.fechaOperacion}</span>
                      <span className="font-mono text-[12px] font-semibold text-[var(--gray-950)]">{fmtFull(movement.importe)}</span>
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
    <div className="rounded-xl bg-[var(--gray-50)] px-3 py-2">
      <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--gray-400)]">{label}</p>
      <p className="mt-1 truncate font-mono text-[15px] font-semibold text-[var(--gray-950)]" title={value}>{value}</p>
    </div>
  );
}

function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-[var(--gray-400)]">{title}</h3>
      <div className="rounded-xl border border-[var(--gray-200)] p-3">{children}</div>
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

function PlanningCard({
  title,
  amount,
  count,
  detail,
  tone,
  active,
  onClick,
}: {
  title: string;
  amount: number;
  count: number;
  detail: string;
  tone: 'danger' | 'success' | 'warning';
  active: boolean;
  onClick: () => void;
}) {
  const toneClass =
    tone === 'danger'
      ? 'text-[var(--danger)] bg-[var(--danger-muted)] border-red-100'
      : tone === 'success'
        ? 'text-[var(--success)] bg-[var(--success-muted)] border-green-100'
        : 'text-[var(--warning)] bg-[var(--warning-muted)] border-yellow-100';

  return (
    <button
      onClick={onClick}
      className={`rounded-2xl border bg-white p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md ${
        active ? 'border-[var(--primary)] ring-2 ring-[var(--primary)]/15' : 'border-[var(--gray-200)]'
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[12px] font-semibold text-[var(--gray-950)]">{title}</p>
          <p className="mt-2 text-[22px] font-bold font-mono text-[var(--gray-950)]">{fmt(amount)}</p>
        </div>
        <span className={`rounded-full border px-2.5 py-1 text-[11px] font-medium ${toneClass}`}>
          {count} fact.
        </span>
      </div>
      <p className="mt-2 text-[11px] leading-5 text-[var(--gray-400)]">{detail}</p>
    </button>
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

  // Visible records = filtered by header's selectedCia
  const visibleRecords = useMemo(() => {
    if (selectedCia === 'all') return records;
    return records.filter(r => r.cia === selectedCia);
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
            <div className="w-14 h-14 rounded-2xl bg-[var(--primary)] flex items-center justify-center mx-auto mb-4 shadow-lg shadow-[var(--primary)]/15">
              <Clock className="text-white" size={26} />
            </div>
            <h1 className="text-[28px] font-bold text-white tracking-tight">Cuentas por Pagar</h1>
          </div>

          <div className="bg-white rounded-2xl shadow-sm border border-[var(--gray-200)] p-8">
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
                <div className="border-2 border-[var(--primary)]/30 bg-[var(--primary-subtle)] rounded-2xl p-10 text-center hover:border-[var(--primary)] hover:bg-[var(--primary-muted)] transition-colors">
                  <Database className="w-10 h-10 mx-auto mb-3 text-[var(--primary)]" />
                  <p className="text-[15px] font-semibold text-[var(--gray-950)]">Consultar desde JDE</p>
                  <p className="text-[12px] text-[var(--gray-400)] mt-1">{scopeLabel}</p>
                  <button
                    onClick={() => selectedCia === 'all' ? loadAll() : loadSingle(selectedCia)}
                    disabled={loading || (selectedCia === 'all' && activeCias.length === 0)}
                    className="mt-4 inline-flex items-center gap-2 px-5 h-10 rounded-xl bg-[var(--primary)] text-white text-[13.5px] font-medium hover:bg-[var(--primary-hover)] shadow-sm shadow-[var(--primary)]/20 disabled:opacity-40 disabled:cursor-not-allowed transition"
                  >
                    <Database className="w-4 h-4" />
                    {selectedCia === 'all' ? 'Consultar todas' : 'Consultar antigüedad'}
                  </button>
                </div>

                <div
                  onClick={() => csvInput.current?.click()}
                  className="border-2 border-dashed border-[var(--gray-200)] rounded-2xl p-10 text-center cursor-pointer hover:border-[var(--primary)] hover:bg-[var(--gray-50)] transition-colors"
                >
                  <FileSpreadsheet className="w-10 h-10 text-[var(--gray-400)] mx-auto mb-3" />
                  <p className="text-[15px] font-semibold text-[var(--gray-950)]">Subir CSV</p>
                  <p className="text-[13px] text-[var(--gray-400)] mt-1">Opcional · si JDE no está disponible</p>
                  <input
                    ref={csvInput} type="file" accept=".csv" className="hidden"
                    onChange={e => e.target.files?.[0] && handleCsvFile(e.target.files[0])}
                  />
                </div>
              </div>
            )}

            {error && !loading && (
              <div className="mt-4 bg-[var(--danger-muted)] border border-red-100 rounded-xl p-4">
                <div className="flex items-start gap-3">
                  <AlertCircle className="text-[var(--danger)] flex-shrink-0 mt-0.5" size={18} />
                  <div className="flex-1">
                    <p className="text-[13px] font-semibold text-[var(--gray-950)]">Error al consultar JDE</p>
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
          <button
            onClick={() => csvInput.current?.click()}
            className="flex items-center gap-1.5 text-[12px] text-[var(--gray-500)] hover:text-[var(--primary)] transition"
          >
            <UploadIcon className="w-3.5 h-3.5" />
            Subir CSV
          </button>
          <button
            onClick={onReset}
            className="flex items-center gap-1.5 text-[12px] text-[var(--gray-400)] hover:text-[var(--danger)] transition"
          >
            <X className="w-3.5 h-3.5" />
            Limpiar
          </button>
          <input
            ref={csvInput} type="file" accept=".csv" className="hidden"
            onChange={e => e.target.files?.[0] && handleCsvFile(e.target.files[0])}
          />
        </div>
      </div>

      {error && (
        <div className="bg-[var(--danger-muted)] border border-red-100 rounded-xl px-4 py-2.5 flex items-center justify-between gap-3">
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
      />
    </div>
  );
};

export default CXP;
