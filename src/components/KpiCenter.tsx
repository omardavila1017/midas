import { useEffect, useMemo, useState } from 'react';
import {
  Check,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { CashFlowAssumptions, Client, ConfirmedPayment } from '../domain/types';
import {
  buildKpiCatalog,
  type KpiCatalogEntry,
  type KpiStatus,
  type KpiUnit,
} from '../domain/kpiCatalog';
import type { FlowPlan, Proposal, Scenario, ScenarioCellOverride, Simulation } from '../types';
import { MONTHS_FULL } from '../types';
import { hex } from '../theme';
import { fmtCompact, fmtCurrency, fmtInt, fmtPct } from '../formatters';

interface Props {
  clients: Client[];
  assumptions: CashFlowAssumptions;
  confirmedPayments: ConfirmedPayment[];
  plan: FlowPlan | null;
  proposals: Proposal[];
  scenarios: Scenario[];
  simulations: Simulation[];
  overrides: ScenarioCellOverride[];
  activeProposalId: string | null;
  activeScenarioId: string | null;
  activeKpiIds: string[];
  onActiveKpiIdsChange: (ids: string[]) => void;
  defaultKpiIds: readonly string[];
}

function defaultActiveMonth(year: number): number {
  const now = new Date();
  return now.getFullYear() === year ? now.getMonth() : 0;
}

function formatKpiValue(unit: KpiUnit, value: number): string {
  if (unit === 'currency') return fmtCurrency(value);
  if (unit === 'percent') return fmtPct(value);
  return fmtInt(Math.round(value));
}

function formatKpiCompact(unit: KpiUnit, value: number): string {
  if (unit === 'currency') return fmtCompact(value);
  return formatKpiValue(unit, value);
}

function formatKpiDiff(unit: KpiUnit, value: number): string {
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  if (unit === 'currency') return `${sign}${fmtCompact(Math.abs(value))}`;
  if (unit === 'percent') return `${sign}${(Math.abs(value) * 100).toFixed(1)} pp`;
  return `${sign}${fmtInt(Math.abs(Math.round(value)))}`;
}

function formatKpiAxis(unit: KpiUnit, value: number): string {
  if (unit === 'currency') return fmtCompact(value);
  if (unit === 'percent') return `${Math.round(value * 100)}%`;
  return fmtInt(Math.round(value));
}

function statusLabel(entry: KpiCatalogEntry, status: KpiStatus): string {
  if (status === 'na') return 'Sin datos';
  if (entry.comparisonKind === 'target') {
    return status === 'met' ? 'Meta cumplida' : 'Debajo de meta';
  }
  return status === 'met' ? 'Mejor que base' : 'Peor que base';
}

function StatusBadge({ entry, status }: { entry: KpiCatalogEntry; status: KpiStatus }) {
  if (status === 'na') {
    return (
      <span className="inline-flex items-center rounded-full bg-[var(--gray-50)] px-3 py-1 text-[12px] font-medium text-[var(--gray-400)]">
        Sin datos
      </span>
    );
  }

  const tone = status === 'met'
    ? 'bg-[var(--success)]/10 text-[var(--success)]'
    : 'bg-[var(--danger)]/10 text-[var(--danger)]';

  return (
    <span className={`inline-flex items-center rounded-full px-3 py-1 text-[12px] font-medium ${tone}`}>
      {statusLabel(entry, status)}
    </span>
  );
}

export default function KpiCenter({
  clients,
  assumptions,
  confirmedPayments,
  plan,
  proposals,
  scenarios,
  simulations,
  overrides,
  activeProposalId,
  activeScenarioId,
  activeKpiIds,
  onActiveKpiIdsChange,
  defaultKpiIds,
}: Props) {
  const [activeMonth, setActiveMonth] = useState(() => defaultActiveMonth(assumptions.year));
  const [selectedKpiId, setSelectedKpiId] = useState<string | null>(null);
  const [libraryQuery, setLibraryQuery] = useState('');

  useEffect(() => {
    setActiveMonth(defaultActiveMonth(assumptions.year));
  }, [assumptions.year]);

  const entries = useMemo(
    () => buildKpiCatalog({
      clients,
      assumptions,
      confirmedPayments,
      plan,
      proposals,
      scenarios,
      simulations,
      overrides,
      activeProposalId,
      activeScenarioId,
      activeMonth,
    }),
    [
      clients,
      assumptions,
      confirmedPayments,
      plan,
      proposals,
      scenarios,
      simulations,
      overrides,
      activeProposalId,
      activeScenarioId,
      activeMonth,
    ],
  );

  const entryById = useMemo(
    () => new Map(entries.map((entry) => [entry.id, entry])),
    [entries],
  );

  const activeEntries = useMemo(
    () => activeKpiIds.map((id) => entryById.get(id)).filter(Boolean) as KpiCatalogEntry[],
    [activeKpiIds, entryById],
  );

  const libraryEntries = useMemo(() => {
    const activeSet = new Set(activeKpiIds);
    const query = libraryQuery.trim().toLowerCase();
    return entries.filter((entry) => {
      if (activeSet.has(entry.id)) return false;
      if (!query) return true;
      return (
        entry.label.toLowerCase().includes(query) ||
        entry.category.toLowerCase().includes(query) ||
        entry.description.toLowerCase().includes(query)
      );
    });
  }, [activeKpiIds, entries, libraryQuery]);

  const selectedEntry = selectedKpiId ? entryById.get(selectedKpiId) ?? null : null;
  const activeAvailableCount = activeEntries.filter((entry) => entry.available).length;
  const unavailableCount = activeEntries.length - activeAvailableCount;

  const addKpi = (id: string) => {
    if (activeKpiIds.includes(id)) return;
    onActiveKpiIdsChange([...activeKpiIds, id]);
  };

  const removeKpi = (id: string) => {
    onActiveKpiIdsChange(activeKpiIds.filter((item) => item !== id));
    if (selectedKpiId === id) setSelectedKpiId(null);
  };

  const restoreDefaults = () => {
    onActiveKpiIdsChange([...defaultKpiIds]);
  };

  return (
    <div className="space-y-5">
      <section className="rounded-2xl border border-[var(--gray-200)]/60 bg-white overflow-hidden">
        <div className="px-5 py-4 border-b border-[var(--gray-200)]/40 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="text-[24px] font-semibold tracking-tight text-[var(--gray-950)]">Todos los KPIs</h1>
            <p className="mt-1 text-[13px] text-[var(--gray-400)]">
              Vista unificada para cobranza, KPIs financieros y variaciones del pronóstico. Puedes agregar o quitar KPIs desde la biblioteca.
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <label className="flex flex-col gap-1 text-[11px] uppercase tracking-wide text-[var(--gray-400)]">
              Mes activo
              <select
                value={activeMonth}
                onChange={(event) => setActiveMonth(Number(event.target.value))}
                className="input h-9 min-w-[180px] text-[13px] normal-case tracking-normal"
              >
                {MONTHS_FULL.map((month, index) => (
                  <option key={month} value={index}>{month} {assumptions.year}</option>
                ))}
              </select>
            </label>
            <button
              onClick={restoreDefaults}
              className="h-9 rounded-xl border border-[var(--gray-200)] px-3 text-[13px] font-medium text-[var(--gray-500)] transition-colors hover:bg-[var(--gray-50)] hover:text-[var(--gray-950)]"
            >
              Restaurar sugeridos
            </button>
          </div>
        </div>

        <div className="px-5 py-4 bg-[var(--surface-alt)]/80 border-b border-[var(--gray-200)]/40 flex flex-wrap gap-3 text-[12px] text-[var(--gray-500)]">
          <span>{activeEntries.length} KPIs activos</span>
          <span>{activeAvailableCount} disponibles</span>
          {unavailableCount > 0 && <span>{unavailableCount} pendientes por contexto</span>}
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-full text-[13px]">
            <thead className="bg-[var(--surface-alt)] text-[var(--gray-400)] uppercase tracking-wide text-[11px]">
              <tr>
                <th className="px-5 py-3 text-left font-medium">KPI</th>
                <th className="px-4 py-3 text-left font-medium">Categoría</th>
                <th className="px-4 py-3 text-left font-medium">Periodo</th>
                <th className="px-4 py-3 text-right font-medium">Resultado</th>
                <th className="px-4 py-3 text-right font-medium">Referencia</th>
                <th className="px-4 py-3 text-right font-medium">Diferencia</th>
                <th className="px-4 py-3 text-right font-medium">Estado</th>
                <th className="px-5 py-3 text-right font-medium">Acción</th>
              </tr>
            </thead>
            <tbody>
              {activeEntries.map((entry) => {
                const diffTone = entry.status === 'na'
                  ? 'text-[var(--gray-400)]'
                  : entry.status === 'met'
                    ? 'text-[var(--success)]'
                    : 'text-[var(--danger)]';
                const clickable = entry.available;

                return (
                  <tr
                    key={entry.id}
                    onClick={() => clickable && setSelectedKpiId(entry.id)}
                    className={`border-t border-[var(--gray-200)]/40 ${clickable ? 'cursor-pointer hover:bg-[var(--gray-50)]/70' : 'bg-[var(--gray-50)]/40'}`}
                  >
                    <td className="px-5 py-3.5">
                      <div className="flex items-start gap-3">
                        <span className="mt-1.5 h-2.5 w-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: entry.accentColor }} />
                        <div className="min-w-0">
                          <div className="font-medium text-[var(--gray-950)]">{entry.label}</div>
                          <div className="mt-0.5 text-[12px] text-[var(--gray-400)]">{entry.description}</div>
                          {!entry.available && entry.availabilityReason && (
                            <div className="mt-1 text-[12px] text-[var(--warning)]">{entry.availabilityReason}</div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3.5 text-[var(--gray-500)]">{entry.category}</td>
                    <td className="px-4 py-3.5 text-[var(--gray-500)]">{entry.periodLabel ?? '—'}</td>
                    <td className="px-4 py-3.5 text-right font-medium tabular-nums text-[var(--gray-950)]">
                      {entry.value === null ? '—' : formatKpiCompact(entry.unit, entry.value)}
                    </td>
                    <td className="px-4 py-3.5 text-right tabular-nums text-[var(--gray-500)]">
                      {entry.comparisonValue === null || !entry.comparisonLabel
                        ? '—'
                        : `${entry.comparisonLabel}: ${formatKpiCompact(entry.unit, entry.comparisonValue)}`}
                    </td>
                    <td className={`px-4 py-3.5 text-right tabular-nums font-medium ${diffTone}`}>
                      {entry.diffValue === null ? '—' : formatKpiDiff(entry.unit, entry.diffValue)}
                    </td>
                    <td className="px-4 py-3.5 text-right">
                      <StatusBadge entry={entry} status={entry.status} />
                    </td>
                    <td className="px-5 py-3.5 text-right">
                      <button
                        onClick={(event) => {
                          event.stopPropagation();
                          removeKpi(entry.id);
                        }}
                        className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-[var(--gray-200)] text-[var(--gray-400)] transition-colors hover:bg-[var(--danger)]/10 hover:text-[var(--danger)]"
                        aria-label={`Eliminar KPI ${entry.label}`}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                );
              })}
              {activeEntries.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-5 py-12 text-center">
                    <p className="text-[15px] font-medium text-[var(--gray-950)]">No hay KPIs activos</p>
                    <p className="mt-1 text-[13px] text-[var(--gray-400)]">Agrega KPIs desde la biblioteca para construir tu tablero.</p>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-2xl border border-[var(--gray-200)]/60 bg-white overflow-hidden">
        <div className="px-5 py-4 border-b border-[var(--gray-200)]/40 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h2 className="text-[15px] font-semibold text-[var(--gray-950)]">Biblioteca de KPIs</h2>
            <p className="mt-1 text-[12px] text-[var(--gray-400)]">
              Agrega KPIs de cobranza, financieros y de variación vs base según lo que quieras monitorear.
            </p>
          </div>
          <div className="relative min-w-[260px]">
            <Search className="w-4 h-4 text-[var(--gray-400)] absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              value={libraryQuery}
              onChange={(event) => setLibraryQuery(event.target.value)}
              className="input w-full pl-9"
              placeholder="Buscar KPI..."
            />
          </div>
        </div>

        <div className="grid gap-3 p-4 md:grid-cols-2 xl:grid-cols-3">
          {libraryEntries.map((entry) => (
            <div key={entry.id} className="rounded-2xl border border-[var(--gray-200)]/60 bg-[var(--surface-alt)] p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: entry.accentColor }} />
                    <p className="font-medium text-[var(--gray-950)]">{entry.label}</p>
                  </div>
                  <p className="mt-1 text-[12px] text-[var(--gray-400)]">{entry.category}</p>
                </div>
                <button
                  onClick={() => entry.available && addKpi(entry.id)}
                  disabled={!entry.available}
                  className={`inline-flex h-9 items-center gap-1 rounded-xl px-3 text-[12px] font-medium transition-colors ${
                    entry.available
                      ? 'bg-[var(--primary)] text-white hover:brightness-110'
                      : 'bg-[var(--gray-100)] text-[var(--gray-400)] cursor-not-allowed'
                  }`}
                >
                  <Plus className="w-3.5 h-3.5" />
                  Agregar
                </button>
              </div>
              <p className="mt-3 text-[13px] text-[var(--gray-500)]">{entry.description}</p>
              {!entry.available && entry.availabilityReason && (
                <div className="mt-3 rounded-xl bg-[var(--warning)]/10 px-3 py-2 text-[12px] text-[var(--warning)]">
                  {entry.availabilityReason}
                </div>
              )}
            </div>
          ))}
          {libraryEntries.length === 0 && (
            <div className="md:col-span-2 xl:col-span-3 rounded-2xl border border-dashed border-[var(--gray-200)] px-5 py-10 text-center">
              <p className="text-[15px] font-medium text-[var(--gray-950)]">No hay más KPIs para agregar</p>
              <p className="mt-1 text-[13px] text-[var(--gray-400)]">Prueba otra búsqueda o restaura los KPIs sugeridos.</p>
            </div>
          )}
        </div>
      </section>

      {selectedEntry?.available && (
        <KpiDetailModal
          entry={selectedEntry}
          onClose={() => setSelectedKpiId(null)}
        />
      )}
    </div>
  );
}

function KpiDetailModal({
  entry,
  onClose,
}: {
  entry: KpiCatalogEntry;
  onClose: () => void;
}) {
  const comparisonCount = entry.points.filter((point) => point.comparison !== null).length;
  const metCount = entry.points.filter((point) => point.status === 'met').length;
  const summaryLabel = entry.comparisonKind === 'target' ? 'Meses cumpliendo' : 'Meses mejorando';
  const diffTone = entry.status === 'na'
    ? 'text-[var(--gray-400)]'
    : entry.status === 'met'
      ? 'text-[var(--success)]'
      : 'text-[var(--danger)]';

  return (
    <div
      className="fixed inset-0 px-4 py-6 md:py-10"
      style={{ backgroundColor: 'rgba(29, 29, 31, 0.34)', zIndex: 60 }}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="mx-auto max-w-6xl rounded-[28px] bg-white shadow-2xl shadow-black/10 overflow-hidden"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="grid lg:grid-cols-[minmax(0,1.8fr)_320px]">
          <div className="p-6 md:p-8">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div
                  className="inline-flex rounded-xl px-3 py-1 text-[11px] font-semibold uppercase tracking-wide"
                  style={{ backgroundColor: `${entry.accentColor}14`, color: entry.accentColor }}
                >
                  {entry.category}
                </div>
                <h3 className="mt-4 text-[30px] leading-tight font-semibold tracking-tight text-[var(--gray-950)]">
                  {entry.label}
                </h3>
                <p className="mt-3 max-w-3xl text-[15px] leading-7 text-[var(--gray-500)]">
                  {entry.description}
                </p>
              </div>
              <button
                onClick={onClose}
                className="flex h-10 w-10 items-center justify-center rounded-full text-[var(--gray-400)] transition-colors hover:bg-[var(--gray-50)] hover:text-[var(--gray-950)]"
                aria-label="Cerrar detalle KPI"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="mt-8 h-[320px]">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={entry.points} margin={{ top: 12, right: 12, left: 4, bottom: 8 }}>
                  <CartesianGrid stroke={hex.gray100} vertical={false} />
                  <XAxis
                    dataKey="label"
                    tick={{ fill: hex.gray400, fontSize: 12 }}
                    tickLine={false}
                    axisLine={{ stroke: hex.gray100 }}
                  />
                  <YAxis
                    width={88}
                    tick={{ fill: hex.gray400, fontSize: 12 }}
                    tickLine={false}
                    axisLine={false}
                    tickFormatter={(value) => formatKpiAxis(entry.unit, Number(value))}
                  />
                  <Tooltip
                    labelFormatter={(label) => `${label}`}
                    formatter={(value: number, name: string) => [
                      formatKpiValue(entry.unit, Number(value)),
                      name === 'value'
                        ? entry.chartValueLabel ?? 'Resultado'
                        : entry.chartComparisonLabel ?? 'Referencia',
                    ]}
                    contentStyle={{
                      borderRadius: 18,
                      border: `1px solid ${hex.gray200}`,
                      boxShadow: '0 16px 32px rgba(0,0,0,0.08)',
                    }}
                  />
                  <Line
                    type="monotone"
                    dataKey="comparison"
                    name="comparison"
                    stroke={hex.gray300}
                    strokeWidth={2.5}
                    strokeDasharray="7 5"
                    dot={false}
                    connectNulls
                  />
                  <Line
                    type="monotone"
                    dataKey="value"
                    name="value"
                    stroke={entry.accentColor}
                    strokeWidth={3}
                    dot={(props: any) => {
                      const { cx, cy, payload } = props;
                      if (typeof cx !== 'number' || typeof cy !== 'number') {
                        return <circle cx={0} cy={0} r={0} fill="transparent" />;
                      }
                      const fill = payload.status === 'met'
                        ? hex.success
                        : payload.status === 'missed'
                          ? hex.danger
                          : hex.gray300;
                      return <circle cx={cx} cy={cy} r={5} fill={fill} stroke="white" strokeWidth={2} />;
                    }}
                    activeDot={{ r: 6, stroke: entry.accentColor, strokeWidth: 2, fill: '#fff' }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>

            <div className="mt-6 grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-6">
              {entry.points.map((point) => (
                <div
                  key={point.label}
                  className={`rounded-2xl border px-3 py-3 ${
                    point.status === 'met'
                      ? 'border-[var(--success)]/20 bg-[var(--success)]/10'
                      : point.status === 'missed'
                        ? 'border-[var(--danger)]/20 bg-[var(--danger)]/10'
                        : 'border-[var(--gray-200)]/60 bg-[var(--gray-50)]'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--gray-400)]">
                      {point.label}
                    </span>
                    {point.status === 'met' && <Check className="w-3.5 h-3.5 text-[var(--success)]" />}
                    {point.status === 'missed' && <X className="w-3.5 h-3.5 text-[var(--danger)]" />}
                    {point.status === 'na' && <span className="text-[10px] text-[var(--gray-400)]">N/A</span>}
                  </div>
                  <div className="mt-2 text-[13px] font-medium tabular-nums text-[var(--gray-950)]">
                    {formatKpiCompact(entry.unit, point.value)}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <aside className="border-t border-[var(--gray-200)]/50 bg-[var(--surface-alt)] p-6 md:p-8 lg:border-l lg:border-t-0">
            <div className="text-[12px] uppercase tracking-wide text-[var(--gray-400)]">
              {entry.periodLabel}
            </div>
            <div className="mt-3 text-[40px] leading-none font-semibold tracking-tight text-[var(--gray-950)]">
              {entry.value === null ? 'Sin dato' : formatKpiValue(entry.unit, entry.value)}
            </div>

            <div className="mt-7">
              <div className="text-[12px] uppercase tracking-wide text-[var(--gray-400)]">
                {entry.comparisonLabel ?? 'Referencia'}
              </div>
              <div className="mt-2 text-[28px] leading-tight font-semibold text-[var(--gray-950)]">
                {entry.comparisonValue === null ? 'Sin referencia' : formatKpiValue(entry.unit, entry.comparisonValue)}
              </div>
            </div>

            <div className="mt-7">
              <div className="text-[12px] uppercase tracking-wide text-[var(--gray-400)]">Diferencia</div>
              <div className={`mt-2 text-[28px] leading-tight font-semibold ${diffTone}`}>
                {entry.diffValue === null ? 'N/A' : formatKpiDiff(entry.unit, entry.diffValue)}
              </div>
            </div>

            <div className="mt-7">
              <div className="text-[12px] uppercase tracking-wide text-[var(--gray-400)]">{summaryLabel}</div>
              <div className="mt-2 text-[28px] leading-tight font-semibold text-[var(--gray-950)]">
                {metCount}/{comparisonCount || 0}
              </div>
            </div>

            <div className="mt-7">
              <div className="text-[12px] uppercase tracking-wide text-[var(--gray-400)]">Estado actual</div>
              <div className="mt-3">
                <StatusBadge entry={entry} status={entry.status} />
              </div>
            </div>

            {entry.note && (
              <div className="mt-7 rounded-2xl bg-white p-4 text-[13px] leading-6 text-[var(--gray-500)] border border-[var(--gray-200)]/60">
                {entry.note}
              </div>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}
