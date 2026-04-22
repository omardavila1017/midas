import React, { useEffect, useMemo, useState } from 'react';
import {
  Plus, AlertTriangle, Sparkles, Lightbulb, TrendingUp, TrendingDown,
  Pencil, Activity, Wallet,
} from 'lucide-react';
import type { Proposal, EvaluatedCashFlow, CashFlowMonth } from '../types';
import { PROPOSAL_FREQUENCY_LABELS } from '../types';
import { fmtCurrency, fmtCompact } from '../formatters';
import {
  evaluateCashFlow,
  buildHistoricalMonths,
  buildFutureExpenses,
  projectFutureIncome,
  buildExpenseProjector,
  projectMonthlyExpense,
  filterCompleteHistorical,
  toYearMonth,
  addMonths,
  compareYearMonth,
  monthsBetween,
} from '../domain/cashFlowEngine';
import {
  fetchAgedBalances,
  type BankAccountStatement,
  type AgedBalanceRecord,
} from '../services/jde';
import ProposalEditor from './ProposalEditor';
import SimulacionChart from './SimulacionChart';

interface Props {
  companyCode: string;
  bankStatements: BankAccountStatement[];
  proposals: Proposal[];
  onProposalsChange: (next: Proposal[]) => void;
}

type EditorState =
  | { mode: 'closed' }
  | { mode: 'create' }
  | { mode: 'edit'; id: string };

