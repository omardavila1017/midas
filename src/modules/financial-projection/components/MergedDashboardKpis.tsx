import React, { useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import { fmtCompact, fmtCurrency, fmtYearMonthShort } from '../../../formatters';
import type { AuxiliarMatchTier, AuxiliarReconResult } from '../../../domain/auxiliarReconciliationEngine';
import type { FinancialMovement, ForecastRun } from '../../shared-finance/types';
import { effectiveAmount } from '../../shared-finance/calculation-engine/financialProjectionEngine';

/**
 * Componentes y cálculos rescatados del antiguo `Dashboard.tsx` cuando la
 * pestaña Dashboard se fusionó dentro de Proyección Financiera (2026-05-18).
 *
 *   - `MinimumExpenseKpi`  — tarjeta del piso operativo (rayado amarillo).
 *   - `CobranzaKpiCard`    — cruce cobranza JDE ↔ bancos con diagnóstico.
 *   - `computeRunYtd`      — Ingresos/Egresos YTD + caja, derivados del
 *                            mismo scenario-run que alimenta el chart.
 */

function isRealMovement(movement: { status?: string; actualDate?: string; sourceSystem?: string }): boolean {
  return movement.status === 'REAL'
    || movement.status === 'EXECUTED'
    || Boolean(movement.actualDate)
    || movement.sourceSystem === 'BANK';
}

/**
 * Traspasos internos netos (`internal-recon:`, categoría `INTERNAL_RECON`).
 * Anclan la caja al saldo bancario real pero NO son ingreso/egreso económico,
 * así que se excluyen de los brutos YTD de Ingresos/Egresos operativos.
 */
function isInternalReconMovement(movement: { category?: string }): boolean {
  return movement.category === 'INTERNAL_RECON';
}

export interface RunYtd {
  ingresosYtd: number;
  egresosYtd: number;
  monthsElapsed: number;
  ingresosAvgMonth: number;
  egresosAvgMonth: number;
  flujoNetoYtd: number;
  margenYtd: number;
  cajaInicial: number;
  cajaActual: number;
  cajaDelta: number;
  cajaDeltaPct: number;
}

/**
 * YTD del año en curso a partir de los buckets del scenario-run activo.
 * Tolera cualquier granularidad: real = `isRealMovement`, meses
 * transcurridos = # de yearMonths históricos distintos del año en curso.
 * Misma fuente que la barra del chart → reconcilia exacto.
 */
export function computeRunYtd(
  run: Pick<ForecastRun, 'buckets' | 'movements'>,
  currentYm: string,
  currentYear: number,
): RunYtd {
  const movementById = new Map<string, FinancialMovement>(run.movements.map((m) => [m.id, m]));
  const yearPrefix = String(currentYear);

  let ingresosYtd = 0;
  let egresosYtd = 0;
  const histMonths = new Set<string>();
  let firstHistOpening: number | null = null;
  let cajaActual = 0;
  let sawCurrentYm = false;
  let lastHistClosing = 0;

  for (const bucket of run.buckets) {
    const ym = bucket.date.slice(0, 7);
    if (ym.slice(0, 4) !== yearPrefix) continue;
    const isHistorical = ym <= currentYm;
    if (!isHistorical) continue;

    let realIncome = 0;
    let realExpense = 0;
    for (const id of bucket.movementIds) {
      const movement = movementById.get(id);
      if (!movement || !isRealMovement(movement)) continue;
      // Los traspasos internos netos anclan la caja pero no son flujo económico.
      if (isInternalReconMovement(movement)) continue;
      if (movement.type === 'INFLOW') realIncome += effectiveAmount(movement);
      else realExpense += effectiveAmount(movement);
    }
    ingresosYtd += Math.min(realIncome, bucket.inflows);
    egresosYtd += Math.min(realExpense, bucket.outflows);
    histMonths.add(ym);
    if (firstHistOpening === null) firstHistOpening = bucket.openingCash;
    lastHistClosing = bucket.closingCash;
    if (ym === currentYm) {
      sawCurrentYm = true;
      cajaActual = bucket.closingCash;
    }
  }

  if (!sawCurrentYm) cajaActual = lastHistClosing;
  const monthsElapsed = histMonths.size;
  const flujoNetoYtd = ingresosYtd - egresosYtd;
  const cajaInicial = firstHistOpening ?? 0;
  const cajaDelta = cajaActual - cajaInicial;

  return {
    ingresosYtd,
    egresosYtd,
    monthsElapsed,
    ingresosAvgMonth: monthsElapsed > 0 ? ingresosYtd / monthsElapsed : 0,
    egresosAvgMonth: monthsElapsed > 0 ? egresosYtd / monthsElapsed : 0,
    flujoNetoYtd,
    margenYtd: ingresosYtd > 0 ? flujoNetoYtd / ingresosYtd : 0,
    cajaInicial,
    cajaActual,
    cajaDelta,
    cajaDeltaPct: cajaInicial !== 0 ? cajaDelta / cajaInicial : 0,
  };
}

/**
 * KPI especial del piso operativo. Fondo amarillo rayado — mismo lenguaje
 * visual que la línea de piso de la proyección operativa.
 */
export const MinimumExpenseKpi: React.FC<{
  monthly: number;
  annual: number;
  providersMonthly: number;
  payrollMonthly: number;
  criticalCount: number;
  /** Mes cerrado de TRESS del que sale la nómina (`YYYY-MM`). */
  payrollFloorMonth?: string;
}> = ({ monthly, annual, providersMonthly, payrollMonthly, criticalCount, payrollFloorMonth }) => (
  <div
    className="relative overflow-hidden rounded-[var(--radius)] p-4 floor-kpi"
    title="Piso operativo: proveedores de Operación + nómina/finiquitos. Es el monto que necesitas cubrir cada mes para no afectar operación."
    style={{
      background: 'var(--color-floor-bg)',
      border: '1px solid color-mix(in oklch, var(--color-floor) 35%, transparent)',
      boxShadow: 'var(--shadow-card)',
      backgroundImage: `repeating-linear-gradient(
        45deg,
        color-mix(in oklch, var(--color-floor-pattern) 14%, transparent) 0px,
        color-mix(in oklch, var(--color-floor-pattern) 14%, transparent) 8px,
        transparent 8px,
        transparent 16px
      )`,
    }}
  >
    <div className="flex items-center justify-between mb-2">
      <p
        className="text-[11px] font-bold uppercase tracking-[0.08em]"
        style={{ color: 'var(--color-floor)' }}
      >
        Gasto mín. operativo
      </p>
      <span style={{ color: 'var(--color-floor)' }}>
        <ShieldAlert className="w-4 h-4" />
      </span>
    </div>
    <p
      className="text-[20px] font-bold tabular-nums leading-tight"
      style={{ color: 'var(--gray-950)' }}
    >
      {fmtCurrency(monthly)}
      <span
        className="text-[11px] font-normal ml-1"
        style={{ color: 'var(--gray-500)' }}
      >
        / mes
      </span>
    </p>
    <p
      className="text-[10px] mt-0.5"
      style={{ color: 'var(--gray-500)' }}
    >
      {fmtCompact(annual)} anualizado
    </p>
    <div
      className="mt-2.5 space-y-1 pt-2"
      style={{ borderTop: '1px solid color-mix(in oklch, var(--color-floor) 25%, transparent)' }}
    >
      <div className="flex items-center justify-between text-[11px]">
        <span style={{ color: 'var(--gray-700)' }}>
          Proveedores Operación
          <span className="ml-1" style={{ color: 'var(--gray-500)' }}>· {criticalCount}</span>
        </span>
        <span
          className="font-medium tabular-nums"
          style={{ color: 'var(--gray-950)' }}
        >
          {fmtCompact(providersMonthly)}
        </span>
      </div>
      {payrollMonthly > 0 && (
        <div className="flex items-center justify-between text-[11px]">
          <span style={{ color: 'var(--gray-700)' }}>
            Nómina + aportaciones
            <span className="ml-1" style={{ color: 'var(--gray-500)' }}>
              · TRESS {payrollFloorMonth ? fmtYearMonthShort(payrollFloorMonth) : 'últ. mes cerrado'}
            </span>
          </span>
          <span
            className="font-medium tabular-nums"
            style={{ color: 'var(--gray-950)' }}
          >
            {fmtCompact(payrollMonthly)}
          </span>
        </div>
      )}
    </div>
  </div>
);

/**
 * Tarjeta de KPI para la conciliación AuxiliarContable ↔ Bancos.
 *
 * Muestra % de líneas del libro mayor cruzadas a banco (ingresos y egresos),
 * monto conciliado y un diagnóstico desplegable por cía.
 * Color semáforo: verde ≥95%, ámbar ≥70%, rojo <70%.
 */
// Etiquetas es-MX de los tiers para la telemetría del cruce (display-only).
const MATCH_TIER_LABELS: Record<AuxiliarMatchTier, string> = {
  'jde-reconciled': "Marca 'R' de JDE",
  exact: 'Match exacto (Midas)',
  tolerance: 'Match con tolerancia (Midas)',
  'cross-account': 'Cuenta hermana (Midas)',
  'gl-orphan': 'Sin contraparte (huérfano GL)',
  caja: 'Caja (1010)',
  interno: 'Traspaso interno',
  'asiento-interno': 'Asiento interno (VI)',
  'asiento-contable': 'Asiento contable',
  'pendiente-revision': 'Pendiente de revisión',
  'sin-banco': 'Sin estado de cuenta',
  'sin-cuenta-aux': 'Sin cuenta en la línea aux',
  'cuenta-no-en-banco': 'Cuenta sin movimientos en banco',
  'timing-pendiente': 'Extracto bancario pendiente',
};

export const CobranzaKpiCard: React.FC<{
  reconciliation: AuxiliarReconResult;
}> = ({ reconciliation }) => {
  const [showDiagnose, setShowDiagnose] = useState(false);
  const [showTiers, setShowTiers] = useState(false);
  const s = reconciliation.summary;
  const cruzables = s.ingresoLineas + s.egresoLineas;
  const cruzadas = s.ingresoCruzadas + s.egresoCruzadas;
  const pct = cruzables > 0 ? (cruzadas / cruzables) * 100 : 0;
  const sinDatos = cruzables === 0;
  const tierColor = sinDatos
    ? 'var(--gray-400)'
    : pct >= 95
      ? 'var(--success)'
      : pct >= 70
        ? 'var(--warning, #d97706)'
        : 'var(--danger)';
  const tierBg = sinDatos
    ? 'var(--gray-50)'
    : pct >= 95
      ? 'var(--success-muted)'
      : pct >= 70
        ? 'var(--warning-muted, #fef3c7)'
        : 'var(--danger-muted)';

  const ciasBajas = s.ciaBreakdown.filter(c => c.lineas > 0 && c.pct < 70);
  const tieneAlerta = !sinDatos && pct < 70 && ciasBajas.length > 0;

  return (
    <div
      className="rounded-[var(--radius)] border-2 p-4"
      style={{
        borderColor: tierColor,
        backgroundColor: tierBg,
      }}
    >
      <div className="flex items-stretch gap-6 flex-wrap">
        <div className="flex-1 min-w-[200px]">
          <div className="flex items-center justify-between">
            <p className="text-[11px] font-medium uppercase tracking-[0.08em]" style={{ color: 'var(--gray-500)' }}>
              Libro mayor cruzado con banco
            </p>
          </div>
          <p className="text-[28px] font-bold tabular-nums leading-tight mt-1" style={{ color: tierColor }}>
            {sinDatos ? '—' : `${pct.toFixed(1)}%`}
          </p>
          <p className="text-[11px] mt-0.5" style={{ color: 'var(--gray-500)' }}>
            {sinDatos
              ? 'Sin auxiliar contable cargado · revisa la pestaña Conciliación'
              : `${cruzadas} de ${cruzables} líneas · ${s.pendienteRevisionLineas} sin movimiento bancario`}
          </p>
        </div>

        <div className="flex-1 min-w-[200px] border-l border-[var(--gray-200)]/60 pl-6">
          <p className="text-[11px] font-medium uppercase tracking-[0.08em]" style={{ color: 'var(--gray-500)' }}>
            Abonos conciliados
          </p>
          <p className="text-[20px] font-bold tabular-nums leading-tight mt-1" style={{ color: 'var(--success)' }}>
            {fmtCurrency(s.ingresoMontoCruzado)}
          </p>
          <p className="text-[11px] mt-0.5" style={{ color: 'var(--gray-500)' }}>
            {s.pctIngresoCruzado.toFixed(1)}% · {s.conciliadasJde.toLocaleString('es-MX')} conciliadas por JDE
          </p>
        </div>

        <div className="flex-1 min-w-[200px] border-l border-[var(--gray-200)]/60 pl-6">
          <p className="text-[11px] font-medium uppercase tracking-[0.08em]" style={{ color: 'var(--gray-500)' }}>
            Cargos conciliados
          </p>
          <p className="text-[20px] font-bold tabular-nums leading-tight mt-1" style={{ color: 'var(--gray-950)' }}>
            {fmtCurrency(s.egresoMontoCruzado)}
          </p>
          <p className="text-[11px] mt-0.5" style={{ color: 'var(--gray-500)' }}>
            {s.pctEgresoCruzado.toFixed(1)}% · {s.internoLineas > 0
              ? `${s.internoLineas} traspasos internos descartados`
              : 'sin traspasos internos detectados'}
          </p>
        </div>
      </div>

      {/* Telemetría por tier de match — mide cuánto aporta la marca nativa 'R'
          de JDE vs los tiers propios de Midas (decisión pendiente con
          Contabilidad: adoptar 'R' como proceso o dejar de esperarla). Solo
          medición: el matching no cambia. */}
      {!sinDatos && s.matchTierBreakdown.length > 0 && (
        <div className="mt-3 pt-3 border-t border-[var(--gray-200)]/60">
          <button
            onClick={() => setShowTiers(v => !v)}
            className="text-[12px] text-[var(--primary)] hover:underline flex items-center gap-1"
          >
            {showTiers ? '▾' : '▸'} Cruce por método
            {(() => {
              const r = s.matchTierBreakdown.find(t => t.tier === 'jde-reconciled');
              return (
                <span className="text-[var(--gray-500)]">
                  · marca 'R' de JDE: {(r?.lineas ?? 0).toLocaleString('es-MX')} línea{(r?.lineas ?? 0) === 1 ? '' : 's'}
                  {r?.pctDeCruzadas != null ? ` (${r.pctDeCruzadas.toFixed(1)}% del cruce)` : ''}
                </span>
              );
            })()}
          </button>
          {showTiers && (
            <table className="w-full text-[11px] mt-2">
              <thead className="text-[var(--gray-400)]">
                <tr>
                  <th className="text-left font-medium">Método</th>
                  <th className="text-right font-medium">Líneas</th>
                  <th className="text-right font-medium">Monto</th>
                  <th className="text-right font-medium">% del cruce</th>
                </tr>
              </thead>
              <tbody>
                {s.matchTierBreakdown.map(t => (
                  <tr key={t.tier} className={t.cruzada ? '' : 'text-[var(--gray-400)]'}>
                    <td>{MATCH_TIER_LABELS[t.tier] ?? t.tier}</td>
                    <td className="text-right tabular-nums">{t.lineas.toLocaleString('es-MX')}</td>
                    <td className="text-right tabular-nums">{fmtCompact(t.monto)}</td>
                    <td className="text-right tabular-nums">
                      {t.pctDeCruzadas != null ? `${t.pctDeCruzadas.toFixed(1)}%` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {(tieneAlerta || (!sinDatos && pct === 0)) && (
        <div className="mt-3 pt-3 border-t border-[var(--gray-200)]/60">
          <button
            onClick={() => setShowDiagnose(v => !v)}
            className="text-[12px] text-[var(--primary)] hover:underline flex items-center gap-1"
          >
            {showDiagnose ? '▾' : '▸'} Diagnosticar bajo cruce
          </button>
          {showDiagnose && (
            <div className="mt-2 text-[11px] space-y-2">
              {ciasBajas.length > 0 && (
                <div>
                  <span className="font-bold text-[var(--danger)]">Cías con cruce bajo:</span>{' '}
                  {ciasBajas.map(c => `${c.cia} (${c.pct.toFixed(0)}%)`).join(', ')}
                  <div className="text-[var(--gray-500)] mt-0.5">
                    → Revisa que los estados de cuenta de esas cías estén cargados en la pestaña Bancos.
                  </div>
                </div>
              )}
              <div className="pt-1 border-t border-[var(--gray-200)]/60">
                <span className="font-bold">Breakdown completo:</span>
                <table className="w-full text-[11px] mt-1">
                  <thead className="text-[var(--gray-400)]">
                    <tr>
                      <th className="text-left">Cía</th>
                      <th className="text-right">Líneas</th>
                      <th className="text-right">Cruzadas</th>
                      <th className="text-right">% Cruce</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.ciaBreakdown.map(c => (
                      <tr key={c.cia}>
                        <td className="tabular-nums">{c.cia}</td>
                        <td className="text-right tabular-nums">{c.lineas}</td>
                        <td className="text-right tabular-nums">{c.cruzadas}</td>
                        <td className="text-right tabular-nums">{c.pct.toFixed(0)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
