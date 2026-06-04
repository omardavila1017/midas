// ─────────────────────────────────────────────────────────────────────────
// MÓDULO TEMPORAL DE DEPURACIÓN — Traspasos internos.
//
// Objetivo: ver, mes por mes, el bruto de traspasos internos (Σ ABONO vs
// Σ CARGO) y poder abrir el detalle por movimiento para depurar por qué el
// ingreso interno (~$83.3M) y el egreso interno (~$55.x M) NO empatan (la
// detección no es perfectamente simétrica; el residuo es lo que el motor
// re-emite como el plug `INTERNAL_RECON`).
//
// Recalcula la clasificación con LOS MISMOS helpers que el motor
// (`historicalReconciledEngine` → MOTOR 1): primero la heurística
// `classifyMovement` (leyenda / RFC / beneficiario / sigla / cuenta-destino /
// pair-matched) y, si no, la regla de cuenta neutra del catálogo bancario.
// Así los totales empatan con el plug del motor.
//
// TEMPORAL: este panel es una herramienta de depuración. Se puede borrar sin
// afectar la proyección — no muta ningún movimiento ni la caja.
// ─────────────────────────────────────────────────────────────────────────
import { Fragment, useEffect, useMemo, useState } from 'react';
import { Download, ChevronDown, ChevronRight } from 'lucide-react';
import type { BankAccountStatement } from '../../../services/jdeTypes';
import {
  buildOwnAccountsIndex,
  buildOwnAccountDetector,
  buildPairMatchedKeys,
  classifyMovement,
  INTERNAL_REASON_LABELS,
  type InternalReason,
} from '../../../domain/netCashFlowEngine';
import { enrichMovementWithCatalog } from '../../../domain/bankAccountsCatalog';
import { fmtCurrency, fmtCompact, fmtInt, fmtYearMonthLong } from '../../../formatters';

type DebugReason = InternalReason | 'neutral-account';

const REASON_LABELS: Record<DebugReason, string> = {
  ...INTERNAL_REASON_LABELS,
  'neutral-account': 'Cuenta neutra del catálogo (reserva/ahorro/crédito/garantía/…)',
};

const ALL_REASONS: DebugReason[] = [
  'legend',
  'legend-extended',
  'rfc',
  'beneficiary',
  'own-account',
  'pair-matched',
  'neutral-account',
];

interface DetailRow {
  cia: string;
  cuenta: string;
  nombreBanco: string;
  fecha: string;
  ym: string;
  tipo: string;
  importe: number;
  reason: DebugReason;
  concepto: string;
  referencia: string;
}

interface MonthAgg {
  ym: string;
  ingresos: number;
  egresos: number;
  count: number;
  rows: DetailRow[];
}

interface ReasonAgg {
  reason: DebugReason;
  count: number;
  ingresos: number;
  egresos: number;
}

interface DebugResult {
  months: MonthAgg[];
  byReason: ReasonAgg[];
  totalIngresos: number;
  totalEgresos: number;
  totalCount: number;
  scannedLines: number;
  allRows: DetailRow[];
}

// Cap de filas renderizadas por mes expandido — el detalle completo va por CSV.
const MAX_DETAIL_ROWS_PER_MONTH = 500;

