// ─────────────────────────────────────────────────────────────────────────
// budget — modelo + parser + serializador del presupuesto anual.
//
// El usuario sube un CSV con el formato "Presupuesto <año> — Resumen
// Mensual" que tiene conceptos por fila y meses por columna. Aquí lo
// parseamos a un `Budget` tipado y en pesos (normalizado por escala).
//
// Escalas soportadas:
//   - 'pesos'    → sin factor
//   - 'miles'    → × 1_000
//   - 'millones' → × 1_000_000
//
// La escala se intenta detectar del header del CSV ("Cifras en millones
// de pesos"). Si no se puede detectar, la UI pregunta al usuario.
// ─────────────────────────────────────────────────────────────────────────

export type BudgetScale = 'pesos' | 'miles' | 'millones';

export interface BudgetConceptRow {
  concept: string;
  /** 12 montos mensuales (Ene..Dic) en pesos ya normalizados. */
  monthly: number[];
}

export interface Budget {
  /** Año al que aplica el presupuesto. */
  year: number;
  /** Escala original del archivo — sólo informativa; monthly ya está en pesos. */
  scale: BudgetScale;
  /** Opcional: caja inicial por mes declarada en el CSV. */
  openingCash?: number[];
  /** Total de ingresos por mes (Ingresos Totales). */
  incomeTotal: number[];
  /** Desglose de ingresos por concepto — puede estar vacío si sólo hay una fila. */
  incomeByConcept: BudgetConceptRow[];
  /** Total de egresos por mes (Total Egresos). Si el CSV no lo trae, se suma. */
  expenseTotal: number[];
  /** Desglose de egresos por concepto. */
  expenseByConcept: BudgetConceptRow[];
  /** Metadata para mostrar al usuario. */
  uploadedAt: string;
  fileName?: string;
}

export const MONTH_HEADERS = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

// ── Utilidades ───────────────────────────────────────────────────────────

export function scaleFactor(scale: BudgetScale): number {
  switch (scale) {
    case 'millones': return 1_000_000;
    case 'miles':    return 1_000;
    default:         return 1;
  }
}

export function scaleLabel(scale: BudgetScale): string {
  switch (scale) {
    case 'millones': return 'millones de pesos';
    case 'miles':    return 'miles de pesos';
    default:         return 'pesos';
  }
}

/**
 * Parse numérico tolerante al formato del CSV de presupuesto:
 *   - "-" → 0
 *   - "1,038.7" → 1038.7 (coma como miles)
 *   - "(6.6)" → -6.6 (paréntesis = negativo)
 *   - " "     → 0
 */
export function parseBudgetNumber(raw: string): number {
  const s = (raw ?? '').trim();
  if (!s || s === '-' || s === '—') return 0;
  let negative = false;
  let t = s;
  if (t.startsWith('(') && t.endsWith(')')) {
    negative = true;
    t = t.slice(1, -1);
  }
  // Quitamos separadores de miles (coma), espacios, $
  t = t.replace(/[$\s,]/g, '');
  const n = Number(t);
  if (!Number.isFinite(n)) return 0;
  return negative ? -n : n;
}

/**
 * Parser CSV simple con soporte de comillas dobles y campos escapados.
 * No soporta multiline quoted (los archivos de presupuesto no los tienen).
 */
