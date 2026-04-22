/**
 * ProposalDrawer — editor guiado para crear o editar una Propuesta.
 *
 * Se monta con React Portal al <body> para escapar cualquier contexto de
 * stacking (en particular el <header sticky z-50>). El backdrop cubre la
 * pantalla completa con blur; el drawer entra desde la derecha.
 *
 * Flujo:
 *   1. Tipo de ajuste
 *   2. Rubros donde aplica
 *   3. Parámetros (monto/%, frecuencia, fechas)
 *   4. Nombre + categoría + notas
 */

import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  X,
  Trash2,
  Percent,
  DollarSign,
  RefreshCw,
  Layers,
  ArrowDownUp,
  PauseCircle,
  TrendingUp,
  TrendingDown,
  Check,
  Search,
  Sparkles,
  ChevronRight,
} from 'lucide-react';
import {
  CATEGORY_COLORS,
  FlowPlan,
  Proposal,
  ProposalCategory,
  ProposalFrequency,
  ProposalOperation,
  ProposalType,
  ROLE_TARGET_COLLECTIONS,
  ROLE_TARGET_EXPENSE,
  ROLE_TARGET_INCOME,
  ROLE_TARGET_LABELS,
  ROLE_TARGET_PROVIDER_PAYMENTS,
} from '../types';
import { buildProposalEffects } from '../domain/proposalCompiler';
import { getProposalTargetOptions } from '../domain/scenarioEngine';

interface ProposalDrawerProps {
  plan: FlowPlan;
  proposal: Proposal | null;
  onClose: () => void;
  onSave: (proposal: Proposal) => void;
  onDelete?: () => void;
}

type TypeOption = {
  id: ProposalType;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  category: ProposalCategory;
  summary: string;
  accent: string;
};

const TYPE_OPTIONS: TypeOption[] = [
  {
    id: 'percent_adjustment',
    label: 'Ajuste porcentual',
    icon: Percent,
    category: 'Reducción de Costos',
    summary: 'Subir o bajar un rubro en un %',
    accent: 'oklch(62% 0.19 155)',
  },
  {
    id: 'amount_adjustment',
    label: 'Ajuste por monto',
    icon: DollarSign,
    category: 'Incremento de Ingresos',
    summary: 'Sumar o restar un monto fijo',
    accent: 'oklch(55% 0.22 255)',
  },
  {
    id: 'recurring_series',
    label: 'Serie recurrente',
    icon: RefreshCw,
    category: 'Incremento de Ingresos',
    summary: 'Un ingreso o gasto que se repite',
    accent: 'oklch(58% 0.21 295)',
  },
  {
    id: 'installment_plan',
    label: 'Parcialidades',
    icon: Layers,
    category: 'Diferimiento',
    summary: 'Dividir un total en varios pagos',
    accent: 'oklch(66% 0.18 65)',
  },
  {
    id: 'timing_shift',
    label: 'Adelantar / atrasar',
    icon: ArrowDownUp,
    category: 'Diferimiento',
    summary: 'Mover parte de un rubro en el tiempo',
    accent: 'oklch(60% 0.20 200)',
  },
  {
    id: 'pause_expense',
    label: 'Pausar gasto',
    icon: PauseCircle,
    category: 'Reducción de Costos',
    summary: 'Dejar un rubro en cero un rango',
    accent: 'oklch(58% 0.22 25)',
  },
];

const FREQUENCY_OPTIONS: { id: ProposalFrequency; label: string }[] = [
  { id: 'once', label: 'Solo una vez' },
  { id: 'monthly', label: 'Mensual' },
  { id: 'bimonthly', label: 'Bimestral' },
  { id: 'quarterly', label: 'Trimestral' },
  { id: 'semiannual', label: 'Semestral' },
  { id: 'annual', label: 'Anual' },
];

const CATEGORY_OPTIONS: ProposalCategory[] = [
  'Reducción de Costos',
  'Incremento de Ingresos',
  'Diferimiento',
  'Renegociación',
];

function firstDayOfYear(year: number): string {
  return `${year}-01`;
}

function emptyProposal(plan: FlowPlan): Proposal {
  const now = new Date().toISOString();
  return {
    id: `proposal-${Date.now()}`,
    name: '',
    description: '',
    category: 'Reducción de Costos',
    type: 'percent_adjustment',
    targetIds: [ROLE_TARGET_EXPENSE],
    startYearMonth: firstDayOfYear(plan.year),
    frequency: 'monthly',
    operation: 'decrease',
    percent: 10,
    amount: undefined,
    installments: 3,
    shiftMonths: 1,
    shiftRatio: 1,
    effects: [],
    createdAt: now,
    updatedAt: now,
  };
}