function computeInternalTransfers(
  bankStatements: readonly BankAccountStatement[],
  companyCode: string,
): DebugResult {
  const ownAccounts = buildOwnAccountsIndex(bankStatements);
  const ownAccountDetector = buildOwnAccountDetector(ownAccounts);
  const pairedKeys = buildPairMatchedKeys(bankStatements);

  const monthMap = new Map<string, MonthAgg>();
  const reasonMap = new Map<DebugReason, ReasonAgg>();
  const allRows: DetailRow[] = [];
  let totalIngresos = 0;
  let totalEgresos = 0;
  let scannedLines = 0;

  for (const statement of bankStatements) {
    if (companyCode !== 'all' && companyCode && statement.cia !== companyCode) continue;
    for (const line of statement.movimientos) {
      const fecha = line.fechaOperacion ?? '';
      const ym = fecha.slice(0, 7);
      if (ym.length !== 7) continue;
      scannedLines += 1;

      // Mismo orden que el motor: heurística primero, cuenta neutra después.
      let reason: DebugReason | null = null;
      const cls = classifyMovement(
        line,
        { ownAccountDetector, pairedKeys },
        statement.cia,
        statement.cuenta,
      );
      if (cls.kind === 'internal') {
        reason = cls.reason ?? 'legend';
      } else {
        const enrich = enrichMovementWithCatalog({
          cuenta: statement.cuenta,
          cuentaBancos: line.cuentaBancos ?? line.cuenta,
          tipoMovimiento: line.tipoMovimiento,
          importe: line.importe,
        });
        if (enrich && enrich.entry.flow === 'neutro') reason = 'neutral-account';
      }
      if (!reason) continue;

      const amt = Math.abs(Number(line.importe) || 0);
      if (!(amt > 0)) continue;
      const isAbono = line.tipoMovimiento === 'ABONO';

      const row: DetailRow = {
        cia: statement.cia,
        cuenta: statement.cuenta,
        nombreBanco: statement.nombreBanco || statement.banco || '',
        fecha,
        ym,
        tipo: line.tipoMovimiento,
        importe: amt,
        reason,
        concepto: line.concepto ?? '',
        referencia: line.referencia ?? '',
      };
      allRows.push(row);

      let month = monthMap.get(ym);
      if (!month) {
        month = { ym, ingresos: 0, egresos: 0, count: 0, rows: [] };
        monthMap.set(ym, month);
      }
      month.count += 1;
      month.rows.push(row);
      if (isAbono) { month.ingresos += amt; totalIngresos += amt; }
      else { month.egresos += amt; totalEgresos += amt; }

      let r = reasonMap.get(reason);
      if (!r) { r = { reason, count: 0, ingresos: 0, egresos: 0 }; reasonMap.set(reason, r); }
      r.count += 1;
      if (isAbono) r.ingresos += amt; else r.egresos += amt;
    }
  }

  const months = Array.from(monthMap.values()).sort((a, b) => a.ym.localeCompare(b.ym));
  for (const m of months) {
    m.rows.sort((a, b) => a.fecha.localeCompare(b.fecha) || b.importe - a.importe);
  }
  const byReason = ALL_REASONS
    .map((reason) => reasonMap.get(reason))
    .filter((r): r is ReasonAgg => !!r);

  return {
    months,
    byReason,
    totalIngresos,
    totalEgresos,
    totalCount: allRows.length,
    scannedLines,
    allRows,
  };
}

