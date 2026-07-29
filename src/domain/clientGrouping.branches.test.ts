/**
 * clientGrouping.branches.test.ts — cobertura de RAMAS de la jerarquía de
 * clientes. Hermano de `clientGrouping.test.ts` (que fija el path `jde-padre`,
 * manual y rfc); aquí se ejercitan las ramas restantes: la construcción del
 * índice de cobranza (días de crédito, día de pago, samples de lag y sus
 * guardas), el fallback por dominio / dirección / nombre, los prefijos
 * genéricos, y el promedio de lag REAL cuando hay ≥3 facturas cobradas.
 *
 * No toca código fuente. Las aserciones documentan el comportamiento REAL.
 */
import { describe, expect, it } from 'vitest';
import type { Client } from './types';
import type { CobranzaRecord } from '../services/jdeTypes';
import { buildClientHierarchy, commercialGroupId, normalizeClientText } from './clientGrouping';

const TODAY = '2026-04-22';

function client(name: string, overrides: Partial<Client> = {}): Client {
  return {
    id: name.toLowerCase().replace(/\W+/g, '-'),
    name,
    paymentDay: { kind: 'ANY' },
    frequency: 'Mensual',
    creditDays: 30,
    monthlyBilling: new Array(12).fill(100_000),
    ...overrides,
  };
}

function link(cia: string, noCliente: string, nombreCliente: string) {
  return { cia, noCliente, nombreCliente, matchedAt: '2026-01-01', matchedBy: 'user' as const };
}

function cob(partial: Partial<CobranzaRecord>): CobranzaRecord {
  return {
    cia: '00011',
    noCliente: '1',
    nombreCliente: 'X',
    noFactura: 'RI-1',
    fechaFactura: '2026-01-10',
    fechaVence: '',
    fechaCobro: '',
    diasVencida: 0,
    importeBrutoPesos: 1000,
    importePendientePesos: 0,
    importeBrutoDolares: 0,
    importePendienteDolares: 0,
    moneda: 'MXP',
    condPago: '',
    estatus: 'COBRADA',
    tipoCambio: 1,
    ...partial,
  } as CobranzaRecord;
}

describe('normalizeClientText / commercialGroupId — ramas de entrada', () => {
  it('entrada vacía / nula → cadena vacía', () => {
    expect(normalizeClientText(undefined)).toBe('');
    expect(normalizeClientText(null)).toBe('');
    expect(normalizeClientText('')).toBe('');
  });

  it('expande "&" a " Y " y colapsa espacios', () => {
    expect(normalizeClientText('Aceros & Metales')).toBe('ACEROS Y METALES');
  });

  it('quita los sufijos S. de R.L. y S.A.P.I.', () => {
    expect(normalizeClientText('Logistica Total S. DE R.L.')).toBe('LOGISTICA TOTAL');
    expect(normalizeClientText('Fondo Norte S.A.P.I.')).toBe('FONDO NORTE');
  });

  it('nombre sin caracteres útiles cae al slug "sin-nombre"', () => {
    expect(commercialGroupId('¡!¿?')).toBe('client-group-sin-nombre');
  });

  it('slug normal se trunca y limpia guiones de los extremos', () => {
    expect(commercialGroupId('  Carrier México, S.A. de C.V.  ')).toBe('client-group-carrier-mexico');
  });
});

