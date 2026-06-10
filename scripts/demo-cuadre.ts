/* eslint-disable no-console */
// ─────────────────────────────────────────────────────────────────────────
// DEMO ejecutable del cuadre del flujo de efectivo (Escenario Base) —
// corre el pipeline REAL completo sobre un escenario sintético verificable
// a mano:
//
//   estados de cuenta → reconcileAuxiliar (GL×Banco) →
//   adaptAuxiliarForProjection → buildCanonicalProjection →
//   buildScenarioForecastRun (Base) → reconcilePlanningAgainstBank
//
// Imprime: (1) el cruce GL×Banco, (2) los totales reconciliados vs la verdad
// bancaria, (3) el cuadre Planeación↔Banco por mes al peso, y (4) los buckets
// de categorización de ingresos/egresos.
//
// Ejecutar: npx vite-node scripts/demo-cuadre.ts
// ─────────────────────────────────────────────────────────────────────────
import type { CashFlowAssumptions } from '../src/domain/types';
import type {
  AuxiliarContableRecord,
  BankAccountStatement,
  BankStatementLine,
} from '../src/services/jdeTypes';
import { reconcileAuxiliar } from '../src/domain/auxiliarReconciliationEngine';
import { adaptAuxiliarForProjection } from '../src/domain/auxiliarProjectionAdapter';
import { buildHistoricalMonths } from '../src/domain/cashFlowEngine';
import { buildCanonicalProjection } from '../src/modules/shared-finance/calculation-engine/canonicalProjection';
import { calculateInitialCash } from '../src/modules/financial-projection/services/financialProjectionService';
import { defaultTaxStore } from '../src/modules/taxes/services/taxModuleService';
import { buildScenarioForecastRun } from '../src/modules/financial-planning/services/scenarioForecastRun';
import { reconcilePlanningAgainstBank } from '../src/modules/financial-planning/services/cashFlowBankReconciliation';
import { bucketForMovement } from '../src/modules/financial-planning/services/planningRowTaxonomy';
import { setProviderCatalogForCategoryLookup } from '../src/modules/financial-planning/services/providerCategoryGeneralization';
import type { Provider } from '../src/domain/types';

const CIA = '00001';
const TODAY = '2026-03-15';
const CTA_A = '99988877766';
const CTA_B = '11122233344';
/** Cuenta RESERVA real del catálogo (flow=neutro). */
const CTA_NEUTRA = '70144758151';
/** Concentradora MULTICARGA/Sendex real del catálogo (flow=ingreso). */
const CTA_MULTICARGA = '06787361240';

const mxn = (v: number) => v.toLocaleString('es-MX', { style: 'currency', currency: 'MXN' });

function line(patch: Partial<BankStatementLine>): BankStatementLine {
  return {
    cia: CIA,
    banco: 'BANAMEX',
    nombreBanco: 'BANAMEX',
    cuenta: CTA_A,
    moneda: 'MXN',
    fechaOperacion: '2026-01-15',
    referencia: `R-${Math.random().toString(36).slice(2, 8)}`,
    concepto: 'MOVIMIENTO',
    tipoMovimiento: 'ABONO',
    importe: 100,
    ...patch,
  };
}

function statement(cuenta: string, saldoInicial: number, movimientos: BankStatementLine[]): BankAccountStatement {
  return {
    cia: CIA,
    banco: 'BANAMEX',
    nombreBanco: 'BANAMEX',
    cuenta,
    moneda: 'MXN',
    fechaEstadoCuenta: TODAY,
    saldoInicial,
    movimientos: movimientos.map((m) => ({ ...m, cuenta })),
  };
}

