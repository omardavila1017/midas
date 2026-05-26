import type { BankStatementLine, CobranzaPayment } from '../../../services/jdeTypes';
import type { CXPRecord } from '../../../domain/persistence';
import type { CustomKpi, KpiRow, SystemKpiDescriptor, SystemKpiId } from '../types';

// ─────────────────────────────────────────────────────────────────────────
// Catálogo de KPIs autocalculados.
//
// El módulo lee SOLO datos crudos que el shell ya tiene en memoria
// (bankStatements + cobranzaPayments + cxpRecords). No invoca el motor
// canónico ni recomputa proyecciones — eso lo hace Proyección Financiera.
// El precio: KPIs son simples ("estado hoy") y no consideran propuestas
// activas del escenario seleccionado. v2 puede engancharse al ForecastRun
// si el usuario lo pide.
// ─────────────────────────────────────────────────────────────────────────

export const SYSTEM_KPIS: SystemKpiDescriptor[] = [
  {
    id: 'caja_actual',
    label: 'Caja actual',
    unit: 'MXN',
    periodLabel: 'Hoy',
    description: 'Suma del último saldo reportado por cada cuenta bancaria activa.',
  },
  {
    id: 'cobranza_ytd',
    label: 'Cobranza YTD',
    unit: 'MXN',
    periodLabel: 'Año en curso',
    description: 'Suma de pagos recibidos (cobranza JDE) desde el 1 de enero.',
  },
  {
    id: 'cobranza_mes',
    label: 'Cobranza mes actual',
    unit: 'MXN',
    periodLabel: 'Mes en curso',
    description: 'Pagos recibidos en el mes en curso.',
  },
  {
    id: 'gasto_ytd',
    label: 'Gasto YTD',
    unit: 'MXN',
    periodLabel: 'Año en curso',
    description: 'Suma de cargos bancarios desde el 1 de enero.',
  },
  {
    id: 'gasto_mes',
    label: 'Gasto mes actual',
    unit: 'MXN',
    periodLabel: 'Mes en curso',
    description: 'Cargos bancarios del mes en curso.',
  },
  {
    id: 'flujo_neto_ytd',
    label: 'Flujo neto YTD',
    unit: 'MXN',
    periodLabel: 'Año en curso',
    description: 'Cobranza YTD menos Gasto YTD.',
  },
  {
    id: 'cxp_pendiente',
    label: 'CXP pendiente',
    unit: 'MXN',
    periodLabel: 'Hoy',
    description: 'Saldo total pendiente en antigüedad de saldos.',
  },
];

export interface KpiInputs {
  bankStatements: BankStatementLine[];
  cobranzaPayments: CobranzaPayment[];
  cxpRecords: CXPRecord[];
  /** ISO YYYY-MM-DD. Se usa como "hoy" para periodos. */
  today: string;
}

interface DerivedTotals {
  cobranzaYtd: number;
  cobranzaMes: number;
  cobranzaPrevMes: number;
  gastoYtd: number;
  gastoMes: number;
  gastoPrevMes: number;
  cajaActual: number | null;
  cajaPrev: number | null;
  cxpPendiente: number;
}

function computeDerivedTotals(inputs: KpiInputs): DerivedTotals {
  const todayYear = inputs.today.slice(0, 4);
  const todayYm = inputs.today.slice(0, 7);
  const prevYm = previousYearMonth(todayYm);

  let cobranzaYtd = 0;
  let cobranzaMes = 0;
  let cobranzaPrevMes = 0;
  for (const pago of inputs.cobranzaPayments) {
    const fecha = pago.fechaCobro || pago.fechaContable || '';
    if (!fecha) continue;
    const amount = Number(pago.importeRecibo) || 0;
    if (fecha.slice(0, 4) === todayYear) cobranzaYtd += amount;
    if (fecha.slice(0, 7) === todayYm) cobranzaMes += amount;
    if (fecha.slice(0, 7) === prevYm) cobranzaPrevMes += amount;
  }

  let gastoYtd = 0;
  let gastoMes = 0;
  let gastoPrevMes = 0;
  for (const line of inputs.bankStatements) {
    if (line.tipoMovimiento !== 'CARGO') continue;
    const fecha = line.fechaOperacion || line.fechaValor || '';
    if (!fecha) continue;
    const amount = Number(line.importe) || 0;
    if (fecha.slice(0, 4) === todayYear) gastoYtd += amount;
    if (fecha.slice(0, 7) === todayYm) gastoMes += amount;
    if (fecha.slice(0, 7) === prevYm) gastoPrevMes += amount;
  }

  const { current: cajaActual, prev: cajaPrev } = computeCashBalance(
    inputs.bankStatements,
    inputs.today,
  );

  const cxpPendiente = inputs.cxpRecords.reduce(
    (acc, r) => acc + (Number(r.importePendientePesos) || 0),
    0,
  );

  return {
    cobranzaYtd,
    cobranzaMes,
    cobranzaPrevMes,
    gastoYtd,
    gastoMes,
    gastoPrevMes,
    cajaActual,
    cajaPrev,
    cxpPendiente,
  };
}

