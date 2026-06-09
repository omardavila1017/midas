import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Check, ClipboardPaste, Pencil, Plus, RefreshCcw, Trash2, X } from 'lucide-react';
import { fmtCurrency, fmtDate } from '../../../formatters';
import type {
  ManualPlanningCategory,
  ManualPlanningEntry,
  ManualPlanningRecurrence,
} from '../../shared-finance/types';
import {
  MANUAL_PLANNING_CATEGORY_LABELS,
  MANUAL_PLANNING_RECURRENCE_LABELS,
} from '../services/manualPlanningEntries';
import {
  EXPECTED_COMMITMENT_CATEGORY_OPTIONS,
  EXPECTED_COMMITMENT_RECURRENCE_OPTIONS,
  ExpectedCommitmentCategory,
  ExpectedCommitmentDraft,
  isExpectedCommitmentCategory,
  parseExpectedCommitmentsPaste,
} from '../services/expectedCommitments';

interface ExpectedCommitmentsPanelProps {
  entries: ManualPlanningEntry[];
  activeScenarioId: string;
  activeScenarioName: string;
  canEdit: boolean;
  defaultCompanyId?: string;
  today: string;
  onCreate: (input: ExpectedCommitmentDraft) => void;
  onBulkCreate: (inputs: ExpectedCommitmentDraft[]) => void;
  onUpdate: (entryId: string, patch: ExpectedCommitmentDraft) => void;
  onDelete: (entryId: string) => void;
  onToggleScenario: (entryId: string, enabled: boolean) => void;
  onMarkReplaced: (entryId: string) => void;
}

interface FormState {
  name: string;
  category: ExpectedCommitmentCategory;
  amount: string;
  startDate: string;
  recurrence: ManualPlanningRecurrence;
  companyId: string;
}

const EMPTY_PASTE = 'Concepto\tCategoría\tMonto\tFecha\tRecurrencia\tCompañía';