export function parseCsvRow(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

// ── Detección de escala desde el header ──────────────────────────────────

export function detectScaleFromText(text: string): BudgetScale | null {
  const t = text.toLowerCase();
  if (t.includes('millones')) return 'millones';
  if (t.includes('miles'))    return 'miles';
  if (t.includes('pesos'))    return 'pesos';
  return null;
}

// ── Parser del CSV de presupuesto ────────────────────────────────────────

export interface ParseBudgetOptions {
  /** Escala explícita del usuario. Si no se pasa, se intenta detectar del header. */
  scale?: BudgetScale;
  /** Nombre de archivo para metadata. */
  fileName?: string;
}

export interface ParseBudgetResult {
  budget: Budget | null;
  detectedScale: BudgetScale | null;
  warnings: string[];
  error?: string;
}

/**
 * Parser principal. Toma el contenido raw del CSV y devuelve un Budget
 * normalizado en pesos. Si no se especifica `opts.scale`, intenta detectarla
 * del primer header ("Cifras en millones de pesos").
 *
 * Estructura esperada:
 *   Row 0..2: headers libres (título, escala, alcance)
 *   Row ?:    línea Concepto,Ene,Feb,...,Dic[,Total Año]
 *   Después, filas con concepto en col 0 y 12 valores mensuales.
 *
 * Filas con primera columna vacía o en mayúsculas (INGRESOS, EGRESOS,
 * TOTALES) son separadores de sección. Usamos esos separadores para
 * distinguir conceptos de ingreso vs egreso.
 *
 * Filas reconocidas especial:
 *   - "Caja Inicial"          → openingCash
 *   - "Ingresos Totales"      → incomeTotal
 *   - "Total Egresos"         → expenseTotal
 *   - "Flujo Neto del Mes"    → se ignora (derivado)
 *   - "Caja Final"            → se ignora (derivado)
 */
export function parseBudgetCsv(
  raw: string,
  opts: ParseBudgetOptions = {},
): ParseBudgetResult {
  const warnings: string[] = [];
  const lines = raw
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l)
    .filter((l) => l.length > 0 || true); // conservamos líneas vacías de momento
  if (lines.length === 0) {
    return { budget: null, detectedScale: null, warnings, error: 'CSV vacío.' };
  }

  // Detectar escala del header (primeras 5 filas suelen ser libre-texto).
  const headerText = lines.slice(0, 5).join(' ');
  const detectedScale = detectScaleFromText(headerText);
  const scale: BudgetScale = opts.scale ?? detectedScale ?? 'pesos';
  const factor = scaleFactor(scale);
  if (!opts.scale && !detectedScale) {
    warnings.push('No se detectó la escala en el encabezado; asumiendo pesos.');
  }

  // Detectar año del primer header (busca 4 dígitos).
  let year = new Date().getFullYear();
  const yearMatch = /\b(20\d{2})\b/.exec(headerText);
  if (yearMatch) year = Number(yearMatch[1]);

  // Encontrar fila de columnas: empieza con "Concepto" y tiene 12 meses.
  let headerIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const cells = parseCsvRow(lines[i]).map((c) => c.trim().toLowerCase());
    if (cells[0] === 'concepto' && cells.length >= 13) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) {
    return {
      budget: null,
      detectedScale,
      warnings,
      error: 'No se encontró la fila de encabezado "Concepto,Ene,Feb,…,Dic".',
    };
  }

  // Leer filas de conceptos.
  let section: 'none' | 'income' | 'expense' = 'none';
  const incomeByConcept: BudgetConceptRow[] = [];
  const expenseByConcept: BudgetConceptRow[] = [];
  let openingCash: number[] | undefined;
  let incomeTotal: number[] | null = null;
  let expenseTotal: number[] | null = null;

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cells = parseCsvRow(lines[i]);
    const first = (cells[0] ?? '').trim();
    if (!first) continue;
    const firstLower = first.toLowerCase();

    // Detectar separadores de sección. Un separador es una fila donde
    // (a) la primera celda es un título conocido, y
    // (b) las celdas de mes están vacías.
    const monthCells = cells.slice(1, 13);
    const hasNumbers = monthCells.some((c) => c.trim() !== '');
    if (!hasNumbers) {
      if (firstLower.includes('ingreso')) section = 'income';
      else if (firstLower.includes('egreso') || firstLower.includes('gasto')) section = 'expense';
      else if (firstLower.includes('total')) section = 'none';
      continue;
    }

    const monthly = monthCells.map((c) => parseBudgetNumber(c) * factor);

    // Filas especiales por nombre.
    if (firstLower === 'caja inicial') { openingCash = monthly; continue; }
    if (firstLower === 'ingresos totales' || firstLower === 'ingreso total') { incomeTotal = monthly; continue; }
    if (firstLower === 'total egresos' || firstLower === 'egreso total' || firstLower === 'total egreso') {
      expenseTotal = monthly; continue;
    }
    if (firstLower.includes('flujo neto') || firstLower.includes('caja final')) continue;

    const row: BudgetConceptRow = { concept: first, monthly };
    if (section === 'income') incomeByConcept.push(row);
    else if (section === 'expense') expenseByConcept.push(row);
    else {
      // Sin sección previa: si es una fila con "ingreso" en el nombre → ingresos;
      // si no, egresos. El CSV del usuario siempre tiene INGRESOS/EGRESOS pero
      // somos defensivos.
      if (firstLower.includes('ingreso') || firstLower.includes('venta')) incomeByConcept.push(row);
      else expenseByConcept.push(row);
    }
  }

  // Si no encontramos "Ingresos Totales", sumamos los conceptos.
  if (!incomeTotal) {
    incomeTotal = sumRows(incomeByConcept);
    if (incomeByConcept.length === 0) {
      warnings.push('No se detectaron filas de ingresos.');
    }
  }
  if (!expenseTotal) {
    expenseTotal = sumRows(expenseByConcept);
    if (expenseByConcept.length === 0) {
      warnings.push('No se detectaron filas de egresos.');
    }
  }

  const budget: Budget = {
    year,
    scale,
    openingCash,
    incomeTotal,
    incomeByConcept,
    expenseTotal,
    expenseByConcept,
    uploadedAt: new Date().toISOString(),
    fileName: opts.fileName,
  };

  return { budget, detectedScale, warnings };
}

