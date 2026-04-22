import React, { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, BarChart3, Table2, Layers } from 'lucide-react';
import type { Proposal, Scenario, ForecastGranularity, CashFlowMonth } from '../types';
import {
  evaluateCashFlow,
  buildHistoricalMonths,
  buildFutureExpenses,
  projectFutureIncome,
  toYearMonth,
  addMonths,
  compareYearMonth,
} from '../domain/cashFlowEngine';
import { fetchAgedBalances, type BankAccountStatement, type AgedBalanceRecord } from '../services/jde';
import { fmtCurrency } from '../formatters';
import CashFlowChart from './CashFlowChart';
import ProposalManager from './ProposalManager';
import ScenarioManager, { createScenarioFromCurrent } from './ScenarioManager';
import ScenarioComparator from './ScenarioComparator';
import EstadoResultados from './EstadoResultados';

interface Props {
  companyCode: string; // 'all' significa sin filtro de cia
  bankStatements: BankAccountStatement[];
  proposals: Proposal[];
  scenarios: Scenario[];
  activeScenarioId: string | null;
  onProposalsChange: (next: Proposal[]) => void;
  onScenariosChange: (next: Scenario[]) => void;
  onActiveScenarioChange: (id: string | null) => void;
}

type BottomTab = 'pnl' | 'comparator';