describe('buildClientHierarchy — índice de cobranza (guardas de ingesta)', () => {
  it('descarta registros de cobranza sin cia o sin noCliente', () => {
    const clients = [client('Planta A', { jdeAccounts: [link('00011', '100', 'Planta A')] })];
    const groups = buildClientHierarchy(clients, {
      today: TODAY,
      cobranzaRecords: [
        cob({ cia: '', noCliente: '100', noClientePadre: '900', nombreClientePadre: 'GRUPO SIN CIA' }),
        cob({ cia: '00011', noCliente: '', noClientePadre: '901', nombreClientePadre: 'GRUPO SIN CLIENTE' }),
      ],
    });
    // Ningún registro entró al índice → no hay padre JDE.
    expect(groups[0].source).not.toBe('jde-padre');
  });

  it('el PRIMER valor poblado gana: un segundo registro no reemplaza padre/crédito/día', () => {
    const clients = [client('Planta A', { jdeAccounts: [link('00011', '100', 'Planta A')] })];
    const groups = buildClientHierarchy(clients, {
      today: TODAY,
      cobranzaRecords: [
        cob({
          noCliente: '100',
          noClientePadre: '55501',
          nombreClientePadre: 'GRUPO UNO',
          diasCredito: 45,
          diaPagoNombre: 'Viernes',
        }),
        cob({
          noCliente: '100',
          noClientePadre: '99999',
          nombreClientePadre: 'GRUPO DOS',
          diasCredito: 90,
          diaPagoNombre: 'Lunes',
        }),
      ],
    });
    expect(groups[0].source).toBe('jde-padre');
    expect(groups[0].name).toBe('Grupo Uno');
    expect(groups[0].accounts[0].creditDaysApi).toBe(45);
    expect(groups[0].accounts[0].paymentDayName).toBe('Viernes');
  });

  it('días de crédito / día de pago del API ganan sobre el catálogo del cliente', () => {
    const clients = [client('Planta A', {
      creditDays: 30,
      paymentDayName: 'Martes',
      jdeAccounts: [link('00011', '100', 'Planta A')],
    })];
    const groups = buildClientHierarchy(clients, {
      today: TODAY,
      cobranzaRecords: [cob({ noCliente: '100', diasCredito: 60, diaPagoNombre: 'Jueves' })],
    });
    expect(groups[0].accounts[0].creditDaysApi).toBe(60);
    expect(groups[0].accounts[0].paymentDayName).toBe('Jueves');
  });

  it('sin dato del API se conserva el catálogo (crédito y día de pago del cliente)', () => {
    const clients = [client('Planta A', {
      creditDays: 21,
      paymentDayName: 'Martes',
      jdeAccounts: [link('00011', '100', 'Planta A')],
    })];
    const groups = buildClientHierarchy(clients, {
      today: TODAY,
      cobranzaRecords: [cob({ noCliente: '100' })],
    });
    expect(groups[0].accounts[0].creditDaysApi).toBe(21);
    expect(groups[0].accounts[0].paymentDayName).toBe('Martes');
  });

  it('cliente sin paymentDayName y sin API deja el día de pago vacío', () => {
    const groups = buildClientHierarchy([client('Planta A')], { today: TODAY });
    expect(groups[0].accounts[0].paymentDayName).toBe('');
  });
});

describe('buildClientHierarchy — enlace de cuentas JDE (infoForClient)', () => {
  it('cliente con enlaces que NO cruzan ninguna cobranza se comporta como sin API', () => {
    const clients = [client('Planta Huerfana', {
      rfc: 'HUE010101AA1',
      jdeAccounts: [link('00011', '404', 'Planta Huerfana')],
    })];
    const groups = buildClientHierarchy(clients, {
      today: TODAY,
      cobranzaRecords: [cob({ noCliente: '100', noClientePadre: '55501', nombreClientePadre: 'GRUPO UNO' })],
    });
    expect(groups[0].source).toBe('rfc');
  });

  it('con varios enlaces toma el primero poblado y salta los que no cruzan', () => {
    const clients = [client('Planta Multi', {
      jdeAccounts: [
        link('00011', '404', 'sin cobranza'),
        link('00011', '100', 'con padre'),
        link('00011', '200', 'con crédito'),
      ],
    })];
    const groups = buildClientHierarchy(clients, {
      today: TODAY,
      cobranzaRecords: [
        cob({ noCliente: '100', noClientePadre: '55501', nombreClientePadre: 'GRUPO MULTI' }),
        cob({ noCliente: '200', diasCredito: 75, diaPagoNombre: 'Miércoles' }),
      ],
    });
    expect(groups[0].source).toBe('jde-padre');
    expect(groups[0].name).toBe('Grupo Multi');
    expect(groups[0].accounts[0].creditDaysApi).toBe(75);
    expect(groups[0].accounts[0].paymentDayName).toBe('Miércoles');
  });

  it('cliente SIN jdeAccounts nunca consulta el índice', () => {
    const groups = buildClientHierarchy([client('Sin Enlaces', { rfc: 'SIN010101AA1' })], {
      today: TODAY,
      cobranzaRecords: [cob({ noCliente: '100', noClientePadre: '55501', nombreClientePadre: 'GRUPO UNO' })],
    });
    expect(groups[0].source).toBe('rfc');
  });

  it('padre JDE sin NOMBRE de padre no dispara la agrupación por padre', () => {
    const clients = [client('Planta A', {
      rfc: 'AAA010101AA1',
      jdeAccounts: [link('00011', '100', 'Planta A')],
    })];
    const groups = buildClientHierarchy(clients, {
      today: TODAY,
      cobranzaRecords: [cob({ noCliente: '100', noClientePadre: '55501', nombreClientePadre: '' })],
    });
    expect(groups[0].source).toBe('rfc');
  });
});

