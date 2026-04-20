import { type ReactNode, useEffect, useMemo, useState } from 'react';
import {
  Check,
  Pencil,
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
  getKpiVariableDocs,
  KPI_FORMULA_HELPERS,
  KPI_GOAL_OPTIONS,
  KPI_PERIOD_OPTIONS,
  KPI_UNIT_OPTIONS,
  type CustomKpiDefinition,
  type KpiCatalogEntry,
  type KpiGoal,
  type KpiPeriod,
  type KpiStatus,
  type KpiUnit,
} from '../domain/kpiCatalog';
import type { FlowPlan, Proposal, Scenario, ScenarioCellOverride, Simulation } from '../types';
import { MONTHS_FULL } from '../types';
import { hex } from '../theme';
import { fmtCompact, fmtCurrency, fmtInt, fmtNum, fmtPct } from '../formatters';

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
  customKpis: CustomKpiDefinition[];
  onCustomKpisChange: (kpis: CustomKpiDefinition[]) => void;
}

interface CustomKpiDraft {
  id: string | null;
  name: string;
  category: string;
  formula: string;
  targetValue: string;
  period: KpiPeriod;
  unit: KpiUnit;
  customUnitLabel: string;
  goal: KpiGoal;
  warningThreshold: string;
  notes: string;
}

function defaultActiveMonth(year: number): number {
  const now = new Date();
  return now.getFullYear() === year ? now.getMonth() : 0;
}

function makeDraft(definition?: CustomKpiDefinition): CustomKpiDraft {
  const targetValue = definition
    ? definition.unit === 'percent'
      ? String(definition.targetValue * 100)
      : String(definition.targetValue)
    : '100';
  const warningThreshold = definition
    ? definition.unit === 'percent'
      ? String(definition.warningThreshold * 100)
      : String(definition.warningThreshold)
    : '85';

  return {
    id: definition?.id ?? null,
    name: definition?.name ?? '',
    category: definition?.category ?? 'KPIs personalizados',
    formula: definition?.formula ?? 'porcentaje_cobranza',
    targetValue,
    period: definition?.period ?? 'monthly',
    unit: definition?.unit ?? 'percent',
    customUnitLabel: definition?.customUnitLabel ?? '',
    goal: definition?.goal ?? 'higher',
    warningThreshold,
    notes: definition?.notes ?? '',
  };
}

function formatKpiValue(unit: KpiUnit, value: number, customUnitLabel?: string | null): string {
  if (unit === 'currency') return fmtCurrency(value);
  if (unit === 'percent') return fmtPct(value);
  if (unit === 'days') return `${fmtNum(value)} días`;
  if (unit === 'times') return `${fmtNum(value)}x`;
  if (unit === 'custom') return `${fmtNum(value)}${customUnitLabel ? ` ${customUnitLabel}` : ''}`;
  return fmtInt(Math.round(value));
}

function formatKpiCompact(unit: KpiUnit, value: number, customUnitLabel?: string | null): string {
  if (unit === 'currency') return fmtCompact(value);
  if (unit === 'percent') return fmtPct(value);
  if (unit === 'days') return `${fmtNum(value)}d`;
  if (unit === 'times') return `${fmtNum(value)}x`;
  if (unit === 'custom') return `${fmtNum(value)}${customUnitLabel ? ` ${customUnitLabel}` : ''}`;
  return fmtInt(Math.round(value));
}

function formatKpiDiff(unit: KpiUnit, value: number, customUnitLabel?: string | null): string {
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';
  if (unit === 'currency') return `${sign}${fmtCompact(Math.abs(value))}`;
  if (unit === 'percent') return `${sign}${(Math.abs(value) * 100).toFixed(1)} pp`;
  if (unit === 'days') return `${sign}${fmtNum(Math.abs(value))} días`;
  if (unit === 'times') return `${sign}${fmtNum(Math.abs(value))}x`;
  if (unit === 'custom') return `${sign}${fmtNum(Math.abs(value))}${customUnitLabel ? ` ${customUnitLabel}` : ''}`;
  return `${sign}${fmtInt(Math.abs(Math.round(value)))}`;
}

