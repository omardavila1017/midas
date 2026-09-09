import { describe, expect, it } from 'vitest';
import { latestUsableDataDate, summarizeSourceDataFreshness } from './sourceDataFreshness';

// Ancla REAL de la auditoría 2026-09-07: `jde.Antiguedad_Saldos` dejó de cargar
// el 01-sep, así que la factura más reciente del CXP era del 31-ago mientras el
// panel reportaba la consulta del día. 2026-08-31 → 2026-09-07 son 5 días
// hábiles (1-4 de sep + el lunes 7; el 5 y 6 caen en fin de semana).
describe('summarizeSourceDataFreshness', () => {
  it('mide la antigüedad del DATO, no la de la consulta', () => {
    const result = summarizeSourceDataFreshness(['2026-08-28', '2026-08-31'], '2026-09-07');
    expect(result.lastDataDate).toBe('2026-08-31');
    expect(result.businessDaysElapsed).toBe(5);
    expect(result.status).toBe('aging');
  });

  it('una fuente al día sale verde', () => {
    expect(summarizeSourceDataFreshness(['2026-09-04'], '2026-09-07').status).toBe('fresh');
  });

  it('un feed muerto de semanas sale rojo', () => {
    const result = summarizeSourceDataFreshness(['2026-08-13'], '2026-09-07');
    expect(result.status).toBe('stale');
    expect(result.businessDaysElapsed).toBeGreaterThan(10);
  });

  it('sin fechas usables reporta no-data en vez de inventar frescura', () => {
    expect(summarizeSourceDataFreshness([], '2026-09-07').status).toBe('no-data');
    expect(summarizeSourceDataFreshness(['', undefined, 'no-es-fecha'], '2026-09-07'))
      .toEqual({ lastDataDate: null, businessDaysElapsed: null, status: 'no-data' });
  });

  // Una factura post-fechada NO prueba que la fuente siga cargando: tomarla
  // como máximo pintaría de verde justo el feed muerto que esto vino a delatar.
  it('ignora las fechas futuras al elegir el máximo', () => {
    expect(latestUsableDataDate(['2026-12-31', '2026-08-31'], '2026-09-07')).toBe('2026-08-31');
    expect(summarizeSourceDataFreshness(['2026-12-31', '2026-08-31'], '2026-09-07').status)
      .toBe('aging');
    // Sólo futuras: no hay evidencia de carga reciente.
    expect(summarizeSourceDataFreshness(['2026-12-31'], '2026-09-07').status).toBe('no-data');
  });

  it('tolera fechas con hora (recorta a día)', () => {
    expect(latestUsableDataDate(['2026-09-04T00:00:00.000'], '2026-09-07')).toBe('2026-09-04');
  });

  // El barrido descarta por `day <= latest` ANTES de validar el formato (los
  // datasets grandes llegan a cientos de miles de filas). El atajo sólo es
  // legítimo si el resultado NO depende del orden de entrada ni deja pasar
  // basura que ordene por encima del máximo válido.
  describe('el atajo de barrido no cambia el resultado', () => {
    it('descarta el DD-MM-YYYY de Antiguedad_Saldos aunque nada lo corte por futuro', () => {
      // `jde.Antiguedad_Saldos` es la única tabla del espejo que guarda sus
      // fechas como `DD-MM-YYYY` en varchar (medido 2026-09-07). Mide 10 chars
      // y ordena por encima de una ISO del mismo año ('3' > '2'), así que pasa
      // los dos cortes baratos: el regex es la ÚNICA defensa. Con un `today`
      // lejano el corte de futuro no lo alcanza, y sin el regex el máximo
      // saldría '31-08-2026' — una fecha que ningún consumidor puede leer.
      expect(latestUsableDataDate(['2026-09-04', '31-08-2026'], '9999-12-31')).toBe('2026-09-04');
      // Y también cuando llega PRIMERO, sin un `latest` que lo frene.
      expect(latestUsableDataDate(['31-08-2026', '2026-09-04'], '9999-12-31')).toBe('2026-09-04');
    });

    it('es indiferente al orden de entrada', () => {
      const values = ['', '2026-08-31', '2026-12-31', '2026-09-04', 'N/A', '2026-08-28', '31-08-2026'];
      const expected = '2026-09-04';
      expect(latestUsableDataDate(values, '2026-09-07')).toBe(expected);
      expect(latestUsableDataDate([...values].reverse(), '2026-09-07')).toBe(expected);
      expect(latestUsableDataDate([...values].sort(), '2026-09-07')).toBe(expected);
    });
  });
});
