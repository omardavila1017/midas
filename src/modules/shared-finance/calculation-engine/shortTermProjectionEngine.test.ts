import { describe, expect, it } from 'vitest';
import type { CXPRecord } from '../../../domain/persistence';
import { isInternalProviderClassification } from '../../../domain/netCashFlowEngine';
import type { CashFlowAssumptions, Client } from '../../../domain/types';
import type { BankAccountStatement, BankStatementLine, CobranzaRecord, RolRecord } from '../../../services/jdeTypes';
import type { PayrollCostRecord, PurchaseReceiptRecord } from '../types';
import { buildCanonicalProjection } from './canonicalProjection';
import { buildShortTermProjectionMovements } from './shortTermProjectionEngine';
import { buildAppliedAmountByFactura } from '../../../domain/cobranzaReceiptsOverlay';

const assumptions: CashFlowAssumptions = {
  year: 2026,
  globalCompliance: 1,
  factorajeDays: 30,
};

describe('buildShortTermProjectionMovements (MOTOR 2)', () => {
  it('proyecta CXC abierto como cxc: fechado por la regla del cliente (días de crédito)', () => {
    const run = (creditDays: number) => {
      const inputs = {
        companyCode: 'all',
        bankStatements: [],
        clients: [client({ creditDays })],
        providers: [],
        cxpRecords: [],
        cobranzaRecords: [
          cobranzaRecord({
            noCliente: '1',
            nombreCliente: 'Cliente IVA',
            noFactura: 'CXC-1',
            fechaFactura: '2026-05-01',
            fechaVence: '2026-05-15',
            importeBrutoPesos: 1_160,
            importePendientePesos: 580,
          }),
        ],
        assumptions,
        budget: null,
        startingBalance: 10_000,
        asOfDate: '2026-04-22',
      };
      const monthly = buildCanonicalProjection(inputs).monthly;
      return buildShortTermProjectionMovements({ monthly, inputs });
    };

    // creditDays 0: factura 2026-05-01 (inhábil, 1 mayo) → siguiente hábil.
    const sinCredito = run(0).find((m) => m.id === 'cxc:00001:1:CXC-1');
    expect(sinCredito).toBeTruthy();
    expect(sinCredito!.category).toBe('AR_COLLECTION');
    expect(sinCredito!.status).toBe('PROJECTED_BASE');
    expect(sinCredito!.projectedDate).toBe('2026-05-04');
    // Solo el saldo pendiente, con desglose IVA 16% sobre bruto.
    expect(sinCredito!.projectedAmount).toBe(580);
    expect(sinCredito!.taxTreatment).toBe('IVA_CAUSED');
    expect(sinCredito!.taxBaseAmount).toBeCloseTo(500);
    expect(sinCredito!.taxAmount).toBeCloseTo(80);

    // creditDays 45: factura + 45 días → 2026-06-15 (hábil). La fecha sale de
    // la regla del cliente, no del vencimiento JDE.
    const conCredito = run(45).find((m) => m.id === 'cxc:00001:1:CXC-1');
    expect(conCredito).toBeTruthy();
    expect(conCredito!.projectedDate).toBe('2026-06-15');
    expect(conCredito!.projectedDate > sinCredito!.projectedDate).toBe(true);
  });

  it('emite órdenes de compra (purchase:) fechadas F_Recepcion + D_Credito con IVA del API', () => {
    const inputs = {
      companyCode: 'all',
      bankStatements: [],
      clients: [],
      providers: [],
      cxpRecords: [],
      purchaseReceipts: [
        purchaseReceipt({
          invoiceNo: 'P-OC',
          receiptDate: '2026-05-01',
          creditDays: 30,
          // estimatedDueDate = F_Recepcion + D_Credito (contrato del adapter).
          estimatedDueDate: '2026-05-31',
          totalAmount: 1_160,
          amountMxn: 1_160,
          taxRateCode: 'IVA16',
          taxRate: 16,
          taxTreatment: 'IVA_CREDITABLE',
          taxBaseAmount: 1_000,
          taxAmount: 160,
        }),
      ],
      assumptions,
      budget: null,
      startingBalance: 10_000,
      asOfDate: '2026-04-22',
    };
    const monthly = buildCanonicalProjection(inputs).monthly;
    const mv = buildShortTermProjectionMovements({ monthly, inputs });

    const oc = mv.find((m) => m.id.startsWith('purchase:') && m.sourceObjectId === 'P-OC');
    expect(oc).toBeTruthy();
    expect(oc!.type).toBe('OUTFLOW');
    expect(oc!.category).toBe('AP_PAYMENT');
    expect(oc!.projectedDate).toBe('2026-05-31');
    expect(oc!.projectedAmount).toBe(1_160);
    expect(oc!.taxRate).toBe(16);
    expect(oc!.taxBaseAmount).toBeCloseTo(1_000);
    expect(oc!.taxAmount).toBeCloseTo(160);
  });

  it('emite nómina TRESS real SIN replicarla a meses futuros', () => {
    const inputs = {
      companyCode: 'all',
      bankStatements: [],
      clients: [],
      providers: [],
      cxpRecords: [],
      payrollCosts: [
        payrollCost({ conceptId: 1, conceptName: 'SUELDO ORDINARIO', conceptType: 'Percepción', amount: 1_000, cashTreatment: 'CASH_OUT', month: 5, paymentDate: '2026-05-15' }),
        payrollCost({ conceptId: 51, conceptName: 'ISR (TRABAJADOR)', conceptType: 'Deducción', amount: 300, cashTreatment: 'DEDUCTION', month: 5, paymentDate: '2026-05-15' }),
      ],
      assumptions,
      budget: null,
      startingBalance: 10_000,
      asOfDate: '2026-04-22',
    };
    const monthly = buildCanonicalProjection(inputs).monthly;
    const mv = buildShortTermProjectionMovements({ monthly, inputs });

    const payroll = mv.filter((m) => m.id.startsWith('payroll:'));
    // Solo el registro real cash-affecting (SUELDO); la deducción no sale y
    // NO existen réplicas sintéticas hacia junio o después.
    expect(payroll).toHaveLength(1);
    expect(payroll[0]!.projectedDate).toBe('2026-05-15');
    expect(payroll[0]!.category).toBe('PAYROLL');
    expect(payroll.some((m) => m.concept.includes('ISR'))).toBe(false);
    expect(mv.some((m) => m.id.startsWith('payroll:') && m.projectedDate >= '2026-06-01')).toBe(false);
    expect(mv.some((m) => m.id.includes('payroll:forecast'))).toBe(false);
  });

  it('descarta payables intra-grupo (clasificación filial/intercompañía o nombre del grupo)', () => {
    // Referencia de la señal: la clasificación JDE "Filiales" es intra-grupo.
    expect(isInternalProviderClassification('Filiales')).toBe(true);

    const inputs = {
      companyCode: 'all',
      bankStatements: [],
      clients: [],
      providers: [],
      cxpRecords: [
        cxpRecord({
          noProveedor: 'INT-1',
          nombre: 'SERVICIOS DEL GRUPO',
          noFactura: 'F-FILIAL',
          clasificacionProveedor: 'Filiales',
          importePendientePesos: 500_000,
        }),
        cxpRecord({
          noProveedor: 'INT-2',
          nombre: 'PROVEEDOR INTERCIA',
          noFactura: 'F-INTERCIA',
          clasifica: 'Intercompañías',
          importePendientePesos: 200_000,
        }),
        cxpRecord({
          noProveedor: 'INT-3',
          nombre: 'MULTICARGA SA DE CV',
          noFactura: 'F-MULTI',
          importePendientePesos: 158_300,
        }),
        cxpRecord({
          noProveedor: 'EXT-1',
          nombre: 'PROVEEDOR EXTERNO SA',
          noFactura: 'F-EXT',
          clasificacionProveedor: 'REFACCIONARIO',
          importePendientePesos: 90_000,
        }),
      ],
      assumptions,
      budget: null,
      startingBalance: 10_000,
      asOfDate: '2026-04-22',
    };
    const monthly = buildCanonicalProjection(inputs).monthly;
    const mv = buildShortTermProjectionMovements({ monthly, inputs });

    const cxpIds = mv.filter((m) => m.id.startsWith('cxp:')).map((m) => m.sourceObjectId);
    expect(cxpIds).toContain('F-EXT');
    expect(cxpIds).not.toContain('F-FILIAL');
    expect(cxpIds).not.toContain('F-INTERCIA');
    expect(cxpIds).not.toContain('F-MULTI');
  });

  it('no emite client:/recurring-*/sintéticos de balanceo ni movimientos históricos bank:', () => {
    const inputs = {
      companyCode: 'all',
      bankStatements: [bankStatement({
        cia: '00001',
        cuenta: 'CTA-A',
        movimientos: [
          bankMovement({ cia: '00001', cuenta: 'CTA-A', tipoMovimiento: 'ABONO', importe: 10_000, fechaOperacion: '2026-03-15', concepto: 'Cobro cliente' }),
        ],
      })],
      clients: [client({ creditDays: 30 })],
      providers: [],
      cxpRecords: [cxpRecord({ noFactura: 'F-1', importePendientePesos: 900 })],
      cobranzaRecords: [cobranzaRecord({ noFactura: 'CXC-1', importePendientePesos: 580, fechaFactura: '2026-05-01' })],
      purchaseReceipts: [purchaseReceipt({ invoiceNo: 'P-1' })],
      payrollCosts: [payrollCost({ month: 5, paymentDate: '2026-05-15' })],
      rolRecords: [rolRecord({ claveJDE: '1', fechaViaje: '2026-05-04', subTotal: 1_000, efectuado: true })],
      assumptions,
      budget: null,
      startingBalance: 10_000,
      asOfDate: '2026-04-22',
    };
    const monthly = buildCanonicalProjection(inputs).monthly;
    const mv = buildShortTermProjectionMovements({ monthly, inputs });

    expect(mv.length).toBeGreaterThan(0);
    const forbidden = ['client:', 'recurring-provider:', 'recurring-operating:', 'budget-opex-gap:', 'canonical-inflow:', 'canonical-outflow:', 'forecast:trend:', 'bank:', 'internal-recon:', 'cobranza-historic:', 'auxiliar-historic:'];
    for (const prefix of forbidden) {
      expect(mv.some((m) => m.id.startsWith(prefix))).toBe(false);
    }
    // Todo lo de MOTOR 2 es proyección (nunca REAL histórico).
    expect(mv.every((m) => m.status === 'PROJECTED_BASE')).toBe(true);
  });

  it('prorratea el IVA de una CXP parcialmente pagada desde los importes JDE', () => {
    const inputs = {
      companyCode: 'all',
      bankStatements: [],
      clients: [],
      providers: [],
      cxpRecords: [
        cxpRecord({
          noFactura: 'F-IVA',
          importeSubtotalPesos: 1_000,
          importeImpuestosPesos: 160,
          importeBrutoPesos: 1_160,
          importePendientePesos: 580,
        }),
      ],
      assumptions,
      budget: null,
      startingBalance: 10_000,
      asOfDate: '2026-04-22',
    };
    const monthly = buildCanonicalProjection(inputs).monthly;
    const mv = buildShortTermProjectionMovements({ monthly, inputs });

    const movement = mv.find((m) => m.id.startsWith('cxp:') && m.sourceObjectId === 'F-IVA');
    expect(movement).toBeTruthy();
    expect(movement!.projectedAmount).toBe(580);
    expect(movement!.taxTreatment).toBe('IVA_CREDITABLE');
    expect(movement!.taxRate).toBe(16);
    // Base e IVA escalados al 50% pendiente: 500 + 80.
    expect(movement!.taxBaseAmount).toBeCloseTo(500);
    expect(movement!.taxAmount).toBeCloseTo(80);
  });

  it('proyecta ROL efectuado no facturado como rol: con bruto = subtotal × 1.16', () => {
    const inputs = {
      companyCode: 'all',
      bankStatements: [],
      clients: [client({ id: 'client-1', creditDays: 30, paymentDay: { kind: 'ANY' } })],
      providers: [],
      cxpRecords: [],
      cobranzaRecords: [],
      rolRecords: [
        rolRecord({ claveJDE: '1', fechaViaje: '2026-05-04', subTotal: 1_000, iva: 16, viajes: 5, efectuado: true }),
      ],
      assumptions,
      budget: null,
      startingBalance: 10_000,
      asOfDate: '2026-04-22',
    };
    const monthly = buildCanonicalProjection(inputs).monthly;
    const mv = buildShortTermProjectionMovements({ monthly, inputs });

    const rol = mv.find((m) => m.id.startsWith('rol:'));
    expect(rol).toBeTruthy();
    expect(rol!.id).toMatch(/^rol:00001:client-1:\d{4}-\d{2}-\d{2}$/);
    expect(rol!.category).toBe('AR_COLLECTION');
    expect(rol!.subcategory).toBe('Clientes Citi');
    // 1000 subtotal × 1.16 = 1160 bruto; viaje + 30d crédito → junio.
    expect(rol!.projectedAmount).toBeCloseTo(1_160);
    expect(rol!.taxBaseAmount).toBeCloseTo(1_000);
    expect(rol!.taxAmount).toBeCloseTo(160);
    expect(rol!.projectedDate.slice(0, 7)).toBe('2026-06');
  });
});

