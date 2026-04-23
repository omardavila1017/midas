import React, { useEffect, useMemo, useState } from 'react';
import {
  Plus, AlertTriangle, Lightbulb, TrendingUp, TrendingDown,
  Pencil, Activity, Wallet, Minus, Save, Layers, Trash2, Check, Download,
} from 'lucide-react';
import { toCSV, downloadFile } from '../utils/export';
import type { Proposal, Scenario, EvaluatedCashFlow, ProposalKind } from '../types';
import { PROPOSAL_FREQUENCY_LABELS } from '../types';
import { fmtCurrency, fmtCompact } from '../formatters';
import {
  evaluateCashFlow,
  analyzeLiquidity,
  type LiquiditySummary,
} from '../domain/cashFlowEngine';
import {
  fetchAgedBalances,
  type BankAccountStatement,
  type AgedBalanceRecord,
} from '../services/jde';
import type { Client, Provider, CashFlowAssumptions } from '../domain/types';
import type { CXPRecord } from '../domain/persistence';
import type { Budget } from '../domain/budget';
import ProposalEditor from './ProposalEditor';
import SimulacionChart from './SimulacionChart';
import { computeBaseCashFlow, loadOverrides } from './Dashboard';
import PageHeader from './ui/PageHeader';

interface Props {
  companyCode: string;
  bankStatements: BankAccountStatement[];
  proposals: Proposal[];
  onProposalsChange: (next: Proposal[]) => void;
  scenarios: Scenario[];
  onScenariosChange: (next: Scenario[]) => void;
  activeScenarioId: string | null;
  onActiveScenarioChange: (id: string | null) => void;
  // Inputs necesarios para que la línea de caja de Simulación coincida
  // exactamente con la que se ve en el Dashboard (mismo motor, mismos
  // insumos: clientes, proveedores, CXP, presupuesto, overrides y caja
  // inicial). Antes Simulación usaba una proyección "plana" y por eso las
  // curvas divergían.
  clients: Client[];
  providers: Provider[];
  cxpRecords: CXPRecord[];
  assumptions: CashFlowAssumptions;
  budget: Budget | null;
  startingBalance: number;
}

interface KindPresentation {
  label: string;
  accent: string;
  icon: React.ReactNode;
  sign: '+' | '−';
}

