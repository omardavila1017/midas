import type { BankStatementLine, CobranzaPayment } from '../../../services/jdeTypes';
import type {
  Comparison,
  KpiRow,
  Objective,
  ObjectiveEvaluation,
  ObjectiveStatus,
} from '../types';

// ─────────────────────────────────────────────────────────────────────────
// Evaluador de objetivos.
//
// Reglas (en orden de precedencia):
//   1. Si `manualStatus` está fijado → gana, sin importar la fórmula.
//   2. NUMERIC_MONTHLY  → agrega ingresos/egresos del mes y compara contra meta.
//   3. KPI_THRESHOLD    → toma el valor del KPI ligado y aplica la comparación.
//   4. QUALITATIVE      → default IN_PROGRESS; MISSED si pasó dueDate.
//
// Cuando un objetivo no puede evaluarse (datos insuficientes, KPI no
// encontrado), regresa IN_PROGRESS + reason explicando el porqué.
// ─────────────────────────────────────────────────────────────────────────

export interface EvaluatorContext {
  bankStatements: BankStatementLine[];
  cobranzaPayments: CobranzaPayment[];
  kpiRows: KpiRow[];
  /** ISO YYYY-MM-DD. */
  today: string;
}

export function evaluateObjective(objective: Objective, ctx: EvaluatorContext): ObjectiveEvaluation {
  if (objective.manualStatus) {
    return {
      status: objective.manualStatus,
      actualValue: null,
      reason: 'Estado fijado manualmente.',
      manualOverride: true,
    };
  }

  switch (objective.kind) {
    case 'NUMERIC_MONTHLY':
      return evaluateNumeric(objective, ctx);
    case 'KPI_THRESHOLD':
      return evaluateThreshold(objective, ctx);
    case 'QUALITATIVE':
      return evaluateQualitative(objective, ctx);
    default:
      return inProgress('Tipo de objetivo no reconocido.');
  }
}

function evaluateNumeric(objective: Objective, ctx: EvaluatorContext): ObjectiveEvaluation {
  if (
    !objective.numericConcept
    || !objective.targetYearMonth
    || typeof objective.targetAmount !== 'number'
    || !objective.comparison
  ) {
    return inProgress('Faltan datos para evaluar (concepto, mes, monto o comparación).');
  }

  const monthEnd = lastDayOfMonth(objective.targetYearMonth);
  const isPast = monthEnd < ctx.today;

  let actual = 0;
  if (objective.numericConcept === 'INFLOW') {
    for (const pago of ctx.cobranzaPayments) {
      const fecha = pago.fechaCobro || pago.fechaContable || '';
      if (fecha.slice(0, 7) === objective.targetYearMonth) {
        actual += Number(pago.importeRecibo) || 0;
      }
    }
  } else if (objective.numericConcept === 'OUTFLOW') {
    for (const line of ctx.bankStatements) {
      if (line.tipoMovimiento !== 'CARGO') continue;
      const fecha = line.fechaOperacion || line.fechaValor || '';
      if (fecha.slice(0, 7) === objective.targetYearMonth) {
        actual += Number(line.importe) || 0;
      }
    }
  } else {
    // CASH_CLOSE — saldo de bancos al cierre del mes objetivo.
    actual = sumLatestSaldoBefore(ctx.bankStatements, monthEnd);
  }

  const passes = compare(actual, objective.targetAmount, objective.comparison);
  if (isPast) {
    return {
      status: passes ? 'MET' : 'MISSED',
      actualValue: actual,
      reason: `${describeConcept(objective.numericConcept)} de ${objective.targetYearMonth}: ${formatCurrency(actual)} vs meta ${formatCurrency(objective.targetAmount)}.`,
      manualOverride: false,
    };
  }
  return {
    status: 'IN_PROGRESS',
    actualValue: actual,
    reason: `Mes en curso o futuro. Acumulado actual: ${formatCurrency(actual)} / meta ${formatCurrency(objective.targetAmount)}.`,
    manualOverride: false,
  };
}