describe('overlay de recibos: /cobranza no aplica los cobros', () => {
  // MEDIDO CONTRA LA BD el 2026-09-07 (carga fresca del día): `jde.Cobranza_Citi`
  // deja 1,694 facturas con `Importe_Pendiente > 0` que `jde.Cobranza_Indicadores`
  // ya reporta cobradas — **$345.3M**, de los cuales **$310.5M son de la cía
  // 00011** (grupo Citi). Ahí `cobradaBancoKeys` no puede ayudar: los depósitos
  // entran a la concentradora y no cruzan a factura individual (es la razón de
  // ser del prorrateo Citi). Sin el overlay, MOTOR 2 proyecta ese dinero como
  // entrada de caja FUTURA mientras el mismo depósito ya está pintado del lado
  // banco: doble conteo.
  const CIA_CITI = '00011';

  const run = (applied?: Map<string, number>, pendiente = 221_201.53) => {
    const inputs = {
      companyCode: 'all',
      bankStatements: [],
      clients: [],
      providers: [],
      cxpRecords: [],
      cobranzaRecords: [
        cobranzaRecord({
          cia: CIA_CITI,
          noCliente: '3M',
          nombreCliente: '3M MEXICO S.A. DE C.V.',
          noFactura: 'RI-301306',
          fechaFactura: '2026-08-10',
          // La ventana del canónico arranca el mes SIGUIENTE al asOfDate
          // cuando no hay histórico bancario cargado.
          fechaVence: '2026-10-15',
          importeBrutoPesos: 221_201.53,
          importePendientePesos: pendiente,
        }),
      ],
      assumptions,
      budget: null,
      startingBalance: 0,
      asOfDate: '2026-09-07',
      cobranzaAppliedByFactura: applied,
    };
    const monthly = buildCanonicalProjection(inputs).monthly;
    return buildShortTermProjectionMovements({ monthly, inputs })
      .find((m) => m.id === `cxc:${CIA_CITI}:3M:RI-301306`);
  };

  it('NO proyecta la factura que los recibos reportan cobrada por completo', () => {
    // Indicadores manda el folio con espacios ("RI - 301306"); la llave del
    // overlay lo normaliza igual que /cobranza.
    const applied = buildAppliedAmountByFactura([{
      idPago: 'P-1',
      cia: CIA_CITI,
      fechaCobro: '2026-08-12',
      fechaContable: '2026-08-12',
      cuentaBancaria: '855877',
      banco: 'BANAMEX',
      noRecibo: '855877',
      importeRecibo: 221_201.53,
      pendienteAplicar: 0,
      noCliente: '3M',
      cliente: '3M MEXICO S.A. DE C.V.',
      noBatch: '1',
      tipoCambio: 1,
      applications: [{
        idPago: 'P-1',
        cia: CIA_CITI,
        fechaAplicacion: '2026-08-12',
        noCliente: '3M',
        cliente: '3M MEXICO S.A. DE C.V.',
        tipoDocto: 'RI',
        noFactura: 'RI - 301306',
        noFacturaNormalizada: 'RI-301306',
        fechaFactura: '2026-08-10',
        fechaVencimiento: '2026-10-15',
        diasAntiguedadFafv: 0,
        importeCobrado: 221_201.53,
        importeOriginalFactura: 221_201.53,
        tasaIva: '16',
        importeIvaFacturaOriginal: 30_510.56,
      }],
    }]);

    expect(run(applied)).toBeUndefined();
  });

  it('proyecta sólo el residuo cuando el cobro fue parcial, con su IVA reescalado', () => {
    const applied = new Map([[`${CIA_CITI}::RI-301306`, 200_000]]);
    const movement = run(applied);

    expect(movement).toBeTruthy();
    expect(movement!.projectedAmount).toBeCloseTo(21_201.53, 2);
    // El IVA debe seguir al importe REALMENTE proyectado: si se desglosara
    // sobre el pendiente inflado, el causado FORECAST quedaría 10x arriba.
    expect(movement!.taxAmount).toBeCloseTo(21_201.53 - 21_201.53 / 1.16, 2);
  });

  it('sin recibos el resultado es byte-idéntico al pendiente reportado', () => {
    // Degrada solo: ene–may 2026 no tiene NI UNA fila en Cobranza_Indicadores,
    // así que esos meses no se pueden mover ni un peso.
    expect(run(undefined)!.projectedAmount).toBe(221_201.53);
    expect(run(new Map())!.projectedAmount).toBe(221_201.53);
  });

  it('no descuenta dos veces la factura que /cobranza ya aplicó', () => {
    // /cobranza ya bajó el pendiente a 21,201.53 Y el recibo dice 200,000
    // cobrados: son el MISMO cobro. Restar el recibo del pendiente dejaría
    // 0 y borraría un saldo que sí está vivo.
    const applied = new Map([[`${CIA_CITI}::RI-301306`, 200_000]]);
    expect(run(applied, 21_201.53)!.projectedAmount).toBeCloseTo(21_201.53, 2);
  });

  // El pozo se construye sobre el set COMPLETO de líneas, ANTES del dedup por
  // folio del motor. Con dos líneas de $100k y un recibo de $150k, lo que
  // `/cobranza` ya reconoce del folio es 0, el excedente es $150k y la línea
  // que el motor sí emite se lleva $100k de ajuste — nunca más que su saldo.
  // Calcular el pozo sobre el set dedupeado subestimaría lo ya aplicado.
  it('el pozo del folio se calcula sobre TODAS las líneas, no sobre la dedupeada', () => {
    const twoLines = (applied?: Map<string, number>) => {
      const inputs = {
        companyCode: 'all',
        bankStatements: [],
        clients: [],
        providers: [],
        cxpRecords: [],
        cobranzaRecords: [
          cobranzaRecord({
            cia: CIA_CITI, noCliente: '3M', nombreCliente: '3M MEXICO S.A. DE C.V.',
            noFactura: 'RI-301306', fechaFactura: '2026-08-10', fechaVence: '2026-10-15',
            importeBrutoPesos: 100_000, importePendientePesos: 100_000,
          }),
          cobranzaRecord({
            cia: CIA_CITI, noCliente: '3M', nombreCliente: '3M MEXICO S.A. DE C.V.',
            noFactura: 'RI-301306', fechaFactura: '2026-08-10', fechaVence: '2026-10-15',
            importeBrutoPesos: 100_000, importePendientePesos: 100_000,
          }),
        ],
        assumptions,
        budget: null,
        startingBalance: 0,
        asOfDate: '2026-09-07',
        cobranzaAppliedByFactura: applied,
      };
      const monthly = buildCanonicalProjection(inputs).monthly;
      return buildShortTermProjectionMovements({ monthly, inputs })
        .filter((m) => m.id === `cxc:${CIA_CITI}:3M:RI-301306`);
    };

    // Sin recibos: el motor dedupea por folio y emite UNA línea de $100k.
    expect(twoLines().map((m) => m.projectedAmount)).toEqual([100_000]);
    // Con recibo de $150k: la línea emitida se agota (ajuste acotado a su
    // saldo), no queda proyección — y el ajuste NUNCA excedió los $100k.
    expect(twoLines(new Map([[`${CIA_CITI}::RI-301306`, 150_000]]))).toEqual([]);
    // Con recibo de $60k: sólo baja $60k, quedan $40k proyectados.
    expect(twoLines(new Map([[`${CIA_CITI}::RI-301306`, 60_000]])).map((m) => m.projectedAmount))
      .toEqual([40_000]);
  });

  // ESTE es el caso que separa el pozo de comparar línea-contra-bruto, y el que
  // hace DESAPARECER cobranza real: el cobro que el recibo reporta ya está
  // aplicado por `/cobranza`, pero en OTRA línea del folio — invisible para el
  // motor, que dedupea y sólo ve la primera. Comparando contra el bruto de la
  // línea que sí emite, el recibo se descontaría otra vez.
  it('no descuenta un cobro que /cobranza ya aplicó en otra línea del folio', () => {
    const inputs = {
      companyCode: 'all',
      bankStatements: [],
      clients: [],
      providers: [],
      cxpRecords: [],
      cobranzaRecords: [
        // Línea que el motor EMITE: nada aplicado, saldo completo.
        cobranzaRecord({
          cia: CIA_CITI, noCliente: '3M', nombreCliente: '3M MEXICO S.A. DE C.V.',
          noFactura: 'RI-301306', fechaFactura: '2026-08-10', fechaVence: '2026-10-15',
          importeBrutoPesos: 100_000, importePendientePesos: 100_000,
        }),
        // Línea que el dedup DESCARTA: /cobranza ya le aplicó $60k.
        cobranzaRecord({
          cia: CIA_CITI, noCliente: '3M', nombreCliente: '3M MEXICO S.A. DE C.V.',
          noFactura: 'RI-301306', fechaFactura: '2026-08-10', fechaVence: '2026-10-15',
          importeBrutoPesos: 100_000, importePendientePesos: 40_000,
        }),
      ],
      assumptions,
      budget: null,
      startingBalance: 0,
      asOfDate: '2026-09-07',
      // El recibo reporta exactamente esos $60k: es el MISMO cobro.
      cobranzaAppliedByFactura: new Map([[`${CIA_CITI}::RI-301306`, 60_000]]),
    };
    const monthly = buildCanonicalProjection(inputs).monthly;
    const movements = buildShortTermProjectionMovements({ monthly, inputs })
      .filter((m) => m.id === `cxc:${CIA_CITI}:3M:RI-301306`);

    // El pozo ve el folio COMPLETO ($60k ya reconocidos) → excedente 0 → sin
    // ajuste. Comparar contra el bruto de la línea emitida daría $40k, borrando
    // $60k de saldo vivo.
    expect(movements.map((m) => m.projectedAmount)).toEqual([100_000]);
  });
});


