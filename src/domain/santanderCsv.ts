import type { BankAccountStatement, BankStatementLine } from '../services/jdeTypes';

export const SANTANDER_FILE_FORMAT = 'SANTANDER ARCHIVO';
const SANTANDER_BANK_NAME = 'SANTANDER';
const TXT_LINE_LENGTH = 581;

const TXT_SLICE = {
  cuenta: [0, 11],
  fecha: [16, 24],
  hora: [24, 28],
  descripcion: [32, 72],
  signedImporte: [72, 87],
  saldo: [87, 101],
  referencia: [101, 109],
  detalle: [109, 581],
} as const;

interface SantanderMovementRow {
  cuenta: string;
  fechaOperacion: string;
  hora: string;
  referencia: string;
  concepto: string;
  tipoMovimiento: 'CARGO' | 'ABONO';
  importe: number;
  saldo: number;
}

function cleanCell(value: string | undefined): string {
  if (!value) return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  const noLeadingQuote = trimmed.startsWith("'") ? trimmed.slice(1) : trimmed;
  return noLeadingQuote.trim();
}

function digitsOnly(value: string): string {
  return value.replace(/\D+/g, '');
}

function parseDdMmYyyy(raw: string): string {
  const digits = digitsOnly(raw);
  if (digits.length !== 8) throw new Error(`Fecha Santander inválida: ${raw || 'vacía'}`);
  const dd = digits.slice(0, 2);
  const mm = digits.slice(2, 4);
  const yyyy = digits.slice(4, 8);
  return `${yyyy}-${mm}-${dd}`;
}

function parseHour(raw: string): string {
  const digits = digitsOnly(raw);
  if (digits.length !== 4) return cleanCell(raw);
  return `${digits.slice(0, 2)}:${digits.slice(2, 4)}`;
}

function parseAmount(raw: string, field: string): number {
  const cleaned = cleanCell(raw).replace(/,/g, '');
  const value = Number(cleaned);
  if (!Number.isFinite(value)) throw new Error(`Monto Santander inválido en ${field}: ${raw || 'vacío'}`);
  return value;
}

function parseFixedAmount(raw: string, field: string): number {
  const sign = raw.includes('-') ? -1 : 1;
  const digits = digitsOnly(raw);
  if (!digits) throw new Error(`Monto Santander inválido en ${field}: ${raw || 'vacío'}`);
  const value = Number(digits) / 100;
  if (!Number.isFinite(value)) throw new Error(`Monto Santander inválido en ${field}: ${raw || 'vacío'}`);
  return sign * value;
}

function normalizeText(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim();
}

function uniqueJoin(parts: Array<string | undefined>): string {
  return Array.from(new Set(parts.map(part => normalizeText(part ?? '')).filter(Boolean))).join(' · ');
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        cell += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      row.push(cell);
      cell = '';
      continue;
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') i += 1;
      row.push(cell);
      if (row.some(part => part.trim() !== '')) rows.push(row);
      row = [];
      cell = '';
      continue;
    }

    cell += char;
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    if (row.some(part => part.trim() !== '')) rows.push(row);
  }

  return rows;
}

function buildHeaderMap(header: string[]): Map<string, number> {
  return new Map(header.map((value, index) => [cleanCell(value).toLowerCase(), index]));
}

function getField(row: string[], header: Map<string, number>, name: string): string {
  const idx = header.get(name.toLowerCase());
  return idx === undefined ? '' : row[idx] ?? '';
}

function buildConcept(row: string[], header: Map<string, number>): string {
  return uniqueJoin([
    getField(row, header, 'Descripcion'),
    getField(row, header, 'Concepto'),
    getField(row, header, 'Nombre Beneficiario'),
    getField(row, header, 'Nombre Ordenante'),
    getField(row, header, 'Clave de Rastreo'),
  ]);
}

function parseCsvMovementRow(row: string[], header: Map<string, number>): SantanderMovementRow {
  const cuenta = digitsOnly(getField(row, header, 'Cuenta'));
  if (!cuenta) throw new Error('El CSV Santander no trae número de cuenta.');

  const fechaOperacion = parseDdMmYyyy(getField(row, header, 'Fecha'));
  const hora = parseHour(getField(row, header, 'Hora'));
  const referencia = cleanCell(getField(row, header, 'Referencia'));
  const rawTipo = cleanCell(getField(row, header, 'Cargo/Abono'));
  if (rawTipo !== '+' && rawTipo !== '-') {
    throw new Error(`Cargo/Abono inválido en CSV Santander: ${rawTipo || 'vacío'}`);
  }
  const tipoMovimiento = rawTipo === '-' ? 'CARGO' : 'ABONO';
  const importe = parseAmount(getField(row, header, 'Importe'), 'Importe');
  const saldo = parseAmount(getField(row, header, 'Saldo'), 'Saldo');
  const concepto = buildConcept(row, header);

  return {
    cuenta,
    fechaOperacion,
    hora,
    referencia,
    concepto,
    tipoMovimiento,
    importe,
    saldo,
  };
}

