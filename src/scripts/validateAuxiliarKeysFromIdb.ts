/**
 * Runner browser-only para `validateAuxiliarBankKeys`.
 *
 * Levanta los registros ya cacheados en `dailyApiCache` (IDB) — NO toca la
 * red. Recorre el rango día por día, junta auxiliar + bank statements para la
 * cía y la ventana pedida, corre la función pura y descarga un JSON.
 *
 * Uso (devtools del dev server con la app corriendo):
 *
 *   const m = await import('/src/scripts/validateAuxiliarKeysFromIdb.ts');
 *   const report = await m.run({ cia: '00042', from: '2026-05-19', to: '2026-05-25' });
 *
 * Imprime el reporte y deja un JSON descargable como `auxiliar-key-report-{cia}-{from}-{to}.json`.
 *
 * IMPORTANTE: requiere que la app haya cargado bancos + auxiliar de ese rango
 * previamente (su boot hidrata el IDB). Si los días no están en cache este
 * runner los reporta como ausentes — pídeselos a la app antes de re-correr.
 */

import {
  primeDailyCache,
  hasDailyCached,
  getDailyCachedAsync,
} from '../services/dailyApiCache';
import {
  validateAuxiliarBankKeys,
  formatReport,
  type KeyValidationReport,
} from '../domain/auxiliarKeyValidation';
import type {
  AuxiliarContableRecord,
  BankAccountStatement,
} from '../services/jdeTypes';

const AUX_API = 'auxiliarcontable';
const BANK_API = 'banks.SWIFT';

export interface RunOptions {
  cia: string;
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD
  /** Si true, dispara descarga del JSON. Default true. */
  download?: boolean;
  /** Si true, imprime formatReport a console. Default true. */
  print?: boolean;
}

export interface RunResult {
  report: KeyValidationReport;
  cacheCoverage: {
    days: string[];
    auxDaysCached: number;
    bankDaysCached: number;
    auxDaysMissing: string[];
    bankDaysMissing: string[];
  };
}

function buildDays(from: string, to: string): string[] {
  const start = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return [];
  const out: string[] = [];
  const cursor = new Date(start);
  while (cursor <= end) {
    out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

function triggerDownload(filename: string, payload: unknown): void {
  if (typeof document === 'undefined' || typeof URL === 'undefined') return;
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export async function run(options: RunOptions): Promise<RunResult> {
  const { cia, from, to, download = true, print = true } = options;

  await primeDailyCache();

  const days = buildDays(from, to);
  if (days.length === 0) {
    throw new Error(`Rango inválido: ${from}..${to}`);
  }

  const auxRecords: AuxiliarContableRecord[] = [];
  const bankStatements: BankAccountStatement[] = [];
  const auxDaysMissing: string[] = [];
  const bankDaysMissing: string[] = [];
  let auxDaysCached = 0;
  let bankDaysCached = 0;

  for (const day of days) {
    const auxHit = hasDailyCached(AUX_API, day, cia);
    if (auxHit) {
      auxDaysCached++;
      const list = await getDailyCachedAsync<AuxiliarContableRecord>(AUX_API, day, cia);
      if (list) auxRecords.push(...list);
    } else {
      auxDaysMissing.push(day);
    }

    const bankHit = hasDailyCached(BANK_API, day);
    if (bankHit) {
      bankDaysCached++;
      const list = await getDailyCachedAsync<BankAccountStatement>(BANK_API, day);
      if (list) bankStatements.push(...list);
    } else {
      bankDaysMissing.push(day);
    }
  }

  if (auxRecords.length === 0 && auxDaysCached === 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[validateAuxiliarKeysFromIdb] Sin auxiliar cacheado para ${cia} en ${from}..${to}. Carga la app primero — el boot hidrata el IDB.`,
    );
  }
  if (bankStatements.length === 0 && bankDaysCached === 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[validateAuxiliarKeysFromIdb] Sin bancos cacheados en ${from}..${to}. Igual que arriba — corre la app y vuelve.`,
    );
  }

  const report = validateAuxiliarBankKeys({
    records: auxRecords,
    bankStatements,
    cia,
  });

  if (print) {
    // eslint-disable-next-line no-console
    console.log(formatReport(report));
  }

  const result: RunResult = {
    report,
    cacheCoverage: {
      days,
      auxDaysCached,
      bankDaysCached,
      auxDaysMissing,
      bankDaysMissing,
    },
  };

  if (download) {
    triggerDownload(`auxiliar-key-report-${cia}-${from}-${to}.json`, result);
  }

  return result;
}
