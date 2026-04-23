import { describe, expect, it } from 'vitest';
import { parseSantanderCsv } from './santanderCsv';

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