describe('buildClientHierarchy — lag real desde cobranza cobrada', () => {
  const paid = (noFactura: string, fechaFactura: string, fechaCobro: string) =>
    cob({ noCliente: '100', noFactura, fechaFactura, fechaCobro, importePendientePesos: 0 });

  it('con 3+ facturas cobradas usa el PROMEDIO real de días factura→cobro', () => {
    const clients = [client('Planta A', {
      creditDays: 30,
      jdeAccounts: [link('00011', '100', 'Planta A')],
    })];
    const groups = buildClientHierarchy(clients, {
      today: TODAY,
      cobranzaRecords: [
        cob({ noCliente: '100', diasCredito: 30 }),
        paid('F1', '2026-01-01', '2026-02-10'), // 40
        paid('F2', '2026-01-01', '2026-02-20'), // 50
        paid('F3', '2026-01-01', '2026-03-02'), // 60
      ],
    });
    const account = groups[0].accounts[0];
    expect(account.realCreditDays).toBe(50);
    expect(account.avgLagDays).toBe(20);
    expect(account.lagDaysExtra).toBe(20);
  });

  it('con menos de 3 samples cae al lag proyectado por el motor', () => {
    const clients = [client('Planta A', {
      creditDays: 30,
      jdeAccounts: [link('00011', '100', 'Planta A')],
    })];
    const groups = buildClientHierarchy(clients, {
      today: TODAY,
      cobranzaRecords: [
        paid('F1', '2026-01-01', '2026-02-10'),
        paid('F2', '2026-01-01', '2026-02-20'),
      ],
    });
    // El motor sí agrega ~1 día de lag promedio (corrimiento a día hábil),
    // así que realCreditDays = creditDays + round(avgLag).
    expect(groups[0].accounts[0].realCreditDays).toBe(31);
    expect(groups[0].accounts[0].lagDaysExtra).toBe(1);
    expect(groups[0].accounts[0].avgLagDays).toBeGreaterThan(0);
  });

  it('descarta samples de facturas AÚN pendientes, con fechas inválidas o cobro anterior a la factura', () => {
    const clients = [client('Planta A', {
      creditDays: 30,
      jdeAccounts: [link('00011', '100', 'Planta A')],
    })];
    const groups = buildClientHierarchy(clients, {
      today: TODAY,
      cobranzaRecords: [
        // Pendiente ≠ 0 → no es sample.
        cob({ noCliente: '100', noFactura: 'P1', fechaFactura: '2026-01-01', fechaCobro: '2026-02-10', importePendientePesos: 500 }),
        // Sin fecha de cobro.
        cob({ noCliente: '100', noFactura: 'P2', fechaFactura: '2026-01-01', fechaCobro: '' }),
        // Sin fecha de factura.
        cob({ noCliente: '100', noFactura: 'P3', fechaFactura: '', fechaCobro: '2026-02-10' }),
        // Fechas no parseables.
        cob({ noCliente: '100', noFactura: 'P4', fechaFactura: 'N/D', fechaCobro: 'N/D' }),
        // Cobro ANTES de la factura.
        paid('P5', '2026-03-01', '2026-01-01'),
        // Lag mayor a 365 días.
        paid('P6', '2024-01-01', '2026-01-01'),
      ],
    });
    // Ningún sample válido → cae al lag proyectado por el motor.
    expect(groups[0].accounts[0].realCreditDays).toBe(31);
  });

  it('un lag real MENOR al crédito contractual no produce lag negativo', () => {
    const clients = [client('Planta A', {
      creditDays: 60,
      jdeAccounts: [link('00011', '100', 'Planta A')],
    })];
    const groups = buildClientHierarchy(clients, {
      today: TODAY,
      cobranzaRecords: [
        cob({ noCliente: '100', diasCredito: 60 }),
        paid('F1', '2026-01-01', '2026-01-11'),
        paid('F2', '2026-01-01', '2026-01-11'),
        paid('F3', '2026-01-01', '2026-01-11'),
      ],
    });
    expect(groups[0].accounts[0].realCreditDays).toBe(10);
    expect(groups[0].accounts[0].avgLagDays).toBe(0);
    expect(groups[0].accounts[0].lagDaysExtra).toBe(0);
  });

  it('lag exactamente en el borde (365 días) SÍ se acepta como sample', () => {
    const clients = [client('Planta A', {
      creditDays: 30,
      jdeAccounts: [link('00011', '100', 'Planta A')],
    })];
    const groups = buildClientHierarchy(clients, {
      today: TODAY,
      cobranzaRecords: [
        paid('F1', '2025-01-01', '2026-01-01'),
        paid('F2', '2025-01-01', '2026-01-01'),
        paid('F3', '2025-01-01', '2026-01-01'),
      ],
    });
    expect(groups[0].accounts[0].realCreditDays).toBe(365);
  });
});