// ── Fixtures ─────────────────────────────────────────────────────────────

function client(patch: Partial<Client> = {}): Client {
  const monthlyBilling = Array.from({ length: 12 }, () => 0);
  monthlyBilling[4] = 1000;
  return {
    id: 'client-1',
    name: 'Cliente IVA',
    paymentDay: { kind: 'ANY' },
    frequency: 'Mensual',
    creditDays: 0,
    monthlyBilling,
    complianceRate: 1,
    ...patch,
  };
}

function cxpRecord(patch: Partial<CXPRecord>): CXPRecord {
  return {
    cia: patch.cia ?? '00001',
    noProveedor: patch.noProveedor ?? 'P-1',
    nombre: patch.nombre ?? 'Proveedor IVA',
    noFactura: patch.noFactura ?? 'F-1',
    fechaFactura: patch.fechaFactura ?? '2026-05-01',
    fechaVence: patch.fechaVence ?? '2026-05-17',
    fechaProgramacionPago: patch.fechaProgramacionPago ?? '2026-05-17',
    diasVencida: patch.diasVencida ?? 0,
    importeBrutoPesos: patch.importeBrutoPesos ?? 0,
    importePendientePesos: patch.importePendientePesos ?? 0,
    importeSubtotalPesos: patch.importeSubtotalPesos ?? 0,
    importeImpuestosPesos: patch.importeImpuestosPesos ?? 0,
    importeBrutoDolares: patch.importeBrutoDolares ?? 0,
    importePendienteDolares: patch.importePendienteDolares ?? 0,
    moneda: patch.moneda ?? 'MXN',
    condPago: patch.condPago ?? '',
    clasifica: patch.clasifica ?? '',
    clasificacionProveedor: patch.clasificacionProveedor ?? '',
    edoPago: patch.edoPago ?? '',
    tipoCambio: patch.tipoCambio ?? 1,
    porVencer: patch.porVencer ?? 0,
    v1_30: patch.v1_30 ?? 0,
    v31_60: patch.v31_60 ?? 0,
    v61_90: patch.v61_90 ?? 0,
    v91_120: patch.v91_120 ?? 0,
    v121_150: patch.v121_150 ?? 0,
    v151_180: patch.v151_180 ?? 0,
    mas180: patch.mas180 ?? 0,
  };
}

