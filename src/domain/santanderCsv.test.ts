import { describe, expect, it } from 'vitest';
import { parseSantanderCsv, parseSantanderTxt, parseSantanderFile, SANTANDER_FILE_FORMAT } from './santanderCsv';

// ─────────────────────────────────────────────────────────────────────────
// santanderCsv — el parser de carga manual es el camino VIVO de ingesta
// para Santander (los espejos de BD están muertos), así que aquí se PINEA
// el comportamiento actual: encabezados esperados, fecha ddmmyyyy, signo
// vía Cargo/Abono, separadores de miles, BOM, filas basura, agrupación por
// cuenta y el shape de salida (BankAccountStatement + movimientos).
// ─────────────────────────────────────────────────────────────────────────

describe('parseSantanderCsv', () => {
  it('normalizes a Santander export into bank statements', () => {
    const csv = [
      'Cuenta,Fecha,Hora,Sucursal,Descripcion,Cargo/Abono,Importe,Saldo,Referencia,Concepto,Banco Participante,Clabe Beneficiario,Nombre Beneficiario,Cta Ordenante,Nombre Ordenante,Codigo Devolucion,Causa Devolucion,RFC Beneficiario,RFC Ordenante,Clave de Rastreo,Descripcion Larga',
      '\'65502559449,\'01042026\',05:04,\'7465\',ABONO TRANSFERENCIA SPEI,+,10289.93,4028462.95,002146728,AMEXCO SE 9351506317 124180002346330665,CITI MEXICO,\'014580655025594494  \',SERVICIOS ESPECIALIZADOS SENDA SA DE CV,\'124180002346330665  \',AMERICAN EXPRESS COMPANY MEXICO SADE CV,,,SES051125TR5,AEC810901298,D5802283BB559491,ABONO TRANSFERENCIA SPEI',
      '\'65502559449,\'01042026\',12:26,\'0981\',PAGO TRANSFERENCIA SPEI,-,4945000.00,2153.54,009446731,TRTT REF 0000000,BANAMEX,\'002580701381993022  \',SERVICIOS ESPECIALIZADOS SENDA,\'00142674065502559449\',SERVICIOS ESPECIALIZADOS SENDA SA DE CV,,,,SES051125TR5,20260401400140BET0000494467310,PAGO TRANSFERENCIA SPEI',
    ].join('\n');

    const [statement] = parseSantanderCsv(csv, { defaultCia: '00011' });

    expect(statement.cia).toBe('00011');
    expect(statement.banco).toBe('SANTANDER');
    expect(statement.cuenta).toBe('65502559449');
    expect(statement.fechaEstadoCuenta).toBe('2026-04-01');
    expect(statement.saldoInicial).toBeCloseTo(4018173.02, 2);
    expect(statement.saldoFinal).toBeCloseTo(2153.54, 2);
    expect(statement.movimientos).toHaveLength(2);
    expect(statement.movimientos[0].tipoMovimiento).toBe('ABONO');
    expect(statement.movimientos[1].tipoMovimiento).toBe('CARGO');
    expect(statement.movimientos[1].concepto).toContain('TRTT REF 0000000');
  });
});