function suggestedTargets(type: ProposalType): string[] {
  switch (type) {
    case 'percent_adjustment':
    case 'pause_expense':
      return [ROLE_TARGET_EXPENSE];
    case 'amount_adjustment':
    case 'recurring_series':
      return [ROLE_TARGET_INCOME];
    case 'installment_plan':
      return [ROLE_TARGET_PROVIDER_PAYMENTS];
    case 'timing_shift':
      return [ROLE_TARGET_COLLECTIONS];
  }
}

function suggestedOperation(type: ProposalType): ProposalOperation {
  if (type === 'pause_expense') return 'decrease';
  if (type === 'percent_adjustment') return 'decrease';
  return 'increase';
}

export default function ProposalDrawer(props: ProposalDrawerProps) {
  if (typeof document === 'undefined') return null;
  return createPortal(<ProposalDrawerBody {...props} />, document.body);
}

function ProposalDrawerBody({
  plan,
  proposal,
  onClose,
  onSave,
  onDelete,
}: ProposalDrawerProps) {
  const [form, setForm] = useState<Proposal>(() => proposal ?? emptyProposal(plan));
  const isEdit = Boolean(proposal);

  useEffect(() => {
    setForm(proposal ?? emptyProposal(plan));
  }, [proposal, plan]);

  const targetOptions = useMemo(() => getProposalTargetOptions(plan), [plan]);
  const activeType = TYPE_OPTIONS.find((t) => t.id === form.type) ?? TYPE_OPTIONS[0];

  // Lock body scroll while the drawer is open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const update = (patch: Partial<Proposal>) => {
    setForm((prev) => ({ ...prev, ...patch, updatedAt: new Date().toISOString() }));
  };

  const handleChangeType = (type: ProposalType) => {
    const option = TYPE_OPTIONS.find((t) => t.id === type);
    update({
      type,
      category: option?.category ?? form.category,
      targetIds: form.targetIds.length > 0 ? form.targetIds : suggestedTargets(type),
      operation: suggestedOperation(type),
    });
  };

  const toggleTarget = (id: string) => {
    const exists = form.targetIds.includes(id);
    update({
      targetIds: exists ? form.targetIds.filter((t) => t !== id) : [...form.targetIds, id],
    });
  };

  const canSave = form.name.trim().length > 0 && form.targetIds.length > 0;

  const handleSave = () => {
    if (!canSave) return;
    const compiled: Proposal = {
      ...form,
      name: form.name.trim(),
      description: form.description.trim(),
      effects: buildProposalEffects(plan, form),
    };
    onSave(compiled);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const categoryColor = CATEGORY_COLORS[form.category];

  // Short label for the main parameter — used in the summary header.
  const paramPreview = (() => {
    switch (form.type) {
      case 'percent_adjustment':
        return `${form.operation === 'increase' ? '+' : '−'}${form.percent ?? 0}%`;
      case 'amount_adjustment':
      case 'recurring_series':
      case 'installment_plan':
        return `$${Number(form.amount ?? 0).toLocaleString('es-MX')}`;
      case 'timing_shift': {
        const m = form.shiftMonths ?? 0;
        return `${m > 0 ? `+${m}` : m} mes${Math.abs(m) === 1 ? '' : 'es'}`;
      }
      case 'pause_expense':
        return 'Pausado';
    }
  })();

  return (
    <div
      className="fixed inset-0 z-[1000] flex justify-end"
      role="dialog"
      aria-modal="true"
      aria-label={isEdit ? 'Editar propuesta' : 'Nueva propuesta'}
    >
      {/* Backdrop — covers the entire viewport including the sticky header */}
      <div
        onClick={onClose}
        className="absolute inset-0 bg-[oklch(20%_0.02_255_/_0.45)] backdrop-blur-[6px] animate-fade-in"
      />

      {/* Drawer */}
      <aside
        className="relative flex h-full w-full max-w-[560px] flex-col border-l border-[var(--gray-200)] bg-[var(--gray-50)] shadow-[-20px_0_60px_-20px_oklch(20%_0.02_255_/_0.4)]"
        style={{ animation: 'slideInRight 0.32s var(--spring) both' }}
      >
        {/* ── Header ── */}
        <header
          className="relative flex items-start justify-between gap-3 border-b border-[var(--gray-200)] bg-white px-6 pb-5 pt-6"
          style={{
            backgroundImage: `linear-gradient(135deg, ${categoryColor}10 0%, white 55%)`,
          }}
        >
          <div className="flex items-start gap-3.5 min-w-0">
            <div
              className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-2xl shadow-[0_2px_8px_-2px_oklch(20%_0.02_255_/_0.15)]"
              style={{
                background: `linear-gradient(135deg, ${categoryColor}20, ${categoryColor}08)`,
                color: categoryColor,
              }}
            >
              <activeType.icon className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <Sparkles className="h-3 w-3" style={{ color: categoryColor }} />
                <p
                  className="text-[10px] font-bold uppercase tracking-[0.12em]"
                  style={{ color: categoryColor }}
                >
                  {isEdit ? 'Editar propuesta' : 'Nueva propuesta'}
                </p>
              </div>
              <h2 className="mt-0.5 truncate text-[19px] font-semibold tracking-tight text-[var(--gray-950)]">
                {form.name.trim() || (
                  <span className="text-[var(--gray-400)]">Sin título</span>
                )}
              </h2>
              <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11.5px]">
                <span className="text-[var(--gray-500)]">{activeType.label}</span>
                <ChevronRight className="h-3 w-3 text-[var(--gray-300)]" />
                <span
                  className="rounded-md px-1.5 py-0.5 font-semibold"
                  style={{ background: `${categoryColor}15`, color: categoryColor }}
                >
                  {paramPreview}
                </span>
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Cerrar"
            className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-xl text-[var(--gray-400)] transition hover:bg-[var(--gray-100)] hover:text-[var(--gray-700)]"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        {/* ── Body (scrollable) ── */}
        <div className="flex-1 overflow-y-auto">
          <div className="space-y-4 px-5 py-5">
            {/* Step 1: type */}
            <SectionCard
              step={1}
              title="¿Qué tipo de ajuste?"
              subtitle="Elige la mecánica que más se parece a lo que quieres modelar."
            >
              <div className="grid grid-cols-2 gap-2.5">
                {TYPE_OPTIONS.map((opt) => {
                  const active = form.type === opt.id;
                  const Icon = opt.icon;
                  return (
                    <button
                      key={opt.id}
                      onClick={() => handleChangeType(opt.id)}
                      className="group relative flex flex-col gap-2.5 rounded-2xl border p-3.5 text-left transition"
                      style={
                        active
                          ? {
                              borderColor: opt.accent,
                              background: `${opt.accent}08`,
                              boxShadow: `0 0 0 1px ${opt.accent}, 0 6px 16px -8px ${opt.accent}40`,
                            }
                          : {
                              borderColor: 'var(--gray-200)',
                              background: 'white',
                            }
                      }
                    >
                      <div
                        className="flex h-10 w-10 items-center justify-center rounded-xl transition"
                        style={{
                          background: active ? opt.accent : `${opt.accent}15`,
                          color: active ? 'white' : opt.accent,
                        }}
                      >
                        <Icon className="h-[18px] w-[18px]" />
                      </div>
                      <div>
                        <p
                          className="text-[13px] font-semibold leading-tight"
                          style={{ color: active ? opt.accent : 'var(--gray-950)' }}
                        >
                          {opt.label}
                        </p>
                        <p className="mt-0.5 text-[11px] leading-snug text-[var(--gray-500)]">
                          {opt.summary}
                        </p>
                      </div>
                      {active && (
                        <div
                          className="absolute right-2.5 top-2.5 flex h-5 w-5 items-center justify-center rounded-full shadow-sm"
                          style={{ background: opt.accent }}
                        >
                          <Check className="h-3 w-3 text-white" strokeWidth={3} />
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            </SectionCard>

            {/* Step 2: targets */}
            <SectionCard
              step={2}
              title="¿En qué rubros aplica?"
              subtitle="Agregado global (ingresos / egresos) o conceptos específicos del plan."
            >
              {form.targetIds.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {form.targetIds.map((id) => {
                    const label =
                      ROLE_TARGET_LABELS[id] ??
                      targetOptions.find((o) => o.id === id)?.label ??
                      id;
                    return (
                      <span
                        key={id}
                        className="inline-flex items-center gap-1.5 rounded-full bg-[var(--primary-muted)] px-2.5 py-1 text-[11px] font-medium text-[var(--primary)]"
                      >
                        {label}
                        <button
                          onClick={() => toggleTarget(id)}
                          aria-label={`Quitar ${label}`}
                          className="flex h-3.5 w-3.5 items-center justify-center rounded-full hover:bg-[var(--primary)]/15"
                        >
                          <X className="h-2.5 w-2.5" />
                        </button>
                      </span>
                    );
                  })}
                </div>
              )}
              <TargetSelector
                options={targetOptions}
                selected={form.targetIds}
                onToggle={toggleTarget}
              />
            </SectionCard>

            {/* Step 3: parameters */}
            <SectionCard
              step={3}
              title="Parámetros del ajuste"
              subtitle="Define el número, el tiempo y la frecuencia."
            >
              {/* Operation */}
              {form.type !== 'pause_expense' && form.type !== 'timing_shift' && (
                <FieldGroup label="Dirección">
                  <div className="grid grid-cols-2 gap-1 rounded-xl border border-[var(--gray-200)] bg-white p-1">
                    {(
                      [
                        {
                          op: 'increase' as const,
                          label: 'Aumentar',
                          Icon: TrendingUp,
                          color: 'oklch(62% 0.19 155)',
                        },
                        {
                          op: 'decrease' as const,
                          label: 'Disminuir',
                          Icon: TrendingDown,
                          color: 'oklch(58% 0.22 25)',
                        },
                      ]
                    ).map(({ op, label, Icon, color }) => {
                      const active = form.operation === op;
                      return (
                        <button
                          key={op}
                          onClick={() => update({ operation: op })}
                          className="flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-[12.5px] font-semibold transition"
                          style={
                            active
                              ? { background: color, color: 'white' }
                              : { color: 'var(--gray-500)' }
                          }
                        >
                          <Icon className="h-3.5 w-3.5" />
                          {label}
                        </button>
                      );
                    })}
                  </div>
                </FieldGroup>
              )}

              {/* Percent */}
              {form.type === 'percent_adjustment' && (
                <NumberField
                  label="Porcentaje"
                  suffix="%"
                  value={form.percent ?? 0}
                  onChange={(v) => update({ percent: v })}
                  hint="Aplica mes a mes sobre la base."
                />
              )}

              {/* Amount */}
              {(form.type === 'amount_adjustment' ||
                form.type === 'recurring_series' ||
                form.type === 'installment_plan') && (
                <NumberField
                  label="Monto"
                  suffix="MXN"
                  value={form.amount ?? 0}
                  onChange={(v) => update({ amount: v })}
                />
              )}

              {/* Installments */}
              {form.type === 'installment_plan' && (
                <NumberField
                  label="Número de parcialidades"
                  suffix="pagos"
                  value={form.installments ?? 1}
                  onChange={(v) =>
                    update({ installments: Math.max(1, Math.round(v)) })
                  }
                  integer
                />
              )}

              {/* Timing shift */}
              {form.type === 'timing_shift' && (
                <>
                  <NumberField
                    label="Meses a mover"
                    suffix="meses"
                    value={form.shiftMonths ?? 0}
                    onChange={(v) => update({ shiftMonths: Math.round(v) })}
                    integer
                    allowNegative
                    hint="+ adelanta · − atrasa"
                  />
                  <NumberField
                    label="Porción del rubro a mover"
                    suffix="%"
                    value={Math.round((form.shiftRatio ?? 1) * 100)}
                    onChange={(v) =>
                      update({ shiftRatio: Math.max(0, Math.min(1, v / 100)) })
                    }
                  />
                </>
              )}

              {/* Frequency */}
              {form.type !== 'amount_adjustment' && form.type !== 'pause_expense' && (
                <FieldGroup label="Frecuencia">
                  <select
                    value={form.frequency ?? 'monthly'}
                    onChange={(e) =>
                      update({ frequency: e.target.value as ProposalFrequency })
                    }
                    className="w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 py-2.5 text-[13px] font-medium text-[var(--gray-950)] outline-none transition focus:border-[var(--primary)] focus:shadow-[0_0_0_3px_var(--primary-muted)]"
                  >
                    {FREQUENCY_OPTIONS.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                </FieldGroup>
              )}

              {/* Dates */}
              <div className="grid grid-cols-2 gap-3">
                <FieldGroup label="Desde">
                  <input
                    type="month"
                    value={form.startYearMonth}
                    onChange={(e) => update({ startYearMonth: e.target.value })}
                    className="w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 py-2.5 text-[13px] font-medium text-[var(--gray-950)] outline-none transition focus:border-[var(--primary)] focus:shadow-[0_0_0_3px_var(--primary-muted)]"
                  />
                </FieldGroup>
                <FieldGroup label="Hasta (opcional)">
                  <input
                    type="month"
                    value={form.endYearMonth ?? ''}
                    onChange={(e) =>
                      update({
                        endYearMonth: e.target.value ? e.target.value : undefined,
                      })
                    }
                    className="w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 py-2.5 text-[13px] font-medium text-[var(--gray-950)] outline-none transition focus:border-[var(--primary)] focus:shadow-[0_0_0_3px_var(--primary-muted)]"
                  />
                </FieldGroup>
              </div>
            </SectionCard>

            {/* Step 4: identity */}
            <SectionCard
              step={4}
              title="Nombre y categoría"
              subtitle="Cómo reconocerás esta propuesta en la biblioteca."
            >
              <FieldGroup label="Nombre">
                <input
                  type="text"
                  value={form.name}
                  onChange={(e) => update({ name: e.target.value })}
                  placeholder="Ej: Recorte flota 15%, Cobranza anticipada Q3…"
                  className="w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 py-2.5 text-[13px] font-medium text-[var(--gray-950)] outline-none transition placeholder:font-normal placeholder:text-[var(--gray-400)] focus:border-[var(--primary)] focus:shadow-[0_0_0_3px_var(--primary-muted)]"
                />
              </FieldGroup>
              <FieldGroup label="Categoría">
                <div className="flex flex-wrap gap-1.5">
                  {CATEGORY_OPTIONS.map((cat) => {
                    const active = form.category === cat;
                    const color = CATEGORY_COLORS[cat];
                    return (
                      <button
                        key={cat}
                        onClick={() => update({ category: cat })}
                        className="flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[11.5px] font-medium transition"
                        style={
                          active
                            ? { borderColor: 'transparent', background: `${color}18`, color }
                            : { borderColor: 'var(--gray-200)', background: 'white', color: 'var(--gray-700)' }
                        }
                      >
                        <div
                          className="h-2 w-2 rounded-full"
                          style={{ background: color }}
                        />
                        {cat}
                      </button>
                    );
                  })}
                </div>
              </FieldGroup>
              <FieldGroup label="Notas (opcional)">
                <textarea
                  value={form.description}
                  onChange={(e) => update({ description: e.target.value })}
                  placeholder="Contexto, supuestos, origen del número…"
                  rows={3}
                  className="w-full resize-none rounded-xl border border-[var(--gray-200)] bg-white px-3 py-2.5 text-[13px] text-[var(--gray-950)] outline-none transition placeholder:text-[var(--gray-400)] focus:border-[var(--primary)] focus:shadow-[0_0_0_3px_var(--primary-muted)]"
                />
              </FieldGroup>
            </SectionCard>

            <div className="h-2" />
          </div>
        </div>

        {/* ── Footer ── */}
        <footer className="flex items-center justify-between gap-3 border-t border-[var(--gray-200)] bg-white px-5 py-3.5">
          <div>
            {isEdit && onDelete && (
              <button
                onClick={() => {
                  if (confirm(`¿Eliminar la propuesta "${form.name}"?`)) {
                    onDelete();
                  }
                }}
                className="flex items-center gap-1.5 rounded-xl border border-[var(--gray-200)] bg-white px-3 py-2 text-[12.5px] font-medium text-[var(--danger)] transition hover:border-[var(--danger)]/30 hover:bg-[var(--danger)]/5"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Eliminar
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="rounded-xl border border-[var(--gray-200)] bg-white px-4 py-2 text-[13px] font-medium text-[var(--gray-700)] transition hover:bg-[var(--gray-50)]"
            >
              Cancelar
            </button>
            <button
              onClick={handleSave}
              disabled={!canSave}
              className="rounded-xl bg-[var(--primary)] px-4 py-2 text-[13px] font-semibold text-white shadow-[0_2px_8px_oklch(55%_0.22_255_/_0.25)] transition hover:bg-[var(--primary-hover)] disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
            >
              {isEdit ? 'Guardar cambios' : 'Crear propuesta'}
            </button>
          </div>
        </footer>
      </aside>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Sub-componentes
// ═════════════════════════════════════════════════════════════════════════════

function SectionCard({
  step,
  title,
  subtitle,
  children,
}: {
  step: number;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-[var(--gray-200)] bg-white p-4 shadow-[0_1px_2px_oklch(20%_0.01_255_/_0.04)]">
      <header className="mb-3.5 flex items-start gap-2.5">
        <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-xl bg-[var(--gray-950)] text-[12px] font-bold text-white">
          {step}
        </div>
        <div>
          <h3 className="text-[14px] font-semibold leading-tight tracking-tight text-[var(--gray-950)]">
            {title}
          </h3>
          {subtitle && (
            <p className="mt-0.5 text-[11.5px] leading-snug text-[var(--gray-500)]">
              {subtitle}
            </p>
          )}
        </div>
      </header>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function FieldGroup({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="mb-1.5 block text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[var(--gray-500)]">
        {label}
      </label>
      {children}
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
  suffix = '',
  integer,
  allowNegative,
  hint,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  suffix?: string;
  integer?: boolean;
  allowNegative?: boolean;
  hint?: string;
}) {
  return (
    <FieldGroup label={label}>
      <div className="relative">
        <input
          type="number"
          step={integer ? 1 : 'any'}
          min={allowNegative ? undefined : 0}
          value={Number.isFinite(value) ? value : 0}
          onChange={(e) => {
            const n = Number(e.target.value);
            onChange(Number.isNaN(n) ? 0 : n);
          }}
          className={`w-full rounded-xl border border-[var(--gray-200)] bg-white py-2.5 pl-3 text-[13px] font-semibold text-[var(--gray-950)] outline-none transition focus:border-[var(--primary)] focus:shadow-[0_0_0_3px_var(--primary-muted)] ${
            suffix ? 'pr-16' : 'pr-3'
          }`}
        />
        {suffix && (
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[11px] font-semibold uppercase tracking-wide text-[var(--gray-400)]">
            {suffix}
          </span>
        )}
      </div>
      {hint && <p className="mt-1 text-[10.5px] text-[var(--gray-400)]">{hint}</p>}
    </FieldGroup>
  );
}

function TargetSelector({
  options,
  selected,
  onToggle,
}: {
  options: { id: string; label: string; group: 'roles' | 'concepts' }[];
  selected: string[];
  onToggle: (id: string) => void;
}) {
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q));
  }, [options, query]);

  const roles = filtered.filter((o) => o.group === 'roles');
  const concepts = filtered.filter((o) => o.group === 'concepts');

  return (
    <div className="overflow-hidden rounded-xl border border-[var(--gray-200)] bg-white">
      <div className="flex items-center gap-2 border-b border-[var(--gray-200)] bg-[var(--gray-50)] px-3 py-2">
        <Search className="h-3.5 w-3.5 text-[var(--gray-400)]" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar rubro…"
          className="w-full bg-transparent text-[12.5px] outline-none placeholder:text-[var(--gray-400)]"
        />
      </div>
      <div className="max-h-[220px] overflow-y-auto p-1.5">
        {roles.length > 0 && (
          <div className="mb-1">
            <p className="px-2 pb-1 pt-1.5 text-[9.5px] font-semibold uppercase tracking-[0.1em] text-[var(--gray-400)]">
              Agregados globales
            </p>
            {roles.map((o) => (
              <TargetRow
                key={o.id}
                label={ROLE_TARGET_LABELS[o.id] ?? o.label}
                active={selected.includes(o.id)}
                onClick={() => onToggle(o.id)}
              />
            ))}
          </div>
        )}
        {concepts.length > 0 && (
          <div>
            <p className="px-2 pb-1 pt-1.5 text-[9.5px] font-semibold uppercase tracking-[0.1em] text-[var(--gray-400)]">
              Conceptos del plan
            </p>
            {concepts.map((o) => (
              <TargetRow
                key={o.id}
                label={o.label}
                active={selected.includes(o.id)}
                onClick={() => onToggle(o.id)}
              />
            ))}
          </div>
        )}
        {filtered.length === 0 && (
          <p className="px-3 py-6 text-center text-[11.5px] text-[var(--gray-400)]">
            Sin coincidencias.
          </p>
        )}
      </div>
    </div>
  );
}

function TargetRow({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-[12.5px] transition ${
        active
          ? 'bg-[var(--primary-muted)] text-[var(--primary)]'
          : 'text-[var(--gray-700)] hover:bg-[var(--gray-50)]'
      }`}
    >
      <div
        className={`flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-md border transition ${
          active
            ? 'border-[var(--primary)] bg-[var(--primary)]'
            : 'border-[var(--gray-300)] bg-white'
        }`}
      >
        {active && <Check className="h-3 w-3 text-white" strokeWidth={3} />}
      </div>
      <span className={`truncate ${active ? 'font-medium' : ''}`}>{label}</span>
    </button>
  );
}
