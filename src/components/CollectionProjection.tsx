import { useMemo, useState } from 'react';
import { Client, CashFlowAssumptions, Frequency, CollectionEvent } from '../domain/types';
import { projectYear } from '../domain/collectionEngine';
import { parsePaymentDay } from '../domain/parsePaymentDay';
import { MONTHS } from '../types';
import { Search, Settings2, ChevronDown } from 'lucide-react';

/**
 * Proyección de Cobranza — simplified layout.
 *
 * Design principles:
 *   - One summary row. Everything else is on-demand.
 *   - Two primary views: by month, by client. Detail is expandable.
 *   - Filters collapse when not in use.
 *   - Labels are explicit: "% del total" beats a bare "%".
 */

interface Props {
  clients: Client[];
  assumptions: CashFlowAssumptions;
  onAssumptionsChange: (a: CashFlowAssumptions) => void;
}

type ViewMode = 'month' | 'client';
type FactorajeFilter = 'all' | 'yes' | 'no';
const FREQUENCIES: Frequency[] = ['Semanal', 'Quincenal', 'Mensual', 'Contado'];

export default function CollectionProjection({ clients, assumptions, onAssumptionsChange }: Props) {
  const [query, setQuery] = useState('');
  const [freqFilter, setFreqFilter] = useState<Set<Frequency>>(new Set());
  const [factorajeFilter, setFactorajeFilter] = useState<FactorajeFilter>('all');
  const [view, setView] = useState<ViewMode>('month');
  const [showSettings, setShowSettings] = useState(false);

  // Filtered clients
  const filteredClients = useMemo(() => {
    return clients.filter(c => {
      if (query && !c.name.toLowerCase().includes(query.toLowerCase())) return false;
      if (freqFilter.size > 0 && !freqFilter.has(c.frequency)) return false;
      if (factorajeFilter === 'yes' && !c.factoraje) return false;
      if (factorajeFilter === 'no' && c.factoraje) return false;
      return true;
    });
  }, [clients, query, freqFilter, factorajeFilter]);

  const events = useMemo(
    () => projectYear(filteredClients, assumptions),
    [filteredClients, assumptions],
  );

  const total = events.reduce((a, e) => a + e.amount, 0);
  const avgLag = events.length ? events.reduce((a, e) => a + e.lagDays, 0) / events.length : 0;

  // Empty state
  if (clients.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-center">
        <h2 className="text-xl font-semibold text-[#1d1d1f]">Sin clientes cargados</h2>
        <p className="text-[13px] text-[#86868b] mt-1 max-w-sm">
          Importa el catálogo en la pestaña Clientes para ver la proyección.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {/* ── Header ─────────────────────────────────────────── */}
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-[#1d1d1f] tracking-tight">Proyección de cobranza</h1>
          <p className="text-[13px] text-[#86868b] mt-1">
            Cuánto y cuándo entra el efectivo, aplicando la regla de "siguiente ciclo".
          </p>
        </div>
      </header>

      {/* ── Summary strip ─────────────────────────────────── */}
      <div className="bg-white border border-[#d2d2d7]/60 rounded-xl p-5 flex items-end gap-8">
        <div>
          <div className="text-[11px] uppercase tracking-wide text-[#86868b]">Total proyectado {assumptions.year}</div>
          <div className="text-3xl font-semibold tabular-nums text-[#1d1d1f] mt-0.5">{fmt(total)}</div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-[#86868b]">Días promedio de lag</div>
          <div className="text-xl font-medium tabular-nums text-[#1d1d1f] mt-0.5">{avgLag.toFixed(1)}</div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wide text-[#86868b]">Clientes</div>
          <div className="text-xl font-medium tabular-nums text-[#1d1d1f] mt-0.5">
            {filteredClients.length}
            {filteredClients.length !== clients.length && (
              <span className="text-[#86868b] text-[13px]"> / {clients.length}</span>
            )}
          </div>
        </div>
        <div className="ml-auto">
          <button
            onClick={() => setShowSettings(!showSettings)}
            className="flex items-center gap-1.5 px-3 h-8 rounded-lg border border-[#d2d2d7] text-[13px] text-[#86868b] hover:text-[#1d1d1f] hover:bg-[#f5f5f7]"
          >
            <Settings2 className="w-3.5 h-3.5" />
            Supuestos
            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${showSettings ? 'rotate-180' : ''}`} />
          </button>
        </div>
      </div>

      {showSettings && (
        <div className="bg-white border border-[#d2d2d7]/60 rounded-xl p-4 flex gap-6 items-end">
          <Field label="Año">
            <input
              type="number"
              value={assumptions.year}
              onChange={e => onAssumptionsChange({ ...assumptions, year: Number(e.target.value) })}
              className="input w-24"
            />
          </Field>
          <Field label="Cumplimiento global (0–1)">
            <input
              type="number" min={0} max={1} step={0.05}
              value={assumptions.globalCompliance}
              onChange={e => onAssumptionsChange({ ...assumptions, globalCompliance: Number(e.target.value) })}
              className="input w-24"
            />
          </Field>
          <Field label="Días de factoraje">
            <input
              type="number"
              value={assumptions.factorajeDays}
              onChange={e => onAssumptionsChange({ ...assumptions, factorajeDays: Number(e.target.value) })}
              className="input w-24"
            />
          </Field>
        </div>
      )}

      {/* ── Filters ───────────────────────────────────────── */}
      <div className="flex flex-wrap gap-2 items-center">
        <div className="relative flex-1 min-w-[240px] max-w-md">
          <Search className="w-4 h-4 text-[#86868b] absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Buscar cliente…"
            className="input pl-9 w-full"
          />
        </div>

        <div className="flex gap-1">
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
        </div>

        <select
          value={factorajeFilter}
          onChange={e => setFactorajeFilter(e.target.value as FactorajeFilter)}
          className="input text-[12px] h-8"
        >
          <option value="all">Todos</option>
          <option value="yes">Solo factoraje</option>
          <option value="no">Sin factoraje</option>
        </select>

        {(query || freqFilter.size > 0 || factorajeFilter !== 'all') && (
          <button
            onClick={() => { setQuery(''); setFreqFilter(new Set()); setFactorajeFilter('all'); }}
            className="text-[12px] text-[#0071e3] hover:underline px-2"
          >
            Limpiar filtros
          </button>
        )}
      </div>

      {/* ── View toggle ───────────────────────────────────── */}
      <div className="flex items-center justify-between">
        <nav className="flex bg-[#f5f5f7] rounded-full p-0.5 text-[13px]">
          <button
            onClick={() => setView('month')}
            className={`px-4 py-1 rounded-full font-medium ${view === 'month' ? 'bg-white text-[#1d1d1f] shadow-sm' : 'text-[#86868b]'}`}
          >Por mes</button>
          <button
            onClick={() => setView('client')}
            className={`px-4 py-1 rounded-full font-medium ${view === 'client' ? 'bg-white text-[#1d1d1f] shadow-sm' : 'text-[#86868b]'}`}
          >Por cliente</button>
        </nav>
      </div>

      {/* ── Main view ─────────────────────────────────────── */}
      {view === 'month' && <MonthView events={events} total={total} />}
      {view === 'client' && <ClientView events={events} clients={filteredClients} total={total} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

function MonthView({ events, total }: { events: CollectionEvent[]; total: number }) {
  const monthly = new Array(12).fill(0);
  for (const e of events) monthly[Number(e.realDate.slice(5, 7)) - 1] += e.amount;
  const max = Math.max(...monthly, 1);

  return (
    <div className="bg-white border border-[#d2d2d7]/60 rounded-xl p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-[13px] font-semibold text-[#1d1d1f]">Entrada de efectivo por mes</h3>
        <span className="text-[12px] text-[#86868b]">
          Barra = monto del mes · % = participación sobre el total anual
        </span>
      </div>
      <div className="space-y-2.5">
        {MONTHS.map((m, i) => {
          const v = monthly[i];
          const pct = (v / max) * 100;
          const share = total ? (v / total) * 100 : 0;
          return (
            <div key={m} className="grid grid-cols-[44px_1fr_140px_90px] items-center gap-3 text-[13px]">
              <span className="text-[#86868b] font-medium">{m}</span>
              <div className="h-7 bg-[#f5f5f7] rounded-md relative overflow-hidden">
                <div
                  className="absolute inset-y-0 left-0 bg-gradient-to-r from-[#0071e3] to-[#40a9ff] rounded-md"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span className="text-right tabular-nums font-medium text-[#1d1d1f]">{fmt(v)}</span>
              <span className="text-right text-[#86868b] tabular-nums text-[12px]">
                {share.toFixed(1)}% del total
              </span>
            </div>
          );
        })}
      </div>
      <div className="mt-4 pt-3 border-t border-[#d2d2d7]/40 flex justify-between text-[13px]">
        <span className="text-[#86868b]">Total anual</span>
        <span className="font-semibold tabular-nums">{fmt(total)}</span>
      </div>
    </div>
  );
}

function ClientView({ events, clients, total }: { events: CollectionEvent[]; clients: Client[]; total: number }) {
  const agg = new Map<string, { total: number; count: number; lag: number }>();
  for (const e of events) {
    const prev = agg.get(e.clientId) ?? { total: 0, count: 0, lag: 0 };
    agg.set(e.clientId, {
      total: prev.total + e.amount,
      count: prev.count + 1,
      lag: prev.lag + e.lagDays,
    });
  }
  const rows = clients
    .map(c => {
      const a = agg.get(c.id);
      return {
        c,
        total: a?.total ?? 0,
        count: a?.count ?? 0,
        avgLag: a && a.count ? a.lag / a.count : 0,
      };
    })
    .filter(r => r.total > 0)
    .sort((a, b) => b.total - a.total);

  const maxTotal = rows[0]?.total ?? 1;

  return (
    <div className="bg-white border border-[#d2d2d7]/60 rounded-xl overflow-hidden">
      <div className="px-5 py-3 border-b border-[#d2d2d7]/40 flex items-center justify-between">
        <h3 className="text-[13px] font-semibold text-[#1d1d1f]">Ranking por cliente</h3>
        <span className="text-[12px] text-[#86868b]">Ordenado por monto proyectado</span>
      </div>
      <table className="w-full text-[13px]">
        <thead className="bg-[#fbfbfd] text-[#86868b] text-left text-[11px] uppercase tracking-wide">
          <tr>
            <th className="px-5 py-2.5 font-medium">Cliente</th>
            <th className="px-3 py-2.5 font-medium text-right">Eventos</th>
            <th className="px-3 py-2.5 font-medium text-right">Lag</th>
            <th className="px-3 py-2.5 font-medium">Monto</th>
            <th className="px-5 py-2.5 font-medium text-right">% del total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ c, total: rowTotal, count, avgLag }) => {
            const pct = (rowTotal / maxTotal) * 100;
            const share = total ? (rowTotal / total) * 100 : 0;
            return (
              <tr key={c.id} className="border-t border-[#d2d2d7]/40">
                <td className="px-5 py-2.5">
                  <div className="flex items-center gap-2">
                    {c.factoraje && (
                      <span className="text-[10px] bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded">F</span>
                    )}
                    <span className="text-[#1d1d1f]">{c.name}</span>
                    <span className="text-[11px] text-[#86868b]">· {c.frequency}</span>
                  </div>
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums text-[#86868b]">{count}</td>
                <td className="px-3 py-2.5 text-right tabular-nums text-[#86868b]">{avgLag.toFixed(0)}d</td>
                <td className="px-3 py-2.5">
                  <div className="flex items-center gap-2">
                    <div className="h-2 bg-[#f5f5f7] rounded-full flex-1 min-w-[80px] overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-[#0071e3] to-[#40a9ff] rounded-full"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="tabular-nums font-medium w-20 text-right">{fmt(rowTotal)}</span>
                  </div>
                </td>
                <td className="px-5 py-2.5 text-right tabular-nums text-[#86868b] text-[12px]">
                  {share.toFixed(1)}%
                </td>
              </tr>
            );
          })}
          {rows.length === 0 && (
            <tr><td colSpan={5} className="text-center text-[#86868b] py-10">Sin datos con los filtros actuales.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

function Chip({
  children, active, onClick, disabled,
}: { children: React.ReactNode; active?: boolean; onClick?: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`px-3 h-8 rounded-full text-[12px] font-medium border transition-colors ${
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