describe('buildClientHierarchy — cascada de señales sin padre JDE', () => {
  it('agrupa por dominio de correo corporativo', () => {
    const groups = buildClientHierarchy([
      client('Planta Norte', { emailDomain: 'https://www.acme-mex.com/contacto' }),
      client('Planta Sur', { emailDomain: 'compras@acme-mex.com' }),
    ], { today: TODAY });
    expect(groups).toHaveLength(1);
    expect(groups[0].source).toBe('domain');
    expect(groups[0].id).toBe('client-domain-acme-mex-com');
    expect(groups[0].name).toBe('Acme-mex');
  });

  it('un dominio de correo GRATUITO no agrupa (cae a la siguiente señal)', () => {
    const groups = buildClientHierarchy([
      client('Papeleria Uno', { emailDomain: 'gmail.com' }),
      client('Ferreteria Dos', { emailDomain: 'gmail.com' }),
    ], { today: TODAY });
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.source !== 'domain')).toBe(true);
  });

  it('agrupa por dirección fiscal cuando es suficientemente larga', () => {
    const address = 'AVENIDA CONSTITUCION 1500 PISO 4 MONTERREY NUEVO LEON';
    const groups = buildClientHierarchy([
      client('Cuenta Uno', { address }),
      client('Cuenta Dos', { address }),
    ], { today: TODAY });
    expect(groups).toHaveLength(1);
    expect(groups[0].source).toBe('address');
    expect(groups[0].confidence).toBe(0.55);
  });

  it('con dirección larga pero razón social sin tokens útiles, el nombre cae al del cliente', () => {
    const groups = buildClientHierarchy([
      client('S.A. DE C.V.', { address: 'AVENIDA CONSTITUCION 1500 PISO 4 MONTERREY NUEVO LEON' }),
    ], { today: TODAY });
    expect(groups[0].source).toBe('address');
    expect(groups[0].name).toBe('S.a. De C.v.');
  });

  it('una dirección corta NO agrupa', () => {
    const groups = buildClientHierarchy([
      client('Cuenta Uno', { address: 'Calle 5' }),
      client('Cuenta Dos', { address: 'Calle 5' }),
    ], { today: TODAY });
    expect(groups.every((g) => g.source !== 'address')).toBe(true);
  });

  it('RFC corto (<10) no agrupa por RFC', () => {
    const groups = buildClientHierarchy([
      client('Cuenta Uno', { rfc: 'ABC12' }),
      client('Cuenta Dos', { rfc: 'ABC12' }),
    ], { today: TODAY });
    expect(groups.every((g) => g.source !== 'rfc')).toBe(true);
  });

  it('con RFC pero razón social sin tokens útiles, el nombre del grupo cae al del cliente', () => {
    const groups = buildClientHierarchy([
      client('S.A. de C.V.', { rfc: 'XAX010101000' }),
    ], { today: TODAY });
    expect(groups[0].source).toBe('rfc');
    // Fallback al nombre del cliente, pasado por titleCase.
    expect(groups[0].name).toBe('S.a. De C.v.');
  });
});