export function ExpectedCommitmentsPanel(props: ExpectedCommitmentsPanelProps) {
  const {
    entries,
    activeScenarioId,
    activeScenarioName,
    canEdit,
    defaultCompanyId,
    today,
    onCreate,
    onBulkCreate,
    onUpdate,
    onDelete,
    onToggleScenario,
    onMarkReplaced,
  } = props;

  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(() => defaultForm(today, defaultCompanyId));
  const [formError, setFormError] = useState<string | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');

  const rows = useMemo(
    () => [...entries].sort((a, b) => {
      const aActive = isEntryActive(a, activeScenarioId);
      const bActive = isEntryActive(b, activeScenarioId);
      if (a.replacedAt && !b.replacedAt) return 1;
      if (!a.replacedAt && b.replacedAt) return -1;
      if (aActive !== bActive) return aActive ? -1 : 1;
      if (a.startDate !== b.startDate) return a.startDate.localeCompare(b.startDate);
      return a.name.localeCompare(b.name, 'es-MX');
    }),
    [activeScenarioId, entries],
  );

  const activeEntries = rows.filter((entry) => isEntryActive(entry, activeScenarioId) && !entry.replacedAt);
  const activeTotal = activeEntries.reduce((sum, entry) => sum + entry.amount, 0);
  const replacedCount = rows.filter((entry) => entry.replacedAt).length;
  const pastePreview = useMemo(() => parseExpectedCommitmentsPaste(pasteText), [pasteText]);

  const resetForm = () => {
    setEditingId(null);
    setForm(defaultForm(today, defaultCompanyId));
    setFormError(null);
  };

  const beginEdit = (entry: ManualPlanningEntry) => {
    setEditingId(entry.id);
    setForm({
      name: entry.name,
      category: toExpectedCategory(entry.category),
      amount: String(entry.amount),
      startDate: entry.startDate,
      recurrence: entry.recurrence,
      companyId: entry.companyId ?? defaultCompanyId ?? '',
    });
    setFormError(null);
  };

  const submitForm = () => {
    const amount = parseFormAmount(form.amount);
    if (!form.name.trim()) {
      setFormError('El concepto es obligatorio.');
      return;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      setFormError('El monto debe ser mayor a cero.');
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(form.startDate)) {
      setFormError('La fecha debe tener formato válido.');
      return;
    }

    const draft: ExpectedCommitmentDraft = {
      name: form.name.trim(),
      category: form.category,
      amount,
      startDate: form.startDate,
      recurrence: form.recurrence,
      companyId: form.companyId.trim() || undefined,
    };

    try {
      if (editingId) onUpdate(editingId, draft);
      else onCreate(draft);
      resetForm();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'No se pudo guardar el compromiso.');
    }
  };

  const submitPaste = () => {
    if (pastePreview.drafts.length === 0) return;
    onBulkCreate(pastePreview.drafts.map((draft) => ({
      ...draft,
      companyId: draft.companyId ?? defaultCompanyId,
    })));
    setPasteText('');
    setPasteOpen(false);
  };

  return (
    <section className="rounded-2xl border border-[var(--gray-200)] bg-white">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--gray-200)] px-4 py-3">
        <div>
          <h2 className="text-[14px] font-semibold text-[var(--gray-950)]">Compromisos esperados</h2>
          <p className="mt-1 text-[12px] text-[var(--gray-500)]">
            {activeScenarioName} · {activeEntries.length} activo{activeEntries.length === 1 ? '' : 's'} · {fmtCurrency(activeTotal)}
            {replacedCount > 0 ? ` · ${replacedCount} reemplazado${replacedCount === 1 ? '' : 's'}` : ''}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setPasteOpen((open) => !open)}
          disabled={!canEdit}
          className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-[var(--gray-200)] bg-white px-3 text-[12px] font-medium text-[var(--gray-700)] hover:bg-[var(--gray-50)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ClipboardPaste className="h-3.5 w-3.5" strokeWidth={1.5} />
          Pegar Excel
        </button>
      </header>

      <div className="grid grid-cols-1 gap-4 p-4 xl:grid-cols-[360px_minmax(0,1fr)]">
        <div className="space-y-3">
          <div className="rounded-xl border border-[var(--gray-200)] bg-[var(--gray-50)] p-3">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-[12px] font-semibold text-[var(--gray-950)]">
                {editingId ? 'Editar compromiso' : 'Nuevo compromiso'}
              </h3>
              {editingId && (
                <button
                  type="button"
                  onClick={resetForm}
                  className="inline-flex h-7 items-center gap-1 rounded-lg px-2 text-[11px] font-medium text-[var(--gray-500)] hover:bg-white hover:text-[var(--gray-700)]"
                >
                  <X className="h-3 w-3" strokeWidth={1.5} />
                  Limpiar
                </button>
              )}
            </div>

            <div className="grid gap-3">
              <label className="block">
                <span className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-[var(--gray-400)]">Concepto</span>
                <input
                  type="text"
                  value={form.name}
                  onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                  disabled={!canEdit}
                  className="h-10 w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 text-[13px] text-[var(--gray-950)] outline-none focus:border-[var(--primary)] disabled:bg-[var(--gray-100)]"
                  placeholder="Nómina semanal"
                />
              </label>

              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <span className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-[var(--gray-400)]">Categoría</span>
                  <select
                    value={form.category}
                    onChange={(event) => setForm((current) => ({ ...current, category: event.target.value as ExpectedCommitmentCategory }))}
                    disabled={!canEdit}
                    className="h-10 w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 text-[13px] text-[var(--gray-950)] outline-none focus:border-[var(--primary)] disabled:bg-[var(--gray-100)]"
                  >
                    {EXPECTED_COMMITMENT_CATEGORY_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>

                <label className="block">
                  <span className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-[var(--gray-400)]">Monto</span>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={form.amount}
                    onChange={(event) => setForm((current) => ({ ...current, amount: event.target.value }))}
                    disabled={!canEdit}
                    className="h-10 w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 text-right text-[13px] tabular-nums text-[var(--gray-950)] outline-none focus:border-[var(--primary)] disabled:bg-[var(--gray-100)]"
                    placeholder="0.00"
                  />
                </label>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <span className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-[var(--gray-400)]">Fecha</span>
                  <input
                    type="date"
                    value={form.startDate}
                    onChange={(event) => setForm((current) => ({ ...current, startDate: event.target.value }))}
                    disabled={!canEdit}
                    className="h-10 w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 text-[13px] text-[var(--gray-950)] outline-none focus:border-[var(--primary)] disabled:bg-[var(--gray-100)]"
                  />
                </label>

                <label className="block">
                  <span className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-[var(--gray-400)]">Recurrencia</span>
                  <select
                    value={form.recurrence}
                    onChange={(event) => setForm((current) => ({ ...current, recurrence: event.target.value as ManualPlanningRecurrence }))}
                    disabled={!canEdit}
                    className="h-10 w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 text-[13px] text-[var(--gray-950)] outline-none focus:border-[var(--primary)] disabled:bg-[var(--gray-100)]"
                  >
                    {EXPECTED_COMMITMENT_RECURRENCE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>
              </div>

              <label className="block">
                <span className="mb-1 block text-[10px] font-medium uppercase tracking-wider text-[var(--gray-400)]">Compañía</span>
                <input
                  type="text"
                  value={form.companyId}
                  onChange={(event) => setForm((current) => ({ ...current, companyId: event.target.value }))}
                  disabled={!canEdit}
                  className="h-10 w-full rounded-xl border border-[var(--gray-200)] bg-white px-3 text-[13px] text-[var(--gray-950)] outline-none focus:border-[var(--primary)] disabled:bg-[var(--gray-100)]"
                  placeholder="00001"
                />
              </label>
            </div>

            {formError && <p className="mt-2 text-[11px] font-medium text-[var(--danger)]">{formError}</p>}

            <button
              type="button"
              onClick={submitForm}
              disabled={!canEdit}
              className="mt-3 inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-xl bg-[var(--primary)] px-3 text-[12px] font-medium text-white hover:bg-[var(--primary-hover)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              {editingId ? <Check className="h-3.5 w-3.5" strokeWidth={1.5} /> : <Plus className="h-3.5 w-3.5" strokeWidth={1.5} />}
              {editingId ? 'Guardar cambios' : 'Agregar compromiso'}
            </button>
          </div>

          {pasteOpen && (
            <div className="rounded-xl border border-[var(--gray-200)] bg-white p-3">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-[12px] font-semibold text-[var(--gray-950)]">Captura masiva</h3>
                <span className="text-[11px] text-[var(--gray-400)]">{pastePreview.drafts.length} válidos</span>
              </div>
              <textarea
                value={pasteText}
                onChange={(event) => setPasteText(event.target.value)}
                placeholder={EMPTY_PASTE}
                className="h-32 w-full resize-none rounded-xl border border-[var(--gray-200)] bg-white p-3 font-mono text-[11px] leading-relaxed text-[var(--gray-950)] outline-none focus:border-[var(--primary)]"
              />
              {pastePreview.errors.length > 0 && (
                <ul className="mt-2 max-h-20 overflow-auto rounded-lg bg-[var(--warning-muted)] px-2 py-1.5 text-[11px] text-[var(--gray-700)]">
                  {pastePreview.errors.slice(0, 4).map((error) => <li key={error}>{error}</li>)}
                </ul>
              )}
              <button
                type="button"
                onClick={submitPaste}
                disabled={pastePreview.drafts.length === 0}
                className="mt-3 inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-xl bg-[var(--gray-950)] px-3 text-[12px] font-medium text-white hover:bg-[var(--gray-900)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                <ClipboardPaste className="h-3.5 w-3.5" strokeWidth={1.5} />
                Agregar {pastePreview.drafts.length}
              </button>
            </div>
          )}
        </div>

        <div className="overflow-hidden rounded-xl border border-[var(--gray-200)]">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px] text-left text-[12px]">
              <thead className="bg-[var(--gray-50)] text-[10px] uppercase tracking-wider text-[var(--gray-400)]">
                <tr>
                  <th className="px-3 py-2.5">Escenario</th>
                  <th className="px-3 py-2.5">Concepto</th>
                  <th className="px-3 py-2.5">Categoría</th>
                  <th className="px-3 py-2.5 text-right">Monto</th>
                  <th className="px-3 py-2.5">Fecha</th>
                  <th className="px-3 py-2.5">Recurrencia</th>
                  <th className="px-3 py-2.5">Compañía</th>
                  <th className="px-3 py-2.5 text-right">Acciones</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-4 py-10 text-center text-[12px] text-[var(--gray-400)]">
                      Sin compromisos esperados.
                    </td>
                  </tr>
                ) : (
                  rows.map((entry) => {
                    const active = isEntryActive(entry, activeScenarioId) && !entry.replacedAt;
                    const replaced = Boolean(entry.replacedAt);
                    return (
                      <tr key={entry.id} className="border-t border-[var(--gray-100)] align-middle hover:bg-[var(--gray-50)]/50">
                        <td className="px-3 py-3">
                          <ScenarioSwitch
                            checked={active}
                            disabled={!canEdit || replaced}
                            onChange={(checked) => onToggleScenario(entry.id, checked)}
                          />
                        </td>
                        <td className="px-3 py-3">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-[var(--gray-950)]">{entry.name}</span>
                            {replaced && <StatusPill label="Reemplazada" tone="muted" />}
                            {!replaced && entry.status === 'APPROVED' && <StatusPill label="Aprobada" tone="active" />}
                          </div>
                          {entry.replacedBySourceObjectId && (
                            <div className="mt-0.5 text-[10px] text-[var(--gray-400)]">{entry.replacedBySourceObjectId}</div>
                          )}
                        </td>
                        <td className="px-3 py-3 text-[var(--gray-700)]">{categoryLabel(entry.category)}</td>
                        <td className="px-3 py-3 text-right tabular-nums font-medium text-[var(--gray-950)]">{fmtCurrency(entry.amount)}</td>
                        <td className="px-3 py-3 text-[var(--gray-700)]">{formatDate(entry.startDate)}</td>
                        <td className="px-3 py-3 text-[var(--gray-700)]">{MANUAL_PLANNING_RECURRENCE_LABELS[entry.recurrence]}</td>
                        <td className="px-3 py-3 text-[var(--gray-700)]">{entry.companyId ?? '—'}</td>
                        <td className="px-3 py-3">
                          <div className="flex justify-end gap-1">
                            <IconButton
                              label="Editar"
                              disabled={!canEdit || replaced}
                              onClick={() => beginEdit(entry)}
                            >
                              <Pencil className="h-3.5 w-3.5" strokeWidth={1.5} />
                            </IconButton>
                            <IconButton
                              label="Marcar reemplazada por origen real"
                              disabled={!canEdit || replaced}
                              onClick={() => onMarkReplaced(entry.id)}
                            >
                              <RefreshCcw className="h-3.5 w-3.5" strokeWidth={1.5} />
                            </IconButton>
                            <IconButton
                              label="Eliminar"
                              disabled={!canEdit}
                              onClick={() => onDelete(entry.id)}
                            >
                              <Trash2 className="h-3.5 w-3.5" strokeWidth={1.5} />
                            </IconButton>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </section>
  );
}

function ScenarioSwitch({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="inline-flex h-6 w-10 items-center rounded-full border border-transparent p-0.5 transition-colors disabled:cursor-not-allowed disabled:opacity-40"
      style={{ background: checked ? 'var(--primary)' : 'var(--gray-200)' }}
    >
      <span
        className="h-5 w-5 rounded-full bg-white shadow-sm transition-transform"
        style={{ transform: checked ? 'translateX(16px)' : 'translateX(0)' }}
      />
    </button>
  );
}

function IconButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[var(--gray-200)] bg-white text-[var(--gray-500)] hover:bg-[var(--gray-50)] hover:text-[var(--gray-700)] disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function StatusPill({ label, tone }: { label: string; tone: 'active' | 'muted' }) {
  return (
    <span
      className="rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider"
      style={{
        background: tone === 'active' ? 'var(--success-muted)' : 'var(--gray-100)',
        color: tone === 'active' ? 'var(--success)' : 'var(--gray-500)',
      }}
    >
      {label}
    </span>
  );
}

function defaultForm(today: string, defaultCompanyId?: string): FormState {
  return {
    name: '',
    category: 'PAYROLL',
    amount: '',
    startDate: today,
    recurrence: 'ONE_TIME',
    companyId: defaultCompanyId ?? '',
  };
}

function parseFormAmount(value: string): number {
  return Number(value.replace(/,/g, ''));
}

function isEntryActive(entry: ManualPlanningEntry, scenarioId: string): boolean {
  return entry.scenarioIds.includes(scenarioId);
}

function toExpectedCategory(category: ManualPlanningCategory): ExpectedCommitmentCategory {
  return isExpectedCommitmentCategory(category) ? category : 'OTHER';
}

function categoryLabel(category: ManualPlanningCategory): string {
  return MANUAL_PLANNING_CATEGORY_LABELS[category] ?? category;
}

function formatDate(date: string): string {
  return fmtDate(`${date}T12:00:00`);
}
