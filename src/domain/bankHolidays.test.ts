import { describe, it, expect } from 'vitest';
import {
  isBankHoliday,
  isNonOperatingDay,
  isWeekend,
  MX_BANK_HOLIDAYS,
} from './bankHolidays';
import { resolveRealPaymentDate, toISODate } from './calendar';
import type { PaymentDayPattern } from './types';

const utc = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe('bankHolidays', () => {
  it('marca todos los feriados bancarios MX 2026 como inhábiles', () => {
    for (const iso of MX_BANK_HOLIDAYS) {
      expect(isBankHoliday(utc(iso))).toBe(true);
    }
  });

  it('incluye exactamente los 6 días inhábiles del calendario operativo', () => {
    const expected = [
      '2026-05-01',
      '2026-09-16',
      '2026-11-02',
      '2026-11-16',
      '2026-12-12',
      '2026-12-25',
    ];
    expect(MX_BANK_HOLIDAYS.size).toBe(expected.length);
    for (const iso of expected) expect(MX_BANK_HOLIDAYS.has(iso)).toBe(true);
  });

  it('NO marca como inhábiles días que no están en la lista oficial', () => {
    expect(isBankHoliday(utc('2026-01-01'))).toBe(false);
    expect(isBankHoliday(utc('2026-04-02'))).toBe(false);
    expect(isBankHoliday(utc('2026-04-03'))).toBe(false);
    expect(isBankHoliday(utc('2026-03-16'))).toBe(false);
  });

  it('detecta sábados y domingos como fin de semana', () => {
    expect(isWeekend(utc('2026-06-06'))).toBe(true); // sábado
    expect(isWeekend(utc('2026-06-07'))).toBe(true); // domingo
    expect(isWeekend(utc('2026-06-05'))).toBe(false); // viernes
  });

  it('isNonOperatingDay agrupa fines de semana y feriados', () => {
    expect(isNonOperatingDay(utc('2026-06-06'))).toBe(true);
    expect(isNonOperatingDay(utc('2026-05-01'))).toBe(true);
    expect(isNonOperatingDay(utc('2026-06-05'))).toBe(false);
  });
});

describe('resolveRealPaymentDate: pago en inhábil → siguiente día hábil', () => {
  it('DOM[16] noviembre: 16-nov es inhábil → pago el martes 17-nov', () => {
    const pattern: PaymentDayPattern = { kind: 'DOM', day: 16 };
    const real = resolveRealPaymentDate(utc('2026-11-15'), pattern, 'Mensual');
    expect(toISODate(real)).toBe('2026-11-17');
  });

  it('DOW[Fri] que cae en 1-may → pago el lunes 4-may', () => {
    const pattern: PaymentDayPattern = { kind: 'DOW', days: [5] };
    const real = resolveRealPaymentDate(utc('2026-04-27'), pattern, 'Semanal');
    expect(toISODate(real)).toBe('2026-05-04');
  });

  it('DOM[25] diciembre: navidad → pago el lunes 28-dic', () => {
    const pattern: PaymentDayPattern = { kind: 'DOM', day: 25 };
    const real = resolveRealPaymentDate(utc('2026-12-20'), pattern, 'Mensual');
    expect(toISODate(real)).toBe('2026-12-28');
  });

  it('ANY teórica en sábado → siguiente lunes', () => {
    const pattern: PaymentDayPattern = { kind: 'ANY' };
    const real = resolveRealPaymentDate(utc('2026-06-06'), pattern, 'Mensual');
    expect(toISODate(real)).toBe('2026-06-08');
  });

  it('DOM[1] febrero (Sun feb 1) → lunes 2-feb (no es inhábil en lista del usuario)', () => {
    const pattern: PaymentDayPattern = { kind: 'DOM', day: 1 };
    const real = resolveRealPaymentDate(utc('2026-02-01'), pattern, 'Mensual');
    expect(toISODate(real)).toBe('2026-02-02');
  });

  it('DOW[Fri] no afectado por inhábil regresa el viernes original', () => {
    const pattern: PaymentDayPattern = { kind: 'DOW', days: [5] };
    const real = resolveRealPaymentDate(utc('2026-06-05'), pattern, 'Semanal');
    expect(toISODate(real)).toBe('2026-06-05');
  });
});