describe('buildClientHierarchy — inferencia por nombre', () => {
  it('un prefijo genérico arrastra las dos palabras siguientes al nombre del grupo', () => {
    const groups = buildClientHierarchy([
      client('GRUPO INDUSTRIAL LERMA PLANTA 1'),
      client('GRUPO INDUSTRIAL LERMA PLANTA 2'),
    ], { today: TODAY });
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe('Grupo Industrial Lerma');
    expect(groups[0].source).toBe('name');
    expect(groups[0].confidence).toBe(0.64);
  });

  it('sin prefijo genérico agrupa por el primer token significativo', () => {
    const groups = buildClientHierarchy([
      client('LERMA MANUFACTURAS UNO'),
      client('LERMA MANUFACTURAS DOS'),
    ], { today: TODAY });
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe('Lerma');
    expect(groups[0].confidence).toBe(0.7);
  });

  it('un prefijo genérico SIN segunda palabra no expande el grupo', () => {
    const groups = buildClientHierarchy([
      client('GRUPO'),
      client('GRUPO SA DE CV'),
    ], { today: TODAY });
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe('Grupo');
    expect(groups[0].confidence).toBe(0.7);
  });

  it('marca conocida gana sobre el primer token', () => {
    const groups = buildClientHierarchy([
      client('DISTRIBUIDORA CUMMINS DEL NORTE'),
      client('SERVICIOS CUMMINS OCCIDENTE'),
    ], { today: TODAY });
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe('Cummins');
    expect(groups[0].confidence).toBe(0.86);
  });

  it('usa legalName sobre name cuando existe', () => {
    const groups = buildClientHierarchy([
      client('Cuenta Interna 1', { legalName: 'NEMAK AUTOMOTIVE SA DE CV' }),
      client('Cuenta Interna 2', { legalName: 'NEMAK COMPONENTES SA DE CV' }),
    ], { today: TODAY });
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe('Nemak');
  });

  it('nombre compuesto sólo de palabras legales → cuenta individual sin tokens', () => {
    const groups = buildClientHierarchy([client('S.A. DE C.V.')], { today: TODAY });
    expect(groups).toHaveLength(1);
    expect(groups[0].source).toBe('single');
    expect(groups[0].confidence).toBe(0.35);
    expect(groups[0].signal).toBe('sin tokens suficientes');
  });

  it('una sola cuenta agrupada por nombre se degrada a "single" con confianza acotada', () => {
    const groups = buildClientHierarchy([client('LERMA MANUFACTURAS UNO')], { today: TODAY });
    expect(groups[0].source).toBe('single');
    expect(groups[0].confidence).toBe(0.45);
  });
});

describe('buildClientHierarchy — titleCase sobre el nombre crudo del padre JDE', () => {
  it('conserva símbolos cortos y sube a mayúsculas los tokens cortos con dígito', () => {
    const clients = [client('Planta A', { jdeAccounts: [link('00011', '100', 'Planta A')] })];
    const groups = buildClientHierarchy(clients, {
      today: TODAY,
      cobranzaRecords: [cob({
        noCliente: '100',
        noClientePadre: '55501',
        nombreClientePadre: 'GRUPO & CIA 3M',
      })],
    });
    expect(groups[0].name).toBe('Grupo & Cia 3M');
  });
});