const Simulacion: React.FC<Props> = ({
  companyCode,
  bankStatements,
  proposals,
  onProposalsChange,
}) => {
  const [agedBalances, setAgedBalances] = useState<AgedBalanceRecord[]>([]);
  const [agedLoading, setAgedLoading] = useState(false);
  const [agedError, setAgedError] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState>({ mode: 'closed' });

  useEffect(() => {
    let cancelled = false;
    if (!companyCode || companyCode === 'all') {
      setAgedBalances([]);
      setAgedError(null);
      return;
    }
    setAgedLoading(true);
    setAgedError(null);
    fetchAgedBalances({ cia: companyCode })
      .then((data) => {
        if (!cancelled) setAgedBalances(data);
      })
      .catch((err) => {
        if (!cancelled) setAgedError(err instanceof Error ? err.message : 'Error');
      })
      .finally(() => {
        if (!cancelled) setAgedLoading(false);
      });
    return () => { cancelled = true; };
  }, [companyCode]);

  const base = useMemo(
    () => computeBaseCashFlow(bankStatements, agedBalances, companyCode),
    [bankStatements, agedBalances, companyCode],
  );

  const evaluated: EvaluatedCashFlow = useMemo(
    () => evaluateCashFlow(base, proposals),
    [base, proposals],
  );

  const enabled = proposals.filter((p) => p.enabled);
  const cajaBaseFinal = evaluated.totalBaseClosingCash;
  const cajaForecastFinal = evaluated.totalForecastClosingCash;
  const deltaFinal = cajaForecastFinal - cajaBaseFinal;

  const handleSaveProposal = (p: Proposal) => {
    if (editor.mode === 'edit') {
      onProposalsChange(
        proposals.map((x) => (x.id === p.id ? { ...p, updatedAt: new Date().toISOString() } : x)),
      );
    } else {
      onProposalsChange([...proposals, p]);
    }
    setEditor({ mode: 'closed' });
  };

  const handleToggle = (id: string, nextEnabled: boolean) =>
    onProposalsChange(
      proposals.map((p) => (p.id === id ? { ...p, enabled: nextEnabled, updatedAt: new Date().toISOString() } : p)),
    );

  const handleDelete = (id: string) => {
    onProposalsChange(proposals.filter((p) => p.id !== id));
    setEditor({ mode: 'closed' });
  };

  const editingProposal = editor.mode === 'edit'
    ? proposals.find((p) => p.id === editor.id)
    : undefined;

  const hasHistorical = base.some((m) => m.isHistorical);

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header + KPIs */}
      <div className="rounded-2xl border border-[var(--gray-200)] bg-white p-6">
        <div className="flex items-start justify-between flex-wrap gap-4 mb-5">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <Sparkles className="w-4 h-4" style={{ color: 'var(--primary)' }} />
              <h1 className="text-[22px] font-semibold tracking-tight" style={{ color: 'var(--gray-950)' }}>
                Simulación
              </h1>
            </div>
            <p className="text-[12px]" style={{ color: 'var(--gray-400)' }}>
              Crea propuestas y observa cómo cambian la trayectoria de tu caja.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <KpiCard
            label="Caja Final Base"
            value={cajaBaseFinal}
            color="var(--gray-500)"
            icon={<Wallet className="w-4 h-4" />}
          />
          <KpiCard
            label="Caja con Propuestas"
            value={cajaForecastFinal}
            color="var(--primary)"
            icon={<Activity className="w-4 h-4" />}
            highlight
          />
          <KpiCard
            label={`Impacto · ${enabled.length} activa${enabled.length === 1 ? '' : 's'}`}
            value={deltaFinal}
            color={deltaFinal >= 0 ? 'var(--success)' : 'var(--danger)'}
            icon={deltaFinal >= 0 ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
            sign
          />
        </div>

        {/* Warnings */}
        {(!companyCode || companyCode === 'all') && (
          <div className="mt-4 flex items-start gap-2 p-3 rounded-xl bg-[var(--warning-muted)]">
            <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: 'var(--warning)' }} />
            <p className="text-[12px]" style={{ color: 'var(--gray-700)' }}>
              Selecciona una compañía para cargar egresos comprometidos.
            </p>
          </div>
        )}
        {agedError && (
          <div className="mt-4 flex items-start gap-2 p-3 rounded-xl bg-[var(--danger)]/10">
            <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: 'var(--danger)' }} />
            <p className="text-[12px]" style={{ color: 'var(--gray-700)' }}>
              No se cargaron saldos comprometidos: {agedError}
            </p>
          </div>
        )}
        {agedLoading && (
          <p className="mt-3 text-[11px]" style={{ color: 'var(--gray-400)' }}>
            Cargando saldos comprometidos…
          </p>
        )}
        {!hasHistorical && (
          <div className="mt-4 flex items-start gap-2 p-3 rounded-xl bg-[var(--warning-muted)]">
            <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: 'var(--warning)' }} />
            <p className="text-[12px]" style={{ color: 'var(--gray-700)' }}>
              Aún no hay históricos en caché. Ve a Flujo Neto y refresca para traer datos de JDE.
            </p>
          </div>
        )}
      </div>

      {/* Propuestas */}
      <section className="rounded-2xl border border-[var(--gray-200)] bg-white overflow-hidden">
        <header className="flex items-center justify-between px-6 py-4 border-b border-[var(--gray-100)]">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: 'var(--primary-muted)' }}>
              <Lightbulb className="w-4 h-4" style={{ color: 'var(--primary)' }} />
            </div>
            <div>
              <h2 className="text-[15px] font-semibold tracking-tight" style={{ color: 'var(--gray-950)' }}>
                Propuestas
              </h2>
              <p className="text-[11px]" style={{ color: 'var(--gray-400)' }}>
                {proposals.length === 0
                  ? 'Crea propuestas para empezar a simular'
                  : `${enabled.length} activa${enabled.length === 1 ? '' : 's'} · ${proposals.length} en total`}
              </p>
            </div>
          </div>
          {editor.mode === 'closed' && (
            <button
              onClick={() => setEditor({ mode: 'create' })}
              className="h-9 px-3.5 rounded-xl bg-[var(--primary)] text-white text-[12px] font-medium hover:bg-[var(--primary-hover)] flex items-center gap-1.5 transition-all active:scale-[0.98]"
              style={{ boxShadow: '0 2px 8px -2px rgba(15,23,42,0.25)' }}
            >
              <Plus className="w-3.5 h-3.5" />
              Nueva propuesta
            </button>
          )}
        </header>

        <div className="p-5 space-y-4">
          {editor.mode === 'create' && (
            <ProposalEditor
              onCancel={() => setEditor({ mode: 'closed' })}
              onSave={handleSaveProposal}
            />
          )}

          {proposals.length === 0 && editor.mode === 'closed' ? (
            <EmptyState onCreate={() => setEditor({ mode: 'create' })} />
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {proposals.map((p) => {
                if (editor.mode === 'edit' && editor.id === p.id && editingProposal) {
                  return (
                    <div key={p.id} className="sm:col-span-2 lg:col-span-3">
                      <ProposalEditor
                        initial={editingProposal}
                        onCancel={() => setEditor({ mode: 'closed' })}
                        onSave={handleSaveProposal}
                        onDelete={() => handleDelete(p.id)}
                      />
                    </div>
                  );
                }
                return (
                  <ProposalCard
                    key={p.id}
                    proposal={p}
                    onToggle={(next) => handleToggle(p.id, next)}
                    onEdit={() => setEditor({ mode: 'edit', id: p.id })}
                  />
                );
              })}
            </div>
          )}
        </div>
      </section>

      {/* Visualización: switches + chart */}
      <section className="rounded-2xl border border-[var(--gray-200)] bg-white overflow-hidden">
        <header className="px-6 py-4 border-b border-[var(--gray-100)]">
          <h2 className="text-[15px] font-semibold tracking-tight" style={{ color: 'var(--gray-950)' }}>
            Trayectoria de la caja
          </h2>
          <p className="text-[11px] mt-0.5" style={{ color: 'var(--gray-400)' }}>
            Activa o desactiva propuestas para ver el impacto en vivo.
          </p>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr]">
          <aside className="border-r border-[var(--gray-100)] p-4 space-y-1.5 max-h-[440px] overflow-y-auto">
            <p className="text-[10px] font-medium uppercase tracking-wider px-2 mb-2" style={{ color: 'var(--gray-400)' }}>
              Propuestas
            </p>
            {proposals.length === 0 ? (
              <p className="text-[12px] px-2 py-4 text-center" style={{ color: 'var(--gray-400)' }}>
                Sin propuestas todavía.
              </p>
            ) : (
              proposals.map((p) => (
                <SwitchRow
                  key={p.id}
                  proposal={p}
                  onToggle={(next) => handleToggle(p.id, next)}
                />
              ))
            )}
          </aside>

          <div className="p-5">
            <SimulacionChart data={evaluated} />
          </div>
        </div>
      </section>

      {/* Tabla mensual */}
      <section className="rounded-2xl border border-[var(--gray-200)] bg-white overflow-hidden">
        <header className="px-6 py-4 border-b border-[var(--gray-100)]">
          <h2 className="text-[15px] font-semibold tracking-tight" style={{ color: 'var(--gray-950)' }}>
            Detalle mensual
          </h2>
          <p className="text-[11px] mt-0.5" style={{ color: 'var(--gray-400)' }}>
            Ingresos, egresos y caja por mes — base vs simulación con propuestas activas.
          </p>
        </header>
        <MonthlyTable data={evaluated} />
      </section>
    </div>
  );
};

