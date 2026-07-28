import { describe, it, expect } from 'vitest';
import {
  parsePaymentDay,
  detectsFactoraje,
  expandCc13PaymentDay,
  parseCc13PaymentDay,
} from './parsePaymentDay';

describe('parsePaymentDay — días de la semana', () => {
  it('parsea un día simple, tolerante a mayúsculas, acentos y espacios', () => {
    expect(parsePaymentDay('Viernes')).toEqual({ kind: 'DOW', days: [5] });
    expect(parsePaymentDay('  MIÉRCOLES  ')).toEqual({ kind: 'DOW', days: [3] });
    expect(parsePaymentDay('sábado')).toEqual({ kind: 'DOW', days: [6] });
    expect(parsePaymentDay('domingo')).toEqual({ kind: 'DOW', days: [0] });
  });

  it('parsea listas de días ("Miercoles y Jueves") ordenadas y sin duplicados', () => {
    expect(parsePaymentDay('Miercoles y Jueves')).toEqual({ kind: 'DOW', days: [3, 4] });
    expect(parsePaymentDay('Jueves y miércoles')).toEqual({ kind: 'DOW', days: [3, 4] });
    expect(parsePaymentDay('lunes y LUNES')).toEqual({ kind: 'DOW', days: [1] });
  });

  it('los decoradores de frecuencia/factoraje se descartan sin perder el día', () => {
    expect(parsePaymentDay('Jueves-Quincenal')).toEqual({ kind: 'DOW', days: [4] });
    expect(parsePaymentDay('Factoraje-Viernes')).toEqual({ kind: 'DOW', days: [5] });
    expect(parsePaymentDay('Viernes mensual')).toEqual({ kind: 'DOW', days: [5] });
  });
});

describe('parsePaymentDay — patrones ANY', () => {
  it('"cualquier día", "semanal", "Factoraje" solo y "1 vez al mes" → ANY', () => {
    expect(parsePaymentDay('cualquier día de la semana')).toEqual({ kind: 'ANY' });
    expect(parsePaymentDay('cualquier dia')).toEqual({ kind: 'ANY' });
    expect(parsePaymentDay('semanal')).toEqual({ kind: 'ANY' });
    expect(parsePaymentDay('Factoraje')).toEqual({ kind: 'ANY' });
    expect(parsePaymentDay('1 vez al mes')).toEqual({ kind: 'ANY' });
  });

  it('una cadena que solo trae decoradores (sin día) también cae a ANY', () => {
    expect(parsePaymentDay('quincenal')).toEqual({ kind: 'ANY' });
    expect(parsePaymentDay('al vencimiento')).toEqual({ kind: 'ANY' });
  });
});

describe('parsePaymentDay — días del mes', () => {
  it('"dia 16 del mes" / "día 16" → DOM[16]', () => {
    expect(parsePaymentDay('dia 16 del mes')).toEqual({ kind: 'DOM', day: 16 });
    expect(parsePaymentDay('día 16')).toEqual({ kind: 'DOM', day: 16 });
  });

  it('"10 y 25" → DOM_LIST ordenada y deduplicada', () => {
    expect(parsePaymentDay('10 y 25')).toEqual({ kind: 'DOM_LIST', days: [10, 25] });
    expect(parsePaymentDay('25 y 10 de cada mes')).toEqual({ kind: 'DOM_LIST', days: [10, 25] });
  });

  it('"entre 15 y 20 de cada mes" expande el rango completo', () => {
    expect(parsePaymentDay('entre 15 y 20 de cada mes')).toEqual({
      kind: 'DOM_LIST',
      days: [15, 16, 17, 18, 19, 20],
    });
  });

  it('frontera numérica: día 31 vale; 0 y 32 no son días del mes → null', () => {
    expect(parsePaymentDay('dia 31')).toEqual({ kind: 'DOM', day: 31 });
    expect(parsePaymentDay('dia 0')).toBeNull();
    expect(parsePaymentDay('dia 32')).toBeNull();
  });
});

describe('parsePaymentDay — ordinales del mes', () => {
  it('"Primer Viernes de mes" → NTH_DOW[1, Vie]; "Ultimo Viernes" → NTH_DOW[-1, Vie]', () => {
    expect(parsePaymentDay('Primer Viernes de mes')).toEqual({ kind: 'NTH_DOW', nth: 1, day: 5 });
    expect(parsePaymentDay('Ultimo Viernes')).toEqual({ kind: 'NTH_DOW', nth: -1, day: 5 });
    expect(parsePaymentDay('Última viernes')).toEqual({ kind: 'NTH_DOW', nth: -1, day: 5 });
  });

  it('"Segundo y Cuarto Jueves" → NTH_DOW_SET[[2,4], Jue]', () => {
    expect(parsePaymentDay('Segundo y Cuarto Jueves')).toEqual({
      kind: 'NTH_DOW_SET',
      nths: [2, 4],
      day: 4,
    });
  });

  it('semanas del mes: "1er y 3er semana" → WOM[1,3]; "ultima" ordena al final', () => {
    expect(parsePaymentDay('1er y 3er semana')).toEqual({ kind: 'WOM', weeks: [1, 3] });
    expect(parsePaymentDay('1a y ultima semana del mes')).toEqual({ kind: 'WOM', weeks: [1, -1] });
  });
});

describe('parsePaymentDay — entradas inválidas', () => {
  it('vacío o texto no reconocible → null (nunca adivina)', () => {
    expect(parsePaymentDay('')).toBeNull();
    expect(parsePaymentDay('pago inmediato')).toBeNull();
    expect(parsePaymentDay('???')).toBeNull();
  });
});

describe('detectsFactoraje', () => {
  it('detecta factoraje en cualquier posición y case; false cuando no aparece', () => {
    expect(detectsFactoraje('Factoraje-Viernes')).toBe(true);
    expect(detectsFactoraje('FACTORAJE')).toBe(true);
    expect(detectsFactoraje('Viernes')).toBe(false);
  });
});

describe('expandCc13PaymentDay', () => {
  it('expande claves cortas CC13 (trim + case-insensitive, con y sin acento)', () => {
    expect(expandCc13PaymentDay('VIE')).toBe('viernes');
    expect(expandCc13PaymentDay(' lun ')).toBe('lunes');
    expect(expandCc13PaymentDay('MIÉ')).toBe('miercoles');
    expect(expandCc13PaymentDay('SÁB')).toBe('sabado');
  });

  it('cadenas completas o desconocidas pasan tal cual', () => {
    expect(expandCc13PaymentDay('Viernes')).toBe('Viernes');
    expect(expandCc13PaymentDay('XYZ')).toBe('XYZ');
  });
});

describe('parseCc13PaymentDay', () => {
  it('parsea la clave corta y el nombre completo del API', () => {
    expect(parseCc13PaymentDay('VIE')).toEqual({ kind: 'DOW', days: [5] });
    expect(parseCc13PaymentDay('Viernes')).toEqual({ kind: 'DOW', days: [5] });
  });

  it('rechaza claves numéricas del catálogo (no son un día del mes) y vacíos', () => {
    // "027" es Clave_Dia_Pago_CC13 — parsePaymentDay la confundiría con DOM.
    expect(parseCc13PaymentDay('027')).toBeNull();
    expect(parseCc13PaymentDay('7')).toBeNull();
    expect(parseCc13PaymentDay('')).toBeNull();
    expect(parseCc13PaymentDay('   ')).toBeNull();
    expect(parseCc13PaymentDay(null)).toBeNull();
    expect(parseCc13PaymentDay(undefined)).toBeNull();
  });
});
