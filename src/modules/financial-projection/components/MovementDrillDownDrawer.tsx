import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { FileText, X } from 'lucide-react';
import { fmtCurrency, fmtDate, fmtPctInt } from '../../../formatters';
import {
  effectiveAmount,
  effectiveMovementDate,
} from '../../shared-finance/calculation-engine/financialProjectionEngine';
import { ConfidenceBadge, StatusBadge } from '../../shared-finance/components/FinanceBadges';
import type { FinancialMovement } from '../../shared-finance/types';
import type { CXPRecord } from '../../../domain/persistence';
import type {
  Budget,
} from '../../../domain/budget';
import type {
  CashFlowAssumptions,
  Client,
  CollectionEvent,
} from '../../../domain/types';
import type { CobranzaRecord } from '../../../services/jdeTypes';
import { projectClientMonth } from '../../../domain/collectionEngine';
import {
  bankAccountBusinessUnitLabel,
  bankAccountFlowLabel,
  bankAccountRoleLabel,
  findBankAccount,
} from '../../../domain/bankAccountsCatalog';

const POPOVER_WIDTH = 480;
const POPOVER_MARGIN = 8;
const POPOVER_EST_HEIGHT = 620;

/**
 * Contexto completo para reconstruir las facturas/eventos detrás de un
 * `FinancialMovement`. Cuando se pasa, el drawer agrega una sección
 * "Facturas / documentos" con detalle al nivel más bajo disponible:
 *
 *   - AP_PAYMENT  → registro CXP (factura JDE) por `noFactura`.
 *   - AR_COLLECTION → eventos de cobranza derivados del catálogo del
 *     cliente para el mes proyectado (synthetic invoices).
 *   - PAYROLL/TAX/OPEX/CAPEX/DEBT → detalle operativo o legado cuando aplica.
 *
 * Si no se pasa contexto, el drawer cae al modo "trazabilidad" anterior.
 */
export interface InvoiceContext {
  cxpRecords: CXPRecord[];
  cobranzaRecords?: CobranzaRecord[];
  clients: Client[];
  assumptions: CashFlowAssumptions;
  budget: Budget | null;
}

/**
 * Detalle del movimiento como popover anclado al row clickeado. La
 * posición se calcula síncronamente para que el popover aparezca de
 * inmediato (antes había una ventana donde la pos se calculaba en
 * useLayoutEffect y el popover quedaba a (0, 0) sin ser visible).
 */