function formatKpiAxis(unit: KpiUnit, value: number, customUnitLabel?: string | null): string {
  if (unit === 'currency') return fmtCompact(value);
  if (unit === 'percent') return `${Math.round(value * 100)}%`;
  if (unit === 'days') return `${Math.round(value)}d`;
  if (unit === 'times') return `${fmtNum(value)}x`;
  if (unit === 'custom') return `${fmtNum(value)}${customUnitLabel ? ` ${customUnitLabel}` : ''}`;
  return fmtInt(Math.round(value));
}

function statusLabel(entry: KpiCatalogEntry, status: KpiStatus): string {
  if (status === 'na') return 'Sin datos';
  if (status === 'warning') return 'Alerta';
  if (entry.comparisonKind === 'target') {
    return status === 'met' ? 'Meta cumplida' : 'Crítico';
  }
  return status === 'met' ? 'Mejor que base' : 'Peor que base';
}

function statusClasses(status: KpiStatus): string {
  if (status === 'met') return 'bg-[var(--success)]/10 text-[var(--success)] border-[var(--success)]/20';
  if (status === 'warning') return 'bg-[var(--warning)]/10 text-[var(--warning)] border-[var(--warning)]/20';
  if (status === 'missed') return 'bg-[var(--danger)]/10 text-[var(--danger)] border-[var(--danger)]/20';
  return 'bg-[var(--gray-50)] text-[var(--gray-400)] border-[var(--gray-200)]/60';
}

