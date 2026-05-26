import { useCallback, useEffect, useMemo, useState } from 'react';
import type { BankAccountStatement, BankStatementLine, CobranzaPayment } from '../../../services/jdeTypes';
import type { CXPRecord } from '../../../domain/persistence';
import { KpisTable } from '../components/KpisTable';
import { ObjectivesTable } from '../components/ObjectivesTable';
import { CustomKpiEditor, type CustomKpiInput } from '../components/CustomKpiEditor';
import { ObjectiveEditor, type ObjectiveInput } from '../components/ObjectiveEditor';
import { loadCustomKpis, saveCustomKpis } from '../services/customKpisStorage';
import { loadObjectives, saveObjectives } from '../services/objectivesStorage';
import { buildKpiRows } from '../services/kpiCatalog';
import { evaluateObjective } from '../services/objectiveEvaluator';
import type { CustomKpi, Objective, ObjectiveStatus } from '../types';

interface Props {
  bankStatements: BankAccountStatement[];
  cobranzaPayments: CobranzaPayment[];
  cxpRecords: CXPRecord[];
}

export default function KpisObjectivesDashboard({
  bankStatements,
  cobranzaPayments,
  cxpRecords,
}: Props) {
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const bankLines = useMemo<BankStatementLine[]>(
    () => bankStatements.flatMap((s) => s.movimientos ?? []),
    [bankStatements],
  );
  const [customKpis, setCustomKpis] = useState<CustomKpi[]>(() => loadCustomKpis());
  const [objectives, setObjectives] = useState<Objective[]>(() => loadObjectives());

  const [kpiEditorOpen, setKpiEditorOpen] = useState(false);
  const [editingKpiId, setEditingKpiId] = useState<string | null>(null);
  const [objectiveEditorOpen, setObjectiveEditorOpen] = useState(false);
  const [editingObjectiveId, setEditingObjectiveId] = useState<string | null>(null);

  useEffect(() => {
    saveCustomKpis(customKpis);
  }, [customKpis]);
  useEffect(() => {
    saveObjectives(objectives);
  }, [objectives]);

  const kpiRows = useMemo(
    () => buildKpiRows({ bankStatements: bankLines, cobranzaPayments, cxpRecords, today }, customKpis),
    [bankLines, cobranzaPayments, cxpRecords, today, customKpis],
  );

  const objectiveRows = useMemo(
    () =>
      objectives.map((objective) => ({
        objective,
        evaluation: evaluateObjective(objective, {
          bankStatements: bankLines,
          cobranzaPayments,
          kpiRows,
          today,
        }),
      })),
    [objectives, bankLines, cobranzaPayments, kpiRows, today],
  );

  const summary = useMemo(() => {
    const totals = { MET: 0, MISSED: 0, IN_PROGRESS: 0 };
    for (const row of objectiveRows) totals[row.evaluation.status] += 1;
    return totals;
  }, [objectiveRows]);

  // ── KPI custom CRUD ────────────────────────────────────────────────────────
  const openAddKpi = () => {
    setEditingKpiId(null);
    setKpiEditorOpen(true);
  };
  const openEditKpi = (id: string) => {
    setEditingKpiId(id);
    setKpiEditorOpen(true);
  };
  const submitKpi = useCallback((input: CustomKpiInput) => {
    setCustomKpis((prev) => {
      const now = new Date().toISOString();
      if (input.id) {
        return prev.map((k) =>
          k.id === input.id
            ? {
                ...k,
                name: input.name,
                description: input.description,
                unit: input.unit,
                manualValue: input.manualValue,
                manualValueDate: input.manualValueDate,
                updatedAt: now,
              }
            : k,
        );
      }
      const fresh: CustomKpi = {
        id: `custom-kpi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: input.name,
        description: input.description,
        unit: input.unit,
        manualValue: input.manualValue,
        manualValueDate: input.manualValueDate,
        createdAt: now,
        updatedAt: now,
      };
      return [...prev, fresh];
    });
    setKpiEditorOpen(false);
    setEditingKpiId(null);
  }, []);
  const deleteKpi = (id: string) => {
    if (!window.confirm('¿Borrar este KPI custom? También se desligará de los objetivos que lo usen.')) return;
    setCustomKpis((prev) => prev.filter((k) => k.id !== id));
    setObjectives((prev) =>
      prev.map((o) =>
        o.linkedKpiKey === `custom:${id}` ? { ...o, linkedKpiKey: undefined, updatedAt: new Date().toISOString() } : o,
      ),
    );
  };

  // ── Objetivos CRUD ─────────────────────────────────────────────────────────
  const openAddObjective = () => {
    setEditingObjectiveId(null);
    setObjectiveEditorOpen(true);
  };
  const openEditObjective = (id: string) => {
    setEditingObjectiveId(id);
    setObjectiveEditorOpen(true);
  };
  const submitObjective = useCallback((input: ObjectiveInput) => {
    setObjectives((prev) => {
      const now = new Date().toISOString();
      if (input.id) {
        return prev.map((o) =>
          o.id === input.id
            ? { ...o, ...(stripUndefined(input as unknown as Record<string, unknown>) as Partial<Objective>), updatedAt: now }
            : o,
        );
      }
      const fresh: Objective = {
        id: `objective-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: input.name,
        description: input.description,
        kind: input.kind,
        numericConcept: input.numericConcept,
        targetYearMonth: input.targetYearMonth,
        targetAmount: input.targetAmount,
        comparison: input.comparison,
        linkedKpiKey: input.linkedKpiKey,
        threshold: input.threshold,
        dueDate: input.dueDate,
        notes: input.notes,
        createdAt: now,
        updatedAt: now,
      };
      return [...prev, fresh];
    });
    setObjectiveEditorOpen(false);
    setEditingObjectiveId(null);
  }, []);
  const deleteObjective = (id: string) => {
    if (!window.confirm('¿Borrar este objetivo?')) return;
    setObjectives((prev) => prev.filter((o) => o.id !== id));
  };
  const changeManualStatus = (id: string, status: ObjectiveStatus | null) => {
    setObjectives((prev) =>
      prev.map((o) =>
        o.id === id ? { ...o, manualStatus: status ?? undefined, updatedAt: new Date().toISOString() } : o,
      ),
    );
  };

  const editingKpi = editingKpiId ? customKpis.find((k) => k.id === editingKpiId) ?? null : null;
  const editingObjective = editingObjectiveId
    ? objectives.find((o) => o.id === editingObjectiveId) ?? null
    : null;

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h1 className="text-[20px] font-semibold tracking-tight" style={{ color: 'var(--gray-950)' }}>
          KPIs y Objetivos
        </h1>
        <p className="text-[13px] leading-snug" style={{ color: 'var(--gray-600)' }}>
          Indicadores autocalculados a partir de los datos reales que ya cargó la app, KPIs custom
          definidos por ti, y objetivos con seguimiento automático cuando es posible.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <SummaryCard label="Cumplidos" value={summary.MET} tone="success" />
        <SummaryCard label="En progreso" value={summary.IN_PROGRESS} tone="warning" />
        <SummaryCard label="No cumplidos" value={summary.MISSED} tone="danger" />
      </div>

      <KpisTable
        rows={kpiRows}
        onAddCustom={openAddKpi}
        onEditCustom={openEditKpi}
        onDeleteCustom={deleteKpi}
      />

      <ObjectivesTable
        rows={objectiveRows}
        kpiRows={kpiRows}
        onAdd={openAddObjective}
        onEdit={openEditObjective}
        onDelete={deleteObjective}
        onChangeManualStatus={changeManualStatus}
      />

      <CustomKpiEditor
        open={kpiEditorOpen}
        initial={editingKpi}
        onClose={() => {
          setKpiEditorOpen(false);
          setEditingKpiId(null);
        }}
        onSubmit={submitKpi}
      />
      <ObjectiveEditor
        open={objectiveEditorOpen}
        initial={editingObjective}
        kpiRows={kpiRows}
        onClose={() => {
          setObjectiveEditorOpen(false);
          setEditingObjectiveId(null);
        }}
        onSubmit={submitObjective}
      />
    </div>
  );
}

function SummaryCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'success' | 'warning' | 'danger';
}) {
  const palette = {
    success: { bg: 'var(--success-muted)', fg: 'var(--success)', border: 'color-mix(in oklch, var(--success) 25%, var(--gray-200))' },
    warning: { bg: 'var(--warning-muted)', fg: 'var(--warning)', border: 'color-mix(in oklch, var(--warning) 25%, var(--gray-200))' },
    danger: { bg: 'var(--danger-muted)', fg: 'var(--danger)', border: 'color-mix(in oklch, var(--danger) 25%, var(--gray-200))' },
  }[tone];
  return (
    <div
      className="rounded-[var(--radius-lg)] border p-4"
      style={{ background: palette.bg, borderColor: palette.border }}
    >
      <div className="text-[11px] font-medium uppercase tracking-[0.06em]" style={{ color: palette.fg }}>
        {label}
      </div>
      <div className="mt-1 text-[24px] font-bold tabular-nums" style={{ color: palette.fg }}>
        {value}
      </div>
    </div>
  );
}

function stripUndefined<T extends Record<string, unknown>>(input: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}