function gl(patch: Partial<AuxiliarContableRecord>): AuxiliarContableRecord {
  return {
    cia: CIA,
    cuentaContable: '1.1020.0010409',
    idCuenta: patch.idCuenta ?? '0164',
    cuentaObjeto: '1020',
    nombreCuenta: 'BANAMEX',
    cuentaBanco: CTA_A,
    tipoDocto: 'RI',
    noDocto: Math.floor(Math.random() * 100000),
    noFactura: '',
    noOrdenCompra: '',
    fechaContable: '2026-01-10',
    tipoLibro: 'AA',
    noBatch: 1,
    tipoBatch: 'RB',
    estatusConciliado: '',
    importe: 1000,
    moneda: 'MXP',
    tipoCambio: 0,
    posteo: 'P',
    reversa: '',
    concepto: '',
    explicacion: '',
    nombre: '',
    tipoPago: '',
    noPago: '',
    fechaPago: '',
    documentoOriginal: '',
    importeOriginal: 0,
    ...patch,
  } as AuxiliarContableRecord;
}

// ── 1. Estados de cuenta: 2 meses cerrados + mes en curso + traspasos ──────
const bankStatements: BankAccountStatement[] = [
  statement(CTA_A, 1_000_000, [
    line({ fechaOperacion: '2026-01-10', importe: 800_000, concepto: 'PAGO CLIENTE ACME SA' }),
    line({ fechaOperacion: '2026-01-12', tipoMovimiento: 'CARGO', importe: 300_000, concepto: 'PAGO PROVEEDOR XYZ' }),
    // Traspaso interno pareado (contraparte: ABONO 250k en CTA-B mismo día).
    line({ fechaOperacion: '2026-01-20', tipoMovimiento: 'CARGO', importe: 250_000, concepto: 'ENVIO FONDOS' }),
    // Traspaso interno por leyenda, SIN pareja → residuo −150k (plug INTERNAL_RECON).
    line({ fechaOperacion: '2026-01-25', tipoMovimiento: 'CARGO', importe: 150_000, concepto: 'TRASPASO REF 99001' }),
    line({ fechaOperacion: '2026-02-08', importe: 1_000_000, concepto: 'PAGO CLIENTE BETA SA' }),
    line({ fechaOperacion: '2026-02-18', tipoMovimiento: 'CARGO', importe: 400_000, concepto: 'PAGO PROVEEDOR QRS' }),
    // Mes EN CURSO (marzo): debe quedar fuera del cuadre histórico.
    line({ fechaOperacion: '2026-03-05', importe: 999_999, concepto: 'PAGO CLIENTE MARZO' }),
  ]),
  statement(CTA_B, 500_000, [
    line({ fechaOperacion: '2026-01-20', importe: 250_000, concepto: 'RECEPCION FONDOS' }),
  ]),
  // Cuenta NEUTRA del catálogo (RESERVA): su flujo NO es económico.
  statement(CTA_NEUTRA, 0, [
    line({ fechaOperacion: '2026-02-10', importe: 800_000, concepto: 'FONDEO RESERVA' }),
  ]),
  // Concentradora MULTICARGA (Sendex): ingreso real de paquetería.
  statement(CTA_MULTICARGA, 0, [
    line({ fechaOperacion: '2026-02-12', importe: 120_000, concepto: 'VENTA SENDEX MOSTRADOR' }),
  ]),
];

// ── 2. Libro mayor (AuxiliarContable) cubriendo el flujo real + patas de
//      traspaso (para demostrar que NO contaminan el cruce económico) ──────
const glRecords: AuxiliarContableRecord[] = [
  gl({ fechaContable: '2026-01-10', importe: 800_000, noFactura: 'RI-1001', nombre: 'ACME SA' }),
  gl({ fechaContable: '2026-01-12', importe: -300_000, tipoDocto: 'PK', tipoPago: 'PK', noPago: '501', nombre: 'PROVEEDOR XYZ SA' }),
  gl({ fechaContable: '2026-02-08', importe: 1_000_000, noFactura: 'RI-1002', nombre: 'BETA SA', idCuenta: '0165' }),
  gl({ fechaContable: '2026-02-18', importe: -400_000, tipoDocto: 'PK', tipoPago: 'PK', noPago: '502', nombre: 'MARIA LOPEZ HERNANDEZ', idCuenta: '0165' }),
  gl({ fechaContable: '2026-02-12', importe: 120_000, cuentaBanco: CTA_MULTICARGA, idCuenta: '0166' }),
  // Pata GL del traspaso pareado (asentada en CTA-B) → debe bucketear interno.
  gl({ fechaContable: '2026-01-20', importe: 250_000, cuentaBanco: CTA_B, idCuenta: '0167' }),
  // Línea GL sobre la cuenta neutra → interno pre-match.
  gl({ fechaContable: '2026-02-10', importe: 800_000, cuentaBanco: CTA_NEUTRA, idCuenta: '0168' }),
];