function evaluateThreshold(objective: Objective, ctx: EvaluatorContext): ObjectiveEvaluation {
  if (!objective.linkedKpiKey || typeof objective.threshold !== 'number' || !objective.comparison) {
    return inProgress('Faltan datos para evaluar (KPI ligado, umbral o comparación).');
  }
  const row = ctx.kpiRows.find((r) => r.key === objective.linkedKpiKey);
  if (!row) return inProgress('El KPI ligado ya no existe.');
  if (row.value === null) {
    return {
      status: 'IN_PROGRESS',
      actualValue: null,
      reason: `KPI "${row.label}" sin valor disponible aún.`,
      manualOverride: false,
    };
  }

  const passes = compare(row.value, objective.threshold, objective.comparison);
  return {
    status: passes ? 'MET' : 'MISSED',
    actualValue: row.value,
    reason: `${row.label}: ${formatByUnit(row.value, row.unit)} ${comparisonLabel(objective.comparison)} ${formatByUnit(objective.threshold, row.unit)}.`,
    manualOverride: false,
  };
}

function evaluateQualitative(objective: Objective, ctx: EvaluatorContext): ObjectiveEvaluation {
  if (objective.dueDate && objective.dueDate < ctx.today) {
    return {
      status: 'MISSED',
      actualValue: null,
      reason: `Fecha límite ${objective.dueDate} pasó sin marcar como cumplido.`,
      manualOverride: false,
    };
  }
  return {
    status: 'IN_PROGRESS',
    actualValue: null,
    reason: objective.dueDate
      ? `Hito cualitativo. Fecha límite ${objective.dueDate}. Marca manualmente cuando se cumpla.`
      : 'Hito cualitativo. Marca manualmente cuando se cumpla.',
    manualOverride: false,
  };
}

function compare(actual: number, target: number, op: Comparison): boolean {
  switch (op) {
    case 'GTE':
      return actual >= target;
    case 'LTE':
      return actual <= target;
    case 'EQ':
      return Math.abs(actual - target) < 0.005;
    default:
      return false;
  }
}

function comparisonLabel(op: Comparison): string {
  return op === 'GTE' ? '≥' : op === 'LTE' ? '≤' : '=';
}

function describeConcept(c: Objective['numericConcept']): string {
  if (c === 'INFLOW') return 'Cobranza';
  if (c === 'OUTFLOW') return 'Egresos';
  return 'Saldo de cierre';
}

function lastDayOfMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m)) return ym;
  const date = new Date(Date.UTC(y, m, 0));
  return date.toISOString().slice(0, 10);
}

function sumLatestSaldoBefore(lines: BankStatementLine[], cutoff: string): number {
  const latest = new Map<string, { date: string; saldo?: number; gsaid?: string }>();
  for (const line of lines) {
    const fecha = line.fechaOperacion || line.fechaValor || '';
    if (!fecha || fecha > cutoff) continue;
    const key = `${line.cia}::${line.banco}::${line.cuenta}`;
    const snap = { date: fecha, saldo: line.saldo, gsaid: line.gsaid };
    const prev = latest.get(key);
    if (!prev || snap.date > prev.date || (snap.date === prev.date && (snap.gsaid ?? '') > (prev.gsaid ?? ''))) {
      latest.set(key, snap);
    }
  }
  let total = 0;
  for (const snap of latest.values()) {
    if (typeof snap.saldo === 'number' && Number.isFinite(snap.saldo)) total += snap.saldo;
  }
  return total;
}

function formatByUnit(value: number, unit: KpiRow['unit']): string {
  if (unit === 'MXN') return formatCurrency(value);
  if (unit === 'pct') return `${(value * 100).toFixed(1)}%`;
  if (unit === 'days') return `${Math.round(value)} días`;
  if (unit === 'ratio') return `${value.toFixed(2)}x`;
  return new Intl.NumberFormat('es-MX').format(value);
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency: 'MXN',
    maximumFractionDigits: 0,
  }).format(value);
}

function inProgress(reason: string): ObjectiveEvaluation {
  return { status: 'IN_PROGRESS', actualValue: null, reason, manualOverride: false };
}

export function objectiveStatusBadge(status: ObjectiveStatus): { label: string; tone: 'success' | 'danger' | 'warning' } {
  if (status === 'MET') return { label: 'Cumplido', tone: 'success' };
  if (status === 'MISSED') return { label: 'No cumplido', tone: 'danger' };
  return { label: 'En progreso', tone: 'warning' };
}
