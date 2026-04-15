import { useMemo, useState } from 'react';
import { Client, CashFlowAssumptions, Frequency, CollectionEvent } from '../domain/types';
import { projectYear } from '../domain/collectionEngine';
import { parsePaymentDay } from '../domain/parsePaymentDay';
import { MONTHS } from '../types';
import { Search, AlertCircle, Info } from 'lucide-react';

/**
 * Proyección de Cobranza — digestible view over the engine output.
 *
 * Four stacked layers:
 *   1. KPI cards  — total, lag, factoraje, unparsed
 *   2. Filter bar — search / frequency / factoraje / month / unparsed-only
 *   3. View tabs  — Mensual · Semanal · Por Cliente · Detalle
 *   4. Warnings   — e.g. "0 clientes con factoraje" when the user raises
 *                   factorajeDays without any client flagged for it.
 */

interface Props {
  clients: Client[];
  assumptions: CashFlowAssumptions;
  onAssumptionsChange: (a: CashFlowAssumptions) => void;
}

type ViewMode = 'monthly' | 'weekly' | 'byClient' | 'detail';
type FactorajeFilter = 'all' | 'yes' | 'no';

const FREQUENCIES: Frequency[] = ['Semanal', 'Quincenal', 'Mensual', 'Contado'];

export default function CollectionProjection({ clients, assumptions, onAssumptionsChange }: Props) {
  // -------- Filters --------
  const [query, setQuery] = useState('');
  const [freqFilter, setFreqFilter] = useState<Set<Frequency>>(new Set());
  const [factorajeFilter, setFactorajeFilter] = useState<FactorajeFilter>('all');
  const [monthFilter, setMonthFilter] = useState<number | null>(null); // 0..11 or null
  const [onlyUnparsed, setOnlyUnparsed] = useState(false);
  const [view, setView] = useState<ViewMode>('monthly');

  // -------- Filtered clients --------
  const filteredClients = useMemo(() => {
    return clients.filter(c => {
      if (query && !c.name.toLowerCase().includes(query.toLowerCase())) return false;
      if (freqFilter.size > 0 && !freqFilter.has(c.frequency)) return false;
      if (factorajeFilter === 'yes' && !c.factoraje) return false;
      if (factorajeFilter === 'no' && c.factoraje) return false;
      if (onlyUnparsed) {
        const parsed = c.paymentDayRaw ? parsePaymentDay(c.paymentDayRaw) : c.paymentDay;
        if (parsed) return false;
      }
      return true;
    });
  }, [clients, query, freqFilter, factorajeFilter, onlyUnparsed]);

  // -------- Engine output --------
  const events = useMemo(
    () => projectYear(filteredClients, assumptions),
    [filteredClients, assumptions],
  );

  const monthScoped = useMemo(() => {
    if (monthFilter === null) return events;
    return events.filter(e => Number(e.realDate.slice(5, 7)) - 1 === monthFilter);
  }, [events, monthFilter]);

  // -------- KPIs --------
  const factorajeCount = clients.filter(c => c.factoraje).length;
  const unparsedCount = clients.filter(c => {
    const p = c.paymentDayRaw ? parsePaymentDay(c.paymentDayRaw) : null;
    return c.paymentDayRaw && !p;
  }).length;
  const totalAnnual = monthScoped.reduce((a, e) => a + e.amount, 0);
  const avgLag = monthScoped.length
    ? monthScoped.reduce((a, e) => a + e.lagDays, 0) / monthScoped.length
    : 0;

  // -------- Warnings --------
  const factorajeNoop = factorajeCount === 0;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold text-[#1d1d1f] tracking-tight">Proyección de cobranza</h1>
        <p className="text-[13px] text-[#86868b] mt-1">
          Motor: regla de "siguiente ciclo", no siguiente día hábil.
        </p>
      </header>

      {/* KPI cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Kpi label="Total proyectado" value={fmt(totalAnnual)} accent />
        <Kpi label="Lag promedio" value={`${avgLag.toFixed(1)} días`} />
        <Kpi label="Clientes" value={`${filteredClients.length} / ${clients.length}`} />
        <Kpi label="Eventos" value={monthScoped.length.toString()} />
        <Kpi
          label="Con factoraje"
          value={factorajeCount.toString()}
          warn={factorajeNoop}
        />
      </div>

      {factorajeNoop && (
        <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-[13px] text-amber-800">
          <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <div>
            <strong>Cambiar "Días factoraje" no afecta el resultado</strong> porque ningún cliente
            tiene factoraje activo. Marca el checkbox "Factoraje" en la pestaña Clientes para los
            clientes que aplican (o importa nuevamente — se autodetecta por la palabra "factoraje"
            en la columna día de pago).
          </div>
        </div>
      )}
      {unparsedCount > 0 && (
        <div className="flex items-start gap-2 bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 text-[13px] text-blue-800">
          <Info className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <div>
            {unparsedCount} cliente{unparsedCount === 1 ? '' : 's'} sin patrón de pago reconocido.
            Sus fechas caen al fallback (viernes). Revísalos en la pestaña Clientes.
          </div>
        </div>
      )}

      {/* Assumptions */}
      <div className="bg-white border border-[#d2d2d7]/60 rounded-xl p-4 flex flex-wrap gap-6 items-end">
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
            className={`input w-24 ${factorajeNoop ? 'opacity-50' : ''}`}
          />
        </Field>
      </div>

      {/* Filter bar */}
      <div className="bg-white border border-[#d2d2d7]/60 rounded-xl p-4 space-y-3">
        <div className="flex flex-wrap gap-3 items-center">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="w-4 h-4 text-[#86868b] absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Buscar cliente…"
              className="input pl-9 w-full"
            />
          </div>

          <Chip active={factorajeFilter === 'all'} onClick={() => setFactorajeFilter('all')}>Todos</Chip>
          <Chip active={factorajeFilter === 'yes'} onClick={() => setFactorajeFilter('yes')} disabled={factorajeCount === 0}>
            Factoraje
          </Chip>
          <Chip active={factorajeFilter === 'no'} onClick={() => setFactorajeFilter('no')}>Sin factoraje</Chip>

          <div className="h-5 w-px bg-[#d2d2d7] mx-1" />

          {FREQUENCIES.map(f => (
            <Chip
              key={f}
              active={freqFilter.has(f)}
              onClick={() => {
                const next = new Set(freqFilter);
                next.has(f) ? next.delete(f) : next.add(f);
                setFreqFilter(next);
              }}
            >{f}</Chip>
          ))}

          <div className="h-5 w-px bg-[#d2d2d7] mx-1" />

          <label className="flex items-center gap-1.5 text-[13px] text-[#1d1d1f]">
            <input type="checkbox" checked={onlyUnparsed} onChange={e => setOnlyUnparsed(e.target.checked)} />
            Solo sin parsear
          </label>
        </div>

        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[12px] text-[#86868b] mr-1">Mes:</span>
          <Chip active={monthFilter === null} onClick={() => setMonthFilter(null)}>Año</Chip>
          {MONTHS.map((m, i) => (
            <Chip key={m} active={monthFilter === i} onClick={() => setMonthFilter(monthFilter === i ? null : i)}>
              {m}
            </Chip>
          ))}
        </div>
      </div>

      {/* View selector */}
      <nav className="flex bg-[#f5f5f7] rounded-full p-0.5 text-[13px] w-fit">
        {([
          ['monthly', 'Mensual'],
          ['weekly', 'Semanal'],
          ['byClient', 'Por cliente'],
          ['detail', 'Detalle'],
        ] as const).map(([v, lbl]) => (
          <button
            key={v}
            onClick={() => setView(v)}
            className={`px-4 py-1 rounded-full font-medium ${
              view === v ? 'bg-white text-[#1d1d1f] shadow-sm' : 'text-[#86868b]'
            }`}
          >{lbl}</button>
        ))}
      </nav>

      {/* View content */}
      {view === 'monthly' && <MonthlyView events={monthScoped} totalScope={totalAnnual} />}
      {view === 'weekly' && <WeeklyView events={monthScoped} />}
      {view === 'byClient' && <ByClientView events={monthScoped} clients={filteredClients} />}
      {view === 'detail' && <DetailView events={monthScoped} clients={filteredClients} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function MonthlyView({ events, totalScope }: { events: CollectionEvent[]; totalScope: number }) {
  const monthly = new Array(12).fill(0);
  for (const e of events) monthly[Number(e.realDate.slice(5, 7)) - 1] += e.amount;
  const max = Math.max(...monthly, 1);

  return (
    <div className="bg-white border border-[#d2d2d7]/60 rounded-xl p-4 space-y-2">
      {MONTHS.map((m, i) => {
        const v = monthly[i];
        const pct = (v / max) * 100;
        const share = totalScope ? (v / totalScope) * 100 : 0;
        return (
          <div key={m} className="grid grid-cols-[60px_1fr_120px_70px] items-center gap-3 text-[13px]">
            <span className="text-[#86868b] font-medium">{m}</span>
            <div className="h-6 bg-[#f5f5f7] rounded relative overflow-hidden">
              <div
                className="absolute inset-y-0 left-0 bg-gradient-to-r from-[#0071e3] to-[#40a9ff] rounded"
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="text-right tabular-nums">{fmt(v)}</span>
            <span className="text-right text-[#86868b] tabular-nums text-[12px]">{share.toFixed(1)}%</span>
          </div>
        );
      })}
    </div>
  );
}

function WeeklyView({ events }: { events: CollectionEvent[] }) {
  // Bucket by (month, week-of-month) to avoid 53 tiny columns.
  const weekly = new Array(54).fill(0);
  for (const e of events) weekly[e.isoWeek] += e.amount;
  const rows = weekly.slice(1);
  const max = Math.max(...rows, 1);
  return (
    <div className="bg-white border border-[#d2d2d7]/60 rounded-xl p-4 overflow-x-auto">
      <div className="flex items-end gap-1 h-48">
        {rows.map((v, i) => (
          <div key={i} className="flex flex-col items-center gap-1 flex-1 min-w-[14px]">
            <div
              className="w-full bg-gradient-to-t from-[#0071e3] to-[#40a9ff] rounded-sm"
              style={{ height: `${(v / max) * 100}%` }}
              title={`S${i + 1}: ${fmt(v)}`}
            />
          </div>
        ))}
      </div>
      <div className="flex gap-1 mt-1 text-[10px] text-[#86868b]">
        {rows.map((_, i) => (
          <span key={i} className="flex-1 text-center min-w-[14px]">
            {(i + 1) % 4 === 1 ? `S${i + 1}` : ''}
          </span>
        ))}
      </div>
    </div>
  );
}

function ByClientView({ events, clients }: { events: CollectionEvent[]; clients: Client[] }) {
  const byClient = new Map<string, { total: number; count: number; lag: number }>();
  for (const e of events) {
    const prev = byClient.get(e.clientId) ?? { total: 0, count: 0, lag: 0 };
    byClient.set(e.clientId, {
      total: prev.total + e.amount,
      count: prev.count + 1,
      lag: prev.lag + e.lagDays,
    });
  }
  const rows = clients
    .map(c => {
      const agg = byClient.get(c.id);
      return { c, total: agg?.total ?? 0, events: agg?.count ?? 0, avgLag: agg ? agg.lag / agg.count : 0 };
    })
    .sort((a, b) => b.total - a.total);

  const grandTotal = rows.reduce((s, r) => s + r.total, 0);

  return (
    <div className="bg-white border border-[#d2d2d7]/60 rounded-xl overflow-hidden">
      <table className="w-full text-[13px]">
        <thead className="bg-[#f5f5f7] text-[#86868b] text-left text-[12px] uppercase tracking-wide">
          <tr>
            <th className="px-4 py-2.5 font-medium">Cliente</th>
            <th className="px-4 py-2.5 font-medium">Frec.</th>
            <th className="px-4 py-2.5 font-medium text-right">Eventos</th>
            <th className="px-4 py-2.5 font-medium text-right">Lag</th>
            <th className="px-4 py-2.5 font-medium text-right">Total</th>
            <th className="px-4 py-2.5 font-medium text-right">%</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ c, total, events, avgLag }) => (
            <tr key={c.id} className="border-t border-[#d2d2d7]/40">
              <td className="px-4 py-2.5">
                <div className="flex items-center gap-2">
                  {c.factoraje && <span className="text-[10px] bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded">F</span>}
                  <span>{c.name}</span>
                </div>
              </td>
              <td className="px-4 py-2.5 text-[#86868b]">{c.frequency}</td>
              <td className="px-4 py-2.5 text-right tabular-nums">{events}</td>
              <td className="px-4 py-2.5 text-right tabular-nums">{avgLag.toFixed(0)}d</td>
              <td className="px-4 py-2.5 text-right tabular-nums font-medium">{fmt(total)}</td>
              <td className="px-4 py-2.5 text-right tabular-nums text-[#86868b] text-[12px]">
                {grandTotal ? ((total / grandTotal) * 100).toFixed(1) : '0.0'}%
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td colSpan={6} className="text-center text-[#86868b] py-10">Sin datos con los filtros actuales.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function DetailView({ events, clients }: { events: CollectionEvent[]; clients: Client[] }) {
  const byId = new Map(clients.map(c => [c.id, c]));
  const sorted = [...events].sort((a, b) => a.realDate.localeCompare(b.realDate));
  return (
    <div className="bg-white border border-[#d2d2d7]/60 rounded-xl overflow-hidden">
      <div className="max-h-[560px] overflow-y-auto">
        <table className="w-full text-[13px]">
          <thead className="bg-[#f5f5f7] text-[#86868b] text-left sticky top-0">
            <tr>
              <th className="px-4 py-2">Cliente</th>
              <th className="px-4 py-2">Teórica</th>
              <th className="px-4 py-2">Real</th>
              <th className="px-4 py-2 text-right">Lag</th>
              <th className="px-4 py-2">Sem</th>
              <th className="px-4 py-2 text-center">F</th>
              <th className="px-4 py-2 text-right">Monto</th>
            </tr>
          </thead>
          <tbody>
            {sorted.slice(0, 1000).map((e, i) => {
              const c = byId.get(e.clientId);
              return (
                <tr key={i} className="border-t border-[#d2d2d7]/40">
                  <td className="px-4 py-2">{c?.name ?? e.clientId}</td>
                  <td className="px-4 py-2 text-[#86868b]">{e.theoreticalDate}</td>
                  <td className="px-4 py-2 font-medium">{e.realDate}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{e.lagDays}d</td>
                  <td className="px-4 py-2">S{e.isoWeek}</td>
                  <td className="px-4 py-2 text-center">
                    {c?.factoraje && <span className="text-[10px] bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded">F</span>}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">{fmt(e.amount)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {sorted.length > 1000 && (
        <div className="px-4 py-2 text-[12px] text-[#86868b] bg-[#f5f5f7] border-t border-[#d2d2d7]/40">
          Mostrando 1,000 de {sorted.length} eventos. Filtra para reducir.
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

function Kpi({ label, value, accent, warn }: { label: string; value: string; accent?: boolean; warn?: boolean }) {
  return (
    <div className={`rounded-xl border p-4 ${
      warn ? 'bg-amber-50 border-amber-200' :
      accent ? 'bg-gradient-to-br from-[#0071e3] to-[#40a9ff] border-transparent text-white' :
      'bg-white border-[#d2d2d7]/60'
    }`}>
      <div className={`text-[11px] uppercase tracking-wide ${
        warn ? 'text-amber-700' : accent ? 'text-white/80' : 'text-[#86868b]'
      }`}>{label}</div>
      <div className="text-xl font-semibold tabular-nums mt-0.5">{value}</div>
    </div>
  );
}

function Chip({
  children, active, onClick, disabled,
}: { children: React.ReactNode; active?: boolean; onClick?: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`px-3 py-1 rounded-full text-[12px] font-medium border transition-colors ${
        disabled ? 'opacity-40 cursor-not-allowed border-[#d2d2d7]' :
        active ? 'bg-[#0071e3] text-white border-[#0071e3]' :
        'bg-white text-[#86868b] border-[#d2d2d7] hover:text-[#1d1d1f]'
      }`}
    >{children}</button>
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