// ── 3. Pipeline real ───────────────────────────────────────────────────────
const recon = reconcileAuxiliar(glRecords, bankStatements);
const bridge = adaptAuxiliarForProjection(recon, [], []);

const assumptions: CashFlowAssumptions = { year: 2026, globalCompliance: 1, factorajeDays: 30 };
const canonical = buildCanonicalProjection({
  companyCode: CIA,
  bankStatements,
  clients: [],
  providers: [],
  cxpRecords: [],
  cobranzaRecords: [],
  cobradaBancoKeys: bridge.cobradaBancoKeys,
  abonoEnrichments: bridge.abonoEnrichments,
  paidCxpKeys: bridge.paidCxpKeys,
  paidPurchaseOrderKeys: bridge.paidPurchaseOrderKeys,
  cargoEnrichments: bridge.cargoEnrichments,
  auxiliarReconLines: recon.lines,
  reconciledByCompanyMonth: bridge.reconciledByCompanyMonth,
  assumptions,
  budget: null,
  asOfDate: TODAY,
  enablePredictive: false,
});

const initialCash = calculateInitialCash(bankStatements, undefined, { companyCode: CIA });
const baseRun = buildScenarioForecastRun({
  scenarioId: 'base',
  scenarioName: 'Base',
  scenarioKind: 'BASE',
  sourceMovements: canonical.movements,
  adjustments: [],
  manualEntries: [],
  customRows: [],
  overrides: [],
  clients: [],
  providers: [],
  assumptions,
  cxpRecords: [],
  budget: null,
  companyCode: CIA,
  taxStore: defaultTaxStore(),
  startDate: '2026-01-01',
  endDate: '2026-12-31',
  today: TODAY,
  initialCash,
  supplierInitialCash: initialCash,
  minimumCash: 0,
  granularity: 'monthly',
});

const report = reconcilePlanningAgainstBank({
  movements: baseRun.movements,
  initialCash,
  bankStatements,
  companyCode: CIA,
  today: TODAY,
});

// ── 4. Salida ──────────────────────────────────────────────────────────────
console.log('══════════════════════════════════════════════════════════════');
console.log(' 1) CRUCE GL×BANCO (Conciliación)');
console.log('══════════════════════════════════════════════════════════════');
console.log(`   Líneas GL: ${recon.summary.totalLineas} · cruzadas ingreso ${recon.summary.ingresoCruzadas}/${recon.summary.ingresoLineas} (${recon.summary.pctIngresoCruzado.toFixed(0)}%) · egreso ${recon.summary.egresoCruzadas}/${recon.summary.egresoLineas} (${recon.summary.pctEgresoCruzado.toFixed(0)}%)`);
console.log(`   Traspasos internos detectados (bucket interno): ${recon.summary.internoLineas} líneas · ${mxn(recon.summary.internoMonto)}`);
console.log(`   Bank orphans reales: ${recon.summary.bankOrphanLineas} (las patas de traspaso/cuenta neutra NO cuentan)`);

console.log('\n══════════════════════════════════════════════════════════════');
console.log(' 2) TOTALES RECONCILIADOS vs VERDAD BANCARIA (por mes)');
console.log('══════════════════════════════════════════════════════════════');
const bankTruth = new Map(buildHistoricalMonths(bankStatements).map((m) => [m.yearMonth, m]));
for (const [key, t] of [...bridge.reconciledByCompanyMonth.entries()].sort()) {
  const ym = key.split('::')[1];
  const bank = bankTruth.get(ym);
  const okIn = bank && Math.abs(t.ingresoCruzado - bank.income) <= 1 ? '✓' : '✗';
  const okOut = bank && Math.abs(t.egresoCruzado - bank.expense) <= 1 ? '✓' : '✗';
  console.log(`   ${ym}  ingreso reconciliado ${mxn(t.ingresoCruzado)} vs banco ${mxn(bank?.income ?? 0)} ${okIn} · egreso ${mxn(t.egresoCruzado)} vs ${mxn(bank?.expense ?? 0)} ${okOut}`);
}

