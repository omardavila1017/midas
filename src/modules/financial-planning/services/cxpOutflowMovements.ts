import type { CXPRecord } from '../../../domain/persistence';
import type { ClasificacionAlberto, Provider } from '../../../domain/types';
import { CLASIFICACION_LABELS } from '../../../domain/types';
import type { FinancialMovement } from '../../shared-finance/types';

/**
 * Builds OUTFLOW movements from open JDE CXP invoices. Supplier payments stay
 * invoice-dated so the scheduler can prioritize by score and actual CXP dates.
 * Excludes Pausa and Sin clasificar — only compromisos firmes appear.
 */
export interface BuildCxpOutflowsInput {
  cxpRecords: CXPRecord[];
  providers: Provider[];
  companyCode: string;
  asOfDate: string;
  endDate: string;
}

function normalize(value: string | undefined | null): string {
  return (value ?? '').trim().toLowerCase();
}

function normalizeJde(value: string | undefined | null): string {
  const digits = (value ?? '').replace(/\D+/g, '');
  if (!digits) return '';
  return String(Number(digits));
}

function cleanDate(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed && /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : undefined;
}

function effectiveCxpDate(record: CXPRecord, asOfDate: string): { date: string; originalDate: string; moved: boolean } {
  const scheduledDate = cleanDate(record.fechaProgramacionPago)
    ?? cleanDate(record.fechaVence)
    ?? cleanDate(record.fechaFactura)
    ?? asOfDate;
  const dueDate = cleanDate(record.fechaVence);
  const originalDate = dueDate && scheduledDate < dueDate ? dueDate : scheduledDate;
  return originalDate < asOfDate
    ? { date: asOfDate, originalDate, moved: true }
    : { date: originalDate, originalDate, moved: false };
}

// Categorías visibles en el grid de planeación. Se excluyen Pausa y
// Sin clasificar a propósito: no son compromisos firmes.
const VISIBLE_CLASIF: ClasificacionAlberto[] = ['CRITICO', 'FLEX_ALTO', 'FLEX_MEDIO', 'FLEX_BAJO'];

export function buildCxpOutflowMovements(input: BuildCxpOutflowsInput): FinancialMovement[] {
  const { cxpRecords, providers, companyCode, asOfDate, endDate } = input;

  const providerByJde = new Map<string, Provider>();
  const providerByName = new Map<string, Provider>();
  for (const p of providers) {
    const jdeKey = normalizeJde(p.numProveedorJDE);
    if (jdeKey) providerByJde.set(jdeKey, p);
    providerByName.set(normalize(p.name), p);
  }

  const filtered = !companyCode || companyCode === 'all'
    ? cxpRecords
    : cxpRecords.filter((r) => r.cia === companyCode);

  const movements: FinancialMovement[] = [];
  const createdAt = `${asOfDate}T00:00:00.000Z`;

  filtered.forEach((record, index) => {
    const amount = Number(record.importePendientePesos) || 0;
    if (amount <= 0) return;
    const provider = (record.noProveedor ? providerByJde.get(normalizeJde(record.noProveedor)) : undefined)
      ?? providerByName.get(normalize(record.nombre));
    const clasif: ClasificacionAlberto = provider?.clasificacionAlberto
      ?? (record.clasificacionProveedor as ClasificacionAlberto | undefined)
      ?? 'SIN_CLASIFICAR';
    if (!VISIBLE_CLASIF.includes(clasif)) return;
    const dateInfo = effectiveCxpDate(record, asOfDate);
    if (dateInfo.date > endDate) return;
    const providerName = provider?.name ?? record.nombre ?? 'Proveedor sin nombre';
    const providerId = provider?.id ?? record.noProveedor;
    const providerType = provider?.type?.trim() || record.clasifica || 'Sin categoría';
    const categoryLabel = CLASIFICACION_LABELS[clasif];
    const score = provider?.score != null && Number.isFinite(provider.score)
      ? Math.max(0, Math.min(100, Math.round(provider.score)))
      : clasif === 'CRITICO'
        ? 92
        : clasif === 'FLEX_ALTO'
          ? 85
          : clasif === 'FLEX_MEDIO'
            ? 75
            : 65;

    movements.push({
      id: `cxp-invoice:${record.cia}:${record.noProveedor || providerId || 'sin-proveedor'}:${record.noFactura || index}:${index}`,
      sourceSystem: 'JDE',
      sourceObjectId: record.noFactura || undefined,
      companyId: record.cia,
      type: 'OUTFLOW',
      category: 'AP_PAYMENT',
      subcategory: clasif,
      providerCategory: providerType,
      counterpartyId: providerId,
      counterpartyName: providerName,
      counterpartyType: 'SUPPLIER',
      concept: `Factura ${record.noFactura || 'sin folio'} · ${categoryLabel} · ${providerType}`,
      currency: 'MXN',
      originalAmount: amount,
      baseAmount: amount,
      projectedAmount: amount,
      issueDate: cleanDate(record.fechaFactura),
      dueDate: cleanDate(record.fechaVence),
      projectedDate: dateInfo.date,
      confidenceScore: score,
      confidenceBand: clasif === 'CRITICO' || score >= 80 ? 'HIGH' : 'MEDIUM',
      forecastMethod: 'RULE',
      ruleApplied: `CXP JDE · ${categoryLabel} · score ${score}`,
      taxTreatment: Number(record.importeImpuestosPesos) > 0 ? 'IVA_CREDITABLE' : 'UNCLASSIFIED',
      taxRate: Number(record.importeImpuestosPesos) > 0 ? 16 : undefined,
      status: 'PROJECTED_BASE',
      lockState: clasif === 'CRITICO' ? 'LOCKED' : 'RESTRICTED',
      comments: [
        dateInfo.moved
          ? `Fecha CXP original ${dateInfo.originalDate}; se trae a ${dateInfo.date} por estar vencida.`
          : `Fecha CXP ${dateInfo.date}.`,
      ],
      createdAt,
      updatedAt: createdAt,
    });
  });

  return movements.sort((a, b) => {
    const clasifDelta = VISIBLE_CLASIF.indexOf(a.subcategory as ClasificacionAlberto)
      - VISIBLE_CLASIF.indexOf(b.subcategory as ClasificacionAlberto);
    if (clasifDelta !== 0) return clasifDelta;
    if (b.confidenceScore !== a.confidenceScore) return b.confidenceScore - a.confidenceScore;
    if (a.projectedDate !== b.projectedDate) return a.projectedDate.localeCompare(b.projectedDate);
    return (a.counterpartyName ?? '').localeCompare(b.counterpartyName ?? '', 'es-MX');
  });
}
