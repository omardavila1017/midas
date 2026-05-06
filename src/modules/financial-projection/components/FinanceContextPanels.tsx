import type { ReactNode } from 'react';
import { fmtCompact, fmtPctInt } from '../../../formatters';
import type {
  CustomerCollectionProfile,
  SupplierFinancialProfile,
  TaxObligation,
} from '../../shared-finance/types';

/**
 * Paneles de contexto en la página de Proyección. Antes usaban tokens
 * `var(--border)` / `var(--shadow-card)` que rompían la consistencia con
 * el resto del producto. Ahora alinean al patrón canónico de los demás
 * módulos: card blanco con `border-[var(--gray-200)]` sin sombra extra.
 *
 * Si un panel viene vacío (sin clientes/proveedores/impuestos), mostramos
 * un empty state honesto en lugar de un card vacío que confunde.
 */
export function TaxPlanningPanel({ taxes }: { taxes: TaxObligation[] }) {
  return (
    <ContextPanel title="Impuestos" subtitle="Tratamiento separado de proveedores">
      {taxes.length === 0 && <EmptyRow message="Sin obligaciones fiscales registradas." />}
      {taxes.map((tax) => (
        <ContextRow
          key={tax.id}
          title={`${tax.taxType} · vence ${tax.dueDate}`}
          meta={`${humanStatus(tax.status)} · riesgo ${tax.risk.toLowerCase()}`}
          value={fmtCompact(tax.pendingAmount)}
        />
      ))}
    </ContextPanel>
  );
}

export function SupplierRiskPanel({ suppliers }: { suppliers: SupplierFinancialProfile[] }) {
  return (
    <ContextPanel title="Proveedores" subtitle="Riesgo, flexibilidad y exposición">
      {suppliers.length === 0 && <EmptyRow message="No hay proveedores cargados." />}
      {suppliers.slice(0, 6).map((supplier) => (
        <ContextRow
          key={supplier.id}
          title={supplier.name}
          meta={`${humanRisk(supplier.risk)} · ${humanFlexibility(supplier.paymentFlexibility)} · ${supplier.priority}`}
          value={fmtCompact(supplier.pendingAmount)}
        />
      ))}
    </ContextPanel>
  );
}

export function CustomerCollectionPanel({ customers }: { customers: CustomerCollectionProfile[] }) {
  return (
    <ContextPanel title="Clientes y cobranza" subtitle="Probabilidad y patrón de pago">
      {customers.length === 0 && <EmptyRow message="No hay clientes cargados." />}
      {customers.slice(0, 6).map((customer) => (
        <ContextRow
          key={customer.id}
          title={customer.groupName ? `${customer.groupName} · ${customer.name}` : customer.name}
          meta={`${customer.paymentPattern} · ${fmtPctInt(customer.collectionProbability * 100)}`}
          value={fmtCompact(customer.pendingAmount)}
        />
      ))}
    </ContextPanel>
  );
}

function ContextPanel({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-[var(--radius-lg)] border border-[var(--gray-200)] bg-white">
      <div className="border-b border-[var(--gray-200)] px-4 py-3">
        <h2 className="text-[15px] font-bold tracking-tight text-[var(--gray-950)]">{title}</h2>
        <p className="mt-1 text-[12px] text-[var(--gray-400)]">{subtitle}</p>
      </div>
      <div className="divide-y divide-[var(--gray-100)]">{children}</div>
    </section>
  );
}

function ContextRow({ title, meta, value }: { title: string; meta: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <div className="truncate text-[13px] font-medium text-[var(--gray-950)]">{title}</div>
        <div className="mt-0.5 truncate text-[11px] text-[var(--gray-400)]">{meta}</div>
      </div>
      <div className="shrink-0 text-right text-[13px] font-bold tabular-nums text-[var(--gray-950)]">
        {value}
      </div>
    </div>
  );
}

function EmptyRow({ message }: { message: string }) {
  return (
    <div className="px-4 py-6 text-center text-[12px] text-[var(--gray-400)]">{message}</div>
  );
}

function humanStatus(status: string): string {
  switch (status) {
    case 'PROJECTED': return 'Proyectado';
    case 'CONFIRMED': return 'Confirmado';
    case 'PAID': return 'Pagado';
    case 'PENDING': return 'Pendiente';
    default: return status;
  }
}

function humanRisk(risk: string): string {
  switch (risk) {
    case 'CRITICAL': return 'Crítico';
    case 'STRATEGIC': return 'Estratégico';
    case 'FLEXIBLE': return 'Flexible';
    case 'BLOCKED': return 'Bloqueado';
    case 'LOW_RISK': return 'Riesgo bajo';
    case 'HIGH_RISK': return 'Riesgo alto';
    default: return risk.toLowerCase();
  }
}

function humanFlexibility(flexibility: string): string {
  switch (flexibility) {
    case 'LOCKED': return 'Inamovible';
    case 'REVIEW': return 'Revisar';
    case 'NEGOTIABLE': return 'Negociable';
    case 'FLEXIBLE': return 'Flexible';
    default: return flexibility.toLowerCase();
  }
}
