// Genera public/presupuesto.csv con los mismos valores que emite
// buildBudgetTemplateCsv() del dominio, para que el dashboard lo pueda
// cargar automáticamente sin pasar por el uploader.
//
// Este script corre en Node puro (sin TS), se invoca con `node scripts/generate-budget-csv.mjs`.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const YEAR = 2026;
const SCALE = 'millones';
const MM = 1_000_000;

const MONTH_HEADERS = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

function scaleFactor(s) {
  if (s === 'millones') return 1_000_000;
  if (s === 'miles') return 1_000;
  return 1;
}

function scaleLabel(s) {
  if (s === 'millones') return 'millones de pesos';
  if (s === 'miles') return 'miles de pesos';
  return 'pesos';
}

function fmtValueForCsv(pesos, factor) {
  if (pesos === 0) return '-';
  const scaled = pesos / factor;
  const negative = scaled < 0;
  const abs = Math.abs(scaled);
  const digits = abs >= 1000 ? 0 : 1;
  const s = abs.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const needsQuote = s.includes(',');
  const core = needsQuote ? `"${s}"` : s;
  return negative ? `(${core})` : core;
}

function row(label, values, factor) {
  const cells = values.map((v) => v === null ? '' : fmtValueForCsv(v, factor));
  return [label, ...cells].join(',');
}

const factor = scaleFactor(SCALE);

const cajaInicial   = [376.4, 210.9, 164.8, 164.0, 36.0, 173.2, 274.0, 342.8, 525.1, 772.8, 990.6, 846.3].map((v) => v * MM);
const ingresosTotal = [290.7, 253.5, 343.3, 288.5, 325.4, 380.8, 324.6, 415.1, 344.4, 329.9, 420.5, 365.4].map((v) => v * MM);
const nomina        = [82.3, 80.1, 94.4, 77.0, 86.0, 89.5, 77.2, 95.9, 72.1, 77.2, 95.9, 111.2].map((v) => v * MM);
const finiquitos    = [6.7, 5.5, 7.2, 4.6, 3.7, 3.7, 3.0, 3.5, 2.8, 2.8, 3.5, 2.8].map((v) => v * MM);
const diesel        = [59.9, 49.4, 66.8, 58.3, 64.7, 80.9, 64.7, 80.9, 64.7, 64.7, 80.9, 64.7].map((v) => v * MM);
const gas           = [3.4, 6.4, 5.9, 5.8, 5.2, 6.5, 5.2, 6.5, 5.2, 5.2, 6.5, 5.2].map((v) => v * MM);
const lubri         = [5.4, 2.1, 1.8, 3.8, 5.1, 6.4, 5.1, 6.4, 5.1, 5.1, 6.4, 5.1].map((v) => v * MM);
const impuestos     = [50.7, 14.8, 25.3, 27.3, 62.5, 27.5, 51.5, 14.5, 51.5, 14.5, 51.5, 154.5].map((v) => v * MM);
const gastosOp      = [47.2, 57.8, 78.1, 43.5, 61.4, 67.5, 60.9, 92.0, 59.4, 59.9, 91.5, 59.9].map((v) => v * MM);
const capex         = [0, 0, 0, 0, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2].map((v) => v * MM);
const pasivosFin    = [41.5, 98.5, 51.9, 98.2, 45.6, 51.7, 93.3, 58.6, 28.8, 92.4, 62.3, 26.0].map((v) => v * MM);

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
const flujoNeto = ingresosTotal.map((v, i) => v - totalEgresos[i]);
const cajaFinal = [];
for (let i = 0; i < 12; i++) {
  const prev = i === 0 ? cajaInicial[0] : cajaFinal[i - 1];
  cajaFinal.push(prev + flujoNeto[i]);
}

const title = `Presupuesto ${YEAR} — Resumen Mensual`;
const scaleLine = `Cifras en ${scaleLabel(SCALE)} (MXN)`;
const scopeLine = `Todas las compañías`;
const monthsHeader = ['Concepto', ...MONTH_HEADERS, 'Total Año'].join(',');
const commasForEmpty = ','.repeat(MONTH_HEADERS.length + 1);

const yearTotal = (arr) => arr.reduce((s, v) => s + v, 0);

const padded = [];
padded.push(`${title},${commasForEmpty}`);
padded.push(`${scaleLine},${commasForEmpty}`);
padded.push(`${scopeLine},${commasForEmpty}`);
padded.push(`,${commasForEmpty}`);
padded.push(monthsHeader);
padded.push(row('Caja Inicial', [...cajaInicial, cajaInicial[0]], factor));
padded.push(`INGRESOS,${commasForEmpty}`);
padded.push(row('Ingresos Totales', [...ingresosTotal, yearTotal(ingresosTotal)], factor));
padded.push(`EGRESOS,${commasForEmpty}`);
for (const r of expenseRows) {
  padded.push(row(r.label, [...r.values, yearTotal(r.values)], factor));
}
padded.push(`TOTALES,${commasForEmpty}`);
padded.push(row('Total Egresos', [...totalEgresos, yearTotal(totalEgresos)], factor));
padded.push(row('Flujo Neto del Mes', [...flujoNeto, yearTotal(flujoNeto)], factor));
padded.push(row('Caja Final', [...cajaFinal, cajaFinal[cajaFinal.length - 1]], factor));

const out = padded.join('\n') + '\n';

const outPath = resolve(__dirname, '..', 'public', 'presupuesto.csv');
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, out, 'utf-8');
console.log(`Escrito ${outPath} (${out.length} bytes)`);
