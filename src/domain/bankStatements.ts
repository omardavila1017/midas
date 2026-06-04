import type { BankAccountStatement, BankStatementFormat, BankStatementLine } from '../services/jdeTypes';

export interface BankQueryState {
  fechaEstadoCuenta: string;
  formatoElectronico: BankStatementFormat;
  hasUploadedSantander?: boolean;
}

/**
 * BAJIO se muestra en la pestaña Bancos pero NO se contabiliza ni se proyecta.
 * El excedente cae siempre en Banamex, así que incluir BAJIO duplica flujo.
 */
export function isBajioStatement(stmt: Pick<BankAccountStatement, 'banco' | 'nombreBanco'>): boolean {
  const name = (stmt.nombreBanco ?? '').toUpperCase();
  const code = (stmt.banco ?? '').toUpperCase();
  return name.includes('BAJIO') || name.includes('BAJÍO') || code.includes('BAJIO');
}

export function excludeBajio<T extends Pick<BankAccountStatement, 'banco' | 'nombreBanco'>>(stmts: readonly T[]): T[] {
  return stmts.filter(s => !isBajioStatement(s));
}

/**
 * Fideicomiso Dina: CORNING deposita en la cuenta BanBajío de la operadora.
 * Detecta el ABONO de Corning en una línea de estado de cuenta. Vive aquí
 * (dominio) para que la UI (FideicomisoDashboard) y el motor de proyección
 * (fideicomisoMovements) compartan exactamente la misma regla.
 */
export const CORNING_PATTERN = /CORNING/i;

export function corningMovementHaystack(m: Pick<BankStatementLine, 'concepto' | 'referencia' | 'infAdi1' | 'infAdi2' | 'infAdi3'>): string {
  return [m.concepto, m.referencia, m.infAdi1, m.infAdi2, m.infAdi3]
    .filter(Boolean).join(' ');
}

export function isCorningAbono(m: Pick<BankStatementLine, 'tipoMovimiento' | 'concepto' | 'referencia' | 'infAdi1' | 'infAdi2' | 'infAdi3'>): boolean {
  return m.tipoMovimiento === 'ABONO' && CORNING_PATTERN.test(corningMovementHaystack(m));
}

/**
 * Canoniza el identificador de cuenta a dígitos. El API de /bancos entrega la
 * cuenta etiquetada ("BANAMEX - 7014 4758151", a veces sólo en
 * Nombre_cuenta_Contable) → dígitos "70144758151". Quita el nombre del banco
 * inicial, texto entre paréntesis y separadores. Sin padding (la longitud
 * natural del API es la verdad). Si no quedan dígitos regresa el texto
 * recortado (preserva centinelas como "BANBAJIO" y "SIN CUENTA").
 *
 * Defensivo: se aplica tanto al mapear (jde.ts) como al consumir (Bancos.tsx)
 * para que los statements legados ya persistidos en IDB también se corrijan
 * sin re-fetch.
 */
export function canonicalBankAccountNumber(raw: string | null | undefined): string {
  const s = (raw ?? '').trim();
  if (!s) return '';
  let work = s;
  const m = work.match(/^([A-Za-zÁÉÍÓÚáéíóúÑñ]+(?:\s+[A-Za-zÁÉÍÓÚáéíóúÑñ]+)*)/);
  const bank = m ? m[1].trim() : '';
  if (bank && bank.length < work.length) work = work.slice(bank.length);
  work = work.replace(/\([^)]*\)?/g, ' ');
  const digits = work.replace(/\D+/g, '');
  return digits || s;
}

/**
 * Algunos estados de cuenta etiquetan la misma institución con un sufijo
 * regional (p.ej. "BANORTE TAMPS" = sucursal Tamaulipas de Banorte). Para la
 * agrupación por banco en la UI son la MISMA institución, así que colapsamos
 * el alias a su nombre canónico. La llave se compara en mayúsculas y con
 * espacios normalizados.
 *
 * Defensivo: igual que `canonicalBankAccountNumber`, se aplica tanto al mapear
 * (jde.ts) como al consumir (Bancos.tsx) para que los statements ya
 * persistidos en IDB/uploads se reagrupen sin necesidad de re-fetch.
 */
const BANK_NAME_ALIASES: Record<string, string> = {
  'BANORTE TAMPS': 'BANORTE',
};

export function canonicalBankName(raw: string | null | undefined): string {
  const s = (raw ?? '').trim();
  if (!s) return s;
  const key = s.toUpperCase().replace(/\s+/g, ' ');
  return BANK_NAME_ALIASES[key] ?? s;
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

/**
 * Balance "más confiable" para una cuenta:
 *
 *   1. `saldoFinal` cuando viene definido y NO es 0. Es el valor autoritativo
 *      de JDE/Santander para el cierre del último día del rango.
 *   2. Si `saldoFinal` falta o es 0 (sentinela frecuente cuando el API responde
 *      Saldo_Final null o el centinela Bajío suma sub-cuentas que se cancelan),
 *      derivamos: `saldoInicial + Σ(abonos) - Σ(cargos)` sobre el rango cargado.
 *      Esto es matemáticamente equivalente a saldoFinal cuando ambos vienen
 *      bien — y recupera el valor cuando saldoFinal está bugged.
 *   3. Fallback final: `saldoInicial` o 0.
 *
 * Cuentas afectadas observadas en producción: BANBAJIO (centinela) y SANTANDER
 * (Saldo_Final null) mostraban $0.00 en la pestaña Bancos pese a tener
 * saldoInicial real y movimientos del periodo.
 */
export function bankStatementBalance(
  statement: Pick<BankAccountStatement, 'saldoFinal' | 'saldoInicial' | 'movimientos'>,
): number {
  if (statement.saldoFinal !== undefined && statement.saldoFinal !== 0) {
    return statement.saldoFinal;
  }
  const movs = statement.movimientos ?? [];
  if (statement.saldoInicial !== undefined && movs.length > 0) {
    let net = 0;
    for (const m of movs) {
      if (m.tipoMovimiento === 'ABONO') net += m.importe;
      else if (m.tipoMovimiento === 'CARGO') net -= m.importe;
    }
    return statement.saldoInicial + net;
  }
  return statement.saldoFinal ?? statement.saldoInicial ?? 0;
}

export function sumBankStatementBalances(
  statements: readonly Pick<BankAccountStatement, 'saldoFinal' | 'saldoInicial' | 'movimientos'>[],
): number {
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
