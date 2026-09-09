import { describe, expect, it } from 'vitest';
import type { AuxiliarContableRecord } from '../services/jdeTypes';
import {
  classifyIvaAccount,
  rateFromAccountName,
  discoverIvaObjetos,
  buildIvaLedgerByPeriod,
  summarizeIvaAccounts,
  hasIvaLedgerCoverage,
} from './ivaLedger';

function rec(partial: Partial<AuxiliarContableRecord>): AuxiliarContableRecord {
  return {
    cia: '00011',
    cuentaContable: '11.1180.0000',
    idCuenta: 'id-1',
    cuentaObjeto: '1180',
    nombreCuenta: 'IVA ACREDITABLE PAGADO',
    cuentaBanco: '',
    tipoDocto: 'PV',
    noDocto: 1,
    noFactura: '',
    noOrdenCompra: '',
    fechaContable: '2026-03-10',
    tipoLibro: 'AA',
    noBatch: 0,
    tipoBatch: 'V',
    estatusConciliado: '',
    importe: 1600,
    moneda: 'MXP',
    tipoCambio: 1,
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
    ...partial,
  };
}

describe('classifyIvaAccount', () => {
  it('clasifica acreditable', () => {
    expect(classifyIvaAccount('IVA ACREDITABLE PAGADO')).toBe('creditable');
    expect(classifyIvaAccount('IVA por acreditar')).toBe('creditable');
  });
  it('clasifica causado/trasladado', () => {
    expect(classifyIvaAccount('IVA TRASLADADO')).toBe('caused');
    expect(classifyIvaAccount('I.V.A. TRASLADADO')).toBe('caused');
    expect(classifyIvaAccount('IVA TRASLADADO COBRADO')).toBe('caused');
    expect(classifyIvaAccount('IVA causado por pagar')).toBe('caused');
    expect(classifyIvaAccount('IVA cobrado')).toBe('caused');
    // `IVA causado por pagar` SÍ es causado: lo dice `CAUSAD`. La guarda de
    // liquidación sólo aplica cuando la cuenta no declara lado.
    expect(classifyIvaAccount('IVA causado a enterar')).toBe('caused');
    expect(classifyIvaAccount('Impuesto al Valor Agregado trasladado')).toBe('caused');
  });
  it('clasifica retenido aparte', () => {
    expect(classifyIvaAccount('IVA RETENIDO')).toBe('withheld');
  });
  it('ignora cuentas no-IVA', () => {
    expect(classifyIvaAccount('BANCOS MONEDA NACIONAL')).toBe('other');
    expect(classifyIvaAccount('CLIENTES NACIONALES')).toBe('other');
    expect(classifyIvaAccount(undefined)).toBe('other');
  });

  // El mayor separa devengado de consumado por nombre de cuenta; colapsarlos
  // cuenta el mismo peso dos veces. Nombres tal cual los manda db_Artefactos
  // (jde.Auxiliar_Contable, Ano 26 — medido 2026-08-10).
  describe('vocabulario REAL del mayor: devengado vs consumado', () => {
    it('el participio negado NO cuenta como consumado', () => {
      // 'PAGADO' empata dentro de 'NO PAGADO': buscarlo por substring antes de
      // la negación clasificaba como acreditable la cuenta que dice que aún no
      // lo es (+$37.45M en el acreditable de 2026).
      expect(classifyIvaAccount('IVA 16% ACREDIT NO PAGADO')).toBe('creditable-pending');
      expect(classifyIvaAccount('IVA 8% ACREDIT NO PAGADO')).toBe('creditable-pending');
      expect(classifyIvaAccount('IVA Acreditable Pendiente de Pago')).toBe('creditable-pending');
      expect(classifyIvaAccount('IVA 16% TRASLADADO NO COBRADO')).toBe('caused-accrued');
      expect(classifyIvaAccount('IVA 8% TRASLADADO NO COBRADO')).toBe('caused-accrued');
      expect(classifyIvaAccount('IVA devengado')).toBe('caused-accrued');
    });

    it('el participio afirmado sí cuenta como consumado', () => {
      expect(classifyIvaAccount('IVA 16% ACREDIT PAGADO')).toBe('creditable');
      expect(classifyIvaAccount('IVA 8% ACREDIT PAGADO')).toBe('creditable');
      expect(classifyIvaAccount('IVA 16% TRASLADADO COBRADO')).toBe('caused');
      expect(classifyIvaAccount('IVA 8% TRASLADADO COBRADO')).toBe('caused');
    });

    // `IVA POR PAGAR` (objeto 2050, **$50.78M en 33 asientos**, medido
    // 2026-09-07) es la cuenta de LIQUIDACIÓN: el neto mensual que se traspasa
    // para pagarle al SAT, o sea el mismo dinero que ya pasó por TRASLADADO
    // COBRADO. Contarla como causado lo suma dos veces. La delata su signo:
    // POSITIVO, cuando todo el causado real del mayor viene en negativo.
    it('la cuenta de liquidación NO es causado', () => {
      expect(classifyIvaAccount('IVA POR PAGAR')).toBe('other');
      expect(classifyIvaAccount('IVA por enterar')).toBe('other');
      expect(classifyIvaAccount('IVA a cargo')).toBe('other');
      expect(classifyIvaAccount('IVA a favor')).toBe('other');
      // Pero si declara lado, gana el lado.
      expect(classifyIvaAccount('IVA causado por pagar')).toBe('caused');
      expect(classifyIvaAccount('IVA acreditable por pagar')).toBe('creditable');
    });

    // La retención tiene el MISMO par devengado/consumado que los otros dos
    // lados; colapsarlo mezclaba `RETENCION IVA 4% NO PAGADO` (+$228k, aún no
    // enterada) con la ya pagada, distorsionando el diagnóstico de retenciones.
    it('retenido gana sobre la negación, y distingue devengado de consumado', () => {
      expect(classifyIvaAccount('RETENCION IVA 4% NO PAGADO')).toBe('withheld-pending');
      expect(classifyIvaAccount('RETENCION IVA 4% PAGADO')).toBe('withheld');
      expect(classifyIvaAccount('RET IVA ARRENDAMIENTO PAGADO')).toBe('withheld');
      expect(classifyIvaAccount('RET IVA HONORARIOS PAGADO')).toBe('withheld');
    });

    it('el acreditable del periodo excluye el IVA aún no pagado', () => {
      // Cifras de abril 2026 (Periodo 4, objeto 1120), el mes con el sesgo más
      // grande: $36.15M realmente pagado contra $18.32M todavía no pagado.
      const byPeriod = buildIvaLedgerByPeriod([
        rec({
          cuentaObjeto: '1120',
          nombreCuenta: 'IVA 16% ACREDIT PAGADO',
          fechaContable: '2026-04-15',
          importe: 36_152_938,
        }),
        rec({
          cuentaObjeto: '1120',
          nombreCuenta: 'IVA 16% ACREDIT NO PAGADO',
          fechaContable: '2026-04-15',
          importe: 18_319_445.22,
        }),
      ]);
      expect(byPeriod.get('2026-04')?.creditable).toBeCloseTo(36_152_938, 2);
    });
  });
});

