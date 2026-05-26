import React, { useEffect, useState } from 'react';
import { Modal } from '../../../components/ui/Modal';
import type {
  Comparison,
  KpiRow,
  NumericConcept,
  Objective,
  ObjectiveKind,
} from '../types';

interface Props {
  open: boolean;
  initial?: Objective | null;
  kpiRows: KpiRow[];
  onClose: () => void;
  onSubmit: (input: ObjectiveInput) => void;
}

export interface ObjectiveInput {
  id?: string;
  name: string;
  description?: string;
  kind: ObjectiveKind;
  numericConcept?: NumericConcept;
  targetYearMonth?: string;
  targetAmount?: number;
  comparison?: Comparison;
  linkedKpiKey?: string;
  threshold?: number;
  dueDate?: string;
  notes?: string;
}

const KIND_OPTIONS: { value: ObjectiveKind; label: string; help: string }[] = [
  { value: 'NUMERIC_MONTHLY', label: 'Numérico mensual', help: 'Compara cobranza, egresos o saldo de cierre contra un monto en un mes.' },
  { value: 'KPI_THRESHOLD', label: 'Umbral de KPI', help: 'Toma un KPI y verifica si está por encima/debajo de un umbral.' },
  { value: 'QUALITATIVE', label: 'Hito cualitativo', help: 'Hito sin métrica. Se marca a mano cuando se cumple.' },
];

const COMPARISON_OPTIONS: { value: Comparison; label: string }[] = [
  { value: 'GTE', label: '≥ (mayor o igual)' },
  { value: 'LTE', label: '≤ (menor o igual)' },
  { value: 'EQ', label: '= (igual)' },
];

const CONCEPT_OPTIONS: { value: NumericConcept; label: string }[] = [
  { value: 'INFLOW', label: 'Cobranza (ingresos)' },
  { value: 'OUTFLOW', label: 'Egresos bancarios' },
  { value: 'CASH_CLOSE', label: 'Saldo de cierre de bancos' },
];