// ─── Sub-components ─────────────────────────────────────────────────────

const KpiCard: React.FC<{
  label: string;
  value: number;
  color: string;
  icon: React.ReactNode;
  sign?: boolean;
  highlight?: boolean;
}> = ({ label, value, color, icon, sign, highlight }) => (
  <div
    className="rounded-xl p-4 transition-all hover-lift"
    style={{
      background: highlight ? 'linear-gradient(135deg, var(--gray-50), white)' : 'white',
      border: '1px solid var(--gray-200)',
    }}
  >
    <div className="flex items-center justify-between mb-2">
      <p className="text-[10px] font-medium uppercase tracking-wider" style={{ color: 'var(--gray-400)' }}>
        {label}
      </p>
      <span style={{ color }}>{icon}</span>
    </div>
    <p className="text-[20px] font-semibold tabular-nums" style={{ color }}>
      {sign && value > 0 ? '+' : ''}{fmtCurrency(value)}
    </p>
  </div>
);

const ProposalCard: React.FC<{
  proposal: Proposal;
  onToggle: (next: boolean) => void;
  onEdit: () => void;
}> = ({ proposal, onToggle, onEdit }) => {
  const isIncome = proposal.kind === 'income_increase';
  const accent = isIncome ? 'var(--success)' : '#2563eb';
  return (
    <div
      className="group rounded-xl border p-4 transition-all hover-lift"
      style={{
        borderColor: proposal.enabled ? `${accent}55` : 'var(--gray-200)',
        background: proposal.enabled ? `${accent}06` : 'white',
      }}
    >
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <div
            className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0"
            style={{ background: proposal.enabled ? `${accent}1a` : 'var(--gray-100)' }}
          >
            {isIncome ? (
              <TrendingUp className="w-3.5 h-3.5" style={{ color: proposal.enabled ? accent : 'var(--gray-400)' }} />
            ) : (
              <TrendingDown className="w-3.5 h-3.5" style={{ color: proposal.enabled ? accent : 'var(--gray-400)' }} />
            )}
          </div>
          <div className="min-w-0">
            <p
              className="text-[13px] font-semibold truncate"
              style={{ color: proposal.enabled ? 'var(--gray-950)' : 'var(--gray-500)' }}
            >
              {proposal.name}
            </p>
            <p className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--gray-400)' }}>
              {isIncome ? 'Ingreso' : 'Ahorro'} · {PROPOSAL_FREQUENCY_LABELS[proposal.frequency]}
            </p>
          </div>
        </div>
        <Switch enabled={proposal.enabled} onChange={onToggle} accent={accent} />
      </div>

      <p
        className="text-[18px] font-semibold tabular-nums mb-1"
        style={{ color: proposal.enabled ? accent : 'var(--gray-400)' }}
      >
        {isIncome ? '+' : '−'}{fmtCompact(proposal.amount)}
      </p>
      <p className="text-[11px]" style={{ color: 'var(--gray-400)' }}>
        Desde {proposal.startYearMonth}
      </p>

      {proposal.description && (
        <p className="text-[11px] mt-2 line-clamp-2" style={{ color: 'var(--gray-500)' }}>
          {proposal.description}
        </p>
      )}

      <div className="mt-3 pt-3 border-t border-[var(--gray-100)] flex justify-end">
        <button
          onClick={onEdit}
          className="h-7 px-2.5 rounded-lg text-[11px] font-medium text-[var(--gray-500)] hover:bg-[var(--gray-100)] hover:text-[var(--gray-950)] transition-colors flex items-center gap-1"
        >
          <Pencil className="w-3 h-3" />
          Editar
        </button>
      </div>
    </div>
  );
};