function cobranzaRecord(patch: Partial<CobranzaRecord>): CobranzaRecord {
  return {
    cia: patch.cia ?? '00001',
    noCliente: patch.noCliente ?? '1',
    nombreCliente: patch.nombreCliente ?? 'Cliente IVA',
    noFactura: patch.noFactura ?? 'CXC-1',
    fechaFactura: patch.fechaFactura ?? '2026-05-01',
    fechaVence: patch.fechaVence ?? '2026-05-15',
    fechaCobro: patch.fechaCobro ?? '',
    diasVencida: patch.diasVencida ?? 0,
    importeBrutoPesos: patch.importeBrutoPesos ?? 0,
    importePendientePesos: patch.importePendientePesos ?? 0,
    importeBrutoDolares: patch.importeBrutoDolares ?? 0,
    importePendienteDolares: patch.importePendienteDolares ?? 0,
    moneda: patch.moneda ?? 'MXN',
    condPago: patch.condPago ?? '',
    estatus: patch.estatus ?? 'PENDIENTE',
    tipoCambio: patch.tipoCambio ?? 1,
  };
}

function purchaseReceipt(patch: Partial<PurchaseReceiptRecord> = {}): PurchaseReceiptRecord {
  return {
    cia: patch.cia ?? '00001',
    noProveedor: patch.noProveedor ?? '59570032',
    supplierName: patch.supplierName ?? 'NEW WORLD FUEL SA DE CV',
    invoiceNo: patch.invoiceNo ?? 'P-1',
    purchaseOrderNo: patch.purchaseOrderNo ?? 'OC-1',
    receiptNo: patch.receiptNo ?? 'REC-1',
    orderDate: patch.orderDate ?? '2026-05-01',
    receiptDate: patch.receiptDate ?? '2026-05-01',
    creditDays: patch.creditDays ?? 30,
    estimatedDueDate: patch.estimatedDueDate ?? '2026-05-31',
    currency: patch.currency ?? 'MXN',
    exchangeRate: patch.exchangeRate ?? 1,
    totalAmount: patch.totalAmount ?? 1160,
    amountMxn: patch.amountMxn ?? patch.totalAmount ?? 1160,
    taxCode: patch.taxCode,
    taxRateCode: patch.taxRateCode,
    taxRate: patch.taxRate,
    taxTreatment: patch.taxTreatment ?? 'UNCLASSIFIED',
    taxBaseAmount: patch.taxBaseAmount,
    taxAmount: patch.taxAmount,
    cancelledAt: patch.cancelledAt,
    isCancelled: patch.isCancelled ?? false,
    status: patch.status ?? 'PROJECTED_BASE',
    costCenter: patch.costCenter,
    productCode: patch.productCode,
    productDescription: patch.productDescription,
    productType: patch.productType,
    categoryCode: patch.categoryCode,
    categoryName: patch.categoryName ?? 'Combustibles',
    familyCode: patch.familyCode,
    familyName: patch.familyName ?? 'DIESEL AUTOCONSUMO',
    subfamilyCode: patch.subfamilyCode,
    subfamilyName: patch.subfamilyName ?? 'DIESEL',
  };
}