export function ObjectiveEditor({ open, initial, kpiRows, onClose, onSubmit }: Props) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [kind, setKind] = useState<ObjectiveKind>('NUMERIC_MONTHLY');
  const [numericConcept, setNumericConcept] = useState<NumericConcept>('INFLOW');
  const [targetYearMonth, setTargetYearMonth] = useState('');
  const [targetAmountStr, setTargetAmountStr] = useState('');
  const [comparison, setComparison] = useState<Comparison>('GTE');
  const [linkedKpiKey, setLinkedKpiKey] = useState('');
  const [thresholdStr, setThresholdStr] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [notes, setNotes] = useState('');

  useEffect(() => {
    if (!open) return;
    setName(initial?.name ?? '');
    setDescription(initial?.description ?? '');
    setKind(initial?.kind ?? 'NUMERIC_MONTHLY');
    setNumericConcept(initial?.numericConcept ?? 'INFLOW');
    setTargetYearMonth(initial?.targetYearMonth ?? new Date().toISOString().slice(0, 7));
    setTargetAmountStr(initial?.targetAmount !== undefined ? String(initial.targetAmount) : '');
    setComparison(initial?.comparison ?? 'GTE');
    setLinkedKpiKey(initial?.linkedKpiKey ?? (kpiRows[0]?.key ?? ''));
    setThresholdStr(initial?.threshold !== undefined ? String(initial.threshold) : '');
    setDueDate(initial?.dueDate ?? '');
    setNotes(initial?.notes ?? '');
  }, [open, initial, kpiRows]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    const parseNum = (s: string): number | undefined => {
      if (s.trim() === '') return undefined;
      const n = Number(s);
      return Number.isFinite(n) ? n : undefined;
    };
    onSubmit({
      id: initial?.id,
      name: trimmed,
      description: description.trim() || undefined,
      kind,
      numericConcept: kind === 'NUMERIC_MONTHLY' ? numericConcept : undefined,
      targetYearMonth: kind === 'NUMERIC_MONTHLY' ? targetYearMonth : undefined,
      targetAmount: kind === 'NUMERIC_MONTHLY' ? parseNum(targetAmountStr) : undefined,
      comparison: kind === 'NUMERIC_MONTHLY' || kind === 'KPI_THRESHOLD' ? comparison : undefined,
      linkedKpiKey: kind === 'KPI_THRESHOLD' ? linkedKpiKey : undefined,
      threshold: kind === 'KPI_THRESHOLD' ? parseNum(thresholdStr) : undefined,
      dueDate: kind === 'QUALITATIVE' ? dueDate || undefined : undefined,
      notes: notes.trim() || undefined,
    });
  };

  const kindHelp = KIND_OPTIONS.find((opt) => opt.value === kind)?.help;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={initial ? 'Editar objetivo' : 'Nuevo objetivo'}
      description="Define qué quieres lograr y cómo medirlo. Puedes forzar el estado luego desde la tabla."
      size="lg"
      footer={
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-[var(--radius-md)] border px-3 py-1.5 text-[12px] font-medium"
            style={{ borderColor: 'var(--gray-300)', color: 'var(--gray-700)' }}
          >
            Cancelar
          </button>
          <button
            type="submit"
            form="objective-form"
            className="rounded-[var(--radius-md)] px-3 py-1.5 text-[12px] font-medium text-white"
            style={{ background: 'var(--accent-blue, var(--gray-900))' }}
          >
            Guardar
          </button>
        </div>
      }
    >
      <form id="objective-form" onSubmit={submit} className="space-y-4 px-5 py-4">
        <Field label="Nombre">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            className="w-full rounded-[var(--radius-md)] border px-3 py-2 text-[13px]"
            style={{ borderColor: 'var(--gray-300)' }}
            placeholder="ej. Cobrar al menos $50M en mayo"
          />
        </Field>

        <Field label="Descripción (opcional)">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            className="w-full rounded-[var(--radius-md)] border px-3 py-2 text-[13px]"
            style={{ borderColor: 'var(--gray-300)' }}
          />
        </Field>

        <Field label="Tipo de objetivo">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {KIND_OPTIONS.map((opt) => (
              <label
                key={opt.value}
                className="flex cursor-pointer items-start gap-2 rounded-[var(--radius-md)] border p-2 text-[12px]"
                style={{
                  borderColor: kind === opt.value ? 'var(--accent-blue, var(--gray-900))' : 'var(--gray-300)',
                  background: kind === opt.value ? 'var(--gray-50)' : 'var(--surface)',
                }}
              >
                <input
                  type="radio"
                  name="objective-kind"
                  value={opt.value}
                  checked={kind === opt.value}
                  onChange={() => setKind(opt.value)}
                  className="mt-0.5"
                />
                <span>
                  <div className="font-medium" style={{ color: 'var(--gray-950)' }}>{opt.label}</div>
                  <div className="mt-0.5 leading-snug" style={{ color: 'var(--gray-500)' }}>{opt.help}</div>
                </span>
              </label>
            ))}
          </div>
          {kindHelp && (
            <p className="mt-1 text-[11px] leading-snug" style={{ color: 'var(--gray-500)' }}>{kindHelp}</p>
          )}
        </Field>

        {kind === 'NUMERIC_MONTHLY' && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Concepto">
              <select
                value={numericConcept}
                onChange={(e) => setNumericConcept(e.target.value as NumericConcept)}
                className="w-full rounded-[var(--radius-md)] border px-3 py-2 text-[13px]"
                style={{ borderColor: 'var(--gray-300)' }}
              >
                {CONCEPT_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </Field>
            <Field label="Mes objetivo (YYYY-MM)">
              <input
                type="month"
                value={targetYearMonth}
                onChange={(e) => setTargetYearMonth(e.target.value)}
                className="w-full rounded-[var(--radius-md)] border px-3 py-2 text-[13px]"
                style={{ borderColor: 'var(--gray-300)' }}
              />
            </Field>
            <Field label="Comparación">
              <select
                value={comparison}
                onChange={(e) => setComparison(e.target.value as Comparison)}
                className="w-full rounded-[var(--radius-md)] border px-3 py-2 text-[13px]"
                style={{ borderColor: 'var(--gray-300)' }}
              >
                {COMPARISON_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </Field>
            <Field label="Monto meta (MXN)">
              <input
                type="number"
                step="any"
                value={targetAmountStr}
                onChange={(e) => setTargetAmountStr(e.target.value)}
                className="w-full rounded-[var(--radius-md)] border px-3 py-2 text-[13px] tabular-nums"
                style={{ borderColor: 'var(--gray-300)' }}
                placeholder="0"
              />
            </Field>
          </div>
        )}

        {kind === 'KPI_THRESHOLD' && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="KPI ligado">
              <select
                value={linkedKpiKey}
                onChange={(e) => setLinkedKpiKey(e.target.value)}
                className="w-full rounded-[var(--radius-md)] border px-3 py-2 text-[13px]"
                style={{ borderColor: 'var(--gray-300)' }}
              >
                {kpiRows.length === 0 && <option value="">— No hay KPIs —</option>}
                {kpiRows.map((row) => (
                  <option key={row.key} value={row.key}>{row.label}</option>
                ))}
              </select>
            </Field>
            <Field label="Comparación">
              <select
                value={comparison}
                onChange={(e) => setComparison(e.target.value as Comparison)}
                className="w-full rounded-[var(--radius-md)] border px-3 py-2 text-[13px]"
                style={{ borderColor: 'var(--gray-300)' }}
              >
                {COMPARISON_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </Field>
            <Field label="Umbral">
              <input
                type="number"
                step="any"
                value={thresholdStr}
                onChange={(e) => setThresholdStr(e.target.value)}
                className="w-full rounded-[var(--radius-md)] border px-3 py-2 text-[13px] tabular-nums"
                style={{ borderColor: 'var(--gray-300)' }}
              />
            </Field>
          </div>
        )}

        {kind === 'QUALITATIVE' && (
          <Field label="Fecha límite (opcional)">
            <input
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              className="w-full rounded-[var(--radius-md)] border px-3 py-2 text-[13px]"
              style={{ borderColor: 'var(--gray-300)' }}
            />
          </Field>
        )}

        <Field label="Notas (opcional)">
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            className="w-full rounded-[var(--radius-md)] border px-3 py-2 text-[13px]"
            style={{ borderColor: 'var(--gray-300)' }}
            placeholder="Contexto, dueño, blockers…"
          />
        </Field>
      </form>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] font-medium uppercase tracking-[0.06em]" style={{ color: 'var(--gray-500)' }}>
        {label}
      </span>
      {children}
    </label>
  );
}