describe('rateFromAccountName', () => {
  it('detecta 16 y 8', () => {
    expect(rateFromAccountName('IVA ACREDITABLE 16%')).toBe(16);
    expect(rateFromAccountName('IVA ACREDITABLE 8')).toBe(8);
    expect(rateFromAccountName('IVA ACREDITABLE PAGADO')).toBeUndefined();
  });
});

describe('discoverIvaObjetos', () => {
  it('reúne objetos contables de cuentas IVA', () => {
    const objetos = discoverIvaObjetos([
      rec({ cuentaObjeto: '1180', nombreCuenta: 'IVA ACREDITABLE' }),
      rec({ cuentaObjeto: '2160', nombreCuenta: 'IVA TRASLADADO' }),
      rec({ cuentaObjeto: '1105', nombreCuenta: 'CLIENTES' }),
    ]);
    expect(objetos.has('1180')).toBe(true);
    expect(objetos.has('2160')).toBe(true);
    expect(objetos.has('1105')).toBe(false);
  });
});

describe('buildIvaLedgerByPeriod', () => {
  it('suma acreditable y causado por periodo', () => {
    const byPeriod = buildIvaLedgerByPeriod([
      rec({ cuentaObjeto: '1180', nombreCuenta: 'IVA ACREDITABLE', importe: 1600, fechaContable: '2026-03-05' }),
      rec({ cuentaObjeto: '1180', nombreCuenta: 'IVA ACREDITABLE', importe: 400, fechaContable: '2026-03-20' }),
      rec({ cuentaObjeto: '2160', nombreCuenta: 'IVA TRASLADADO', importe: 3200, fechaContable: '2026-03-15' }),
    ]);
    const march = byPeriod.get('2026-03');
    expect(march?.creditable).toBe(2000);
    expect(march?.caused).toBe(3200);
  });

  it('toma la magnitud del neto (signo agnóstico)', () => {
    const byPeriod = buildIvaLedgerByPeriod([
      rec({ cuentaObjeto: '1180', nombreCuenta: 'IVA ACREDITABLE', importe: -1600, fechaContable: '2026-03-10' }),
      rec({ cuentaObjeto: '2160', nombreCuenta: 'IVA TRASLADADO', importe: -3200, fechaContable: '2026-03-15' }),
      rec({ cuentaObjeto: '2160', nombreCuenta: 'IVA TRASLADADO', importe: -800, fechaContable: '2026-03-16' }),
    ]);
    expect(byPeriod.get('2026-03')?.creditable).toBe(1600);
    expect(byPeriod.get('2026-03')?.caused).toBe(4000);
  });

  it('filtra por compañía y rango de fechas', () => {
    const records = [
      rec({ cia: '00011', importe: 1000, fechaContable: '2026-03-10' }),
      rec({ cia: '00042', importe: 9999, fechaContable: '2026-03-10' }),
      rec({ cia: '00011', importe: 5000, fechaContable: '2025-12-31' }),
    ];
    const byPeriod = buildIvaLedgerByPeriod(records, {
      companyCode: '00011',
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    });
    expect(byPeriod.get('2026-03')?.creditable).toBe(1000);
    expect(byPeriod.has('2025-12')).toBe(false);
  });

  it('ignora cuentas no-IVA y retenidos', () => {
    const byPeriod = buildIvaLedgerByPeriod([
      rec({ nombreCuenta: 'IVA RETENIDO', importe: 500 }),
      rec({ nombreCuenta: 'BANCOS', importe: 700 }),
    ]);
    expect(byPeriod.size).toBe(0);
  });

  it('excluye del ACREDITABLE los conceptos que Fiscal quita (nómina/empleados/vales/…)', () => {
    const byPeriod = buildIvaLedgerByPeriod([
      // Acreditable legítimo (proveedor real) → cuenta.
      rec({ nombreCuenta: 'IVA ACREDITABLE', importe: 1600, nombre: 'DIESEL DEL NORTE SA', fechaContable: '2026-03-05' }),
      // Acreditable con concepto excluido → NO cuenta.
      rec({ nombreCuenta: 'IVA ACREDITABLE', importe: 800, concepto: 'Reembolso a empleados', fechaContable: '2026-03-06' }),
      rec({ nombreCuenta: 'IVA ACREDITABLE', importe: 500, nombre: 'ASOCIACION PROTACIO', fechaContable: '2026-03-07' }),
      rec({ nombreCuenta: 'IVA ACREDITABLE', importe: 300, explicacion: 'Compra de vales de despensa', fechaContable: '2026-03-08' }),
      // El causado NO se filtra aunque el concepto suene a excluido.
      rec({ cuentaObjeto: '2160', nombreCuenta: 'IVA TRASLADADO', importe: 3200, concepto: 'Nomina cobrada', fechaContable: '2026-03-15' }),
    ]);
    const march = byPeriod.get('2026-03');
    expect(march?.creditable).toBe(1600); // sólo el proveedor legítimo
    expect(march?.caused).toBe(3200);     // causado intacto
    expect(march?.creditableLines).toHaveLength(1);
  });

  it('respeta un predicado de exclusión inyectado', () => {
    const byPeriod = buildIvaLedgerByPeriod(
      [
        rec({ nombreCuenta: 'IVA ACREDITABLE', importe: 1600, nombre: 'DIESEL DEL NORTE', fechaContable: '2026-03-05' }),
        rec({ nombreCuenta: 'IVA ACREDITABLE', importe: 400, nombre: 'OTRO PROVEEDOR', fechaContable: '2026-03-06' }),
      ],
      { isCreditableExcluded: (r) => /diesel/i.test(r.nombre) },
    );
    expect(byPeriod.get('2026-03')?.creditable).toBe(400);
  });
});