function getKindPresentation(kind: ProposalKind): KindPresentation {
  switch (kind) {
    case 'income_increase':
      return { label: 'Ingreso', accent: 'var(--success)', icon: <TrendingUp className="w-3.5 h-3.5" />, sign: '+' };
    case 'expense_saving':
      return { label: 'Ahorro', accent: '#2563eb', icon: <TrendingDown className="w-3.5 h-3.5" />, sign: '+' };
    case 'new_expense':
      return { label: 'Deuda / Nuevo egreso', accent: 'var(--danger)', icon: <Plus className="w-3.5 h-3.5" />, sign: '−' };
    case 'revenue_loss':
      return { label: 'Pérdida de ingreso', accent: 'var(--warning)', icon: <Minus className="w-3.5 h-3.5" />, sign: '−' };
  }
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
  scenarios,
  onScenariosChange,
  activeScenarioId,
  onActiveScenarioChange,
  clients,
  providers,
  cxpRecords,
  assumptions,
  budget,
  startingBalance,
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

  // Mismo pipeline que el Dashboard. Los overrides se releen de localStorage
  // al montar la pestaña — el usuario los edita desde Dashboard y al volver
  // a Simulación la curva ya refleja esos ajustes.
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const { base } = useMemo(() => computeBaseCashFlow({
    bankStatements,
    aged: agedBalances,
    clients,
    providers,
    cxpRecords,
    assumptions,
    companyCode,
    today,
    overrides: loadOverrides(),
    budget,
    startingBalance,
  }), [
    bankStatements, agedBalances, clients, providers, cxpRecords,
    assumptions, companyCode, today, budget, startingBalance,
  ]);

  const evaluated: EvaluatedCashFlow = useMemo(
    () => evaluateCashFlow(base, proposals),
    [base, proposals],
  );

  const liquidity: LiquiditySummary = useMemo(
    () => analyzeLiquidity(evaluated),
    [evaluated],
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

  // ── Escenarios (presets de propuestas activas) ────────────────────────
  const handleSaveScenario = (name: string, description?: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const now = new Date().toISOString();
    // Snapshot: enabled ids = true, resto = false (el usuario quiere apagar
    // explícitamente las que no fueron elegidas).
    const proposalStates: Record<string, boolean> = {};
    for (const p of proposals) proposalStates[p.id] = p.enabled;
    const id = `scn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const scenario: Scenario = {
      id, name: trimmed, description: description?.trim() || undefined,
      proposalStates, createdAt: now, updatedAt: now,
    };
    onScenariosChange([...scenarios, scenario]);
    onActiveScenarioChange(id);
  };

  const handleApplyScenario = (scenarioId: string) => {
    const scn = scenarios.find((s) => s.id === scenarioId);
    if (!scn) return;
    const now = new Date().toISOString();
    // Aplica el snapshot a las propuestas que ya existían cuando el escenario
    // fue guardado. Propuestas creadas después del escenario no aparecen en el
    // snapshot; se respeta su estado actual para no apagarlas sin que el
    // usuario lo pidiera explícitamente.
    onProposalsChange(
      proposals.map((p) => {
        const known = Object.prototype.hasOwnProperty.call(scn.proposalStates, p.id);
        if (!known) return p;
        const next = scn.proposalStates[p.id] === true;
        return p.enabled === next ? p : { ...p, enabled: next, updatedAt: now };
      }),
    );
    onActiveScenarioChange(scenarioId);
  };

  const handleUpdateScenarioToCurrent = (scenarioId: string) => {
    const scn = scenarios.find((s) => s.id === scenarioId);
    if (!scn) return;
    const now = new Date().toISOString();
    const proposalStates: Record<string, boolean> = {};
    for (const p of proposals) proposalStates[p.id] = p.enabled;
    onScenariosChange(
      scenarios.map((s) => (s.id === scenarioId ? { ...s, proposalStates, updatedAt: now } : s)),
    );
    onActiveScenarioChange(scenarioId);
  };

  const handleDeleteScenario = (scenarioId: string) => {
    if (!confirm('¿Eliminar este escenario?')) return;
    onScenariosChange(scenarios.filter((s) => s.id !== scenarioId));
    if (activeScenarioId === scenarioId) onActiveScenarioChange(null);
  };

  // Si el estado enabled de las propuestas cambia manualmente, el escenario
  // activo deja de reflejar la realidad. Detectarlo evita mostrar "aplicado"
  // cuando ya no lo está. Sólo se consideran las propuestas que existían
  // cuando el escenario se guardó — las nuevas se ignoran para esta detección
  // (se reportan aparte vía `proposalsOutsideScenario`).
  const activeScenarioMatches = useMemo(() => {
    if (!activeScenarioId) return false;
    const scn = scenarios.find((s) => s.id === activeScenarioId);
    if (!scn) return false;
    return proposals.every((p) => {
      const known = Object.prototype.hasOwnProperty.call(scn.proposalStates, p.id);
      if (!known) return true;
      return (scn.proposalStates[p.id] === true) === p.enabled;
    });
  }, [activeScenarioId, scenarios, proposals]);

  // Cuenta de propuestas creadas después del escenario activo. Útil para
  // explicar en UI que el escenario no las controla.
  const proposalsOutsideScenario = useMemo(() => {
    if (!activeScenarioId) return 0;
    const scn = scenarios.find((s) => s.id === activeScenarioId);
    if (!scn) return 0;
    return proposals.filter(
      (p) => !Object.prototype.hasOwnProperty.call(scn.proposalStates, p.id),
    ).length;
  }, [activeScenarioId, scenarios, proposals]);

  return (
    <div className="space-y-5 animate-fade-in">
      <PageHeader title="Simulación" />
      <div className="rounded-2xl border border-[var(--gray-200)] bg-white p-6">
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

        {/* Liquidity alert */}
        <LiquidityAlert summary={liquidity} />

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

      {/* Escenarios (presets de propuestas activas) */}
      <ScenariosPanel
        scenarios={scenarios}
        activeScenarioId={activeScenarioId}
        activeMatches={activeScenarioMatches}
        proposalsCount={proposals.length}
        enabledCount={enabled.length}
        proposalsOutsideScenario={proposalsOutsideScenario}
        onSave={handleSaveScenario}
        onApply={handleApplyScenario}
        onUpdateCurrent={handleUpdateScenarioToCurrent}
        onDelete={handleDeleteScenario}
      />

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
              className="h-9 px-3.5 rounded-xl bg-[var(--primary)] text-white text-[12px] font-medium hover:bg-[var(--primary-hover)] flex items-center gap-1.5 transition-colors"
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
      <section className="rounded-2xl border border-[var(--gray-200)] bg-white overflow-hidden animate-card-in stagger-2">
        <header className="px-6 py-4 border-b border-[var(--gray-100)] flex items-baseline justify-between gap-4">
          <div>
            <h2 className="text-[15px] font-semibold tracking-tight" style={{ color: 'var(--gray-950)' }}>
              Trayectoria de la caja
            </h2>
            <p className="text-[11px] mt-0.5" style={{ color: 'var(--gray-400)' }}>
              Base vs escenario simulado. La proyección de enero a diciembre sale del CSV de presupuesto.
            </p>
            {!budget && (
              <p className="text-[11px] mt-1.5 flex items-center gap-1" style={{ color: 'var(--warning)' }}>
                <AlertTriangle className="w-3 h-3" />
                Sin presupuesto cargado — los meses futuros se dibujan en cero. Cárgalo desde Dashboard → Presupuesto.
              </p>
            )}
          </div>
          {proposals.length > 0 && (
            <p className="text-[11px] tabular-nums flex-shrink-0" style={{ color: 'var(--gray-500)' }}>
              {proposals.filter((p) => p.enabled).length}/{proposals.length} activas
            </p>
          )}
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr]">
          <aside
            aria-label="Propuestas activables"
            className="border-b lg:border-b-0 lg:border-r border-[var(--gray-100)] p-4 space-y-1 max-h-[440px] overflow-y-auto"
          >
            <p className="text-[10px] font-medium uppercase tracking-wider px-2 mb-2" style={{ color: 'var(--gray-400)' }}>
              Propuestas
            </p>
            {proposals.length === 0 ? (
              <p className="text-[12px] px-2 py-6 text-center" style={{ color: 'var(--gray-400)' }}>
                No hay propuestas todavía. Créalas arriba para simular su impacto.
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
        <header className="flex items-center justify-between gap-3 px-6 py-4 border-b border-[var(--gray-100)]">
          <div>
            <h2 className="text-[15px] font-semibold tracking-tight" style={{ color: 'var(--gray-950)' }}>
              Detalle mensual
            </h2>
            <p className="text-[11px] mt-0.5" style={{ color: 'var(--gray-400)' }}>
              Ingresos, egresos y caja por mes — base vs simulación con propuestas activas.
            </p>
          </div>
          <button
            type="button"
            onClick={() => exportEvaluatedToCsv(evaluated, companyCode)}
            disabled={evaluated.months.length === 0}
            title="Descargar detalle mensual en CSV"
            className="flex items-center gap-1.5 h-8 px-3 rounded-lg border border-[var(--gray-200)] text-[12px] font-medium text-[var(--gray-700)] hover:bg-[var(--gray-50)] hover:border-[var(--gray-300)] disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
            Exportar CSV
          </button>
        </header>
        <MonthlyTable data={evaluated} />
      </section>
    </div>
  );
};

/**
 * Construye un CSV con columnas alineadas a lo que la analista lee en pantalla:
 * base, simulación y delta por mes. Se respeta el formato ISO (YYYY-MM) para
 * que abra sin sobresaltos en Excel regional MX y en Google Sheets.
 */
function exportEvaluatedToCsv(data: EvaluatedCashFlow, companyCode: string): void {
  if (data.months.length === 0) return;
  const rows = data.months.map((m) => ({
    mes: m.yearMonth,
    tipo: m.isHistorical ? 'historico' : 'proyeccion',
    ingresos_base: round(m.baseIncome),
    egresos_base: round(m.baseExpense),
    neto_base: round(m.baseIncome - m.baseExpense),
    caja_base: round(m.baseClosingCash),
    ingresos_sim: round(m.forecastIncome),
    egresos_sim: round(m.forecastExpense),
    neto_sim: round(m.forecastIncome - m.forecastExpense),
    caja_sim: round(m.forecastClosingCash),
    delta_caja: round(m.forecastClosingCash - m.baseClosingCash),
  }));
  const csv = toCSV(rows);
  const ciaTag = companyCode && companyCode !== 'all' ? `-${companyCode}` : '';
  const today = new Date().toISOString().slice(0, 10);
  downloadFile(csv, `midas-simulacion${ciaTag}-${today}.csv`);
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

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
    className="rounded-xl p-4 hover-lift"
    style={{
      background: highlight ? 'var(--gray-50)' : 'white',
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
  const { label, accent, icon, sign } = getKindPresentation(proposal.kind);
  return (
    <div
      className="group rounded-xl border p-4 hover-lift"
      style={{
        borderColor: proposal.enabled ? `${accent}55` : 'var(--gray-200)',
        background: proposal.enabled ? `${accent}06` : 'white',
      }}
    >
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <div
            className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0"
            style={{ background: proposal.enabled ? `${accent}1a` : 'var(--gray-100)', color: proposal.enabled ? accent : 'var(--gray-400)' }}
          >
            {icon}
          </div>
          <div className="min-w-0">
            <p
              className="text-[13px] font-semibold truncate"
              style={{ color: proposal.enabled ? 'var(--gray-950)' : 'var(--gray-500)' }}
            >
              {proposal.name}
            </p>
            <p className="text-[10px] uppercase tracking-wider" style={{ color: 'var(--gray-400)' }}>
              {label} · {PROPOSAL_FREQUENCY_LABELS[proposal.frequency]}
            </p>
          </div>
        </div>
        <Switch enabled={proposal.enabled} onChange={onToggle} accent={accent} />
      </div>

      <p
        className="text-[18px] font-semibold tabular-nums mb-1"
        style={{ color: proposal.enabled ? accent : 'var(--gray-400)' }}
      >
        {sign}{fmtCompact(proposal.amount)}
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
  const { accent, sign } = getKindPresentation(proposal.kind);
  return (
    <button
      type="button"
      role="switch"
      aria-checked={proposal.enabled}
      aria-label={`${proposal.enabled ? 'Desactivar' : 'Activar'} propuesta ${proposal.name}`}
      onClick={() => onToggle(!proposal.enabled)}
      className="w-full flex items-center gap-2.5 px-2 py-2 rounded-md text-left transition-colors hover:bg-[var(--gray-50)] focus-visible:bg-[var(--gray-50)]"
    >
      <span
        className="relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors"
        style={{ background: proposal.enabled ? accent : 'var(--gray-200)' }}
        aria-hidden="true"
      >
        <span
          className="inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform"
          style={{ transform: proposal.enabled ? 'translateX(18px)' : 'translateX(2px)' }}
        />
      </span>
      <span className="flex-1 min-w-0">
        <span
          className="block text-[12px] font-medium truncate"
          style={{ color: proposal.enabled ? 'var(--gray-950)' : 'var(--gray-500)' }}
        >
          {proposal.name}
        </span>
        <span
          className="block text-[10px] tabular-nums truncate"
          style={{ color: proposal.enabled ? 'var(--gray-500)' : 'var(--gray-400)' }}
        >
          {sign}{fmtCompact(proposal.amount)} · {PROPOSAL_FREQUENCY_LABELS[proposal.frequency].toLowerCase()}
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
    className="relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors"
    style={{ background: enabled ? accent : 'var(--gray-200)' }}
    aria-label={enabled ? 'Apagar' : 'Prender'}
  >
    <span
      className="inline-block h-4 w-4 rounded-full bg-white shadow transition-transform"
      style={{ transform: enabled ? 'translateX(18px)' : 'translateX(2px)' }}
    />
  </button>
);

// ─── Scenarios panel ────────────────────────────────────────────────────

interface ScenariosPanelProps {
  scenarios: Scenario[];
  activeScenarioId: string | null;
  activeMatches: boolean;
  proposalsCount: number;
  enabledCount: number;
  proposalsOutsideScenario: number;
  onSave: (name: string, description?: string) => void;
  onApply: (id: string) => void;
  onUpdateCurrent: (id: string) => void;
  onDelete: (id: string) => void;
}

const ScenariosPanel: React.FC<ScenariosPanelProps> = ({
  scenarios, activeScenarioId, activeMatches,
  proposalsCount, enabledCount, proposalsOutsideScenario,
  onSave, onApply, onUpdateCurrent, onDelete,
}) => {
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  const canSave = name.trim().length > 0 && proposalsCount > 0;

  const handleSubmit = () => {
    if (!canSave) return;
    onSave(name, description);
    setName('');
    setDescription('');
    setShowForm(false);
  };

  return (
    <section className="rounded-2xl border border-[var(--gray-200)] bg-white overflow-hidden">
      <header className="flex items-center justify-between px-6 py-4 border-b border-[var(--gray-100)]">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: 'var(--primary-muted)' }}>
            <Layers className="w-4 h-4" style={{ color: 'var(--primary)' }} />
          </div>
          <div>
            <h2 className="text-[15px] font-semibold tracking-tight" style={{ color: 'var(--gray-950)' }}>
              Escenarios
            </h2>
            <p className="text-[11px]" style={{ color: 'var(--gray-400)' }}>
              {scenarios.length === 0
                ? 'Guarda combinaciones de propuestas activas como presets'
                : `${scenarios.length} guardado${scenarios.length === 1 ? '' : 's'} · propuestas activas: ${enabledCount}/${proposalsCount}`}
            </p>
          </div>
        </div>
        {!showForm && (
          <button
            onClick={() => setShowForm(true)}
            disabled={proposalsCount === 0}
            className="h-9 px-3.5 rounded-xl text-[12px] font-medium flex items-center gap-1.5 transition-colors border border-[var(--gray-200)] hover:border-[var(--primary)] hover:text-[var(--primary)] disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ color: 'var(--gray-700)' }}
          >
            <Save className="w-3.5 h-3.5" />
            Guardar escenario
          </button>
        )}
      </header>

      {activeScenarioId && proposalsOutsideScenario > 0 && (
        <div
          className="px-6 py-2.5 border-b border-[var(--gray-100)] flex items-center gap-2 text-[11px]"
          style={{ background: 'var(--warning-muted, #fef3c7)', color: 'var(--gray-700)' }}
          role="status"
        >
          <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--warning)' }} />
          <span>
            {proposalsOutsideScenario === 1
              ? 'Hay 1 propuesta nueva que este escenario no controla — se respeta su estado actual.'
              : `Hay ${proposalsOutsideScenario} propuestas nuevas que este escenario no controla — se respeta su estado actual.`}
            <button
              onClick={() => onUpdateCurrent(activeScenarioId)}
              className="ml-2 underline font-medium hover:text-[var(--primary)]"
            >
              Actualizar escenario al estado actual
            </button>
          </span>
        </div>
      )}

      {showForm && (
        <div className="px-6 py-4 border-b border-[var(--gray-100)] bg-[var(--gray-50)]">
          <p className="text-[11px] mb-3" style={{ color: 'var(--gray-500)' }}>
            Se guardará el estado actual: {enabledCount} de {proposalsCount} propuestas activas.
          </p>
          <div className="grid grid-cols-1 md:grid-cols-[1fr_1.5fr_auto] gap-2">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Nombre (ej. Optimista)"
              autoFocus
              className="h-9 px-3 rounded-xl border border-[var(--gray-200)] bg-white text-[13px] focus:outline-none focus:border-[var(--primary)]"
            />
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Descripción (opcional)"
              className="h-9 px-3 rounded-xl border border-[var(--gray-200)] bg-white text-[13px] focus:outline-none focus:border-[var(--primary)]"
            />
            <div className="flex gap-2">
              <button
                onClick={() => { setShowForm(false); setName(''); setDescription(''); }}
                className="h-9 px-3 rounded-xl text-[12px] font-medium text-[var(--gray-500)] hover:bg-white hover:text-[var(--gray-950)] border border-transparent hover:border-[var(--gray-200)] transition-colors"
              >
                Cancelar
              </button>
              <button
                onClick={handleSubmit}
                disabled={!canSave}
                className="h-9 px-4 rounded-xl bg-[var(--primary)] text-white text-[12px] font-medium hover:bg-[var(--primary-hover)] disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
              >
                <Check className="w-3.5 h-3.5" />
                Guardar
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="p-5">
        {scenarios.length === 0 ? (
          <p className="text-[12px] text-center py-4" style={{ color: 'var(--gray-400)' }}>
            Sin escenarios todavía. Activa las propuestas que quieras y guarda el combo.
          </p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {scenarios.map((s) => {
              const isActive = activeScenarioId === s.id && activeMatches;
              const isDrifted = activeScenarioId === s.id && !activeMatches;
              const enabledIds = Object.entries(s.proposalStates).filter(([, v]) => v === true).length;
              return (
                <div
                  key={s.id}
                  className="rounded-xl border p-4 flex flex-col gap-2"
                  style={{
                    borderColor: isActive ? 'var(--primary)' : 'var(--gray-200)',
                    background: isActive ? 'var(--primary-muted)' : 'white',
                  }}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-[13px] font-semibold truncate" style={{ color: 'var(--gray-950)' }}>
                        {s.name}
                      </p>
                      <p className="text-[11px]" style={{ color: 'var(--gray-400)' }}>
                        {enabledIds} propuesta{enabledIds === 1 ? '' : 's'} activa{enabledIds === 1 ? '' : 's'}
                      </p>
                    </div>
                    {isActive && (
                      <span className="text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded" style={{ background: 'var(--primary)', color: 'white' }}>
                        Aplicado
                      </span>
                    )}
                    {isDrifted && (
                      <span
                        className="text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded"
                        style={{ background: 'var(--warning-muted)', color: 'var(--warning)' }}
                        title="El estado de propuestas cambió desde que se aplicó este escenario."
                      >
                        Modificado
                      </span>
                    )}
                  </div>
                  {s.description && (
                    <p className="text-[11px] line-clamp-2" style={{ color: 'var(--gray-500)' }}>
                      {s.description}
                    </p>
                  )}
                  <div className="mt-auto pt-2 flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => onApply(s.id)}
                        disabled={isActive}
                        className="h-7 px-2.5 rounded-lg text-[11px] font-medium bg-[var(--primary)] text-white hover:bg-[var(--primary-hover)] disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        {isActive ? 'Aplicado' : 'Aplicar'}
                      </button>
                      {isDrifted && (
                        <button
                          onClick={() => onUpdateCurrent(s.id)}
                          className="h-7 px-2.5 rounded-lg text-[11px] font-medium border border-[var(--gray-200)] text-[var(--gray-700)] hover:bg-[var(--gray-100)]"
                          title="Actualizar este escenario con el estado actual de propuestas"
                        >
                          Actualizar a actual
                        </button>
                      )}
                    </div>
                    <button
                      onClick={() => onDelete(s.id)}
                      className="h-7 w-7 flex items-center justify-center rounded-lg text-[var(--gray-400)] hover:bg-[var(--danger)]/10 hover:text-[var(--danger)] transition-colors"
                      aria-label="Eliminar escenario"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
};

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
      className="h-9 px-4 rounded-xl bg-[var(--primary)] text-white text-[12px] font-medium hover:bg-[var(--primary-hover)] inline-flex items-center gap-1.5 transition-colors"
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

// ─── Liquidity alert ─────────────────────────────────────────────────────

const MONTH_LABELS_SHORT = [
  'ene', 'feb', 'mar', 'abr', 'may', 'jun',
  'jul', 'ago', 'sep', 'oct', 'nov', 'dic',
];

function formatMonthLabel(yearMonth: string): string {
  const [y, m] = yearMonth.split('-').map(Number);
  if (!y || !m) return yearMonth;
  return `${MONTH_LABELS_SHORT[(m - 1) % 12]} ${y}`;
}

const LiquidityAlert: React.FC<{ summary: LiquiditySummary }> = ({ summary }) => {
  const { shortfalls, worstForecastClosingCash, worstForecastMonth, forecastWorsensAnyMonth } = summary;
  if (shortfalls.length === 0) return null;

  // El mes relevante para el mensaje principal es el primero que entra en
  // crisis con las propuestas activas — es el que marca el cut-off.
  const firstCritical = shortfalls.find((s) => s.status !== 'base_only') ?? shortfalls[0];
  const rescuedCount = shortfalls.filter((s) => s.status === 'base_only').length;
  const worsenedCount = shortfalls.filter((s) => s.status === 'forecast_only').length;
  const bothCount = shortfalls.filter((s) => s.status === 'both').length;

  const severe = firstCritical.status !== 'base_only';
  const bg = severe ? 'rgba(239, 68, 68, 0.08)' : 'rgba(245, 158, 11, 0.10)';
  const fg = severe ? 'var(--danger)' : 'var(--warning)';

  return (
    <div
      className="mt-4 flex items-start gap-2.5 p-3.5 rounded-xl"
      style={{ background: bg }}
      role="alert"
    >
      <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: fg }} />
      <div className="flex-1 text-[12px]" style={{ color: 'var(--gray-700)' }}>
        <p className="font-semibold" style={{ color: 'var(--gray-950)' }}>
          {severe
            ? `La caja cae bajo $0 en ${formatMonthLabel(firstCritical.yearMonth)}.`
            : `El baseline se hunde en ${formatMonthLabel(firstCritical.yearMonth)}, pero las propuestas lo rescatan.`}
        </p>
        <p className="mt-1">
          Peor caja proyectada: <span className="font-semibold tabular-nums">{fmtCurrency(worstForecastClosingCash)}</span>
          {worstForecastMonth ? ` en ${formatMonthLabel(worstForecastMonth)}` : ''}.
          {' '}
          {bothCount > 0 && (
            <span>
              {bothCount === 1 ? '1 mes' : `${bothCount} meses`} con crisis en base y forecast.
            </span>
          )}
          {worsenedCount > 0 && (
            <span className="ml-1" style={{ color: 'var(--danger)' }}>
              {worsenedCount === 1 ? '1 mes' : `${worsenedCount} meses`} que las propuestas hunden bajo $0.
            </span>
          )}
          {rescuedCount > 0 && (
            <span className="ml-1" style={{ color: 'var(--success)' }}>
              {rescuedCount === 1 ? '1 mes' : `${rescuedCount} meses`} que las propuestas rescatan.
            </span>
          )}
          {forecastWorsensAnyMonth && worsenedCount === 0 && bothCount > 0 && (
            <span className="ml-1">
              Las propuestas activas empeoran la caja en algún mes.
            </span>
          )}
        </p>
      </div>
    </div>
  );
};

export default Simulacion;
