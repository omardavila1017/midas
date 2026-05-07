import type { BankAccountStatement, BankStatementFormat, BankStatementLine } from '../services/jdeTypes';

export interface BankQueryState {
  fechaEstadoCuenta: string;
  formatoElectronico: BankStatementFormat;
  hasUploadedSantander?: boolean;
}

function accountKey(statement: Pick<BankAccountStatement, 'cia' | 'cuenta' | 'moneda'>): string {
  return `${statement.cia}::${statement.cuenta}::${statement.moneda}`;
}

function movementKey(movement: Pick<BankStatementLine, 'fechaOperacion' | 'referencia' | 'tipoMovimiento' | 'importe' | 'concepto'>): string {
  return `${movement.fechaOperacion}|${movement.referencia}|${movement.tipoMovimiento}|${movement.importe}|${movement.concepto}`;
}

function movementSortKey(movement: Pick<BankStatementLine, 'fechaOperacion' | 'fechaValor' | 'referencia' | 'importe' | 'tipoMovimiento'>): string {
  return [
    movement.fechaOperacion,
    movement.fechaValor ?? '',
    movement.referencia ?? '',
    movement.tipoMovimiento ?? '',
    String(movement.importe ?? ''),
  ].join('|');
}

export function latestStatementDate(statements: readonly Pick<BankAccountStatement, 'fechaEstadoCuenta'>[]): string | null {
  let latest: string | null = null;
  for (const statement of statements) {
    if (!latest || statement.fechaEstadoCuenta > latest) latest = statement.fechaEstadoCuenta;
  }
  return latest;
}

export function currentBankStatements<T extends Pick<BankAccountStatement, 'fechaEstadoCuenta'>>(
  statements: readonly T[],
  asOfDate = latestStatementDate(statements),
): T[] {
  if (!asOfDate) return [];
  return statements.filter(statement => statement.fechaEstadoCuenta === asOfDate);
}

export function bankStatementBalance(statement: Pick<BankAccountStatement, 'saldoFinal' | 'saldoInicial'>): number {
  return statement.saldoFinal ?? statement.saldoInicial ?? 0;
}

export function sumBankStatementBalances(statements: readonly Pick<BankAccountStatement, 'saldoFinal' | 'saldoInicial'>[]): number {
  return statements.reduce((sum, statement) => sum + bankStatementBalance(statement), 0);
}

export function mergeBankStatements(...groups: BankAccountStatement[][]): BankAccountStatement[] {
  const merged = new Map<string, BankAccountStatement>();
  const seenMovements = new Map<string, Set<string>>();
  const firstDate = new Map<string, string>();
  const lastDate = new Map<string, string>();

  for (const group of groups) {
    for (const statement of group) {
      const key = accountKey(statement);
      let acc = merged.get(key);
      if (!acc) {
        acc = {
          cia: statement.cia,
          banco: statement.banco,
          nombreBanco: statement.nombreBanco,
          cuenta: statement.cuenta,
          moneda: statement.moneda,
          fechaEstadoCuenta: statement.fechaEstadoCuenta,
          saldoInicial: statement.saldoInicial,
          saldoFinal: statement.saldoFinal,
          cuentaContable: statement.cuentaContable,
          cuentaBancos: statement.cuentaBancos,
          nombreCuentaContable: statement.nombreCuentaContable,
          tipoCuentaBancos: statement.tipoCuentaBancos,
          desc039: statement.desc039,
          desc036: statement.desc036,
          movimientos: [],
        };
        merged.set(key, acc);
        seenMovements.set(key, new Set());
        firstDate.set(key, statement.fechaEstadoCuenta);
        lastDate.set(key, statement.fechaEstadoCuenta);
      }

      if (statement.fechaEstadoCuenta < (firstDate.get(key) ?? statement.fechaEstadoCuenta)) {
        firstDate.set(key, statement.fechaEstadoCuenta);
        if (statement.saldoInicial !== undefined) acc.saldoInicial = statement.saldoInicial;
      }
      if (statement.fechaEstadoCuenta >= (lastDate.get(key) ?? statement.fechaEstadoCuenta)) {
        lastDate.set(key, statement.fechaEstadoCuenta);
        acc.fechaEstadoCuenta = statement.fechaEstadoCuenta;
        if (statement.saldoFinal !== undefined) acc.saldoFinal = statement.saldoFinal;
        if (statement.nombreBanco) acc.nombreBanco = statement.nombreBanco;
        if (statement.banco) acc.banco = statement.banco;
        if (statement.cuentaContable) acc.cuentaContable = statement.cuentaContable;
        if (statement.cuentaBancos) acc.cuentaBancos = statement.cuentaBancos;
        if (statement.nombreCuentaContable) acc.nombreCuentaContable = statement.nombreCuentaContable;
        if (statement.tipoCuentaBancos) acc.tipoCuentaBancos = statement.tipoCuentaBancos;
        if (statement.desc039) acc.desc039 = statement.desc039;
        if (statement.desc036) acc.desc036 = statement.desc036;
      }

      const seen = seenMovements.get(key)!;
      for (const movement of statement.movimientos) {
        const mk = movementKey(movement);
        if (seen.has(mk)) continue;
        seen.add(mk);
        acc.movimientos.push(movement);
      }
    }
  }

  const result = Array.from(merged.values());
  for (const statement of result) {
    statement.movimientos.sort((a, b) => movementSortKey(a).localeCompare(movementSortKey(b)));
  }

  return result;
}

export function attachImportedStatementsToKnownCompanies(
  imported: BankAccountStatement[],
  existing: BankAccountStatement[],
): BankAccountStatement[] {
  const byAccount = new Map<string, string | null>();
  for (const statement of existing) {
    if (!statement.cia) continue;
    const current = byAccount.get(statement.cuenta);
    if (current === undefined) byAccount.set(statement.cuenta, statement.cia);
    else if (current !== statement.cia) byAccount.set(statement.cuenta, null);
  }

  return imported.map((statement) => {
    if (statement.cia) return statement;
    const inferredCia = byAccount.get(statement.cuenta);
    if (!inferredCia) return statement;
    return {
      ...statement,
      cia: inferredCia,
      movimientos: statement.movimientos.map((movement) => ({
        ...movement,
        cia: inferredCia,
      })),
    };
  });
}
