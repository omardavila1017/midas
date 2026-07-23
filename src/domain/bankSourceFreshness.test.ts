import { describe, expect, it } from 'vitest';
import {
  countBusinessDaysBetween,
  freshnessStatusFor,
  summarizeManualBankFreshness,
  MANUAL_BANK_FRESHNESS_THRESHOLDS,
} from './bankSourceFreshness';
import type { BankAccountStatement, BankStatementLine } from '../services/jdeTypes';

function mov(fechaOperacion: string, patch: Partial<BankStatementLine> = {}): BankStatementLine {
  return {
    cia: '00001',
    banco: 'ACME',
    cuenta: '000000000',
    moneda: 'MXN',
    fechaOperacion,
    referencia: 'R1',
    concepto: 'MOV',
    tipoMovimiento: 'ABONO',
    importe: 100,
    saldo: 100,
    ...patch,
  };
}

function stmt(patch: Partial<BankAccountStatement> & Pick<BankAccountStatement, 'banco' | 'cuenta' | 'movimientos'>): BankAccountStatement {
  return {
    cia: '00001',
    moneda: 'MXN',
    fechaEstadoCuenta: '2026-07-01',
    nombreBanco: patch.banco,
    ...patch,
  };
}

describe('countBusinessDaysBetween — reloj inyectado, calendario bancario MX', () => {
  it('mismo día o rango invertido → 0', () => {
    expect(countBusinessDaysBetween('2026-07-22', '2026-07-22')).toBe(0);
    expect(countBusinessDaysBetween('2026-07-22', '2026-07-20')).toBe(0);
  });

  it('salta fin de semana: viernes → lunes = 1 día hábil', () => {
    expect(countBusinessDaysBetween('2026-07-10', '2026-07-13')).toBe(1);
  });

  it('salta festivo bancario (16-sep Independencia)', () => {
    expect(countBusinessDaysBetween('2026-09-15', '2026-09-17')).toBe(1);
  });

  it('fecha inválida → null', () => {
    expect(countBusinessDaysBetween('no-fecha', '2026-07-22')).toBeNull();
  });

  it('ancla de la auditoría BD 22-jul: Bajío 08-jul → 10 hábiles; Santander 04-jun → 34', () => {
    expect(countBusinessDaysBetween('2026-07-08', '2026-07-22')).toBe(10);
    expect(countBusinessDaysBetween('2026-06-04', '2026-07-22')).toBe(34);
  });
});

describe('freshnessStatusFor — umbrales configurables', () => {
  it('verde ≤3, amarillo 4-10, rojo >10 (defaults)', () => {
    expect(freshnessStatusFor(0)).toBe('fresh');
    expect(freshnessStatusFor(3)).toBe('fresh');
    expect(freshnessStatusFor(4)).toBe('aging');
    expect(freshnessStatusFor(10)).toBe('aging');
    expect(freshnessStatusFor(11)).toBe('stale');
    expect(freshnessStatusFor(null)).toBe('no-data');
  });

  it('respeta umbrales alternativos', () => {
    const t = { freshMaxBusinessDays: 1, agingMaxBusinessDays: 2 };
    expect(freshnessStatusFor(2, t)).toBe('aging');
    expect(freshnessStatusFor(3, t)).toBe('stale');
  });
});

describe('summarizeManualBankFreshness', () => {
  const today = '2026-07-22';

  it('reporta por banco la fecha del último movimiento y los días hábiles', () => {
    const rows = summarizeManualBankFreshness(
      [
        stmt({ banco: 'BANBAJIO', nombreBanco: 'BANCO DEL BAJIO', cuenta: '000000001', movimientos: [mov('2026-07-06'), mov('2026-07-08')] }),
        stmt({ banco: 'SANTANDER', cuenta: '000000002', movimientos: [mov('2026-06-04')] }),
      ],
      today,
    );
    const bajio = rows.find((r) => r.source === 'bajio')!;
    expect(bajio.lastMovementDate).toBe('2026-07-08');
    expect(bajio.businessDaysElapsed).toBe(10);
    expect(bajio.status).toBe('aging');

    const santander = rows.find((r) => r.source === 'santander')!;
    expect(santander.lastMovementDate).toBe('2026-06-04');
    expect(santander.businessDaysElapsed).toBe(34);
    expect(santander.status).toBe('stale');
  });

  it('banco sin statements cargados → no-data', () => {
    const rows = summarizeManualBankFreshness(
      [stmt({ banco: 'BANBAJIO', cuenta: '000000001', movimientos: [mov('2026-07-21')] })],
      today,
    );
    expect(rows.find((r) => r.source === 'bajio')!.status).toBe('fresh');
    const santander = rows.find((r) => r.source === 'santander')!;
    expect(santander.status).toBe('no-data');
    expect(santander.lastMovementDate).toBeNull();
    expect(santander.accounts).toEqual([]);
  });

  it('detalle por cuenta: una cuenta rezagada no se esconde tras la fresca', () => {
    const rows = summarizeManualBankFreshness(
      [
        stmt({ banco: 'BANBAJIO', cuenta: '000000001', movimientos: [mov('2026-07-21', { cuenta: '000000001' })] }),
        stmt({ banco: 'BANBAJIO', cuenta: '000000009', movimientos: [mov('2026-06-04', { cuenta: '000000009' })] }),
      ],
      today,
    );
    const bajio = rows.find((r) => r.source === 'bajio')!;
    // Agregado del banco = carga más reciente…
    expect(bajio.status).toBe('fresh');
    // …pero la cuenta rezagada sale roja en el detalle.
    const rezagada = bajio.accounts.find((a) => a.cuenta === '000000009')!;
    expect(rezagada.status).toBe('stale');
    expect(rezagada.businessDaysElapsed).toBe(34);
  });

  it('fecha futura (error de captura) → stale, nunca verde', () => {
    const rows = summarizeManualBankFreshness(
      [stmt({ banco: 'SANTANDER', cuenta: '000000002', movimientos: [mov('2026-08-01')] })],
      today,
    );
    expect(rows.find((r) => r.source === 'santander')!.status).toBe('stale');
  });

  it('statement sin movimientos cae a fechaEstadoCuenta', () => {
    const rows = summarizeManualBankFreshness(
      [stmt({ banco: 'BANBAJIO', cuenta: '000000001', movimientos: [], fechaEstadoCuenta: '2026-07-20' })],
      today,
    );
    const bajio = rows.find((r) => r.source === 'bajio')!;
    expect(bajio.lastMovementDate).toBe('2026-07-20');
    expect(bajio.status).toBe('fresh');
  });

  it('los umbrales default son los documentados (3/10)', () => {
    expect(MANUAL_BANK_FRESHNESS_THRESHOLDS).toEqual({ freshMaxBusinessDays: 3, agingMaxBusinessDays: 10 });
  });
});