function computeCashBalance(
  lines: BankStatementLine[],
  today: string,
): { current: number | null; prev: number | null } {
  // Último saldo reportado por cuenta (cia, banco, cuenta). El saldo ya
  // incluye la línea, así que ordenamos por fecha+gsaid y nos quedamos con
  // el más reciente. Si la línea no trae `saldo`, esa cuenta no aporta.
  type Snapshot = { date: string; saldo: number | undefined; gsaid?: string };
  const latestByAccount = new Map<string, Snapshot>();
  const prevMonthEnd = previousMonthEndISO(today);
  const prevByAccount = new Map<string, Snapshot>();

  for (const line of lines) {
    const key = `${line.cia}::${line.banco}::${line.cuenta}`;
    const date = line.fechaOperacion || line.fechaValor || '';
    if (!date) continue;
    const snap: Snapshot = { date, saldo: line.saldo, gsaid: line.gsaid };

    const prev = latestByAccount.get(key);
    if (!prev || compareSnap(snap, prev) > 0) latestByAccount.set(key, snap);

    if (date <= prevMonthEnd) {
      const prevRef = prevByAccount.get(key);
      if (!prevRef || compareSnap(snap, prevRef) > 0) prevByAccount.set(key, snap);
    }
  }

  const sumSaldos = (map: Map<string, Snapshot>): number | null => {
    let total = 0;
    let any = false;
    for (const snap of map.values()) {
      if (typeof snap.saldo === 'number' && Number.isFinite(snap.saldo)) {
        total += snap.saldo;
        any = true;
      }
    }
    return any ? total : null;
  };

  return { current: sumSaldos(latestByAccount), prev: sumSaldos(prevByAccount) };
}

function compareSnap(
  a: { date: string; gsaid?: string },
  b: { date: string; gsaid?: string },
): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  return (a.gsaid ?? '').localeCompare(b.gsaid ?? '');
}

function previousYearMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m)) return ym;
  const date = new Date(Date.UTC(y, m - 1, 1));
  date.setUTCMonth(date.getUTCMonth() - 1);
  const yy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${yy}-${mm}`;
}

function previousMonthEndISO(today: string): string {
  const [y, m] = today.split('-').slice(0, 2).map(Number);
  if (!Number.isFinite(y) || !Number.isFinite(m)) return today;
  // Día 0 del mes actual = último día del mes previo.
  const date = new Date(Date.UTC(y, m - 1, 0));
  return date.toISOString().slice(0, 10);
}

export function evaluateSystemKpi(
  id: SystemKpiId,
  totals: DerivedTotals,
): { value: number | null; deltaPrev: number | null } {
  switch (id) {
    case 'caja_actual':
      return {
        value: totals.cajaActual,
        deltaPrev:
          totals.cajaActual !== null && totals.cajaPrev !== null
            ? totals.cajaActual - totals.cajaPrev
            : null,
      };
    case 'cobranza_ytd':
      return { value: totals.cobranzaYtd, deltaPrev: null };
    case 'cobranza_mes':
      return {
        value: totals.cobranzaMes,
        deltaPrev: totals.cobranzaMes - totals.cobranzaPrevMes,
      };
    case 'gasto_ytd':
      return { value: totals.gastoYtd, deltaPrev: null };
    case 'gasto_mes':
      return {
        value: totals.gastoMes,
        deltaPrev: totals.gastoMes - totals.gastoPrevMes,
      };
    case 'flujo_neto_ytd':
      return {
        value: totals.cobranzaYtd - totals.gastoYtd,
        deltaPrev: null,
      };
    case 'cxp_pendiente':
      return { value: totals.cxpPendiente, deltaPrev: null };
    default:
      return { value: null, deltaPrev: null };
  }
}

export function buildKpiRows(inputs: KpiInputs, customKpis: CustomKpi[]): KpiRow[] {
  const totals = computeDerivedTotals(inputs);
  const systemRows: KpiRow[] = SYSTEM_KPIS.map((descriptor) => {
    const { value, deltaPrev } = evaluateSystemKpi(descriptor.id, totals);
    return {
      key: systemKpiKey(descriptor.id),
      source: 'system',
      label: descriptor.label,
      unit: descriptor.unit,
      periodLabel: descriptor.periodLabel,
      description: descriptor.description,
      value,
      deltaPrev,
    };
  });

  const customRows: KpiRow[] = customKpis.map((kpi) => ({
    key: customKpiKey(kpi.id),
    source: 'custom',
    label: kpi.name,
    unit: kpi.unit,
    periodLabel: kpi.manualValueDate ? `Captura ${kpi.manualValueDate}` : 'Manual',
    description: kpi.description,
    value: typeof kpi.manualValue === 'number' && Number.isFinite(kpi.manualValue)
      ? kpi.manualValue
      : null,
    deltaPrev: null,
    custom: kpi,
  }));

  return [...systemRows, ...customRows];
}

export function systemKpiKey(id: SystemKpiId): string {
  return `system:${id}`;
}

export function customKpiKey(id: string): string {
  return `custom:${id}`;
}

export function listAvailableKpiKeys(customKpis: CustomKpi[]): { key: string; label: string }[] {
  return [
    ...SYSTEM_KPIS.map((k) => ({ key: systemKpiKey(k.id), label: k.label })),
    ...customKpis.map((k) => ({ key: customKpiKey(k.id), label: k.name })),
  ];
}