const SwitchRow: React.FC<{
  proposal: Proposal;
  onToggle: (next: boolean) => void;
}> = ({ proposal, onToggle }) => {
  const isIncome = proposal.kind === 'income_increase';
  const accent = isIncome ? 'var(--success)' : '#2563eb';
  return (
    <button
      type="button"
      onClick={() => onToggle(!proposal.enabled)}
      className="w-full flex items-center gap-2.5 px-2 py-2 rounded-lg text-left transition-colors hover:bg-[var(--gray-50)]"
    >
      <span
        className="relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition"
        style={{ background: proposal.enabled ? accent : 'var(--gray-200)' }}
      >
        <span
          className="inline-block h-4 w-4 rounded-full bg-white shadow transition-transform"
          style={{ transform: proposal.enabled ? 'translateX(18px)' : 'translateX(2px)' }}
        />
      </span>
      <span className="flex-1 min-w-0">
        <span
          className="block text-[12px] font-medium truncate"
          style={{ color: proposal.enabled ? 'var(--gray-950)' : 'var(--gray-400)' }}
        >
          {proposal.name}
        </span>
        <span
          className="block text-[10px] tabular-nums"
          style={{ color: proposal.enabled ? accent : 'var(--gray-400)' }}
        >
          {isIncome ? '+' : '−'}{fmtCompact(proposal.amount)} · {PROPOSAL_FREQUENCY_LABELS[proposal.frequency].toLowerCase()}
        </span>
      </span>
    </button>
  );
};

