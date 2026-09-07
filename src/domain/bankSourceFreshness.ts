/**
 * Frescura de las fuentes bancarias: por fuente MANUAL (Bajío / Santander) y
 * por EMPRESA sobre todo el set cargado (incluye los feeds JDE).
 *
 * Las tablas espejo de BD de estos bancos están muertas (auditoría BD
 * 2026-07-22: última fila Bajío 08-jul, Santander 04-jun); el camino vivo en
 * Midas es la carga manual de CSV (`santanderCsv.ts` + `isBajioStatement`),
 * que llega con semanas de atraso y hoy el rezago es invisible. Este módulo
 * calcula, por banco (y por cuenta), la fecha del último movimiento cargado y
 * los días HÁBILES transcurridos (calendario `bankHolidays.ts`), con umbrales
 * configurables para pintar verde/amarillo/rojo en Bancos y en Salud de datos.
 *
 * `summarizeBankFreshnessByCompany` (2026-09-07) cubre el hueco que quedaba: el
 * resumen por fuente sólo mira Bajío/Santander, así que un feed JDE muerto no
 * avisaba en ninguna parte. Medido contra la BD ese día, **cuatro empresas
 * llevaban semanas sin UN SOLO movimiento bancario** — cía 29 y 46 desde el
 * 13-ago, cía 30 desde el 17-ago, cía 41 desde el **12-mar** — con todas sus
 * cuentas calladas a la vez, mientras el resto del grupo reportaba al 04-sep.
 * Importa porque la caja histórica se ANCLA al estado de cuenta: sin feed, el
 * saldo de esa cía se congela en su último corte y MOTOR 1 se cambia en
 * silencio a los sintéticos `cobranza-historic:`/`auxiliar-historic:` para esos
 * meses (`bankCoverage` en falso). Es dato de origen, pero callarlo es lo que
 * lo vuelve caro.
 *
 * Puro y con reloj inyectado (`todayISO`) — nada de Date.now() en la lógica.
 */
import { isNonOperatingDay } from './bankHolidays';
import { isBajioStatement } from './bankStatements';
import type { BankAccountStatement } from '../services/jdeTypes';

export type ManualBankSourceId = 'bajio' | 'santander';

export type BankSourceFreshnessStatus = 'fresh' | 'aging' | 'stale' | 'no-data';

export interface BankFreshnessThresholds {
  /** Verde hasta este número de días hábiles (inclusive). */
  freshMaxBusinessDays: number;
  /** Amarillo hasta este número de días hábiles (inclusive); arriba → rojo. */
  agingMaxBusinessDays: number;
}

/** Umbrales default: verde ≤3 días hábiles, amarillo 4-10, rojo >10. */
export const MANUAL_BANK_FRESHNESS_THRESHOLDS: BankFreshnessThresholds = {
  freshMaxBusinessDays: 3,
  agingMaxBusinessDays: 10,
};

export interface BankAccountFreshness {
  cuenta: string;
  lastMovementDate: string | null;
  businessDaysElapsed: number | null;
  status: BankSourceFreshnessStatus;
}

export interface ManualBankFreshness {
  source: ManualBankSourceId;
  label: string;
  lastMovementDate: string | null;
  businessDaysElapsed: number | null;
  status: BankSourceFreshnessStatus;
  accounts: BankAccountFreshness[];
}

const MS_PER_DAY = 86_400_000;

