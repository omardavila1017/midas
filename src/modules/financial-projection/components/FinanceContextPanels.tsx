import { fmtCompact, fmtPctInt } from '../../../formatters';
import type { ReactNode } from 'react';
import type {
  CustomerCollectionProfile,
  SupplierFinancialProfile,
  TaxObligation,
} from '../../shared-finance/types';

export function TaxPlanningPanel({ taxes }: { taxes: TaxObligation[] }) {
  return (
    <ContextPanel title="Impuestos" subtitle="Tratamiento separado de proveedores">
      {taxes.map((tax) => (
        <ContextRow
          key={tax.id}
          title={`${tax.taxType} · ${tax.dueDate}`}
          meta={`${tax.status} · riesgo ${tax.risk}`}
          value={fmtCompact(tax.pendingAmount)}
        />
      ))}
    </ContextPanel>
  );
}

export function SupplierRiskPanel({ suppliers }: { suppliers: SupplierFinancialProfile[] }) {
  return (
    <ContextPanel title="Proveedores" subtitle="Riesgo, flexibilidad y exposición">
      {suppliers.slice(0, 6).map((supplier) => (
        <ContextRow
          key={supplier.id}
          title={supplier.name}
          meta={`${supplier.risk} · ${supplier.paymentFlexibility} · ${supplier.priority}`}
          value={fmtCompact(supplier.pendingAmount)}
        />
      ))}
    </ContextPanel>
  );
}

export function CustomerCollectionPanel({ customers }: { customers: CustomerCollectionProfile[] }) {
  return (
    <ContextPanel title="Clientes y cobranza" subtitle="Agrupación comercial y probabilidad">
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
    <section className="rounded-xl border border-[var(--border)] bg-white shadow-[var(--shadow-card)]">
      <div className="border-b border-[var(--border)] px-4 py-3">
        <h2 className="text-[15px] font-semibold text-[var(--gray-950)]">{title}</h2>
        <p className="mt-1 text-[12px] text-[var(--gray-500)]">{subtitle}</p>
      </div>
      <div className="divide-y divide-[var(--border)]">{children}</div>
    </section>
  );
}

function ContextRow({ title, meta, value }: { title: string; meta: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 px-4 py-3">
      <div className="min-w-0">
        <div className="truncate text-[12px] font-medium text-[var(--gray-950)]">{title}</div>
        <div className="mt-0.5 truncate text-[11px] text-[var(--gray-400)]">{meta}</div>
      </div>
      <div className="shrink-0 text-right text-[12px] font-semibold tabular-nums text-[var(--gray-950)]">{value}</div>
    </div>
  );
}