function StatusBadge({ entry, status }: { entry: KpiCatalogEntry; status: KpiStatus }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-3 py-1 text-[12px] font-medium ${statusClasses(status)}`}>
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
  customKpis,
  onCustomKpisChange,
}: Props) {
  const [activeMonth, setActiveMonth] = useState(() => defaultActiveMonth(assumptions.year));
  const [selectedKpiId, setSelectedKpiId] = useState<string | null>(null);
  const [libraryQuery, setLibraryQuery] = useState('');
  const [showEditor, setShowEditor] = useState(false);
  const [draft, setDraft] = useState<CustomKpiDraft>(() => makeDraft());
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    setActiveMonth(defaultActiveMonth(assumptions.year));
  }, [assumptions.year]);

  const variableDocs = useMemo(() => getKpiVariableDocs(plan), [plan]);

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
      customKpis,
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
      customKpis,
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
        entry.description.toLowerCase().includes(query) ||
        (entry.formula ?? '').toLowerCase().includes(query)
      );
    });
  }, [activeKpiIds, entries, libraryQuery]);

  const selectedEntry = selectedKpiId ? entryById.get(selectedKpiId) ?? null : null;
  const activeAvailableCount = activeEntries.filter((entry) => entry.available).length;
  const unavailableCount = activeEntries.length - activeAvailableCount;
  const customCount = customKpis.length;

  const addKpi = (id: string) => {
    if (activeKpiIds.includes(id)) return;
    onActiveKpiIdsChange([...activeKpiIds, id]);
  };

  const removeKpiFromActive = (id: string) => {
    onActiveKpiIdsChange(activeKpiIds.filter((item) => item !== id));
    if (selectedKpiId === id) setSelectedKpiId(null);
  };

  const deleteCustomKpi = (id: string) => {
    onCustomKpisChange(customKpis.filter((item) => item.id !== id));
    onActiveKpiIdsChange(activeKpiIds.filter((item) => item !== id));
    if (selectedKpiId === id) setSelectedKpiId(null);
  };

  const restoreDefaults = () => {
    onActiveKpiIdsChange([...defaultKpiIds]);
  };

  const openCreate = () => {
    setDraft(makeDraft());
    setFormError(null);
    setShowEditor(true);
  };

  const openEdit = (entry: KpiCatalogEntry) => {
    const definition = customKpis.find((item) => item.id === entry.id);
    if (!definition) return;
    setDraft(makeDraft(definition));
    setFormError(null);
    setShowEditor(true);
  };

  const saveDraft = () => {
    const name = draft.name.trim();
    const category = draft.category.trim() || 'KPIs personalizados';
    const formula = draft.formula.trim();
    const parsedTargetValue = Number(draft.targetValue);
    const parsedWarningThreshold = Number(draft.warningThreshold);
    const targetValue = draft.unit === 'percent' ? parsedTargetValue / 100 : parsedTargetValue;
    const warningThreshold = draft.unit === 'percent' ? parsedWarningThreshold / 100 : parsedWarningThreshold;

    if (!name) {
      setFormError('El KPI necesita un nombre.');
      return;
    }
    if (!formula) {
      setFormError('Escribe una fórmula.');
      return;
    }
    if (!Number.isFinite(parsedTargetValue)) {
      setFormError('La meta debe ser un número válido.');
      return;
    }
    if (!Number.isFinite(parsedWarningThreshold)) {
      setFormError('El umbral de alerta debe ser un número válido.');
      return;
    }
    if (draft.goal === 'higher' && warningThreshold > targetValue) {
      setFormError('En KPIs donde más alto es mejor, la alerta debe ser menor o igual a la meta.');
      return;
    }
    if (draft.goal === 'lower' && warningThreshold < targetValue) {
      setFormError('En KPIs donde más bajo es mejor, la alerta debe ser mayor o igual a la meta.');
      return;
    }

    const now = new Date().toISOString();
    const nextDefinition: CustomKpiDefinition = {
      id: draft.id ?? `custom-kpi-${Date.now()}`,
      name,
      category,
      formula,
      targetValue,
      period: draft.period,
      unit: draft.unit,
      customUnitLabel: draft.unit === 'custom' ? draft.customUnitLabel.trim() : undefined,
      goal: draft.goal,
      warningThreshold,
      notes: draft.notes.trim(),
      createdAt: draft.id ? (customKpis.find((item) => item.id === draft.id)?.createdAt ?? now) : now,
      updatedAt: now,
    };

    const exists = customKpis.some((item) => item.id === nextDefinition.id);
    const nextDefinitions = exists
      ? customKpis.map((item) => (item.id === nextDefinition.id ? nextDefinition : item))
      : [...customKpis, nextDefinition];
    onCustomKpisChange(nextDefinitions);
    if (!activeKpiIds.includes(nextDefinition.id)) {
      onActiveKpiIdsChange([...activeKpiIds, nextDefinition.id]);
    }
    setShowEditor(false);
    setSelectedKpiId(nextDefinition.id);
  };

  return (
    <div className="space-y-5">
      <section className="rounded-2xl border border-[var(--gray-200)]/60 bg-white overflow-hidden">
        <div className="px-5 py-4 border-b border-[var(--gray-200)]/40 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="text-[24px] font-semibold tracking-tight text-[var(--gray-950)]">Todos los KPIs</h1>
            <p className="mt-1 text-[13px] text-[var(--gray-400)]">
              Crea KPIs personalizados con fórmula, meta, periodo, semáforo y notas. Se recalculan automáticamente con tus proyecciones y escenarios.
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <label className="flex flex-col gap-1 text-[11px] uppercase tracking-wide text-[var(--gray-400)]">
              Mes ancla
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
            <button
              onClick={openCreate}
              className="inline-flex h-9 items-center gap-2 rounded-xl bg-[var(--primary)] px-3 text-[13px] font-medium text-white transition hover:brightness-110"
            >
              <Plus className="w-4 h-4" />
              Nuevo KPI personalizado
            </button>
          </div>
        </div>

        <div className="px-5 py-4 bg-[var(--surface-alt)]/80 border-b border-[var(--gray-200)]/40 flex flex-wrap gap-3 text-[12px] text-[var(--gray-500)]">
          <span>{activeEntries.length} KPIs activos</span>
          <span>{activeAvailableCount} disponibles</span>
          {unavailableCount > 0 && <span>{unavailableCount} pendientes por contexto</span>}
          <span>{customCount} personalizados</span>
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-full text-[13px]">
            <thead className="bg-[var(--surface-alt)] text-[var(--gray-400)] uppercase tracking-wide text-[11px]">
              <tr>
                <th className="px-5 py-3 text-left font-medium">KPI</th>
                <th className="px-4 py-3 text-left font-medium">Categoría</th>
                <th className="px-4 py-3 text-left font-medium">Periodo</th>
                <th className="px-4 py-3 text-right font-medium">Resultado</th>
                <th className="px-4 py-3 text-right font-medium">Meta / referencia</th>
                <th className="px-4 py-3 text-right font-medium">Diferencia</th>
                <th className="px-4 py-3 text-right font-medium">Estado</th>
                <th className="px-5 py-3 text-right font-medium">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {activeEntries.map((entry) => {
                const diffTone = entry.status === 'na'
                  ? 'text-[var(--gray-400)]'
                  : entry.status === 'met'
                    ? 'text-[var(--success)]'
                    : entry.status === 'warning'
                      ? 'text-[var(--warning)]'
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
                          <div className="flex items-center gap-2">
                            <div className="font-medium text-[var(--gray-950)]">{entry.label}</div>
                            {entry.isCustom && (
                              <span className="rounded-full bg-[var(--primary)]/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--primary)]">
                                Custom
                              </span>
                            )}
                          </div>
                          <div className="mt-0.5 text-[12px] text-[var(--gray-400)]">{entry.description}</div>
                          {entry.formula && (
                            <div className="mt-1 font-mono text-[11px] text-[var(--gray-500)]">{entry.formula}</div>
                          )}
                          {!entry.available && entry.availabilityReason && (
                            <div className="mt-1 text-[12px] text-[var(--warning)]">{entry.availabilityReason}</div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3.5 text-[var(--gray-500)]">{entry.category}</td>
                    <td className="px-4 py-3.5 text-[var(--gray-500)]">{entry.periodLabel ?? '—'}</td>
                    <td className="px-4 py-3.5 text-right font-medium tabular-nums text-[var(--gray-950)]">
                      {entry.value === null ? '—' : formatKpiCompact(entry.unit, entry.value, entry.customUnitLabel)}
                    </td>
                    <td className="px-4 py-3.5 text-right tabular-nums text-[var(--gray-500)]">
                      {entry.comparisonValue === null || !entry.comparisonLabel
                        ? '—'
                        : `${entry.comparisonLabel}: ${formatKpiCompact(entry.unit, entry.comparisonValue, entry.customUnitLabel)}`}
                    </td>
                    <td className={`px-4 py-3.5 text-right tabular-nums font-medium ${diffTone}`}>
                      {entry.diffValue === null ? '—' : formatKpiDiff(entry.unit, entry.diffValue, entry.customUnitLabel)}
                    </td>
                    <td className="px-4 py-3.5 text-right">
                      <StatusBadge entry={entry} status={entry.status} />
                    </td>
                    <td className="px-5 py-3.5 text-right">
                      <div className="flex justify-end gap-2">
                        {entry.isCustom && (
                          <button
                            onClick={(event) => {
                              event.stopPropagation();
                              openEdit(entry);
                            }}
                            className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-[var(--gray-200)] text-[var(--gray-400)] transition-colors hover:bg-[var(--gray-50)] hover:text-[var(--gray-950)]"
                            aria-label={`Editar KPI ${entry.label}`}
                          >
                            <Pencil className="w-4 h-4" />
                          </button>
                        )}
                        <button
                          onClick={(event) => {
                            event.stopPropagation();
                            if (entry.isCustom) deleteCustomKpi(entry.id);
                            else removeKpiFromActive(entry.id);
                          }}
                          className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-[var(--gray-200)] text-[var(--gray-400)] transition-colors hover:bg-[var(--danger)]/10 hover:text-[var(--danger)]"
                          aria-label={entry.isCustom ? `Eliminar KPI ${entry.label}` : `Quitar KPI ${entry.label}`}
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {activeEntries.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-5 py-12 text-center">
                    <p className="text-[15px] font-medium text-[var(--gray-950)]">No hay KPIs activos</p>
                    <p className="mt-1 text-[13px] text-[var(--gray-400)]">Agrega plantillas o crea KPIs personalizados para construir tu tablero.</p>
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
              Usa plantillas existentes o agrega tus KPIs personalizados sin depender solo de los defaults.
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
                  {entry.isCustom && (
                    <p className="mt-1 text-[11px] uppercase tracking-wide text-[var(--primary)]">Personalizado</p>
                  )}
                </div>
                <div className="flex gap-2">
                  {entry.isCustom && (
                    <button
                      onClick={() => openEdit(entry)}
                      className="inline-flex h-9 w-9 items-center justify-center rounded-xl border border-[var(--gray-200)] text-[var(--gray-400)] transition-colors hover:bg-[var(--gray-50)] hover:text-[var(--gray-950)]"
                      aria-label={`Editar KPI ${entry.label}`}
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
                  )}
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
              </div>
              <p className="mt-3 text-[13px] text-[var(--gray-500)]">{entry.description}</p>
              {entry.formula && (
                <div className="mt-3 rounded-xl bg-white px-3 py-2 font-mono text-[11px] text-[var(--gray-500)] border border-[var(--gray-200)]/60">
                  {entry.formula}
                </div>
              )}
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
              <p className="mt-1 text-[13px] text-[var(--gray-400)]">Prueba otra búsqueda o crea uno personalizado.</p>
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

      {showEditor && (
        <CustomKpiEditor
          draft={draft}
          onDraftChange={setDraft}
          onClose={() => setShowEditor(false)}
          onSave={saveDraft}
          error={formError}
          variableDocs={variableDocs}
        />
      )}
    </div>
  );
}

function CustomKpiEditor({
  draft,
  onDraftChange,
  onClose,
  onSave,
  error,
  variableDocs,
}: {
  draft: CustomKpiDraft;
  onDraftChange: (draft: CustomKpiDraft) => void;
  onClose: () => void;
  onSave: () => void;
  error: string | null;
  variableDocs: ReturnType<typeof getKpiVariableDocs>;
}) {
  const groupedVariables = useMemo(() => {
    const map = new Map<string, typeof variableDocs>();
    for (const variable of variableDocs) {
      const group = map.get(variable.group) ?? [];
      group.push(variable);
      map.set(variable.group, group);
    }
    return Array.from(map.entries());
  }, [variableDocs]);

  const thresholdHint = draft.goal === 'higher'
    ? 'Alerta: valor mínimo aceptable antes de caer en crítico.'
    : 'Alerta: valor máximo aceptable antes de caer en crítico.';

  return (
    <div
      className="fixed inset-0 px-4 py-6 md:py-10"
      style={{ backgroundColor: 'rgba(29, 29, 31, 0.34)', zIndex: 70 }}
      onClick={onClose}
    >
      <div
        className="mx-auto max-w-7xl rounded-[28px] bg-white shadow-2xl shadow-black/10 overflow-hidden"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="grid lg:grid-cols-[minmax(0,1.25fr)_420px]">
          <div className="p-6 md:p-8">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="inline-flex rounded-xl bg-[var(--primary)]/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--primary)]">
                  KPI personalizado
                </div>
                <h2 className="mt-4 text-[28px] font-semibold tracking-tight text-[var(--gray-950)]">
                  {draft.id ? 'Editar KPI' : 'Nuevo KPI'}
                </h2>
                <p className="mt-2 text-[14px] text-[var(--gray-500)]">
                  Define nombre, fórmula, meta, periodo, unidad y semáforo. El KPI se recalculará contra proyecciones, simulaciones y escenarios.
                </p>
              </div>
              <button
                onClick={onClose}
                className="flex h-10 w-10 items-center justify-center rounded-full text-[var(--gray-400)] transition-colors hover:bg-[var(--gray-50)] hover:text-[var(--gray-950)]"
                aria-label="Cerrar editor KPI"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="mt-8 grid gap-4 md:grid-cols-2">
              <Field label="Nombre del KPI">
                <input
                  value={draft.name}
                  onChange={(event) => onDraftChange({ ...draft, name: event.target.value })}
                  className="input w-full"
                  placeholder="Ej. Días de cobro"
                />
              </Field>
              <Field label="Categoría">
                <input
                  value={draft.category}
                  onChange={(event) => onDraftChange({ ...draft, category: event.target.value })}
                  className="input w-full"
                  placeholder="Ej. Liquidez"
                />
              </Field>
              <Field label="Periodo de medición">
                <select
                  value={draft.period}
                  onChange={(event) => onDraftChange({ ...draft, period: event.target.value as KpiPeriod })}
                  className="input w-full"
                >
                  {KPI_PERIOD_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </Field>
              <Field label="Unidad">
                <select
                  value={draft.unit}
                  onChange={(event) => onDraftChange({ ...draft, unit: event.target.value as KpiUnit })}
                  className="input w-full"
                >
                  {KPI_UNIT_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </Field>
              {draft.unit === 'custom' && (
                <Field label="Etiqueta unidad">
                  <input
                    value={draft.customUnitLabel}
                    onChange={(event) => onDraftChange({ ...draft, customUnitLabel: event.target.value })}
                    className="input w-full"
                    placeholder="Ej. toneladas"
                  />
                </Field>
              )}
              <Field label="Meta esperada">
                <input
                  type="number"
                  value={draft.targetValue}
                  onChange={(event) => onDraftChange({ ...draft, targetValue: event.target.value })}
                  className="input w-full"
                />
                {draft.unit === 'percent' && <p className="mt-1 text-[11px] text-[var(--gray-400)]">Captura porcentaje completo. Ejemplo: `85` para 85%.</p>}
              </Field>
              <Field label="Semáforo">
                <select
                  value={draft.goal}
                  onChange={(event) => onDraftChange({ ...draft, goal: event.target.value as KpiGoal })}
                  className="input w-full"
                >
                  {KPI_GOAL_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </Field>
              <Field label="Umbral de alerta">
                <input
                  type="number"
                  value={draft.warningThreshold}
                  onChange={(event) => onDraftChange({ ...draft, warningThreshold: event.target.value })}
                  className="input w-full"
                />
                <p className="mt-1 text-[11px] text-[var(--gray-400)]">{thresholdHint}</p>
              </Field>
            </div>

            <div className="mt-4">
              <Field label="Fórmula o lógica de cálculo">
                <textarea
                  value={draft.formula}
                  onChange={(event) => onDraftChange({ ...draft, formula: event.target.value })}
                  className="input min-h-[120px] w-full py-3 font-mono text-[13px]"
                  placeholder="Ej. safe_div(cobranza_confirmada, meta_cobranza)"
                />
              </Field>
              <div className="mt-2 rounded-xl bg-[var(--surface-alt)] px-4 py-3 text-[12px] text-[var(--gray-500)]">
                Ejemplos:
                <div className="mt-1 font-mono">dias_cobro</div>
                <div className="font-mono">safe_div(cobranza_confirmada, meta_cobranza)</div>
                <div className="font-mono">safe_div(ingresos - egresos, ingresos)</div>
                <div className="font-mono">desviacion_egresos</div>
              </div>
            </div>

            <div className="mt-4">
              <Field label="Comentarios o notas">
                <textarea
                  value={draft.notes}
                  onChange={(event) => onDraftChange({ ...draft, notes: event.target.value })}
                  className="input min-h-[96px] w-full py-3"
                  placeholder="Contexto del KPI, supuestos, uso esperado..."
                />
              </Field>
            </div>

            {error && (
              <div className="mt-4 rounded-2xl bg-[var(--danger)]/10 px-4 py-3 text-[13px] text-[var(--danger)]">
                {error}
              </div>
            )}

            <div className="mt-6 flex justify-end gap-3">
              <button
                onClick={onClose}
                className="h-10 rounded-xl border border-[var(--gray-200)] px-4 text-[13px] font-medium text-[var(--gray-500)] transition-colors hover:bg-[var(--gray-50)] hover:text-[var(--gray-950)]"
              >
                Cancelar
              </button>
              <button
                onClick={onSave}
                className="h-10 rounded-xl bg-[var(--primary)] px-4 text-[13px] font-medium text-white transition hover:brightness-110"
              >
                Guardar KPI
              </button>
            </div>
          </div>

          <aside className="border-t border-[var(--gray-200)]/50 bg-[var(--surface-alt)] p-6 md:p-8 lg:border-l lg:border-t-0">
            <h3 className="text-[15px] font-semibold text-[var(--gray-950)]">Variables disponibles</h3>
            <p className="mt-1 text-[12px] text-[var(--gray-400)]">
              Piensa esta sección como una hoja de Excel inteligente: usa estas variables en tus fórmulas.
            </p>

            <div className="mt-5 space-y-4 max-h-[620px] overflow-y-auto pr-1">
              {groupedVariables.map(([group, variables]) => (
                <div key={group}>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--gray-400)]">{group}</p>
                  <div className="mt-2 space-y-2">
                    {variables.map((variable) => (
                      <div key={variable.key} className="rounded-2xl bg-white border border-[var(--gray-200)]/60 px-3 py-3">
                        <div className="font-mono text-[12px] font-medium text-[var(--gray-950)]">{variable.key}</div>
                        <div className="mt-1 text-[12px] text-[var(--gray-500)]">{variable.description}</div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}

              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--gray-400)]">Funciones</p>
                <div className="mt-2 space-y-2">
                  {KPI_FORMULA_HELPERS.map((helper) => (
                    <div key={helper.signature} className="rounded-2xl bg-white border border-[var(--gray-200)]/60 px-3 py-3">
                      <div className="font-mono text-[12px] font-medium text-[var(--gray-950)]">{helper.signature}</div>
                      <div className="mt-1 text-[12px] text-[var(--gray-500)]">{helper.description}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </aside>
        </div>
      </div>
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
  const warningCount = entry.points.filter((point) => point.status === 'warning').length;
  const summaryLabel = entry.comparisonKind === 'target' ? 'Periodos cumpliendo' : 'Periodos mejorando';
  const diffTone = entry.status === 'na'
    ? 'text-[var(--gray-400)]'
    : entry.status === 'met'
      ? 'text-[var(--success)]'
      : entry.status === 'warning'
        ? 'text-[var(--warning)]'
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
                {entry.formula && (
                  <div className="mt-4 rounded-2xl bg-[var(--surface-alt)] px-4 py-3 font-mono text-[12px] text-[var(--gray-500)]">
                    {entry.formula}
                  </div>
                )}
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
                    tickFormatter={(value) => formatKpiAxis(entry.unit, Number(value), entry.customUnitLabel)}
                  />
                  <Tooltip
                    labelFormatter={(label) => `${label}`}
                    formatter={(value: number, name: string) => [
                      formatKpiValue(entry.unit, Number(value), entry.customUnitLabel),
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
                        : payload.status === 'warning'
                          ? hex.warning
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
                  className={`rounded-2xl border px-3 py-3 ${statusClasses(point.status)}`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-semibold uppercase tracking-wide">
                      {point.label}
                    </span>
                    {point.status === 'met' && <Check className="w-3.5 h-3.5" />}
                    {point.status === 'warning' && <span className="text-[11px] font-semibold">!</span>}
                    {point.status === 'missed' && <X className="w-3.5 h-3.5" />}
                    {point.status === 'na' && <span className="text-[10px]">N/A</span>}
                  </div>
                  <div className="mt-2 text-[13px] font-medium tabular-nums text-[var(--gray-950)]">
                    {formatKpiCompact(entry.unit, point.value, entry.customUnitLabel)}
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
              {entry.value === null ? 'Sin dato' : formatKpiValue(entry.unit, entry.value, entry.customUnitLabel)}
            </div>

            <div className="mt-7">
              <div className="text-[12px] uppercase tracking-wide text-[var(--gray-400)]">
                {entry.comparisonLabel ?? 'Referencia'}
              </div>
              <div className="mt-2 text-[28px] leading-tight font-semibold text-[var(--gray-950)]">
                {entry.comparisonValue === null ? 'Sin referencia' : formatKpiValue(entry.unit, entry.comparisonValue, entry.customUnitLabel)}
              </div>
            </div>

            {entry.warningThreshold !== null && (
              <div className="mt-7">
                <div className="text-[12px] uppercase tracking-wide text-[var(--gray-400)]">Umbral alerta</div>
                <div className="mt-2 text-[28px] leading-tight font-semibold text-[var(--gray-950)]">
                  {formatKpiValue(entry.unit, entry.warningThreshold, entry.customUnitLabel)}
                </div>
              </div>
            )}

            <div className="mt-7">
              <div className="text-[12px] uppercase tracking-wide text-[var(--gray-400)]">Diferencia</div>
              <div className={`mt-2 text-[28px] leading-tight font-semibold ${diffTone}`}>
                {entry.diffValue === null ? 'N/A' : formatKpiDiff(entry.unit, entry.diffValue, entry.customUnitLabel)}
              </div>
            </div>

            <div className="mt-7">
              <div className="text-[12px] uppercase tracking-wide text-[var(--gray-400)]">{summaryLabel}</div>
              <div className="mt-2 text-[28px] leading-tight font-semibold text-[var(--gray-950)]">
                {metCount}/{comparisonCount || 0}
              </div>
              {warningCount > 0 && (
                <div className="mt-1 text-[12px] text-[var(--warning)]">{warningCount} en alerta</div>
              )}
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

function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1 text-[12px] text-[var(--gray-500)]">
      <span>{label}</span>
      {children}
    </label>
  );
}