function parseIsoDay(value: string | null | undefined): number | null {
  const trimmed = (value ?? '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  const ms = Date.parse(`${trimmed}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Días hábiles en el intervalo (from, to] — cuántos días de banco han pasado
 * desde `from` hasta `to`. Mismo día o `from` futuro → 0.
 */
export function countBusinessDaysBetween(fromISO: string, toISO: string): number | null {
  const from = parseIsoDay(fromISO);
  const to = parseIsoDay(toISO);
  if (from === null || to === null) return null;
  let count = 0;
  for (let ms = from + MS_PER_DAY; ms <= to; ms += MS_PER_DAY) {
    if (!isNonOperatingDay(new Date(ms))) count += 1;
  }
  return count;
}

export function freshnessStatusFor(
  businessDaysElapsed: number | null,
  thresholds: BankFreshnessThresholds = MANUAL_BANK_FRESHNESS_THRESHOLDS,
): BankSourceFreshnessStatus {
  if (businessDaysElapsed === null) return 'no-data';
  if (businessDaysElapsed <= thresholds.freshMaxBusinessDays) return 'fresh';
  if (businessDaysElapsed <= thresholds.agingMaxBusinessDays) return 'aging';
  return 'stale';
}

function isSantanderStatement(stmt: Pick<BankAccountStatement, 'banco' | 'nombreBanco'>): boolean {
  const name = (stmt.nombreBanco ?? '').toUpperCase();
  const code = (stmt.banco ?? '').toUpperCase();
  return name.includes('SANTANDER') || code.includes('SANTANDER');
}

/** Última fecha con movimiento del estado; cae a `fechaEstadoCuenta` si no hay líneas. */
function statementLastMovementDate(stmt: BankAccountStatement): string | null {
  let max: string | null = null;
  for (const mov of stmt.movimientos ?? []) {
    const day = (mov.fechaOperacion ?? '').trim().slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(day) && (!max || day > max)) max = day;
  }
  if (max) return max;
  const fallback = (stmt.fechaEstadoCuenta ?? '').trim().slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(fallback) ? fallback : null;
}

const SOURCES: { source: ManualBankSourceId; label: string; matches: (s: BankAccountStatement) => boolean }[] = [
  { source: 'bajio', label: 'BanBajío (carga manual)', matches: isBajioStatement },
  { source: 'santander', label: 'Santander (carga manual)', matches: isSantanderStatement },
];

/**
 * Resumen de frescura por fuente bancaria manual sobre los statements ya
 * cargados (JDE + suplementales mergeados). Una fuente sin ningún statement
 * sale `no-data` (equivale a rezago total para Tesorería / Fideicomiso).
 * Fecha futura (error de captura) → `stale`, nunca verde (misma convención
 * que `dataSourcesService`).
 */
export function summarizeManualBankFreshness(
  statements: readonly BankAccountStatement[],
  todayISO: string,
  thresholds: BankFreshnessThresholds = MANUAL_BANK_FRESHNESS_THRESHOLDS,
): ManualBankFreshness[] {
  return SOURCES.map(({ source, label, matches }) => {
    const own = statements.filter(matches);
    const byAccount = new Map<string, string | null>();
    for (const stmt of own) {
      const cuenta = (stmt.cuenta ?? '').trim() || '(sin cuenta)';
      const last = statementLastMovementDate(stmt);
      const prev = byAccount.get(cuenta);
      if (prev === undefined || (last && (!prev || last > prev))) byAccount.set(cuenta, last);
    }

    const accountRow = (cuenta: string, last: string | null): BankAccountFreshness => {
      if (!last) return { cuenta, lastMovementDate: null, businessDaysElapsed: null, status: 'no-data' };
      if (last > todayISO.slice(0, 10)) {
        return { cuenta, lastMovementDate: last, businessDaysElapsed: 0, status: 'stale' };
      }
      const days = countBusinessDaysBetween(last, todayISO);
      return { cuenta, lastMovementDate: last, businessDaysElapsed: days, status: freshnessStatusFor(days, thresholds) };
    };

    const accounts = [...byAccount.entries()]
      .map(([cuenta, last]) => accountRow(cuenta, last))
      .sort((a, b) => a.cuenta.localeCompare(b.cuenta));

    // El agregado del banco usa el movimiento MÁS RECIENTE de cualquier cuenta
    // (¿qué tan vieja es la última carga que llegó?); el detalle por cuenta
    // delata cuentas individuales rezagadas.
    let lastOfBank: string | null = null;
    for (const { lastMovementDate } of accounts) {
      if (lastMovementDate && (!lastOfBank || lastMovementDate > lastOfBank)) lastOfBank = lastMovementDate;
    }
    const bankRow = accountRow('', lastOfBank);
    return {
      source,
      label,
      lastMovementDate: bankRow.lastMovementDate,
      businessDaysElapsed: bankRow.businessDaysElapsed,
      status: accounts.length === 0 ? 'no-data' : bankRow.status,
      accounts,
    };
  });
}

export interface CompanyBankFreshness {
  cia: string;
  lastMovementDate: string | null;
  businessDaysElapsed: number | null;
  status: BankSourceFreshnessStatus;
  /** Cuántas cuentas de la cía tienen statements cargados. */
  accountCount: number;
  /** Cuentas de la cía, la más rezagada primero. */
  accounts: BankAccountFreshness[];
}

/**
 * Frescura bancaria por EMPRESA sobre TODOS los statements cargados (JDE +
 * manuales). El agregado de la cía usa el movimiento MÁS RECIENTE de cualquiera
 * de sus cuentas: la pregunta es "¿esta empresa sigue reportando banco?", y una
 * sola cuenta viva basta para que la caja de la cía avance. El detalle por
 * cuenta delata las cuentas individuales apagadas (cuentas migradas a otra
 * empresa, cerradas, o un feed roto).
 *
 * Fecha futura → `stale`, nunca verde (misma convención que
 * `summarizeManualBankFreshness` y `dataSourcesService`).
 */
export function summarizeBankFreshnessByCompany(
  statements: readonly BankAccountStatement[],
  todayISO: string,
  thresholds: BankFreshnessThresholds = MANUAL_BANK_FRESHNESS_THRESHOLDS,
): CompanyBankFreshness[] {
  const today = todayISO.slice(0, 10);

  const rowFor = (cuenta: string, last: string | null): BankAccountFreshness => {
    if (!last) return { cuenta, lastMovementDate: null, businessDaysElapsed: null, status: 'no-data' };
    if (last > today) return { cuenta, lastMovementDate: last, businessDaysElapsed: 0, status: 'stale' };
    const days = countBusinessDaysBetween(last, todayISO);
    return { cuenta, lastMovementDate: last, businessDaysElapsed: days, status: freshnessStatusFor(days, thresholds) };
  };

  // cía → cuenta → última fecha con movimiento
  const byCompany = new Map<string, Map<string, string | null>>();
  for (const stmt of statements) {
    const cia = (stmt.cia ?? '').trim();
    if (!cia) continue;
    const cuenta = (stmt.cuenta ?? '').trim() || '(sin cuenta)';
    const last = statementLastMovementDate(stmt);
    let accounts = byCompany.get(cia);
    if (!accounts) {
      accounts = new Map();
      byCompany.set(cia, accounts);
    }
    const prev = accounts.get(cuenta);
    if (prev === undefined || (last && (!prev || last > prev))) accounts.set(cuenta, last);
  }

  return [...byCompany.entries()]
    .map(([cia, accountMap]) => {
      const accounts = [...accountMap.entries()]
        .map(([cuenta, last]) => rowFor(cuenta, last))
        // Más rezagada primero: null (sin fecha) arriba, luego la más vieja.
        .sort((a, b) => {
          if (a.lastMovementDate === b.lastMovementDate) return a.cuenta.localeCompare(b.cuenta);
          if (!a.lastMovementDate) return -1;
          if (!b.lastMovementDate) return 1;
          return a.lastMovementDate.localeCompare(b.lastMovementDate);
        });

      let latest: string | null = null;
      for (const { lastMovementDate } of accounts) {
        if (lastMovementDate && (!latest || lastMovementDate > latest)) latest = lastMovementDate;
      }
      const aggregate = rowFor('', latest);
      return {
        cia,
        lastMovementDate: aggregate.lastMovementDate,
        businessDaysElapsed: aggregate.businessDaysElapsed,
        status: aggregate.status,
        accountCount: accounts.length,
        accounts,
      };
    })
    // Peor primero, para que el rezago crítico se vea sin buscar.
    .sort((a, b) => {
      const rank = (s: BankSourceFreshnessStatus) => (s === 'no-data' ? 0 : s === 'stale' ? 1 : s === 'aging' ? 2 : 3);
      return rank(a.status) - rank(b.status)
        || (b.businessDaysElapsed ?? 0) - (a.businessDaysElapsed ?? 0)
        || a.cia.localeCompare(b.cia);
    });
}