describe('summarizeIvaAccounts / hasIvaLedgerCoverage', () => {
  it('resume cuentas con total firmado', () => {
    const accounts = summarizeIvaAccounts([
      rec({ cuentaObjeto: '1180', nombreCuenta: 'IVA ACREDITABLE', importe: 1000 }),
      rec({ cuentaObjeto: '1180', nombreCuenta: 'IVA ACREDITABLE', importe: 600 }),
    ]);
    expect(accounts).toHaveLength(1);
    expect(accounts[0].signedTotal).toBe(1600);
    expect(accounts[0].kind).toBe('creditable');
  });
  it('detecta cobertura', () => {
    expect(hasIvaLedgerCoverage([rec({ nombreCuenta: 'IVA ACREDITABLE' })])).toBe(true);
    expect(hasIvaLedgerCoverage([rec({ nombreCuenta: 'BANCOS' })])).toBe(false);
    expect(hasIvaLedgerCoverage([])).toBe(false);
    expect(hasIvaLedgerCoverage(undefined)).toBe(false);
  });
});

describe('classifyIvaAccount — el participio desnudo no puede pisar el lado declarado', () => {
  // Hallazgo abierto desde 2026-08-12: los fallbacks por participio no estaban
  // guardados por lado, así que una cuenta del lado CAUSADO cuyo nombre
  // contuviera `PAGADO` salía `creditable` — la peor dirección (infla el saldo
  // a favor). Misma clase de colisión de substring que ya costó $37.45M con
  // `'PAGADO'` dentro de `'NO PAGADO'`.
  it('una cuenta del lado causado con PAGADO NO sale acreditable', () => {
    expect(classifyIvaAccount('IVA 16% TRASLADADO PAGADO')).not.toBe('creditable');
    expect(classifyIvaAccount('IVA CAUSADO PAGADO')).not.toBe('creditable');
  });

  it('el lado y el participio en conflicto van a `other`, no se inventa semántica', () => {
    // Queda visible en el diagnóstico por cuenta para que un humano decida si
    // es causado del periodo o IVA ya enterado al SAT (que no es ninguno).
    expect(classifyIvaAccount('IVA 16% TRASLADADO PAGADO')).toBe('other');
    expect(classifyIvaAccount('IVA 16% ACREDITABLE COBRADO')).toBe('other');
  });

  it('el vocabulario REAL del mayor no cambia', () => {
    expect(classifyIvaAccount('IVA 8% ACREDIT PAGADO')).toBe('creditable');
    expect(classifyIvaAccount('IVA 16% ACREDIT NO PAGADO')).toBe('creditable-pending');
    expect(classifyIvaAccount('IVA 16% TRASLADADO COBRADO')).toBe('caused');
    expect(classifyIvaAccount('IVA 16% TRASLADADO NO COBRADO')).toBe('caused-accrued');
    expect(classifyIvaAccount('RETENCION IVA 4% PAGADO')).toBe('withheld');
    expect(classifyIvaAccount('RETENCION IVA 4% NO PAGADO')).toBe('withheld-pending');
    expect(classifyIvaAccount('IVA POR PAGAR')).toBe('other');
  });

  it('sin lado declarado, el participio sigue decidiendo', () => {
    expect(classifyIvaAccount('IVA PAGADO')).toBe('creditable');
    expect(classifyIvaAccount('IVA COBRADO')).toBe('caused');
  });
});