export function MovementDrillDownDrawer({
  movement,
  anchor,
  onClose,
  invoiceContext,
  quickActions,
}: {
  movement: FinancialMovement | null;
  anchor: DOMRect | null;
  onClose: () => void;
  invoiceContext?: InvoiceContext;
  quickActions?: ReactNode;
}) {
  const popoverRef = useRef<HTMLDivElement>(null);

  // Cierre con Escape.
  useEffect(() => {
    if (!movement) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [movement, onClose]);

  // Cierre con click afuera, ignorando el click que abrió el popover.
  useEffect(() => {
    if (!movement) return;
    let mounted = false;
    const t = setTimeout(() => { mounted = true; }, 0);
    const onMouse = (event: MouseEvent) => {
      if (!mounted) return;
      if (!popoverRef.current) return;
      if (popoverRef.current.contains(event.target as Node)) return;
      onClose();
    };
    document.addEventListener('mousedown', onMouse);
    return () => {
      clearTimeout(t);
      document.removeEventListener('mousedown', onMouse);
    };
  }, [movement, onClose]);

  const pos = useMemo(() => {
    if (!anchor) return null;
    return computePosition(anchor);
  }, [anchor]);

  if (!movement || !anchor || !pos) return null;
  const bankAccount = movement.bankAccountId ? findBankAccount(movement.bankAccountId) : null;

  const rows: [string, string][] = [
    ['Fuente', `${movement.sourceSystem}${movement.sourceObjectId ? ` · ${movement.sourceObjectId}` : ''}`],
    ['Fecha emisión', movement.issueDate ?? '—'],
    ['Fecha vencimiento', movement.dueDate ?? '—'],
    ['Fecha proyectada', movement.projectedDate],
    ['Fecha ajustada', movement.adjustedDate ?? '—'],
    ['Fecha efectiva', effectiveMovementDate(movement)],
    ['Monto base (catálogo)', fmtCurrency(movement.baseAmount)],
    ['Monto proyectado', fmtCurrency(movement.projectedAmount)],
    ['Monto efectivo', fmtCurrency(effectiveAmount(movement))],
    ['Regla aplicada', movement.ruleApplied ?? '—'],
    ['Método', movement.forecastMethod],
    ['Bloqueo', humanLockState(movement.lockState)],
  ];

  return (
    <div
      ref={popoverRef}
      className="fixed z-[80] rounded-[var(--radius-lg)] border border-[var(--gray-200)] bg-white shadow-xl"
      style={{
        top: pos.top,
        left: pos.left,
        width: POPOVER_WIDTH,
        maxHeight: 'calc(100vh - 32px)',
        overflowY: 'auto',
      }}
      role="dialog"
      aria-label={`Detalle de ${movement.concept}`}
    >
      <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-[var(--gray-200)] bg-white px-4 py-3">
        <div className="min-w-0">
          <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--gray-400)]">
            Detalle del movimiento
          </div>
          <h2 className="mt-1 truncate text-[15px] font-bold text-[var(--gray-950)]">
            {movement.concept}
          </h2>
          <p className="mt-0.5 text-[11px] text-[var(--gray-500)]">
            {movement.counterpartyName ?? 'Sin contraparte'} · {movement.category}
          </p>
        </div>
        <button
          onClick={onClose}
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius-md)] border border-[var(--gray-200)] bg-white text-[var(--gray-500)] hover:bg-[var(--gray-50)]"
          aria-label="Cerrar detalle"
        >
          <X className="h-4 w-4" strokeWidth={1.5} />
        </button>
      </div>

      <div className="space-y-3 p-4">
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-[var(--radius-md)] border border-[var(--gray-200)] bg-[var(--gray-50)] p-2.5">
            <div className="text-[10px] uppercase tracking-[0.08em] text-[var(--gray-400)]">Estado</div>
            <div className="mt-1.5"><StatusBadge status={movement.status} /></div>
          </div>
          <div className="rounded-[var(--radius-md)] border border-[var(--gray-200)] bg-[var(--gray-50)] p-2.5">
            <div className="text-[10px] uppercase tracking-[0.08em] text-[var(--gray-400)]">Confianza</div>
            <div className="mt-1.5">
              <ConfidenceBadge band={movement.confidenceBand} score={movement.confidenceScore} />
            </div>
          </div>
        </div>

        {/* Sección nueva: detalle al nivel de factura. Sólo cuando el
            caller pasa el contexto operativo. */}
        {invoiceContext && (
          <InvoiceDetailSection movement={movement} context={invoiceContext} />
        )}

        {movement.sourceSystem === 'BANK' && (
          <DetailBlock
            title="Transferencia bancaria"
            items={[
              ['Empresa', movement.companyId ?? '—'],
              ['Cuenta de banco', movement.bankAccountId ?? '—'],
              ['No. transferencia / referencia', movement.sourceObjectId ?? '—'],
              ['Concepto bancario', movement.concept || '—'],
              ['Fecha operación', fmtSafeDate(movement.actualDate ?? movement.projectedDate)],
              ['Importe', fmtCurrency(effectiveAmount(movement))],
              ['Tipo', movement.type === 'INFLOW' ? 'Abono (entrada)' : 'Cargo (salida)'],
            ]}
          />
        )}

        {(movement.sourceSystem === 'BANK' || bankAccount) && (
          <DetailBlock
            title="Clasificación bancaria"
            items={[
              ['Unidad', bankAccount ? bankAccountBusinessUnitLabel(bankAccount.unidadNegocio) : movement.businessUnitId ?? '—'],
              ['Banco', bankAccount?.banco ?? '—'],
              ['Cuenta', bankAccount?.cuenta ?? movement.bankAccountId ?? '—'],
              ['Razón social', bankAccount?.razonSocial ?? '—'],
              ['Concepto cuenta', bankAccount?.concepto ?? movement.subcategory ?? '—'],
              ['Rol', bankAccount ? bankAccountRoleLabel(bankAccount.role) : '—'],
              ['Flujo', bankAccount ? bankAccountFlowLabel(bankAccount.flow) : '—'],
              ['Contraparte', movement.counterpartyName ?? '—'],
            ]}
          />
        )}

        {quickActions && (
          <div className="rounded-[var(--radius-md)] border border-[var(--gray-200)] p-3">
            <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--gray-400)]">
              Ajustes rápidos
            </div>
            {quickActions}
          </div>
        )}

        <div className="rounded-[var(--radius-md)] border border-[var(--gray-200)]">
          <div className="border-b border-[var(--gray-200)] bg-[var(--gray-50)] px-3 py-2 text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--gray-400)]">
            Trazabilidad
          </div>
          <div className="divide-y divide-[var(--gray-100)]">
            {rows.map(([label, value]) => (
              <div key={label} className="grid grid-cols-[140px_1fr] gap-3 px-3 py-2 text-[11px]">
                <div className="text-[var(--gray-400)]">{label}</div>
                <div className="min-w-0 break-words font-medium tabular-nums text-[var(--gray-950)]">
                  {value}
                </div>
              </div>
            ))}
          </div>
        </div>

        {!invoiceContext && movement.category === 'AR_COLLECTION' && (
          <DetailBlock
            title="Cobranza / factura"
            items={[
              ['Cliente', movement.counterpartyName ?? '—'],
              ['Confianza', `${fmtPctInt(movement.confidenceScore)}`],
              ['Responsable', 'Cobranza'],
            ]}
          />
        )}
        {!invoiceContext && movement.category === 'AP_PAYMENT' && (
          <DetailBlock
            title="Proveedor / pago"
            items={[
              ['Proveedor', movement.counterpartyName ?? '—'],
              ['Prioridad', movement.lockState === 'LOCKED' ? 'Crítico' : 'Planificable'],
              ['Flexibilidad', movement.ruleApplied ?? 'Sin clasificación'],
            ]}
          />
        )}
        {!invoiceContext && movement.category === 'TAX' && (
          <DetailBlock
            title="Impuesto"
            items={[
              ['Tipo', movement.concept],
              ['Riesgo', movement.lockState === 'LOCKED' ? 'Legal / crítico' : 'Validar fiscal'],
            ]}
          />
        )}

        {movement.comments && movement.comments.length > 0 && (
          <div className="rounded-[var(--radius-md)] border border-[var(--gray-200)] p-3">
            <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--gray-400)]">
              Comentarios
            </div>
            <div className="mt-1.5 space-y-1.5">
              {movement.comments.map((comment, index) => (
                <p key={`${comment}-${index}`} className="text-[11px] text-[var(--gray-600)]">
                  {comment}
                </p>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────
 * Sección de detalle a nivel factura.
 * ──────────────────────────────────────────────────────────────── */

function InvoiceDetailSection({
  movement,
  context,
}: {
  movement: FinancialMovement;
  context: InvoiceContext;
}) {
  if (movement.category === 'AP_PAYMENT') {
    const records = findCxpRecords(context.cxpRecords, movement);
    if (records.length === 0) {
      return (
        <SourceMissingNote
          title="Factura del proveedor"
          message="No se encontró el registro CXP correspondiente. Pudo cancelarse o pertenecer a otra empresa."
        />
      );
    }
    return (
      <SectionCard title={records.length === 1 ? 'Factura del proveedor' : `Facturas relacionadas (${records.length})`}>
        <div className="divide-y divide-[var(--gray-100)]">
          {records.map((record, idx) => (
            <CxpRecordRow key={`${record.cia}-${record.noFactura}-${idx}`} record={record} />
          ))}
        </div>
      </SectionCard>
    );
  }

  if (movement.category === 'AR_COLLECTION') {
    const cxcRecords = findCobranzaRecords(context.cobranzaRecords ?? [], movement);
    if (cxcRecords.length > 0) {
      return (
        <SectionCard title={cxcRecords.length === 1 ? 'Factura CXC JDE' : `Facturas CXC JDE (${cxcRecords.length})`}>
          <div className="divide-y divide-[var(--gray-100)]">
            {cxcRecords.map((record, idx) => (
              <CobranzaRecordRow key={`${record.cia}-${record.noFactura}-${idx}`} record={record} />
            ))}
          </div>
        </SectionCard>
      );
    }

    const events = computeRelatedCollectionEvents(context, movement);
    if (events.length === 0) {
      return (
        <SourceMissingNote
          title="Cobranza del cliente"
          message="No se pudo derivar el evento de cobranza desde el catálogo. Revisa la configuración del cliente."
        />
      );
    }
    return (
      <SectionCard title={events.length === 1 ? 'Cobranza proyectada' : `Cobranzas del mes (${events.length})`}>
        <p className="px-3 pt-2 pb-1 text-[11px] text-[var(--gray-500)]">
          Eventos derivados del catálogo del cliente. La factura real se emite contra estos parámetros (frecuencia, días de crédito, patrón de pago).
        </p>
        <div className="divide-y divide-[var(--gray-100)]">
          {events.map((event, idx) => (
            <CollectionEventRow
              key={`${event.clientId}-${event.realDate}-${idx}`}
              event={event}
              highlight={event.realDate === movement.projectedDate}
            />
          ))}
        </div>
      </SectionCard>
    );
  }

  if (
    movement.category === 'PAYROLL'
    || movement.category === 'TAX'
    || movement.category === 'OPEX'
    || movement.category === 'CAPEX'
    || movement.category === 'DEBT'
  ) {
    const breakdown = findBudgetBreakdown(context.budget, movement);
    if (!breakdown) {
      return (
        <SourceMissingNote
          title="Detalle operativo no disponible"
          message="No se encontró una factura, documento o fuente operativa coincidente."
        />
      );
    }
    return (
      <SectionCard title="Detalle de plantilla legacy">
        <div className="px-3 py-2.5 space-y-1.5">
          <Row label="Concepto" value={breakdown.concept} />
          <Row label="Mes" value={breakdown.monthLabel} />
          <Row label="Importe del mes" value={fmtCurrency(breakdown.monthAmount)} accent />
          <Row label="Importe anual" value={fmtCurrency(breakdown.annualAmount)} />
          <Row label="Origen" value="Plantilla legacy" />
        </div>
      </SectionCard>
    );
  }

  return null;
}

function CobranzaRecordRow({ record }: { record: CobranzaRecord }) {
  const overdue = (record.diasVencida ?? 0) > 0;
  return (
    <div className="px-3 py-2.5 space-y-1.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[12px] font-bold text-[var(--gray-950)]">
            <FileText className="h-3.5 w-3.5 text-[var(--gray-500)]" strokeWidth={1.75} />
            <span className="truncate">Factura {record.noFactura || 'sin folio'}</span>
          </div>
          <div className="text-[11px] text-[var(--gray-500)]">{record.nombreCliente || 'Cliente sin nombre'}</div>
        </div>
        <div className="text-right">
          <div className="text-[13px] font-bold tabular-nums text-[var(--gray-950)]">
            {fmtCurrency(record.importePendientePesos)}
          </div>
          <div className="text-[10px] text-[var(--gray-400)]">
            Pendiente · {record.moneda || 'MXN'}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-x-3 gap-y-1 pt-1 text-[11px]">
        <Row label="Cliente" value={record.noCliente || '—'} compact />
        <Row label="Empresa" value={record.cia || '—'} compact />
        <Row label="Emisión" value={fmtSafeDate(record.fechaFactura)} compact />
        <Row label="Vencimiento" value={fmtSafeDate(record.fechaVence)} compact />
        <Row label="Cobro JDE" value={fmtSafeDate(record.fechaCobro)} compact />
        <Row
          label="Días vencida"
          value={String(record.diasVencida ?? 0)}
          compact
          accentColor={overdue ? 'var(--danger)' : undefined}
        />
        <Row label="Cond. pago" value={record.condPago || '—'} compact />
        <Row label="Estatus" value={record.estatus || '—'} compact />
        <Row label="Importe bruto" value={fmtCurrency(record.importeBrutoPesos)} compact />
        <Row label="Saldo pendiente" value={fmtCurrency(record.importePendientePesos)} compact accent />
      </div>
    </div>
  );
}

function CxpRecordRow({ record }: { record: CXPRecord }) {
  const overdue = (record.diasVencida ?? 0) > 0;
  return (
    <div className="px-3 py-2.5 space-y-1.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[12px] font-bold text-[var(--gray-950)]">
            <FileText className="h-3.5 w-3.5 text-[var(--gray-500)]" strokeWidth={1.75} />
            <span className="truncate">Factura {record.noFactura || 'sin folio'}</span>
          </div>
          <div className="text-[11px] text-[var(--gray-500)]">{record.nombre}</div>
        </div>
        <div className="text-right">
          <div className="text-[13px] font-bold tabular-nums text-[var(--gray-950)]">
            {fmtCurrency(record.importePendientePesos)}
          </div>
          <div className="text-[10px] text-[var(--gray-400)]">
            {record.moneda || 'MXN'}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-x-3 gap-y-1 pt-1 text-[11px]">
        <Row label="Emisión" value={fmtSafeDate(record.fechaFactura)} compact />
        <Row label="Vencimiento" value={fmtSafeDate(record.fechaVence)} compact />
        <Row label="Programada" value={fmtSafeDate(record.fechaProgramacionPago)} compact />
        <Row
          label="Días vencida"
          value={String(record.diasVencida ?? 0)}
          compact
          accentColor={overdue ? 'var(--danger)' : undefined}
        />
        <Row label="Cond. pago" value={record.condPago || '—'} compact />
        <Row label="Estatus" value={record.edoPago || '—'} compact />
        <Row label="Empresa" value={record.cia} compact />
        <Row label="Importe bruto" value={fmtCurrency(record.importeBrutoPesos)} compact />
      </div>

      {hasAgingBuckets(record) && (
        <div className="pt-1.5">
          <div className="text-[10px] uppercase tracking-[0.08em] text-[var(--gray-400)]">Antigüedad</div>
          <div className="mt-1 grid grid-cols-7 gap-1">
            <AgingPill label="Por vencer" value={record.porVencer} tone="ok" />
            <AgingPill label="1-30" value={record.v1_30} tone="warn" />
            <AgingPill label="31-60" value={record.v31_60} tone="warn" />
            <AgingPill label="61-90" value={record.v61_90} tone="bad" />
            <AgingPill label="91-120" value={record.v91_120} tone="bad" />
            <AgingPill label="121-180" value={record.v121_150 + record.v151_180} tone="bad" />
            <AgingPill label="180+" value={record.mas180} tone="bad" />
          </div>
        </div>
      )}
    </div>
  );
}

function CollectionEventRow({
  event,
  highlight,
}: {
  event: CollectionEvent;
  highlight: boolean;
}) {
  return (
    <div
      className="px-3 py-2.5"
      style={highlight ? { background: 'var(--primary-muted, var(--gray-50))' } : undefined}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[12px] font-bold text-[var(--gray-950)]">
            <FileText className="h-3.5 w-3.5 text-[var(--gray-500)]" strokeWidth={1.75} />
            <span>Cobro proyectado</span>
            {highlight && (
              <span className="inline-flex h-4 items-center rounded-full bg-[var(--primary,var(--gray-700))] px-1.5 text-[9px] font-medium uppercase tracking-[0.08em] text-white">
                Este movimiento
              </span>
            )}
          </div>
        </div>
        <div className="text-[13px] font-bold tabular-nums text-[var(--gray-950)]">
          {fmtCurrency(event.amount)}
        </div>
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1 pt-1 text-[11px]">
        <Row label="Emisión factura" value={fmtSafeDate(event.invoiceDate)} compact />
        <Row label="Fecha teórica" value={fmtSafeDate(event.theoreticalDate)} compact />
        <Row label="Fecha proyectada" value={fmtSafeDate(event.realDate)} compact />
        <Row
          label="Lag"
          value={`${event.lagDays} día${event.lagDays === 1 ? '' : 's'}`}
          compact
          accentColor={event.lagDays > 14 ? 'var(--warning)' : undefined}
        />
      </div>
    </div>
  );
}

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--gray-200)]">
      <div className="border-b border-[var(--gray-200)] bg-[var(--gray-50)] px-3 py-2 text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--gray-400)]">
        {title}
      </div>
      {children}
    </div>
  );
}