function sumRows(rows: BudgetConceptRow[]): number[] {
  const total = new Array(12).fill(0);
  for (const r of rows) {
    for (let m = 0; m < 12; m++) total[m] += r.monthly[m] ?? 0;
  }
  return total;
}

// ── Serializador: plantilla CSV ──────────────────────────────────────────

function fmtValueForCsv(pesos: number, factor: number): string {
  if (pesos === 0) return '-';
  const scaled = pesos / factor;
  const negative = scaled < 0;
  const abs = Math.abs(scaled);
  // 1 decimal cuando |v| < 10, 0 si es grande, y coma como miles
  const digits = abs >= 1000 ? 0 : 1;
  const s = abs.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  // Si tiene coma, cotizamos
  const needsQuote = s.includes(',');
  const core = needsQuote ? `"${s}"` : s;
  return negative ? `(${core})` : core;
}

function row(label: string, values: (number | null)[], factor: number): string {
  const cells = values.map((v) => v === null ? '' : fmtValueForCsv(v, factor));
  return [label, ...cells].join(',');
}

/**
 * Genera un CSV de plantilla con el mismo formato que el usuario sube.
 * `exampleScale` define en qué unidades se emite (p.ej. 'millones').
 *
 * Los valores son ilustrativos y derivados del presupuesto 2026 real
 * que el usuario compartió. Todas las cifras internas van en pesos y
 * se dividen por `scaleFactor(exampleScale)` al escribir.
 */
