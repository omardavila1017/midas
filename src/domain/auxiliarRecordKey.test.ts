import { describe, expect, it } from 'vitest';
import type { AuxiliarContableRecord } from '../services/jdeTypes';
import { auxiliarRecordKey, hasLoadStamp } from './auxiliarRecordKey';

function linea(over: Partial<AuxiliarContableRecord>): AuxiliarContableRecord {
  return {
    cia: '00001',
    idCuenta: '01256665',
    cuentaObjeto: '1020',
    tipoDocto: 'JX',
    noDocto: 10098,
    importe: 942_997.03,
    fechaContable: '2026-09-01',
    concepto: 'Pérd/gan no realizadas',
    ...over,
  } as AuxiliarContableRecord;
}

/**
 * La llave anterior era por DOCUMENTO (`cia::idCuenta::noDocto::tipoDocto`) y
 * un documento contable tiene VARIAS líneas. Medido en `jde.Auxiliar_Contable`
 * (objetos 1010-1020, `Ano 26`): descartaba ~180,000 de 354,359 filas, y 20,439
 * de esos grupos caían dentro de UNA MISMA carga — $1,356.9M.
 */
describe('auxiliarRecordKey — identidad de LÍNEA, no de documento', () => {
  it('separa el par de REVERSA del mismo documento (caso real JX 10098)', () => {
    const cargo = linea({ importe: 942_997.03 });
    const reversa = linea({ importe: -942_997.03 });
    // Con la llave vieja quedaba UNA sola y sobrevivía un fantasma de ±$943k
    // donde el par debía netear cero.
    expect(auxiliarRecordKey(cargo)).not.toBe(auxiliarRecordKey(reversa));
  });

  it('separa la comisión de su IVA en el mismo documento (caso real JT 47200)', () => {
    const comision = linea({ tipoDocto: 'JT', noDocto: 47200, importe: -515.10, concepto: 'COMISION ENV TR: 5720963-01' });
    const iva = linea({ tipoDocto: 'JT', noDocto: 47200, importe: -82.42, concepto: 'I.V.A COM ENV  : 5720963-01' });
    expect(auxiliarRecordKey(comision)).not.toBe(auxiliarRecordKey(iva));
  });

  it('separa dos líneas que sólo difieren en el concepto', () => {
    expect(auxiliarRecordKey(linea({ concepto: 'A' })))
      .not.toBe(auxiliarRecordKey(linea({ concepto: 'B' })));
  });

  it('separa el mismo importe asentado en fechas contables distintas', () => {
    expect(auxiliarRecordKey(linea({ fechaContable: '2026-08-31' })))
      .not.toBe(auxiliarRecordKey(linea({ fechaContable: '2026-09-01' })));
  });

  /**
   * El dedup SIGUE siendo necesario: la tabla no trunca entre cargas y
   * reinserta cada fila. Una reinserción byte-idéntica debe colapsar.
   */
  it('COLAPSA la reinserción byte-idéntica de la misma línea', () => {
    expect(auxiliarRecordKey(linea({}))).toBe(auxiliarRecordKey(linea({})));
  });

  /**
   * El importe va en centavos enteros: interpolar el float mete la
   * representación de JS en la llave y dos corridas podrían formatearlo
   * distinto para el mismo dinero.
   */
  it('normaliza el importe a centavos enteros', () => {
    expect(auxiliarRecordKey(linea({ importe: 0.1 + 0.2 }))).toBe(auxiliarRecordKey(linea({ importe: 0.3 })));
  });

  it('la cía participa: la misma línea en otra compañía es otra línea', () => {
    expect(auxiliarRecordKey(linea({}))).not.toBe(auxiliarRecordKey(linea({ cia: '00011' })));
  });
});

/**
 * El sello de carga es lo único que separa una REINSERCIÓN del espejo de un
 * renglón repetido legítimo del mismo documento. Calibrado contra la cifra
 * autoritativa de Fiscal — IVA acreditable acumulado a agosto 2026 =
 * $154,099,012 (José Luis Gallegos):
 *
 *   · colapsar sólo dentro de una misma carga → $153,649,595  (−0.29%)  ✅
 *   · colapsar también entre cargas          → $136,379,250  (−11.5%)
 *   · no colapsar nada                        → $163,551,205  (+6.1%)
 *   · la llave por DOCUMENTO (lo previo)      →  ~$85,715,368 (−44%)
 */
describe('auxiliarRecordKey — sello de carga', () => {
  it('separa la misma línea traída en dos cargas distintas', () => {
    const a = linea({ fechaCarga: '2026-09-17' });
    const b = linea({ fechaCarga: '2026-09-18' });
    expect(auxiliarRecordKey(a)).not.toBe(auxiliarRecordKey(b));
  });

  it('COLAPSA el duplicado dentro de la MISMA carga', () => {
    expect(auxiliarRecordKey(linea({ fechaCarga: '2026-09-17' })))
      .toBe(auxiliarRecordKey(linea({ fechaCarga: '2026-09-17' })));
  });

  it('sin sello, la llave degrada a la forma previa (no inventa separación)', () => {
    expect(auxiliarRecordKey(linea({}))).toBe(auxiliarRecordKey(linea({})));
  });
});

describe('hasLoadStamp', () => {
  it('detecta el sello aunque sólo una fila lo traiga', () => {
    expect(hasLoadStamp([linea({}), linea({ fechaCarga: '2026-09-17' })])).toBe(true);
  });

  it('es false cuando ninguna fila lo trae — ahí el fetcher NO debe dedupear', () => {
    expect(hasLoadStamp([linea({}), linea({ importe: 1 })])).toBe(false);
  });

  it('ignora un sello en blanco', () => {
    expect(hasLoadStamp([linea({ fechaCarga: '   ' })])).toBe(false);
  });
});