function parseTxtMovementRow(line: string): SantanderMovementRow {
  if (line.length !== TXT_LINE_LENGTH) {
    throw new Error(`Renglón TXT Santander inválido: se esperaban ${TXT_LINE_LENGTH} caracteres y llegaron ${line.length}.`);
  }

  const cuenta = digitsOnly(line.slice(...TXT_SLICE.cuenta));
  if (!cuenta) throw new Error('El TXT Santander no trae número de cuenta.');

  const importeSigned = parseFixedAmount(line.slice(...TXT_SLICE.signedImporte), 'Importe');
  const tipoMovimiento = importeSigned < 0 ? 'CARGO' : 'ABONO';
  const concepto = uniqueJoin([
    line.slice(...TXT_SLICE.descripcion),
    line.slice(...TXT_SLICE.detalle),
  ]);

  return {
    cuenta,
    fechaOperacion: parseDdMmYyyy(line.slice(...TXT_SLICE.fecha)),
    hora: parseHour(line.slice(...TXT_SLICE.hora)),
    referencia: cleanCell(line.slice(...TXT_SLICE.referencia)),
    concepto,
    tipoMovimiento,
    importe: Math.abs(importeSigned),
    saldo: parseFixedAmount(line.slice(...TXT_SLICE.saldo), 'Saldo'),
  };
}

function computeSaldoInicial(first: SantanderMovementRow): number {
  const signedAmount = first.tipoMovimiento === 'ABONO' ? first.importe : -first.importe;
  return first.saldo - signedAmount;
}

function movementSortKey(mov: SantanderMovementRow): string {
  const time = cleanCell(mov.hora).padStart(5, '0');
  return `${mov.fechaOperacion}T${time}|${mov.referencia}|${mov.importe}`;
}

function buildStatements(
  movimientosByCuenta: Map<string, SantanderMovementRow[]>,
  options?: { defaultCia?: string },
): BankAccountStatement[] {
  const defaultCia = options?.defaultCia?.trim() ?? '';
  const statements: BankAccountStatement[] = [];
  for (const [cuenta, movimientosRaw] of movimientosByCuenta.entries()) {
    movimientosRaw.sort((a, b) => movementSortKey(a).localeCompare(movementSortKey(b)));
    const first = movimientosRaw[0];
    const last = movimientosRaw[movimientosRaw.length - 1];
    const movimientos: BankStatementLine[] = movimientosRaw.map((mov) => ({
      cia: defaultCia,
      banco: SANTANDER_BANK_NAME,
      nombreBanco: SANTANDER_BANK_NAME,
      cuenta,
      moneda: 'MXN',
      fechaOperacion: mov.fechaOperacion,
      referencia: mov.referencia,
      concepto: mov.concepto,
      tipoMovimiento: mov.tipoMovimiento,
      importe: mov.importe,
      saldo: mov.saldo,
    }));

    statements.push({
      cia: defaultCia,
      banco: SANTANDER_BANK_NAME,
      nombreBanco: SANTANDER_BANK_NAME,
      cuenta,
      moneda: 'MXN',
      fechaEstadoCuenta: last.fechaOperacion,
      saldoInicial: computeSaldoInicial(first),
      saldoFinal: last.saldo,
      movimientos,
    });
  }

  return statements;
}

export function parseSantanderCsv(
  text: string,
  options?: { defaultCia?: string },
): BankAccountStatement[] {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error('El archivo Santander viene vacío o sin renglones de movimientos.');

  const header = buildHeaderMap(rows[0]);
  const required = ['Cuenta', 'Fecha', 'Descripcion', 'Cargo/Abono', 'Importe', 'Saldo'];
  const missing = required.filter(name => !header.has(name.toLowerCase()));
  if (missing.length > 0) {
    throw new Error(`Faltan columnas del CSV Santander: ${missing.join(', ')}.`);
  }

  const byAccount = new Map<string, SantanderMovementRow[]>();
  for (const row of rows.slice(1)) {
    if (row.every(part => cleanCell(part) === '')) continue;
    const parsed = parseCsvMovementRow(row, header);
    const bucket = byAccount.get(parsed.cuenta);
    if (bucket) bucket.push(parsed);
    else byAccount.set(parsed.cuenta, [parsed]);
  }

  const statements = buildStatements(byAccount, options);
  if (statements.length === 0) throw new Error('No se encontraron movimientos válidos en el CSV Santander.');
  return statements;
}

export function parseSantanderTxt(
  text: string,
  options?: { defaultCia?: string },
): BankAccountStatement[] {
  const lines = text.split(/\r?\n/).map(line => line.replace(/\r/g, '')).filter(line => line.trim() !== '');
  if (lines.length === 0) throw new Error('El TXT Santander viene vacío o sin renglones de movimientos.');

  const byAccount = new Map<string, SantanderMovementRow[]>();
  for (const line of lines) {
    const parsed = parseTxtMovementRow(line);
    const bucket = byAccount.get(parsed.cuenta);
    if (bucket) bucket.push(parsed);
    else byAccount.set(parsed.cuenta, [parsed]);
  }

  const statements = buildStatements(byAccount, options);
  if (statements.length === 0) throw new Error('No se encontraron movimientos válidos en el TXT Santander.');
  return statements;
}

export function parseSantanderFile(
  text: string,
  options?: { defaultCia?: string },
): BankAccountStatement[] {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  if (firstLine.includes(',')) return parseSantanderCsv(text, options);
  return parseSantanderTxt(text, options);
}
