import { AlertTriangle } from 'lucide-react';
import { fmtCompact, fmtCurrency, fmtDate } from '../../../formatters';
import type {
  DailyOperatingFlowRow,
  SupplierPaymentDecision,
  SupplierPaymentPlan,
} from '../services/supplierPaymentSchedule';

export function SupplierPaymentDecisionTable({
  plan,
  comparisonPlan,
  scenarioName,
  comparisonName,
}: {
  plan: SupplierPaymentPlan;
  comparisonPlan?: SupplierPaymentPlan | null;
  scenarioName: string;
  comparisonName?: string;
}) {
  const comparisonByMovement = new Map((comparisonPlan?.decisions ?? []).map((decision) => [decision.movementId, decision]));
  const decisions = plan.decisions.slice(0, 160);
  const paid = plan.decisions.filter((decision) => decision.status === 'PAID').length;
  const deferred = plan.decisions.filter((decision) => decision.status === 'DEFERRED').length;
  const partial = plan.decisions.filter((decision) => decision.status === 'PARTIAL').length;
  const pending = plan.decisions.filter((decision) => decision.status === 'PENDING').length;

  return (
    <section className="rounded-2xl border border-[var(--gray-200)] bg-white">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--gray-200)] px-4 py-3">
        <div>
          <h3 className="text-[13px] font-semibold text-[var(--gray-950)]">Decisión de pagos priorizados</h3>
          <p className="mt-1 text-[11px] text-[var(--gray-500)]">
            {scenarioName} · {paid} pagados · {deferred} recorridos · {partial} parciales · {pending} pendientes
          </p>
        </div>
        {comparisonName && (
          <span className="rounded-lg border border-[var(--gray-200)] px-2 py-1 text-[11px] font-medium text-[var(--gray-500)]">
            Comparando vs {comparisonName}
          </span>
        )}
      </header>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1120px] text-left text-[12px]">
          <thead className="bg-[var(--gray-50)] text-[10px] uppercase tracking-wider text-[var(--gray-400)]">
            <tr>
              <th className="px-3 py-2.5">Proveedor</th>
              <th className="px-3 py-2.5">Factura</th>
              <th className="px-3 py-2.5 text-right">Score</th>
              <th className="px-3 py-2.5">Estado</th>
              <th className="px-3 py-2.5">Límite original</th>
              <th className="px-3 py-2.5">Pago estimado</th>
              <th className="px-3 py-2.5 text-right">Pagado</th>
              <th className="px-3 py-2.5 text-right">Pendiente</th>
              <th className="px-3 py-2.5">Cambio vs escenario</th>
            </tr>
          </thead>
          <tbody>
            {decisions.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-4 py-10 text-center text-[12px] text-[var(--gray-400)]">
                  <div className="font-medium text-[var(--gray-600)]">Sin CXP de proveedores para decidir en este escenario.</div>
                  <div className="mt-1 text-[11px]">
                    {paymentDiagnosticText(plan)}
                  </div>
                </td>
              </tr>
            ) : decisions.map((decision) => {
              const comparison = comparisonByMovement.get(decision.movementId);
              const changed = comparison && (
                comparison.status !== decision.status
                || comparison.estimatedDate !== decision.estimatedDate
                || comparison.pendingAmount !== decision.pendingAmount
              );
              return (
                <tr key={`${decision.movementId}:${decision.status}`} className="border-t border-[var(--gray-100)] align-top hover:bg-[var(--gray-50)]/50">
                  <td className="px-3 py-3">
                    <div className="font-medium text-[var(--gray-950)]">{decision.providerName}</div>
                    <div className="text-[10.5px] text-[var(--gray-400)]">{decision.scenarioId}</div>
                  </td>
                  <td className="px-3 py-3 text-[var(--gray-700)]">{decision.invoiceId ?? '—'}</td>
                  <td className="px-3 py-3 text-right tabular-nums font-semibold text-[var(--gray-950)]">{decision.score}</td>
                  <td className="px-3 py-3"><DecisionBadge status={decision.status} /></td>
                  <td className="px-3 py-3 text-[var(--gray-700)]">{formatDate(decision.dueDate ?? decision.originalDate)}</td>
                  <td className="px-3 py-3 text-[var(--gray-700)]">
                    {decision.estimatedDate ? formatDate(decision.estimatedDate) : 'Fuera de horizonte'}
                    {decision.daysDeferred > 0 && (
                      <div className="text-[10.5px] text-[var(--warning)]">+{decision.daysDeferred} días</div>
                    )}
                    {decision.installments.length > 1 && (
                      <div className="text-[10.5px] text-[var(--gray-400)]">{decision.installments.length} parcialidades</div>
                    )}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums font-medium text-[var(--gray-950)]">{fmtCurrency(decision.paidAmount)}</td>
                  <td className="px-3 py-3 text-right tabular-nums font-medium" style={{ color: decision.pendingAmount > 0 ? 'var(--danger)' : 'var(--gray-500)' }}>
                    {fmtCurrency(decision.pendingAmount)}
                  </td>
                  <td className="px-3 py-3 text-[var(--gray-600)]">
                    {changed && comparison ? (
                      <div>
                        {statusLabel(comparison.status)} {comparison.estimatedDate ?? 's/f'} → {statusLabel(decision.status)} {decision.estimatedDate ?? 's/f'}
                      </div>
                    ) : (
                      <div className="text-[var(--gray-400)]">Sin cambio vs referencia</div>
                    )}
                    <div className="mt-1 max-w-[260px] text-[10.5px] leading-snug text-[var(--gray-500)]">
                      {decisionReasonText(decision)}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function DailyOperatingFlowTable({ rows }: { rows: DailyOperatingFlowRow[] }) {
  const visibleRows = rows.filter((row) =>
    row.expectedInflows !== 0
    || row.confirmedInflows !== 0
    || row.scheduledOutflows !== 0
    || row.executedOutflows !== 0
    || row.suppliersPending > 0
    || row.deficit > 0,
  ).slice(0, 220);

  return (
    <section className="rounded-2xl border border-[var(--gray-200)] bg-white">
      <header className="border-b border-[var(--gray-200)] px-4 py-3">
        <h3 className="text-[13px] font-semibold text-[var(--gray-950)]">Flujo operativo diario</h3>
        <p className="mt-1 text-[11px] text-[var(--gray-500)]">
          Ingresos con cliente, salidas con concepto, proveedores programados y alertas de déficit por día.
        </p>
      </header>
      <div className="max-h-[520px] overflow-auto">
        <table className="w-full min-w-[1780px] text-left text-[12px]">
          <thead className="sticky top-0 z-10 bg-[var(--gray-50)] text-[10px] uppercase tracking-wider text-[var(--gray-400)]">
            <tr>
              <th className="px-3 py-2.5">Día</th>
              <th className="px-3 py-2.5 text-right">Saldo inicial</th>
              <th className="px-3 py-2.5 text-right">Ingresos esperados</th>
              <th className="px-3 py-2.5">Clientes esperados</th>
              <th className="px-3 py-2.5 text-right">Ingresos confirmados</th>
              <th className="px-3 py-2.5">Clientes confirmados</th>
              <th className="px-3 py-2.5 text-right">Pagos programados</th>
              <th className="px-3 py-2.5">Salidas / concepto</th>
              <th className="px-3 py-2.5">Prov. programados</th>
              <th className="px-3 py-2.5 text-right">Pagos ejecutados</th>
              <th className="px-3 py-2.5">Prov. pagados</th>
              <th className="px-3 py-2.5">Prov. pendientes</th>
              <th className="px-3 py-2.5 text-right">Neto</th>
              <th className="px-3 py-2.5 text-right">Saldo final</th>
              <th className="px-3 py-2.5">Alerta</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.length === 0 ? (
              <tr>
                <td colSpan={15} className="px-4 py-10 text-center text-[12px] text-[var(--gray-400)]">
                  Sin movimientos diarios relevantes.
                </td>
              </tr>
            ) : visibleRows.map((row) => (
              <tr key={row.date} className="border-t border-[var(--gray-100)] align-top hover:bg-[var(--gray-50)]/50">
                <td className="px-3 py-3 font-medium text-[var(--gray-950)]">{formatDate(row.date)}</td>
                <MoneyCell value={row.openingCash} />
                <MoneyCell value={row.expectedInflows} positive />
                <ListPreview values={row.clientNamesExpected} />
                <MoneyCell value={row.confirmedInflows} positive />
                <ListPreview values={row.clientNamesConfirmed} muted />
                <MoneyCell value={row.scheduledOutflows} negative />
                <ListPreview values={row.outflowConcepts} />
                <ListPreview values={row.supplierNamesScheduled} muted />
                <MoneyCell value={row.executedOutflows} negative />
                <td className="px-3 py-3">
                  <div className="font-medium text-[var(--gray-950)]">{row.suppliersPaid}</div>
                  <ListText values={row.supplierNamesPaid} muted />
                </td>
                <td className="px-3 py-3">
                  <div className="font-medium" style={{ color: row.suppliersPending > 0 ? 'var(--danger)' : 'var(--gray-950)' }}>{row.suppliersPending}</div>
                  <ListText values={row.supplierNamesPending} muted />
                </td>
                <MoneyCell value={row.net} signed />
                <MoneyCell value={row.closingCash} />
                <td className="px-3 py-3">
                  {row.deficit > 0 ? (
                    <span className="inline-flex items-center gap-1 rounded-lg bg-[var(--danger-muted)] px-2 py-1 text-[10.5px] font-medium text-[var(--danger)]">
                      <AlertTriangle className="h-3 w-3" strokeWidth={1.5} />
                      Déficit {fmtCompact(row.deficit)}
                    </span>
                  ) : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ListPreview({ values, muted }: { values: string[]; muted?: boolean }) {
  return (
    <td className="px-3 py-3">
      <ListText values={values} muted={muted} />
    </td>
  );
}

function paymentDiagnosticText(plan: SupplierPaymentPlan): string {
  const diagnostics = plan.diagnostics;
  if (!diagnostics || diagnostics.payableMovements === 0) {
    return 'No se encontraron facturas CXP abiertas dentro del horizonte; revisa carga JDE o filtros de compañía.';
  }
  if (diagnostics.managedPayableMovements === 0 && diagnostics.skippedResolvedPayables > 0) {
    return 'Las partidas CXP detectadas ya están reales, ejecutadas o canceladas; no requieren decisión de pago.';
  }
  if (diagnostics.missingProviderMatches > 0) {
    return `${diagnostics.missingProviderMatches} CXP no hicieron match con catálogo de proveedores; se usó score del movimiento como respaldo.`;
  }
  return 'Hay CXP detectada, pero no generó decisiones con los filtros actuales del escenario.';
}

function decisionReasonText(decision: SupplierPaymentDecision): string {
  const priority = `Prioridad ${decision.score}/100`;
  if (decision.status === 'PENDING') {
    return `${priority}. ${decision.reason}`;
  }
  if (decision.status === 'PARTIAL') {
    const paid = fmtCompact(decision.paidAmount);
    const pending = fmtCompact(decision.pendingAmount);
    return `${priority}. ${decision.reason} Pagado ${paid}; pendiente ${pending}.`;
  }
  if (decision.status === 'DEFERRED') {
    return `${priority}. ${decision.reason} Se conserva caja mínima antes de liquidar.`;
  }
  return `${priority}. ${decision.reason}`;
}

function ListText({ values, muted }: { values: string[]; muted?: boolean }) {
  const label = values.join(', ');
  const color = muted ? 'text-[var(--gray-400)]' : 'text-[var(--gray-600)]';
  return (
    <div className={`max-w-[240px] truncate text-[10.5px] ${color}`} title={label}>
      {label || '—'}
    </div>
  );
}

function MoneyCell({ value, positive, negative, signed }: { value: number; positive?: boolean; negative?: boolean; signed?: boolean }) {
  const color = positive && value > 0
    ? 'var(--success)'
    : negative && value > 0
      ? 'var(--danger)'
      : signed && value < 0
        ? 'var(--danger)'
        : signed && value > 0
          ? 'var(--success)'
          : 'var(--gray-950)';
  const prefix = signed && value > 0 ? '+' : signed && value < 0 ? '-' : '';
  return (
    <td className="px-3 py-3 text-right tabular-nums font-medium" style={{ color }}>
      {value === 0 ? '—' : `${prefix}${fmtCompact(Math.abs(value))}`}
    </td>
  );
}

function DecisionBadge({ status }: { status: SupplierPaymentDecision['status'] }) {
  const style = status === 'PAID'
    ? { background: 'var(--success-muted)', color: 'var(--success)' }
    : status === 'DEFERRED'
      ? { background: 'var(--warning-muted)', color: 'var(--warning)' }
      : status === 'PARTIAL'
        ? { background: 'var(--primary-muted, var(--gray-100))', color: 'var(--primary, var(--gray-700))' }
      : { background: 'var(--danger-muted)', color: 'var(--danger)' };
  return (
    <span className="inline-flex h-5 items-center rounded-full px-2 text-[10px] font-medium" style={style}>
      {statusLabel(status)}
    </span>
  );
}

function statusLabel(status: SupplierPaymentDecision['status']): string {
  if (status === 'PAID') return 'Pagado';
  if (status === 'DEFERRED') return 'Recorrido';
  if (status === 'PARTIAL') return 'Parcial';
  return 'Pendiente';
}

function formatDate(date: string): string {
  return fmtDate(`${date}T12:00:00`);
}