export function buildBudgetTemplateCsv(exampleScale: BudgetScale, year = new Date().getFullYear()): string {
  const factor = scaleFactor(exampleScale);
  const title = `Presupuesto ${year} — Resumen Mensual`;
  const scaleLine = `Cifras en ${scaleLabel(exampleScale)} (MXN)`;
  const scopeLine = `Todas las compañías`;
  const monthsHeader = ['Concepto', ...MONTH_HEADERS, 'Total Año'].join(',');

  // Datos de ejemplo en pesos (tomados del presupuesto 2026 en millones).
  const MM = 1_000_000;
  const cajaInicial = [376.4, 210.9, 164.8, 164.0, 36.0, 173.2, 274.0, 342.8, 525.1, 772.8, 990.6, 846.3].map((v) => v * MM);
  const ingresosTotales = [290.7, 253.5, 343.3, 288.5, 325.4, 380.8, 324.6, 415.1, 344.4, 329.9, 420.5, 365.4].map((v) => v * MM);
  const nomina = [82.3, 80.1, 94.4, 77.0, 86.0, 89.5, 77.2, 95.9, 72.1, 77.2, 95.9, 111.2].map((v) => v * MM);
  const finiquitos = [6.7, 5.5, 7.2, 4.6, 3.7, 3.7, 3.0, 3.5, 2.8, 2.8, 3.5, 2.8].map((v) => v * MM);
  const diesel = [59.9, 49.4, 66.8, 58.3, 64.7, 80.9, 64.7, 80.9, 64.7, 64.7, 80.9, 64.7].map((v) => v * MM);
  const gas = [3.4, 6.4, 5.9, 5.8, 5.2, 6.5, 5.2, 6.5, 5.2, 5.2, 6.5, 5.2].map((v) => v * MM);
  const lubri = [5.4, 2.1, 1.8, 3.8, 5.1, 6.4, 5.1, 6.4, 5.1, 5.1, 6.4, 5.1].map((v) => v * MM);
  const impuestos = [50.7, 14.8, 25.3, 27.3, 62.5, 27.5, 51.5, 14.5, 51.5, 14.5, 51.5, 154.5].map((v) => v * MM);
  const gastosOp = [47.2, 57.8, 78.1, 43.5, 61.4, 67.5, 60.9, 92.0, 59.4, 59.9, 91.5, 59.9].map((v) => v * MM);
  const capex = [0, 0, 0, 0, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2].map((v) => v * MM);
  const pasivosFin = [41.5, 98.5, 51.9, 98.2, 45.6, 51.7, 93.3, 58.6, 28.8, 92.4, 62.3, 26.0].map((v) => v * MM);

  const expenseRows = [
    { label: 'Nómina', values: nomina },
    { label: 'Finiquitos', values: finiquitos },
    { label: 'Diésel', values: diesel },
    { label: 'Gas', values: gas },
    { label: 'Lubricantes y Otros', values: lubri },
    { label: 'Impuestos', values: impuestos },
    { label: 'Gastos de Operación', values: gastosOp },
    { label: 'CAPEX', values: capex },
    { label: 'Pasivos Financieros', values: pasivosFin },
  ];

  const totalEgresos = new Array(12).fill(0).map((_, i) =>
    expenseRows.reduce((s, r) => s + r.values[i], 0),
  );
  const flujoNeto = ingresosTotales.map((v, i) => v - totalEgresos[i]);
  // Caja final encadenada — el primer mes sale del cajaInicial[0] + flujoNeto[0]
  const cajaFinal: number[] = [];
  let running = cajaInicial[0];
  for (let i = 0; i < 12; i++) {
    running = (i === 0 ? cajaInicial[0] : cajaFinal[i - 1]) + flujoNeto[i];
    cajaFinal.push(running);
  }

  const padded: string[] = [];
  const commasForEmpty = ','.repeat(MONTH_HEADERS.length + 1);
  padded.push(`${title},${commasForEmpty}`);
  padded.push(`${scaleLine},${commasForEmpty}`);
  padded.push(`${scopeLine},${commasForEmpty}`);
  padded.push(`,${commasForEmpty}`);
  padded.push(monthsHeader);

  const yearTotal = (arr: number[]) => arr.reduce((s, v) => s + v, 0);

  padded.push(row('Caja Inicial', [...cajaInicial, cajaInicial[0]], factor));
  padded.push(`INGRESOS,${commasForEmpty}`);
  padded.push(row('Ingresos Totales', [...ingresosTotales, yearTotal(ingresosTotales)], factor));
  padded.push(`EGRESOS,${commasForEmpty}`);
  for (const r of expenseRows) {
    padded.push(row(r.label, [...r.values, yearTotal(r.values)], factor));
  }
  padded.push(`TOTALES,${commasForEmpty}`);
  padded.push(row('Total Egresos', [...totalEgresos, yearTotal(totalEgresos)], factor));
  padded.push(row('Flujo Neto del Mes', [...flujoNeto, yearTotal(flujoNeto)], factor));
  padded.push(row('Caja Final', [...cajaFinal, cajaFinal[cajaFinal.length - 1]], factor));

  return padded.join('\n') + '\n';
}