function payrollCost(patch: Partial<PayrollCostRecord>): PayrollCostRecord {
  return {
    cia: patch.cia ?? '00001',
    empresaNomina: patch.empresaNomina ?? 'SIR',
    year: patch.year ?? 2026,
    month: patch.month ?? 5,
    paymentDate: patch.paymentDate ?? '2026-05-15',
    periodStartDate: patch.periodStartDate,
    periodEndDate: patch.periodEndDate,
    payrollPeriod: patch.payrollPeriod ?? 1,
    payrollType: patch.payrollType ?? 'Semanal',
    conceptId: patch.conceptId ?? 1,
    conceptName: patch.conceptName ?? 'SUELDO ORDINARIO',
    conceptType: patch.conceptType ?? 'Percepción',
    cashTreatment: patch.cashTreatment ?? 'CASH_OUT',
    amount: patch.amount ?? 1000,
    costCenter: patch.costCenter,
  };
}

function rolRecord(patch: Partial<RolRecord> = {}): RolRecord {
  return {
    cia: patch.cia ?? '00001',
    empresa: patch.empresa ?? 'SERVICIO INDUSTRIAL',
    kCliente: patch.kCliente ?? 125,
    cCliente: patch.cCliente ?? 'CLI',
    dCliente: patch.dCliente ?? 'Cliente IVA',
    rfc: patch.rfc ?? 'XAXX010101000',
    claveJDE: patch.claveJDE ?? '1',
    facturacionTipo: patch.facturacionTipo ?? 'MENSUAL',
    iva: patch.iva ?? 16,
    tipoViaje: patch.tipoViaje ?? 'SENCILL',
    ruta: patch.ruta ?? 'RUTA TEST',
    costoRuta: patch.costoRuta ?? 200,
    viajes: patch.viajes ?? 5,
    subTotal: patch.subTotal ?? 1000,
    despachado: patch.despachado ?? true,
    efectuado: patch.efectuado ?? true,
    anio: patch.anio ?? 2026,
    semana: patch.semana ?? 19,
    fechaViaje: patch.fechaViaje ?? '2026-05-04',
    factura: patch.factura,
    uuidFiscal: patch.uuidFiscal,
    plazaCiti: patch.plazaCiti,
  };
}