const Switch: React.FC<{ enabled: boolean; onChange: (next: boolean) => void; accent: string }> = ({
  enabled,
  onChange,
  accent,
}) => (
  <button
    type="button"
    onClick={(e) => {
      e.stopPropagation();
      onChange(!enabled);
    }}
    className="relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition active:scale-95"
    style={{ background: enabled ? accent : 'var(--gray-200)' }}
    aria-label={enabled ? 'Apagar' : 'Prender'}
  >
    <span
      className="inline-block h-4 w-4 rounded-full bg-white shadow transition-transform"
      style={{ transform: enabled ? 'translateX(18px)' : 'translateX(2px)' }}
    />
  </button>
);

const EmptyState: React.FC<{ onCreate: () => void }> = ({ onCreate }) => (
  <div className="rounded-xl border border-dashed border-[var(--gray-200)] bg-[var(--gray-50)] py-10 text-center">
    <div
      className="w-12 h-12 rounded-2xl bg-white border border-[var(--gray-200)] mx-auto mb-3 flex items-center justify-center"
      style={{ boxShadow: '0 4px 12px -4px rgba(15,23,42,0.08)' }}
    >
      <Lightbulb className="w-5 h-5" style={{ color: 'var(--gray-400)' }} />
    </div>
    <p className="text-[14px] font-semibold mb-1" style={{ color: 'var(--gray-700)' }}>
      Aún no hay propuestas
    </p>
    <p className="text-[12px] mb-4" style={{ color: 'var(--gray-400)' }}>
      Crea una idea de ahorro o ingreso para verla en la simulación.
    </p>
    <button
      onClick={onCreate}
      className="h-9 px-4 rounded-xl bg-[var(--primary)] text-white text-[12px] font-medium hover:bg-[var(--primary-hover)] inline-flex items-center gap-1.5 transition-all active:scale-[0.98]"
    >
      <Plus className="w-3.5 h-3.5" />
      Crear primera propuesta
    </button>
  </div>
);