console.log('\n══════════════════════════════════════════════════════════════');
console.log(' 3) CUADRE PLANEACIÓN (Base) ↔ BANCO — meses históricos cerrados');
console.log('══════════════════════════════════════════════════════════════');
console.log(`   Caja inicial del run = Σ saldoInicial bancario = ${mxn(initialCash)} (offset: ${mxn(report.initialCashVsBankInitial)})`);
for (const m of report.months) {
  console.log(`\n   ── ${m.yearMonth} ${m.reconciled ? '✓ CUADRA AL PESO' : '✗ NO CUADRA'}`);
  console.log(`      Ingresos:  Planeación ${mxn(m.planningIncome)}  ==  Banco ${mxn(m.bankIncome)}  (diff ${mxn(m.incomeDiff)})`);
  console.log(`      Egresos:   Planeación ${mxn(m.planningExpense)}  ==  Banco ${mxn(m.bankExpense)}  (diff ${mxn(m.expenseDiff)})`);
  console.log(`      Caja fin:  Planeación ${mxn(m.planningClosingCash)}  ==  Banco ${mxn(m.bankClosingCash)}  (diff ${mxn(m.closingCashDiff)})`);
  console.log(`      Plug traspasos (INTERNAL_RECON, fuera de brutos, dentro de caja): ${mxn(m.internalReconNet)}`);
}
console.log(`\n   Reporte global: reconciled=${report.reconciled} · meses divergentes=[${report.divergentMonths.join(', ')}] · maxDiffCaja=${mxn(report.maxClosingCashDiff)}`);
console.log('   El mes en curso (2026-03, parcial) queda fuera del cuadre histórico a propósito.');

console.log('\n══════════════════════════════════════════════════════════════');
console.log(' 4) CATEGORIZACIÓN — buckets de la cuadrícula de Planeación');
console.log('══════════════════════════════════════════════════════════════');
// Catálogo derivado de proveedores (como lo empuja App.tsx en runtime):
setProviderCatalogForCategoryLookup([
  { id: 'p1', name: 'PROVEEDOR XYZ SA', type: 'CONVENIO SENDEX', numProveedorJDE: '111' },
  { id: 'p2', name: 'PROVEEDOR QRS SA', type: 'NEUMÁTICOS', numProveedorJDE: '222' },
] as unknown as Provider[]);
const buckets = new Map<string, { n: number; total: number }>();
for (const mv of baseRun.movements) {
  const label = `${mv.type === 'INFLOW' ? 'Ingresos' : 'Egresos'} · ${bucketForMovement(mv)}`;
  const agg = buckets.get(label) ?? { n: 0, total: 0 };
  agg.n += 1;
  agg.total += mv.projectedAmount;
  buckets.set(label, agg);
}
for (const [label, agg] of [...buckets.entries()].sort()) {
  console.log(`   ${label.padEnd(46)} ${String(agg.n).padStart(2)} mov  ${mxn(agg.total)}`);
}
console.log('\n   Nota: "PROVEEDOR QRS" viene de la línea GL a nombre de MARIA LOPEZ');
console.log('   HERNANDEZ → rescate persona física → Personal y nómina.');
console.log('   "PROVEEDOR XYZ SA" → catálogo CONVENIO SENDEX → Flota (patrón nuevo).');
console.log('   ABONO Sendex en concentradora MULTICARGA → bucket Multicarga (regla nueva).');

const exitOk = report.reconciled && report.months.length === 2;
if (!exitOk) {
  console.error('\n✗ EL CUADRE FALLÓ');
  process.exit(1);
}
console.log('\n✓ CUADRE COMPLETO: caja, ingresos y egresos de Base == banco, al peso.');
