import { useMemo, useState } from 'react';
import { Client, CashFlowAssumptions } from '../domain/types';
import { projectYear, bucketByWeek, bucketByMonth } from '../domain/collectionEngine';
import { MONTHS } from '../types';

/**
 * Proyección de Cobranza (equivalent to Excel "Resumen 2" per spec: only
 * shows the collection projection).
 *
 * This component is a view over the engine — no business logic here.
 * Business rules (pay-day pattern, next-cycle resolution, factoraje) all
 * live in `src/domain/calendar.ts` and `src/domain/collectionEngine.ts`.
 */

interface Props {
  clients: Client[];
  assumptions: CashFlowAssumptions;
  onAssumptionsChange: (a: CashFlowAssumptions) => void;
}

export default function CollectionProjection({ clients, assumptions, onAssumptionsChange }: Props) {
  const events = useMemo(() => projectYear(clients, assumptions), [clients, assumptions]);
  const weekly = useMemo(() => bucketByWeek(events), [events]);
  const monthly = useMemo(() => bucketByMonth(events), [events]);
  const [view, setView] = useState<'weekly' | 'monthly' | 'detail'>('monthly');

  const total = monthly.reduce((a, b) => a + b, 0);
  const avgLag = events.length
    ? events.reduce((a, e) => a + e.lagDays, 0) / events.length
    : 0;

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-[#1d1d1f] tracking-tight">Proyección de cobranza</h1>
          <p className="text-[13px] text-[#86868b] mt-1">
            {clients.length} clientes · {events.length} eventos proyectados · lag promedio {avgLag.toFixed(1)} días
          </p>
        </div>
        <nav className="flex bg-[#f5f5f7] rounded-full p-0.5 text-[13px]">
          {(['monthly', 'weekly', 'detail'] as const).map(v => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`px-3 py-1 rounded-full font-medium ${
                view === v ? 'bg-white text-[#1d1d1f] shadow-sm' : 'text-[#86868b]'
              }`}
            >
              {v === 'monthly' ? 'Mensual' : v === 'weekly' ? 'Semanal' : 'Detalle'}
            </button>
          ))}
        </nav>
      </header>

      {/* Assumptions */}
      <div className="bg-white border border-[#d2d2d7]/60 rounded-xl p-4 flex gap-6 items-end">
        <Field label="Año">
          <input
            type="number"
            value={assumptions.year}
            onChange={e => onAssumptionsChange({ ...assumptions, year: Number(e.target.value) })}
            className="input w-24"
          />
        </Field>
        <Field label="Cumplimiento global">
          <input
            type="number" min={0} max={1} step={0.05}
            value={assumptions.globalCompliance}
            onChange={e => onAssumptionsChange({ ...assumptions, globalCompliance: Number(e.target.value) })}
            className="input w-24"
          />
        </Field>
        <Field label="Días factoraje">
          <input
            type="number"
            value={assumptions.factorajeDays}
            onChange={e => onAssumptionsChange({ ...assumptions, factorajeDays: Number(e.target.value) })}
            className="input w-24"
          />
        </Field>
        <div className="ml-auto text-right">
          <div className="text-[12px] text-[#86868b]">Total anual proyectado</div>
          <div className="text-xl font-semibold tabular-nums">{fmt(total)}</div>
        </div>
      </div>

      {/* View */}
      {view === 'monthly' && <MonthlyTable monthly={monthly} />}
      {view === 'weekly' && <WeeklyTable weekly={weekly} />}
      {view === 'detail' && <DetailTable events={events} clients={clients} />}
    </div>
  );
}

function MonthlyTable({ monthly }: { monthly: number[] }) {
  return (
    <div className="bg-white border border-[#d2d2d7]/60 rounded-xl overflow-hidden">
      <table className="w-full text-[13px]">
        <thead className="bg-[#f5f5f7] text-[#86868b] text-left">
          <tr>{MONTHS.map(m => <th key={m} className="px-3 py-2 font-medium text-center">{m}</th>)}</tr>
        </thead>
        <tbody>
          <tr>
            {monthly.map((v, i) => (
              <td key={i} className="px-3 py-3 text-right tabular-nums text-[#1d1d1f]">{fmt(v)}</td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function WeeklyTable({ weekly }: { weekly: number[] }) {
  const rows = weekly.slice(1); // ISO week index starts at 1
  return (
    <div className="bg-white border border-[#d2d2d7]/60 rounded-xl overflow-x-auto">
      <table className="text-[13px]">
        <thead className="bg-[#f5f5f7] text-[#86868b]">
          <tr>{rows.map((_, i) => <th key={i} className="px-2 py-2 font-medium">S{i + 1}</th>)}</tr>
        </thead>
        <tbody>
          <tr>{rows.map((v, i) => <td key={i} className="px-2 py-2 text-right tabular-nums">{v ? fmt(v) : '—'}</td>)}</tr>
        </tbody>
      </table>
    </div>
  );
}

function DetailTable({ events, clients }: { events: ReturnType<typeof projectYear>; clients: Client[] }) {
  const byId = new Map(clients.map(c => [c.id, c.name]));
  return (
    <div className="bg-white border border-[#d2d2d7]/60 rounded-xl overflow-hidden max-h-[560px] overflow-y-auto">
      <table className="w-full text-[13px]">
        <thead className="bg-[#f5f5f7] text-[#86868b] text-left sticky top-0">
          <tr>
            <th className="px-4 py-2">Cliente</th>
            <th className="px-4 py-2">Teórica</th>
            <th className="px-4 py-2">Real</th>
            <th className="px-4 py-2 text-right">Lag</th>
            <th className="px-4 py-2">Sem</th>
            <th className="px-4 py-2 text-right">Monto</th>
          </tr>
        </thead>
        <tbody>
          {events.slice(0, 500).map((e, i) => (
            <tr key={i} className="border-t border-[#d2d2d7]/40">
              <td className="px-4 py-2">{byId.get(e.clientId) ?? e.clientId}</td>
              <td className="px-4 py-2 text-[#86868b]">{e.theoreticalDate}</td>
              <td className="px-4 py-2 font-medium">{e.realDate}</td>
              <td className="px-4 py-2 text-right tabular-nums">{e.lagDays}d</td>
              <td className="px-4 py-2">S{e.isoWeek}</td>
              <td className="px-4 py-2 text-right tabular-nums">{fmt(e.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {events.length > 500 && (
        <div className="px-4 py-2 text-[12px] text-[#86868b] bg-[#f5f5f7]">
          Mostrando 500 de {events.length} eventos.
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-[12px] text-[#86868b]">
      <span>{label}</span>
      {children}
    </label>
  );
}

function fmt(n: number): string {
  return n.toLocaleString('es-MX', { maximumFractionDigits: 0 });
}