describe('parseSantanderFile', () => {
  it('normalizes a fixed-width Santander txt export into bank statements', () => {
    const txt = [
      '65502559449     0104202605047465ABONO TRANSFERENCIA SPEI                +000000010289930000040284629502146728AMEXCO SE 9351506317                     124180002346330665                               CITI MEXICO                             014580655025594494  SERVICIOS ESPECIALIZADOS SENDA SA DE CV 124180002346330665  AMERICAN EXPRESS COMPANY MEXICO SADE CV                                 SES051125TR5   AEC810901298   D5802283BB559491              ABONO TRANSFERENCIA SPEI                                                                                                          ',
      '65502559449     0104202612260981PAGO TRANSFERENCIA SPEI                 -000004945000000000000021535409446731TRTT REF 0000000                                                                          BANAMEX                                 002580701381993022  SERVICIOS ESPECIALIZADOS SENDA          00142674065502559449SERVICIOS ESPECIALIZADOS SENDA SA DE CV                                                SES051125TR5   20260401400140BET0000494467310PAGO TRANSFERENCIA SPEI                                                                                                           ',
    ].join('\n');

    const [statement] = parseSantanderFile(txt, { defaultCia: '00011' });

    expect(statement.cia).toBe('00011');
    expect(statement.banco).toBe('SANTANDER');
    expect(statement.cuenta).toBe('65502559449');
    expect(statement.fechaEstadoCuenta).toBe('2026-04-01');
    expect(statement.saldoInicial).toBeCloseTo(4018173.02, 2);
    expect(statement.saldoFinal).toBeCloseTo(2153.54, 2);
    expect(statement.movimientos).toHaveLength(2);
    expect(statement.movimientos[0].referencia).toBe('02146728');
    expect(statement.movimientos[1].tipoMovimiento).toBe('CARGO');
    expect(statement.movimientos[1].concepto).toContain('SERVICIOS ESPECIALIZADOS SENDA');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Cobertura extendida (pineo del comportamiento actual, fixtures inline)
// ─────────────────────────────────────────────────────────────────────────

const CSV_HEADER =
  'Cuenta,Fecha,Hora,Referencia,Descripcion,Concepto,Nombre Beneficiario,Nombre Ordenante,Clave de Rastreo,Cargo/Abono,Importe,Saldo';

function csv(...rows: string[]): string {
  return [CSV_HEADER, ...rows].join('\n');
}

// Renglón TXT de ancho fijo (581 chars). Offsets tomados de TXT_SLICE:
// cuenta [0,11) · fecha [16,24) · hora [24,28) · descripcion [32,72) ·
// importe firmado [72,87) · saldo [87,101) · referencia [101,109) ·
// detalle [109,581).
function pad(value: string, width: number): string {
  return value.padEnd(width, ' ').slice(0, width);
}

function makeTxtLine(overrides: Partial<{
  cuenta: string; fecha: string; hora: string; descripcion: string;
  importe: string; saldo: string; referencia: string; detalle: string;
}> = {}): string {
  const f = {
    cuenta: '65501234567',
    fecha: '15012026',
    hora: '0930',
    descripcion: 'PAGO PROVEEDOR',
    importe: '-0000000250000', // centavos con signo → -2,500.00
    saldo: '0000000750000',    // centavos → 7,500.00
    referencia: 'REF00001',
    detalle: 'DETALLE OPERACION',
    ...overrides,
  };
  const line =
    pad(f.cuenta, 11) +
    pad('', 5) +
    pad(f.fecha, 8) +
    pad(f.hora, 4) +
    pad('', 4) +
    pad(f.descripcion, 40) +
    pad(f.importe, 15) +
    pad(f.saldo, 14) +
    pad(f.referencia, 8) +
    pad(f.detalle, 472);
  expect(line.length).toBe(581);
  return line;
}

describe('parseSantanderCsv — shape y parsing de campos', () => {
  it('parsea un CSV válido: fecha ddmmyyyy → ISO, "+" → ABONO, miles removidos, concepto con dedup', () => {
    const text = csv(
      '65501234567,15/01/2026,0930,1234567,PAGO RECIBIDO,PAGO RECIBIDO,CLIENTE EQUIS SA,,SANTCLAVE,+,"1,500.00","10,500.00"',
    );
    const statements = parseSantanderCsv(text);
    expect(statements).toHaveLength(1);

    const st = statements[0];
    expect(st.banco).toBe('SANTANDER');
    expect(st.nombreBanco).toBe('SANTANDER');
    expect(st.cuenta).toBe('65501234567');
    expect(st.moneda).toBe('MXN');
    expect(st.cia).toBe(''); // sin defaultCia → cia vacía
    expect(st.fechaEstadoCuenta).toBe('2026-01-15');
    expect(st.saldoFinal).toBe(10_500);
    // saldoInicial = saldo reportado − monto firmado del primer movimiento
    expect(st.saldoInicial).toBe(10_500 - 1_500);

    expect(st.movimientos).toHaveLength(1);
    const mov = st.movimientos[0];
    expect(mov.fechaOperacion).toBe('2026-01-15');
    expect(mov.tipoMovimiento).toBe('ABONO');
    expect(mov.importe).toBe(1_500);
    expect(mov.saldo).toBe(10_500);
    expect(mov.referencia).toBe('1234567');
    // Concepto = uniqueJoin(Descripcion, Concepto, Beneficiario, Ordenante,
    // Clave de Rastreo) con dedup — 'PAGO RECIBIDO' aparece UNA vez.
    expect(mov.concepto).toBe('PAGO RECIBIDO · CLIENTE EQUIS SA · SANTCLAVE');
    expect(mov.banco).toBe('SANTANDER');
    expect(mov.moneda).toBe('MXN');
  });

  it('mapea "-" a CARGO y aplica defaultCia a statement y movimientos', () => {
    const text = csv('655099,16/01/2026,1000,REF1,PAGO PROVEEDOR,,,,,-,"2,500.00","8,000.00"');
    const [st] = parseSantanderCsv(text, { defaultCia: '00150' });
    expect(st.cia).toBe('00150');
    expect(st.movimientos[0].cia).toBe('00150');
    expect(st.movimientos[0].tipoMovimiento).toBe('CARGO');
    expect(st.movimientos[0].importe).toBe(2_500);
    // CARGO: saldoInicial = saldo − (−importe) = saldo + importe
    expect(st.saldoInicial).toBe(8_000 + 2_500);
  });

  it('ordena movimientos por fecha+hora y deriva saldoInicial/saldoFinal del primero/último', () => {
    // Renglones fuera de orden cronológico a propósito.
    const text = csv(
      '655011,16/01/2026,0900,R3,TERCERO,,,,,-,"2,500.00","8,000.00"',
      '655011,15/01/2026,1400,R2,SEGUNDO,,,,,-,"1,000.00","9,000.00"',
      '655011,15/01/2026,0900,R1,PRIMERO,,,,,+,"1,500.00","10,500.00"',
    );
    const [st] = parseSantanderCsv(text);
    expect(st.movimientos.map(m => m.referencia)).toEqual(['R1', 'R2', 'R3']);
    // Primero: ABONO 1,500 con saldo 10,500 → saldo inicial 9,000
    expect(st.saldoInicial).toBe(9_000);
    // Último: 16/01 saldo 8,000
    expect(st.saldoFinal).toBe(8_000);
    expect(st.fechaEstadoCuenta).toBe('2026-01-16');
  });

  it('tolera BOM UTF-8 en el header y comillas escapadas / comas dentro de celdas', () => {
    const text =
      '﻿' +
      csv('655022,15/01/2026,0930,R1,"TRANSFERENCIA, SPEI",,"EMPRESA ""X"" SA",,,+,"1,000.00","5,000.00"');
    const [st] = parseSantanderCsv(text);
    expect(st.cuenta).toBe('655022'); // el BOM no rompe el lookup de 'Cuenta'
    expect(st.movimientos[0].concepto).toBe('TRANSFERENCIA, SPEI · EMPRESA "X" SA');
  });

  it('acepta comilla líder estilo Excel y agrupa multi-cuenta en un statement por cuenta', () => {
    const text = csv(
      "'655033,15/01/2026,0900,RA,MOV A,,,,,+,\"1,000.00\",\"2,000.00\"",
      '655044,15/01/2026,0900,RB,MOV B,,,,,-,"500.00","3,000.00"',
    );
    const statements = parseSantanderCsv(text);
    expect(statements).toHaveLength(2);
    const cuentas = statements.map(s => s.cuenta).sort();
    expect(cuentas).toEqual(['655033', '655044']);
  });

  it('salta filas vacías / basura sin reventar', () => {
    const text = [
      CSV_HEADER,
      '', // línea en blanco — descartada por el tokenizador
      ',,,,,,,,,,,', // solo comas — descartada por el tokenizador
      "',',',',',',',',',',','", // celdas que limpian a vacío — saltada en el loop
      '655055,15/01/2026,0900,R1,REAL,,,,,+,"1,000.00","2,000.00"',
      '   ,   ,   ,   ,   ,   ,   ,   ,   ,   ,   ,   ', // whitespace puro
    ].join('\n');
    const [st] = parseSantanderCsv(text);
    expect(st.movimientos).toHaveLength(1);
    expect(st.movimientos[0].concepto).toBe('REAL');
  });

  it('PIN: un Importe negativo en CSV se conserva con signo (no se toma valor absoluto)', () => {
    // A diferencia del path TXT (que hace Math.abs), el path CSV guarda el
    // importe tal cual. Si el banco exportara el importe YA firmado además
    // de la columna Cargo/Abono, el movimiento quedaría con importe negativo
    // y el saldoInicial se calcularía con el signo invertido. Comportamiento
    // actual pineado — ver hallazgos del reporte.
    const text = csv('655066,15/01/2026,0900,R1,CARGO FIRMADO,,,,,-,"-2,500.00","8,000.00"');
    const [st] = parseSantanderCsv(text);
    expect(st.movimientos[0].tipoMovimiento).toBe('CARGO');
    expect(st.movimientos[0].importe).toBe(-2_500); // NO abs
    // computeSaldoInicial: saldo − (−importe) = 8,000 + (−2,500) = 5,500
    expect(st.saldoInicial).toBe(5_500);
  });

  it('rechaza archivo vacío / solo header', () => {
    expect(() => parseSantanderCsv('')).toThrow(/vacío/);
    expect(() => parseSantanderCsv(CSV_HEADER)).toThrow(/vacío/);
  });

  it('rechaza CSV sin columnas requeridas, listándolas', () => {
    const text = ['Cuenta,Fecha,Descripcion,Importe', '655077,15/01/2026,X,100'].join('\n');
    expect(() => parseSantanderCsv(text)).toThrow(/Cargo\/Abono/);
    expect(() => parseSantanderCsv(text)).toThrow(/Saldo/);
  });

  it('rechaza Cargo/Abono, fecha, montos y cuenta inválidos con errores descriptivos', () => {
    expect(() => parseSantanderCsv(csv('655088,15/01/2026,0900,R1,X,,,,,C,"100.00","200.00"')))
      .toThrow(/Cargo\/Abono inválido/);
    expect(() => parseSantanderCsv(csv('655088,15/01/26,0900,R1,X,,,,,+,"100.00","200.00"')))
      .toThrow(/Fecha Santander inválida/);
    expect(() => parseSantanderCsv(csv('655088,15/01/2026,0900,R1,X,,,,,+,abc,"200.00"')))
      .toThrow(/Monto Santander inválido en Importe/);
    expect(() => parseSantanderCsv(csv('SIN-DIGITOS,15/01/2026,0900,R1,X,,,,,+,"100.00","200.00"')))
      .toThrow(/no trae número de cuenta/);
  });
});

describe('parseSantanderTxt — renglón sintético de ancho fijo', () => {
  it('parsea el renglón 581: signo del importe → CARGO, importe abs en centavos/100', () => {
    const [st] = parseSantanderTxt(makeTxtLine(), { defaultCia: '00033' });
    expect(st.cia).toBe('00033');
    expect(st.cuenta).toBe('65501234567');
    expect(st.movimientos).toHaveLength(1);
    const mov = st.movimientos[0];
    expect(mov.fechaOperacion).toBe('2026-01-15');
    expect(mov.tipoMovimiento).toBe('CARGO'); // el '-' del importe manda
    expect(mov.importe).toBe(2_500);          // abs(−250000/100) — TXT sí hace abs
    expect(mov.saldo).toBe(7_500);
    expect(mov.referencia).toBe('REF00001');
    expect(mov.concepto).toBe('PAGO PROVEEDOR · DETALLE OPERACION');
    // saldoInicial = 7,500 − (−2,500) = 10,000
    expect(st.saldoInicial).toBe(10_000);
    expect(st.saldoFinal).toBe(7_500);
  });

  it('rechaza renglones con longitud distinta a 581 y TXT vacío', () => {
    expect(() => parseSantanderTxt('CORTO')).toThrow(/581/);
    expect(() => parseSantanderTxt('')).toThrow(/vacío/);
    expect(() => parseSantanderTxt('\n\n  \n')).toThrow(/vacío/);
  });
});

describe('parseSantanderFile — dispatch de formato', () => {
  it('enruta por la primera línea: con coma → CSV, sin coma → TXT', () => {
    const csvText = csv('655099,15/01/2026,0900,R1,VIA CSV,,,,,+,"100.00","200.00"');
    const fromCsv = parseSantanderFile(csvText);
    expect(fromCsv[0].movimientos[0].concepto).toBe('VIA CSV');

    const fromTxt = parseSantanderFile(makeTxtLine());
    expect(fromTxt[0].movimientos[0].tipoMovimiento).toBe('CARGO');
    expect(fromTxt[0].cuenta).toBe('65501234567');
  });

  it('expone el identificador de formato del archivo', () => {
    expect(SANTANDER_FILE_FORMAT).toBe('SANTANDER ARCHIVO');
  });
});