function SourceMissingNote({ title, message }: { title: string; message: string }) {
  return (
    <SectionCard title={title}>
      <p className="px-3 py-2.5 text-[11px] text-[var(--gray-500)]">{message}</p>
    </SectionCard>
  );
}

function Row({
  label,
  value,
  accent,
  accentColor,
  compact,
}: {
  label: string;
  value: string;
  accent?: boolean;
  accentColor?: string;
  compact?: boolean;
}) {
  return (
    <div className={compact ? 'flex items-baseline justify-between gap-2' : 'grid grid-cols-[120px_1fr] gap-2'}>
      <span className="text-[var(--gray-400)]">{label}</span>
      <span
        className="font-medium tabular-nums text-right"
        style={{
          color: accentColor ?? (accent ? 'var(--gray-950)' : 'var(--gray-700)'),
        }}
      >
        {value}
      </span>
    </div>
  );
}

function AgingPill({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'ok' | 'warn' | 'bad';
}) {
  const palette = {
    ok: { bg: 'var(--success-muted)', fg: 'var(--success)' },
    warn: { bg: 'var(--warning-muted)', fg: 'var(--warning)' },
    bad: { bg: 'var(--danger-muted)', fg: 'var(--danger)' },
  }[tone];
  const empty = !value || value === 0;
  return (
    <div
      className="rounded-md px-1.5 py-1 text-center"
      style={{
        background: empty ? 'var(--gray-50)' : palette.bg,
        color: empty ? 'var(--gray-400)' : palette.fg,
      }}
    >
      <div className="text-[9px] uppercase tracking-[0.08em] opacity-80">{label}</div>
      <div className="text-[10px] font-bold tabular-nums">
        {empty ? '—' : compactCurrency(value)}
      </div>
    </div>
  );
}