const MonthlyTable: React.FC<{ data: EvaluatedCashFlow }> = ({ data }) => {
  if (data.months.length === 0) {
    return (
      <div className="px-4 py-10 text-center">
        <p className="text-[13px]" style={{ color: 'var(--gray-400)' }}>Sin datos para mostrar.</p>
      </div>
    );
  }
  const { months } = data;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12px]">
        <thead>
          <tr className="border-b border-[var(--gray-100)] bg-[var(--gray-50)]">
            <th
              className="text-left px-4 py-2.5 font-medium sticky left-0 z-10 bg-[var(--gray-50)]"
              style={{ color: 'var(--gray-500)' }}
            >
              Concepto
            </th>
            {months.map((m) => (
              <th
                key={m.yearMonth}
                className="text-right px-3 py-2.5 font-medium whitespace-nowrap tabular-nums"
                style={{ color: m.isHistorical ? 'var(--gray-400)' : 'var(--gray-700)' }}
              >
                {m.yearMonth}
                <span className="block text-[9px] normal-case font-normal" style={{ color: 'var(--gray-400)' }}>
                  {m.isHistorical ? 'histórico' : 'proyección'}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <Row label="Ingresos (base)" values={months.map((m) => m.baseIncome)} />
          <Row label="Egresos (base)" values={months.map((m) => m.baseExpense)} />
          <Row label="Neto (base)" values={months.map((m) => m.baseIncome - m.baseExpense)} bold />
          <Row label="Caja Final (base)" values={months.map((m) => m.baseClosingCash)} divider muted />
          <Row label="Ingresos (sim.)" values={months.map((m) => m.forecastIncome)} accent />
          <Row label="Egresos (sim.)" values={months.map((m) => m.forecastExpense)} accent />
          <Row label="Neto (sim.)" values={months.map((m) => m.forecastIncome - m.forecastExpense)} bold accent />
          <Row label="Caja Final (sim.)" values={months.map((m) => m.forecastClosingCash)} bold accent divider />
        </tbody>
      </table>
    </div>
  );
};

const Row: React.FC<{
  label: string;
  values: number[];
  bold?: boolean;
  accent?: boolean;
  divider?: boolean;
  muted?: boolean;
}> = ({ label, values, bold, accent, divider, muted }) => {
  const color = accent ? 'var(--primary)' : muted ? 'var(--gray-500)' : 'var(--gray-700)';
  return (
    <tr className={divider ? 'border-t border-[var(--gray-200)]' : 'border-t border-[var(--gray-50)]'}>
      <td
        className="px-4 py-2 sticky left-0 bg-white whitespace-nowrap"
        style={{ color, fontWeight: bold ? 600 : 400 }}
      >
        {label}
      </td>
      {values.map((v, i) => (
        <td
          key={i}
          className="text-right px-3 py-2 tabular-nums whitespace-nowrap"
          style={{ color, fontWeight: bold ? 600 : 400 }}
        >
          {fmtCompact(v)}
        </td>
      ))}
    </tr>
  );
};

// ─── Cash flow base computation (mismo algoritmo que el resto) ──────────

function computeBaseCashFlow(
  bankStatements: BankAccountStatement[],
  agedBalances: AgedBalanceRecord[],
  companyCode: string,
): CashFlowMonth[] {
  const filtered = companyCode === 'all' || !companyCode
    ? bankStatements
    : bankStatements.filter((s) => s.cia === companyCode);

  const historical = buildHistoricalMonths(filtered);
  const futureExpenses = buildFutureExpenses(agedBalances);

  const today = new Date().toISOString().slice(0, 10);
  const todayYm = toYearMonth(today);
  // Excluimos el mes en curso (parcial) del input de proyección para no sesgar
  // los promedios hacia abajo.
  const completeHistorical = filterCompleteHistorical(historical, today);
  const avgIncome = projectFutureIncome(completeHistorical, 6);
  const expenseProjector = buildExpenseProjector(completeHistorical);

  const horizonMonths = 12;
  const lastHistoricalYm = historical.length > 0
    ? historical[historical.length - 1].yearMonth
    : todayYm;
  const projectionAnchorYm = completeHistorical.length > 0
    ? completeHistorical[completeHistorical.length - 1].yearMonth
    : lastHistoricalYm;
  const firstFutureYm = addMonths(
    compareYearMonth(lastHistoricalYm, todayYm) > 0 ? lastHistoricalYm : todayYm,
    1,
  );
  const lastFutureYm = addMonths(todayYm, horizonMonths);

  const months: CashFlowMonth[] = [...historical];
  let running = historical.length > 0 ? historical[historical.length - 1].closingCash : 0;
  let cursor = firstFutureYm;
  while (compareYearMonth(cursor, lastFutureYm) <= 0) {
    const offset = Math.max(1, monthsBetween(projectionAnchorYm, cursor));
    const committed = futureExpenses.get(cursor) ?? 0;
    const expense = projectMonthlyExpense(offset, committed, expenseProjector);
    const income = avgIncome;
    running = running + income - expense;
    months.push({
      yearMonth: cursor,
      isHistorical: false,
      income,
      expense,
      closingCash: running,
    });
    cursor = addMonths(cursor, 1);
  }
  return months;
}

export default Simulacion;