function csvEscape(value: string | number): string {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadCsv(rows: readonly DetailRow[]): void {
  const header = ['mes', 'fecha', 'cia', 'cuenta', 'banco', 'tipo', 'importe', 'razon', 'concepto', 'referencia'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([
      r.ym, r.fecha, r.cia, r.cuenta, r.nombreBanco, r.tipo,
      r.importe, REASON_LABELS[r.reason], r.concepto, r.referencia,
    ].map(csvEscape).join(','));
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `traspasos-internos-debug-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export interface InternalTransfersDebugPanelProps {
  bankStatements: BankAccountStatement[];
  companyCode: string;
}

export function InternalTransfersDebugPanel({
  bankStatements,
  companyCode,
}: InternalTransfersDebugPanelProps) {
  const result = useMemo(
    () => computeInternalTransfers(bankStatements, companyCode),
    [bankStatements, companyCode],
  );
  const [openMonths, setOpenMonths] = useState<Set<string>>(new Set());

  // Diagnóstico por consola: window.__midas__.internalTransfersDebug
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const w = window as unknown as { __midas__?: Record<string, unknown> };
      w.__midas__ = w.__midas__ || {};
      w.__midas__.internalTransfersDebug = result;
    }
  }, [result]);

  const neto = result.totalIngresos - result.totalEgresos;

  if (result.totalCount === 0) {
    return (
      <div className="rounded-xl border border-[var(--gray-200)] bg-white px-4 py-6 text-center text-[13px] text-[var(--gray-600)]">
        No se detectaron traspasos internos en los estados de cuenta cargados
        {companyCode !== 'all' ? ` (empresa ${companyCode})` : ''}.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Resumen */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Ingresos internos (Σ ABONO)" value={fmtCurrency(result.totalIngresos)} tone="success" />
        <StatCard label="Egresos internos (Σ CARGO)" value={fmtCurrency(result.totalEgresos)} tone="danger" />
        <StatCard
          label="Neto / asimetría (ingreso − egreso)"
          value={fmtCurrency(neto)}
          tone={Math.abs(neto) < 1 ? 'neutral' : 'warn'}
          sub="Esto es lo que el plug INTERNAL_RECON ancla a la caja"
        />
        <StatCard label="# movimientos" value={fmtInt(result.totalCount)} tone="neutral" sub={`de ${fmtInt(result.scannedLines)} líneas`} />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[12px] text-[var(--gray-600)]">
          {companyCode !== 'all'
            ? <>Filtrado a empresa <b>{companyCode}</b>.</>
            : <>Todas las empresas.</>}{' '}
          Mismo criterio que el motor (heurística + cuenta neutra del catálogo).
        </p>
        <button
          type="button"
          onClick={() => downloadCsv(result.allRows)}
          className="inline-flex h-9 items-center gap-2 rounded-lg border border-[var(--gray-200)] bg-white px-3 text-[12px] font-medium text-[var(--gray-700)] hover:bg-[var(--gray-50)]"
        >
          <Download className="h-3.5 w-3.5" strokeWidth={1.75} />
          Descargar CSV ({fmtInt(result.totalCount)})
        </button>
      </div>

      {/* Desglose por razón de detección */}
      <div className="rounded-xl border border-[var(--gray-200)] bg-white overflow-hidden">
        <div className="px-4 py-2 text-[12px] font-semibold text-[var(--gray-700)] border-b border-[var(--gray-200)]">
          Por qué se clasificó como interno
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-[var(--gray-500)] text-left">
                <th className="px-4 py-2 font-medium">Razón</th>
                <th className="px-4 py-2 font-medium text-right">#</th>
                <th className="px-4 py-2 font-medium text-right">Σ ABONO</th>
                <th className="px-4 py-2 font-medium text-right">Σ CARGO</th>
                <th className="px-4 py-2 font-medium text-right">Neto</th>
              </tr>
            </thead>
            <tbody>
              {result.byReason.map((r) => (
                <tr key={r.reason} className="border-t border-[var(--gray-100)]">
                  <td className="px-4 py-2 text-[var(--gray-700)]">{REASON_LABELS[r.reason]}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{fmtInt(r.count)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{fmtCompact(r.ingresos)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{fmtCompact(r.egresos)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{fmtCompact(r.ingresos - r.egresos)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Tabla por mes con drill-down */}
      <div className="rounded-xl border border-[var(--gray-200)] bg-white overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-[var(--gray-500)] text-left">
                <th className="px-4 py-2 font-medium">Mes</th>
                <th className="px-4 py-2 font-medium text-right">Ingresos (ABONO)</th>
                <th className="px-4 py-2 font-medium text-right">Egresos (CARGO)</th>
                <th className="px-4 py-2 font-medium text-right">Neto</th>
                <th className="px-4 py-2 font-medium text-right"># movs</th>
              </tr>
            </thead>
            <tbody>
              {result.months.map((m) => {
                const isOpen = openMonths.has(m.ym);
                const monthNeto = m.ingresos - m.egresos;
                return (
                  <Fragment key={m.ym}>
                    <tr
                      className="border-t border-[var(--gray-100)] cursor-pointer hover:bg-[var(--gray-50)]"
                      onClick={() => setOpenMonths((prev) => {
                        const next = new Set(prev);
                        if (next.has(m.ym)) next.delete(m.ym); else next.add(m.ym);
                        return next;
                      })}
                    >
                      <td className="px-4 py-2 text-[var(--gray-800)] font-medium">
                        <span className="inline-flex items-center gap-1">
                          {isOpen
                            ? <ChevronDown className="h-3.5 w-3.5" strokeWidth={1.75} />
                            : <ChevronRight className="h-3.5 w-3.5" strokeWidth={1.75} />}
                          {fmtYearMonthLong(m.ym)}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-[var(--success)]">{fmtCurrency(m.ingresos)}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-[var(--danger)]">{fmtCurrency(m.egresos)}</td>
                      <td className="px-4 py-2 text-right tabular-nums font-medium">{fmtCurrency(monthNeto)}</td>
                      <td className="px-4 py-2 text-right tabular-nums">{fmtInt(m.count)}</td>
                    </tr>
                    {isOpen && (
                      <tr className="bg-[var(--gray-50)]">
                        <td colSpan={5} className="px-4 py-2">
                          <div className="max-h-80 overflow-auto rounded-lg border border-[var(--gray-200)] bg-white">
                            <table className="w-full text-[11px]">
                              <thead className="sticky top-0 bg-[var(--gray-50)]">
                                <tr className="text-[var(--gray-500)] text-left">
                                  <th className="px-3 py-1.5 font-medium">Fecha</th>
                                  <th className="px-3 py-1.5 font-medium">Empresa</th>
                                  <th className="px-3 py-1.5 font-medium">Cuenta / Banco</th>
                                  <th className="px-3 py-1.5 font-medium">Tipo</th>
                                  <th className="px-3 py-1.5 font-medium text-right">Importe</th>
                                  <th className="px-3 py-1.5 font-medium">Razón</th>
                                  <th className="px-3 py-1.5 font-medium">Concepto</th>
                                </tr>
                              </thead>
                              <tbody>
                                {m.rows.slice(0, MAX_DETAIL_ROWS_PER_MONTH).map((r, i) => (
                                  <tr key={i} className="border-t border-[var(--gray-100)]">
                                    <td className="px-3 py-1.5 tabular-nums whitespace-nowrap">{r.fecha}</td>
                                    <td className="px-3 py-1.5 tabular-nums">{r.cia}</td>
                                    <td className="px-3 py-1.5 whitespace-nowrap">{r.cuenta} · {r.nombreBanco}</td>
                                    <td className={`px-3 py-1.5 ${r.tipo === 'ABONO' ? 'text-[var(--success)]' : 'text-[var(--danger)]'}`}>{r.tipo}</td>
                                    <td className="px-3 py-1.5 text-right tabular-nums">{fmtCurrency(r.importe)}</td>
                                    <td className="px-3 py-1.5">{REASON_LABELS[r.reason]}</td>
                                    <td className="px-3 py-1.5 max-w-xs truncate" title={r.concepto}>{r.concepto}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                            {m.rows.length > MAX_DETAIL_ROWS_PER_MONTH && (
                              <div className="px-3 py-2 text-[11px] text-[var(--gray-500)]">
                                Mostrando {MAX_DETAIL_ROWS_PER_MONTH} de {fmtInt(m.rows.length)} movimientos.
                                Usa “Descargar CSV” para el detalle completo.
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  tone,
  sub,
}: {
  label: string;
  value: string;
  tone: 'success' | 'danger' | 'warn' | 'neutral';
  sub?: string;
}) {
  const color = tone === 'success' ? 'var(--success)'
    : tone === 'danger' ? 'var(--danger)'
    : tone === 'warn' ? 'var(--warning, #b45309)'
    : 'var(--gray-700)';
  return (
    <div className="rounded-xl border border-[var(--gray-200)] bg-white px-4 py-3">
      <div className="text-[11px] text-[var(--gray-500)]">{label}</div>
      <div className="text-[18px] font-semibold tabular-nums" style={{ color }}>{value}</div>
      {sub && <div className="text-[10px] text-[var(--gray-400)] mt-0.5">{sub}</div>}
    </div>
  );
}