const CashFlowView: React.FC<Props> = ({
  companyCode,
  bankStatements,
  proposals,
  scenarios,
  activeScenarioId,
  onProposalsChange,
  onScenariosChange,
  onActiveScenarioChange,
}) => {
  const [granularity, setGranularity] = useState<ForecastGranularity>('monthly');
  const [agedBalances, setAgedBalances] = useState<AgedBalanceRecord[]>([]);
  const [agedLoading, setAgedLoading] = useState(false);
  const [agedError, setAgedError] = useState<string | null>(null);
  const [bottomTab, setBottomTab] = useState<BottomTab>('pnl');

  // Fetch aged balances al cambiar la cia (se usan para egresos futuros).
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
        if (cancelled) return;
        setAgedBalances(data);
      })
      .catch((err) => {
        if (cancelled) return;
        setAgedError(err instanceof Error ? err.message : 'Error al cargar saldos');
        setAgedBalances([]);
      })
      .finally(() => {
        if (cancelled) return;
        setAgedLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [companyCode]);

  const base = useMemo(
    () => computeBaseCashFlow(bankStatements, agedBalances, companyCode),
    [bankStatements, agedBalances, companyCode],
  );

  const evaluated = useMemo(() => evaluateCashFlow(base, proposals), [base, proposals]);

  const enabledCount = proposals.filter((p) => p.enabled).length;
  const cajaBaseFinal = evaluated.totalBaseClosingCash;
  const cajaForecastFinal = evaluated.totalForecastClosingCash;
  const deltaFinal = cajaForecastFinal - cajaBaseFinal;

  const handleAddProposal = (p: Proposal) => onProposalsChange([...proposals, p]);
  const handleUpdateProposal = (p: Proposal) =>
    onProposalsChange(proposals.map((x) => (x.id === p.id ? { ...p, updatedAt: new Date().toISOString() } : x)));
  const handleDeleteProposal = (id: string) => onProposalsChange(proposals.filter((p) => p.id !== id));
  const handleToggleProposal = (id: string, enabled: boolean) =>
    onProposalsChange(proposals.map((p) => (p.id === id ? { ...p, enabled, updatedAt: new Date().toISOString() } : p)));

  const handleSaveScenario = (name: string, description?: string) => {
    const scen = createScenarioFromCurrent(proposals, name, description);
    onScenariosChange([...scenarios, scen]);
    onActiveScenarioChange(scen.id);
  };

  const handleLoadScenario = (id: string) => {
    const scen = scenarios.find((s) => s.id === id);
    if (!scen) return;
    const now = new Date().toISOString();
    const next = proposals.map((p) => ({
      ...p,
      enabled: scen.proposalStates[p.id] ?? p.enabled,
      updatedAt: now,
    }));
    onProposalsChange(next);
    onActiveScenarioChange(id);
  };

  const handleDeleteScenario = (id: string) => {
    onScenariosChange(scenarios.filter((s) => s.id !== id));
    if (activeScenarioId === id) onActiveScenarioChange(null);
  };

  const hasHistorical = base.some((m) => m.isHistorical);

  return (
    <div className="space-y-5">
      {/* Header: filtros + KPIs */}
      <div className="rounded-2xl border border-[var(--gray-200)] bg-white p-5">
        <div className="flex items-start justify-between flex-wrap gap-4">
          <div>
            <h1 className="text-[20px] font-semibold tracking-tight" style={{ color: 'var(--gray-950)' }}>
              Flujo de Caja
            </h1>
            <p className="text-[12px] mt-0.5" style={{ color: 'var(--gray-400)' }}>
              Histórico real desde JDE · {hasHistorical ? `${base.filter((m) => m.isHistorical).length} meses históricos` : 'sin históricos'} · {base.filter((m) => !m.isHistorical).length} meses proyectados
            </p>
          </div>

          <div className="flex items-center gap-2">
            {(['monthly', 'weekly', 'daily'] as ForecastGranularity[]).map((g) => (
              <button
                key={g}
                onClick={() => setGranularity(g)}
                className="h-9 px-3 rounded-lg text-[12px] font-medium border transition"
                style={{
                  borderColor: granularity === g ? 'var(--primary)' : 'var(--gray-200)',
                  background: granularity === g ? 'var(--primary-muted)' : 'white',
                  color: granularity === g ? 'var(--primary)' : 'var(--gray-500)',
                }}
                title={granularity !== 'monthly' ? 'La vista semanal/diaria se deriva repartiendo cada mes' : undefined}
              >
                {g === 'monthly' ? 'Mensual' : g === 'weekly' ? 'Semanal' : 'Diaria'}
              </button>
            ))}
          </div>
        </div>

        {/* KPIs */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-5">
          <KpiCard label="Caja Final Base" value={cajaBaseFinal} color="#94a3b8" />
          <KpiCard label="Caja Final Pronosticada" value={cajaForecastFinal} color="#2563eb" />
          <KpiCard
            label={`Delta de ${enabledCount} propuesta${enabledCount === 1 ? '' : 's'} activa${enabledCount === 1 ? '' : 's'}`}
            value={deltaFinal}
            color={deltaFinal >= 0 ? '#10b981' : '#ef4444'}
            sign
          />
        </div>

        {/* Warnings */}
        {(!companyCode || companyCode === 'all') && (
          <div className="mt-4 flex items-start gap-2 p-3 rounded-lg bg-[var(--warning-muted)]">
            <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: 'var(--warning)' }} />
            <p className="text-[12px]" style={{ color: 'var(--gray-700)' }}>
              Selecciona una compañía específica para cargar egresos comprometidos (Antigüedad de Saldos).
              Sin compañía seleccionada sólo se muestran los históricos de Bancos.
            </p>
          </div>
        )}
        {agedError && (
          <div className="mt-4 flex items-start gap-2 p-3 rounded-lg bg-[var(--danger)]/10">
            <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: 'var(--danger)' }} />
            <p className="text-[12px]" style={{ color: 'var(--gray-700)' }}>
              No se pudo cargar la Antigüedad de Saldos: {agedError}.
            </p>
          </div>
        )}
        {agedLoading && (
          <p className="mt-3 text-[11px]" style={{ color: 'var(--gray-400)' }}>Cargando saldos comprometidos…</p>
        )}
        {!hasHistorical && (
          <div className="mt-4 flex items-start gap-2 p-3 rounded-lg bg-[var(--warning-muted)]">
            <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: 'var(--warning)' }} />
            <p className="text-[12px]" style={{ color: 'var(--gray-700)' }}>
              No hay históricos bancarios en caché. Ve a Flujo Neto y haz refresh para traer datos reales de JDE.
            </p>
          </div>
        )}
        <p className="mt-3 text-[11px]" style={{ color: 'var(--gray-400)' }}>
          <strong>Nota:</strong> los ingresos futuros son una proyección (promedio móvil 6 meses). No hay API de cobranza todavía.
        </p>
      </div>

      {/* Chart + side panels */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-5">
        <div className="space-y-5">
          <div className="rounded-2xl border border-[var(--gray-200)] bg-white p-5">
            <CashFlowChart data={evaluated} />
          </div>

          {/* Toggles: pnl vs comparador */}
          <div className="flex gap-1 rounded-xl bg-[var(--gray-100)] p-1 w-fit">
            <button
              onClick={() => setBottomTab('pnl')}
              className="flex items-center gap-1.5 h-8 px-3 rounded-lg text-[12px] font-medium transition"
              style={{
                background: bottomTab === 'pnl' ? 'white' : 'transparent',
                color: bottomTab === 'pnl' ? 'var(--gray-950)' : 'var(--gray-500)',
              }}
            >
              <Table2 className="w-3.5 h-3.5" />
              Estado de Resultados
            </button>
            <button
              onClick={() => setBottomTab('comparator')}
              className="flex items-center gap-1.5 h-8 px-3 rounded-lg text-[12px] font-medium transition"
              style={{
                background: bottomTab === 'comparator' ? 'white' : 'transparent',
                color: bottomTab === 'comparator' ? 'var(--gray-950)' : 'var(--gray-500)',
              }}
            >
              <Layers className="w-3.5 h-3.5" />
              Comparador
            </button>
          </div>

          {bottomTab === 'pnl' ? (
            <EstadoResultados data={evaluated} />
          ) : (
            <ScenarioComparator base={base} proposals={proposals} scenarios={scenarios} />
          )}
        </div>

        <div className="space-y-4">
          <ProposalManager
            proposals={proposals}
            onAdd={handleAddProposal}
            onUpdate={handleUpdateProposal}
            onDelete={handleDeleteProposal}
            onToggle={handleToggleProposal}
          />
          <ScenarioManager
            proposals={proposals}
            scenarios={scenarios}
            activeScenarioId={activeScenarioId}
            onSaveCurrent={handleSaveScenario}
            onLoad={handleLoadScenario}
            onDelete={handleDeleteScenario}
          />
          <NotaGranularidad granularity={granularity} />
        </div>
      </div>
    </div>
  );
};

