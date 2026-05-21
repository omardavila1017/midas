// Genera public/presupuesto.csv con el flujo de mayo 2026 para que el
// dashboard lo cargue automáticamente sin pasar por el uploader.
//
// Este script corre en Node puro (sin TS), se invoca con `node scripts/generate-budget-csv.mjs`.
//
// Fuente: /Users/paolo/Desktop/necesidad de flujo Mayo 2026 04.05.26.xlsx
// Hoja base: "Plan de Flujo Ajustado"; cierre mensual: fila "Caja Final Mxn".

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
  const s = abs.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 3 });
  const needsQuote = s.includes(',');
  const core = needsQuote ? `"${s}"` : s;
  return negative ? `(${core})` : core;
}

function row(label, values, factor) {
  const cells = values.map((v) => v === null ? '' : fmtValueForCsv(v, factor));
  return [label, ...cells].join(',');
}

const factor = scaleFactor(SCALE);

const cajaInicial   = [76.31531, 84.355879, 36.978986, 53.151053, 41.00915, 18.450778, 73.357256, 4.94028, 16.237168, 64.17287, 12.712694, 14.463955].map((v) => v * MM);
const cajaFinalPlan = [84.355879, 36.978986, 53.151053, 41.00915, 18.450778, 73.357256, 4.94028, 16.237168, 64.17287, 12.712694, 14.463955, 67.212907].map((v) => v * MM);
const ingresosTotal = [290.659137, 253.480686, 343.300154, 282.151754, 349.54324, 380.804902, 324.595028, 329.042434, 430.380668, 329.923957, 329.247512, 456.616817].map((v) => v * MM);
const nomina        = [82.338284, 80.089234, 94.351781, 78.144421, 85.993874, 89.473874, 77.201874, 77.201874, 90.776049, 77.201874, 77.321874, 139.744577].map((v) => v * MM);
const finiquitos    = [6.725399, 5.53828, 7.239512, 5.125377, 4.256212, 4.686109, 3.895906, 3.49229, 4.051014, 3.49229, 3.351014, 4.077777].map((v) => v * MM);
const diesel        = [51.048235, 40.936897, 59.150619, 52.11396, 60.4, 68, 54.4, 54.4, 68, 54.4, 54.4, 68].map((v) => v * MM);
const gas           = [3.439098, 6.374311, 5.87172, 4.268475, 5.188, 6.485, 5.188, 5.188, 6.485, 5.188, 5.188, 6.485].map((v) => v * MM);
const lubri         = [5.441633, 2.054016, 1.811769, 1.450369, 5.12, 6.4, 5.12, 5.12, 6.4, 5.12, 5.12, 6.4].map((v) => v * MM);
const impuestos     = [50.690934, 14.822174, 25.321892, 27.361047, 62.5, 27.5, 81.5, 54.5, 81.5, 74.5, 61.5, 54.5].map((v) => v * MM);
const gastosOp      = [47.16007, 57.838345, 78.102966, 27.573743, 88.763189, 67.830323, 64.851993, 73.843993, 74.47014, 61.699991, 73.177991, 76.50314].map((v) => v * MM);
const capex         = [0, 0, 0, 0, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2, 0.2].map((v) => v * MM);
const gastosAsesores = [2.925967, 3.125487, 2.963132, 0.0406, 9.079967, 1.16, 1.1, 1.1, 1.1, 1.1, 1.1, 1.1].map((v) => v * MM);
const proyectos     = [0.523912, 0.521137, 0.687332, 0.128136, 0.124, 0.124, 0.124, 0.124, 0.124, 0.124, 0.124, 0.124].map((v) => v * MM);
const planPago      = [1.332413, 1.076603, 1.599284, 0.041988, 2.103, 2.356, 2.122, 2.14, 2.41, 1.94, 1.84, 2.56].map((v) => v * MM);
const pasivosFin    = [41.532624, 98.458229, 51.928081, 98.045542, 48.373371, 51.683118, 97.308231, 40.43539, 46.928762, 96.417979, 44.173371, 44.173371].map((v) => v * MM);
// Ajusta enero-marzo para que el encadenado coincida con "Caja Final Mxn".
const ajusteReservas = [-10.54, -9.977135, -1.9, 0, 0, 0, 0, 0, 0, 0, 0, 0].map((v) => v * MM);

const expenseRows = [
  { label: 'Nómina', values: nomina },
  { label: 'Finiquitos', values: finiquitos },
  { label: 'Diésel', values: diesel },
  { label: 'Gas', values: gas },
  { label: 'Lubricantes y Otros', values: lubri },
  { label: 'Impuestos', values: impuestos },
  { label: 'Gastos de Operación', values: gastosOp },
  { label: 'CAPEX', values: capex },
  { label: 'Gastos Asesores: CM y fiscal', values: gastosAsesores },
  { label: 'Proyectos', values: proyectos },
  { label: 'Plan de Pago', values: planPago },
  { label: 'Pasivos Financieros', values: pasivosFin },
  { label: 'Ajuste reservas y financiamiento', values: ajusteReservas },
];

const totalEgresos = new Array(12).fill(0).map((_, i) =>
  expenseRows.reduce((s, r) => s + r.values[i], 0),
);
const flujoNeto = ingresosTotal.map((v, i) => v - totalEgresos[i]);
const cajaFinal = cajaFinalPlan;

const title = `Presupuesto ${YEAR} — Resumen Mensual`;
const scaleLine = `Cifras en ${scaleLabel(SCALE)} (MXN)`;
const scopeLine = `Todas las compañías — necesidad de flujo Mayo 2026 04.05.26`;
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