function compactCurrency(value: number): string {
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(0)}K`;
  return value.toFixed(0);
}

function hasAgingBuckets(record: CXPRecord): boolean {
  return [
    record.porVencer,
    record.v1_30,
    record.v31_60,
    record.v61_90,
    record.v91_120,
    record.v121_150,
    record.v151_180,
    record.mas180,
  ].some((v) => v && v !== 0);
}

function findCxpRecords(records: CXPRecord[], movement: FinancialMovement): CXPRecord[] {
  if (!movement.sourceObjectId) return [];
  const exact = records.filter(
    (record) =>
      record.noFactura === movement.sourceObjectId
      && (!movement.companyId || record.cia === movement.companyId),
  );
  if (exact.length > 0) return exact;
  // Fallback: si la empresa no coincidió, devolvemos cualquier match por folio.
  return records.filter((record) => record.noFactura === movement.sourceObjectId);
}

function findCobranzaRecords(records: CobranzaRecord[], movement: FinancialMovement): CobranzaRecord[] {
  if (!movement.sourceObjectId) return [];
  const exact = records.filter(
    (record) =>
      record.noFactura === movement.sourceObjectId
      && (!movement.companyId || record.cia === movement.companyId),
  );
  if (exact.length > 0) return exact;
  return records.filter((record) => record.noFactura === movement.sourceObjectId);
}

function computeRelatedCollectionEvents(
  context: InvoiceContext,
  movement: FinancialMovement,
): CollectionEvent[] {
  const clientId = movement.counterpartyId ?? movement.sourceObjectId;
  if (!clientId) return [];
  const client = context.clients.find((c) => c.id === clientId);
  if (!client) return [];
  const targetYm = (movement.actualDate ?? movement.adjustedDate ?? movement.projectedDate).slice(0, 7);
  const [yearStr, monthStr] = targetYm.split('-');
  const year = Number(yearStr);
  const monthIdx = Number(monthStr) - 1;
  if (!year || Number.isNaN(monthIdx)) return [];

  // Escaneamos el mes objetivo y los 2 anteriores (créditos cortos).
  const scans: Array<{ year: number; monthIdx: number }> = [
    { year, monthIdx: monthIdx - 2 },
    { year, monthIdx: monthIdx - 1 },
    { year, monthIdx },
  ].map((s) => {
    if (s.monthIdx < 0) return { year: s.year - 1, monthIdx: s.monthIdx + 12 };
    if (s.monthIdx > 11) return { year: s.year + 1, monthIdx: s.monthIdx - 12 };
    return s;
  });

  const events: CollectionEvent[] = [];
  for (const scan of scans) {
    const generated = projectClientMonth(client, scan.year, scan.monthIdx, {
      ...context.assumptions,
      year: scan.year,
    });
    for (const event of generated) {
      if (event.realDate.slice(0, 7) === targetYm && event.amount > 0) {
        events.push(event);
      }
    }
  }
  events.sort((a, b) => a.realDate.localeCompare(b.realDate));
  return events;
}

interface BudgetBreakdown {
  concept: string;
  monthLabel: string;
  monthAmount: number;
  annualAmount: number;
}

function findBudgetBreakdown(budget: Budget | null, movement: FinancialMovement): BudgetBreakdown | null {
  if (!budget) return null;
  const date = movement.actualDate ?? movement.adjustedDate ?? movement.projectedDate;
  const [yStr, mStr] = date.split('-');
  const year = Number(yStr);
  const monthIdx = Number(mStr) - 1;
  if (Number.isNaN(monthIdx)) return null;

  const haystack = (movement.concept ?? '').toLowerCase();
  const concepts = budget.expenseByConcept ?? [];
  const found = concepts.find((c) => haystack.includes((c.concept ?? '').toLowerCase()))
    ?? concepts.find((c) => (c.concept ?? '').toLowerCase().includes(movement.category.toLowerCase()));
  if (!found) return null;

  const monthAmount = found.monthly?.[monthIdx] ?? 0;
  const annualAmount = (found.monthly ?? []).reduce((sum, v) => sum + (v ?? 0), 0);
  const monthName = MONTH_NAMES[monthIdx] ?? `Mes ${monthIdx + 1}`;
  return {
    concept: found.concept,
    monthLabel: `${monthName} ${year}`,
    monthAmount,
    annualAmount,
  };
}

const MONTH_NAMES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
];

function fmtSafeDate(value: string | undefined | null): string {
  if (!value) return '—';
  if (value.length < 10) return value;
  try {
    return fmtDate(value);
  } catch {
    return value;
  }
}

function computePosition(anchor: DOMRect): { top: number; left: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = anchor.right - POPOVER_WIDTH;
  if (left < POPOVER_MARGIN) left = POPOVER_MARGIN;
  if (left + POPOVER_WIDTH + POPOVER_MARGIN > vw) left = vw - POPOVER_WIDTH - POPOVER_MARGIN;

  // Intentar debajo del anchor
  let top = anchor.bottom + POPOVER_MARGIN;
  if (top + POPOVER_EST_HEIGHT + POPOVER_MARGIN > vh) {
    // Intentar arriba del anchor
    const above = anchor.top - POPOVER_EST_HEIGHT - POPOVER_MARGIN;
    if (above >= POPOVER_MARGIN) {
      top = above;
    } else {
      // No cabe ni arriba ni abajo: centrar respecto al anchor,
      // manteniéndolo dentro del viewport.
      top = Math.max(
        POPOVER_MARGIN,
        Math.min(
          anchor.top + anchor.height / 2 - POPOVER_EST_HEIGHT / 2,
          vh - POPOVER_EST_HEIGHT - POPOVER_MARGIN,
        ),
      );
    }
  }
  return { top, left };
}

function DetailBlock({ title, items }: { title: string; items: [string, string][] }) {
  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--gray-200)] p-3">
      <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--gray-400)]">{title}</div>
      <div className="mt-2 grid gap-1.5">
        {items.map(([label, value]) => (
          <div key={label} className="flex items-start justify-between gap-3 text-[11px]">
            <span className="text-[var(--gray-400)]">{label}</span>
            <span className="max-w-[280px] text-right font-medium text-[var(--gray-950)]">{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function humanLockState(state: string): string {
  switch (state) {
    case 'UNLOCKED': return 'Sin restricción';
    case 'RESTRICTED': return 'Restringido';
    case 'LOCKED': return 'Bloqueado';
    default: return state;
  }
}