const KpiCard: React.FC<{ label: string; value: number; color: string; sign?: boolean }> = ({ label, value, color, sign }) => (
  <div className="rounded-xl border border-[var(--gray-200)] p-4">
    <div className="flex items-center gap-2 mb-1.5">
      <span className="w-2 h-2 rounded-full" style={{ background: color }} />
      <p className="text-[11px] font-medium uppercase tracking-wider" style={{ color: 'var(--gray-400)' }}>
        {label}
      </p>
    </div>
    <p className="text-[20px] font-semibold tabular-nums" style={{ color }}>
      {sign && value > 0 ? '+' : ''}{fmtCurrency(value)}
    </p>
  </div>
);

const NotaGranularidad: React.FC<{ granularity: ForecastGranularity }> = ({ granularity }) => {
  if (granularity === 'monthly') return null;
  return (
    <div className="rounded-xl border border-[var(--gray-200)] bg-white p-3 flex items-start gap-2">
      <BarChart3 className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: 'var(--gray-400)' }} />
      <p className="text-[11px]" style={{ color: 'var(--gray-500)' }}>
        La vista <strong>{granularity === 'weekly' ? 'semanal' : 'diaria'}</strong> se deriva repartiendo lineal cada mes.
        El total mensual se preserva; no respeta calendario de días hábiles MX (TODO).
      </p>
    </div>
  );
};

// buildBaseCashFlow en el engine es async porque en general puede disparar
// fetch. Aquí, al tener bankStatements + agedBalances pasados por props,
// replicamos la parte sincrónica para no lidiar con estado async extra.
function computeBaseCashFlow(
  bankStatements: BankAccountStatement[],
  agedBalances: AgedBalanceRecord[],
  companyCode: string,
): CashFlowMonth[] {
  const filteredStatements = companyCode === 'all' || !companyCode
    ? bankStatements
    : bankStatements.filter((s) => s.cia === companyCode);

  const historical = buildHistoricalMonths(filteredStatements);
  const futureExpenses = buildFutureExpenses(agedBalances);
  const avgIncome = projectFutureIncome(historical, 6);

  const today = new Date().toISOString().slice(0, 10);
  const todayYm = toYearMonth(today);
  const horizonMonths = 12;

  const lastHistoricalYm = historical.length > 0
    ? historical[historical.length - 1].yearMonth
    : todayYm;
  const firstFutureYm = addMonths(
    compareYearMonth(lastHistoricalYm, todayYm) > 0 ? lastHistoricalYm : todayYm,
    1,
  );
  const lastFutureYm = addMonths(todayYm, horizonMonths);

  const months: CashFlowMonth[] = [...historical];
  let runningCash = historical.length > 0 ? historical[historical.length - 1].closingCash : 0;

  let cursor = firstFutureYm;
  while (compareYearMonth(cursor, lastFutureYm) <= 0) {
    const expense = futureExpenses.get(cursor) ?? 0;
    const income = avgIncome;
    runningCash = runningCash + income - expense;
    months.push({
      yearMonth: cursor,
      isHistorical: false,
      income,
      expense,
      closingCash: runningCash,
    });
    cursor = addMonths(cursor, 1);
  }
  return months;
}

export default CashFlowView;
