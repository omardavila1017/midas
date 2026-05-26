import React, { useEffect, useState } from 'react';
import { Modal } from '../../../components/ui/Modal';
import type { CustomKpi, KpiUnit } from '../types';

interface Props {
  open: boolean;
  initial?: CustomKpi | null;
  onClose: () => void;
  onSubmit: (input: CustomKpiInput) => void;
}

export interface CustomKpiInput {
  id?: string;
  name: string;
  description?: string;
  unit: KpiUnit;
  manualValue?: number;
  manualValueDate?: string;
}

const UNIT_OPTIONS: { value: KpiUnit; label: string }[] = [
  { value: 'MXN', label: 'Pesos (MXN)' },
  { value: 'count', label: 'Conteo' },
  { value: 'pct', label: 'Porcentaje (0–1)' },
  { value: 'days', label: 'Días' },
];

export function CustomKpiEditor({ open, initial, onClose, onSubmit }: Props) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [unit, setUnit] = useState<KpiUnit>('MXN');
  const [valueStr, setValueStr] = useState('');
  const [date, setDate] = useState('');

  useEffect(() => {
    if (!open) return;
    setName(initial?.name ?? '');
    setDescription(initial?.description ?? '');
    setUnit(initial?.unit ?? 'MXN');
    setValueStr(initial?.manualValue !== undefined ? String(initial.manualValue) : '');
    setDate(initial?.manualValueDate ?? new Date().toISOString().slice(0, 10));
  }, [open, initial]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) return;
    const numeric = valueStr.trim() === '' ? undefined : Number(valueStr);
    onSubmit({
      id: initial?.id,
      name: trimmedName,
      description: description.trim() || undefined,
      unit,
      manualValue: Number.isFinite(numeric) ? numeric : undefined,
      manualValueDate: date || undefined,
    });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={initial ? 'Editar KPI custom' : 'Nuevo KPI custom'}
      description="Define un indicador con un valor manual. Puedes ligarlo a un objetivo después."
      size="md"
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
            form="custom-kpi-form"
            className="rounded-[var(--radius-md)] px-3 py-1.5 text-[12px] font-medium text-white"
            style={{ background: 'var(--accent-blue, var(--gray-900))' }}
          >
            Guardar
          </button>
        </div>
      }
    >
      <form id="custom-kpi-form" onSubmit={submit} className="space-y-3 px-5 py-4">
        <Field label="Nombre">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            className="w-full rounded-[var(--radius-md)] border px-3 py-2 text-[13px]"
            style={{ borderColor: 'var(--gray-300)' }}
            placeholder="ej. Días promedio de cobro"
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
        <div className="grid grid-cols-2 gap-3">
          <Field label="Unidad">
            <select
              value={unit}
              onChange={(e) => setUnit(e.target.value as KpiUnit)}
              className="w-full rounded-[var(--radius-md)] border px-3 py-2 text-[13px]"
              style={{ borderColor: 'var(--gray-300)' }}
            >
              {UNIT_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </Field>
          <Field label="Valor actual">
            <input
              type="number"
              step="any"
              value={valueStr}
              onChange={(e) => setValueStr(e.target.value)}
              className="w-full rounded-[var(--radius-md)] border px-3 py-2 text-[13px] tabular-nums"
              style={{ borderColor: 'var(--gray-300)' }}
              placeholder="0"
            />
          </Field>
        </div>
        <Field label="Fecha del valor">
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="w-full rounded-[var(--radius-md)] border px-3 py-2 text-[13px]"
            style={{ borderColor: 'var(--gray-300)' }}
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