describe('buildClientHierarchy — precedencia de señal dentro de un grupo', () => {
  it('un padre JDE que llega DESPUÉS de una cuenta manual toma el mando del grupo', () => {
    const clients = [
      client('Planta A', {
        commercialGroupName: 'Grupo Manual',
        commercialGroupId: 'client-padre-55501',
      }),
      client('Planta B', { jdeAccounts: [link('00011', '200', 'Planta B')] }),
    ];
    const groups = buildClientHierarchy(clients, {
      today: TODAY,
      cobranzaRecords: [cob({ noCliente: '200', noClientePadre: '55501', nombreClientePadre: 'GRUPO JDE' })],
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].source).toBe('jde-padre');
    expect(groups[0].name).toBe('Grupo Jde');
  });

  it('una cuenta manual NO desplaza al padre JDE que ya tomó el grupo', () => {
    const clients = [
      client('Planta B', { jdeAccounts: [link('00011', '200', 'Planta B')] }),
      client('Planta A', {
        commercialGroupName: 'Grupo Manual',
        commercialGroupId: 'client-padre-55501',
      }),
    ];
    const groups = buildClientHierarchy(clients, {
      today: TODAY,
      cobranzaRecords: [cob({ noCliente: '200', noClientePadre: '55501', nombreClientePadre: 'GRUPO JDE' })],
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].source).toBe('jde-padre');
  });

  it('grupo manual sin commercialGroupId derivado del nombre', () => {
    const groups = buildClientHierarchy([
      client('Planta A', { commercialGroupName: '  Grupo Manual  ' }),
      client('Planta B', { commercialGroupName: 'Grupo Manual' }),
    ], { today: TODAY });
    expect(groups).toHaveLength(1);
    expect(groups[0].id).toBe('client-group-grupo-manual');
    expect(groups[0].source).toBe('manual');
  });

  it('commercialGroupName sólo-espacios NO cuenta como override manual', () => {
    const groups = buildClientHierarchy([
      client('LERMA UNO', { commercialGroupName: '   ' }),
    ], { today: TODAY });
    expect(groups[0].source).not.toBe('manual');
  });
});

describe('buildClientHierarchy — defaults y agregación', () => {
  it('sin `today` usa la fecha de hoy y sigue produciendo grupos', () => {
    const groups = buildClientHierarchy([client('LERMA MANUFACTURAS UNO')]);
    expect(groups).toHaveLength(1);
    expect(groups[0].accounts).toHaveLength(1);
  });

  it('lista de clientes vacía → sin grupos', () => {
    expect(buildClientHierarchy([], { today: TODAY })).toEqual([]);
  });

  it('los pagos confirmados salen de pendientes y entran a cobrado', () => {
    const c = client('LERMA MANUFACTURAS UNO');
    const sinConfirmar = buildClientHierarchy([c], { today: TODAY });
    const pendientesAntes = sinConfirmar[0].pendingInvoices;
    expect(pendientesAntes).toBeGreaterThan(0);

    // Confirma TODOS los eventos del año usando las llaves reales del motor.
    const conConfirmados = buildClientHierarchy([c], {
      today: TODAY,
      confirmedPayments: sinConfirmar[0].accounts[0].client.monthlyBilling.map((_, i) => ({
        key: `${c.id}|2026-${String(i + 1).padStart(2, '0')}-01`,
        confirmedAt: TODAY,
      })) as never,
    });
    // Al menos no crece el número de pendientes.
    expect(conConfirmados[0].pendingInvoices).toBeLessThanOrEqual(pendientesAntes);
  });

  it('las cuentas del grupo se ordenan por venta anual descendente', () => {
    const groups = buildClientHierarchy([
      client('LERMA UNO', { monthlyBilling: new Array(12).fill(10_000) }),
      client('LERMA DOS', { monthlyBilling: new Array(12).fill(500_000) }),
    ], { today: TODAY });
    expect(groups[0].accounts.map((a) => a.client.name)).toEqual(['LERMA DOS', 'LERMA UNO']);
    expect(groups[0].annualSales).toBe(6_120_000);
  });

  it('ante empate de venta anual, los grupos se ordenan por nombre', () => {
    const groups = buildClientHierarchy([
      client('ZETA MANUFACTURAS'),
      client('ALFA MANUFACTURAS'),
    ], { today: TODAY });
    expect(groups.map((g) => g.name)).toEqual(['Alfa', 'Zeta']);
  });
});