function bankMovement(patch: Partial<BankStatementLine> & Pick<BankStatementLine, 'cia' | 'cuenta' | 'tipoMovimiento' | 'importe' | 'fechaOperacion'>): BankStatementLine {
  return {
    cia: patch.cia,
    banco: patch.banco ?? 'BANK-X',
    nombreBanco: patch.nombreBanco,
    cuenta: patch.cuenta,
    moneda: patch.moneda ?? 'MXN',
    fechaOperacion: patch.fechaOperacion,
    fechaValor: patch.fechaValor,
    referencia: patch.referencia ?? '',
    concepto: patch.concepto ?? '',
    tipoMovimiento: patch.tipoMovimiento,
    importe: patch.importe,
    saldo: patch.saldo,
  };
}

function bankStatement(patch: Partial<BankAccountStatement> & Pick<BankAccountStatement, 'cia' | 'cuenta' | 'movimientos'>): BankAccountStatement {
  return {
    cia: patch.cia,
    banco: patch.banco ?? 'BANK-X',
    nombreBanco: patch.nombreBanco,
    cuenta: patch.cuenta,
    moneda: patch.moneda ?? 'MXN',
    fechaEstadoCuenta: patch.fechaEstadoCuenta ?? '2026-04-30',
    saldoInicial: patch.saldoInicial ?? 0,
    saldoFinal: patch.saldoFinal,
    movimientos: patch.movimientos,
  };
}
