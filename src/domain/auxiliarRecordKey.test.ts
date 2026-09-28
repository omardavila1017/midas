import { describe, expect, it } from 'vitest';
import type { AuxiliarContableRecord } from '../services/jdeTypes';
import { auxiliarRecordKey, hasLoadStamp, markDuplicateOccurrences } from './auxiliarRecordKey';

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
 * Regla medida en la BD (2026-09-24, IVA acreditable `Ano 26` P<=8 sin cía 33):
 * conservar las repeticiones DENTRO de una carga (líneas reales — el origen no
 * expone número de línea) y colapsar la misma línea entre cargas (reinserción:
 * abril-2026 se cargó dos veces el 2026-05-28, 01:07 y 01:16). Resultado
 * $135,045,844.80; sólo abril cambia respecto a no dedupear ($151,741,050.81).
 * Las cifras previas de este bloque incluían a Multicarga y están retiradas.
 */
describe('auxiliarRecordKey + markDuplicateOccurrences — sello de carga', () => {
  it('la misma línea de dos cargas distintas COLAPSA (reinserción)', () => {
    const rows = markDuplicateOccurrences([
      linea({ fechaCarga: '2026-05-28T01:07:43.187' }),
      linea({ fechaCarga: '2026-05-28T01:16:43.690' }),
    ]);
    expect(auxiliarRecordKey(rows[0])).toBe(auxiliarRecordKey(rows[1]));
  });

  it('dos repeticiones de UNA carga se CONSERVAN (líneas reales)', () => {
    const rows = markDuplicateOccurrences([
      linea({ fechaCarga: '2026-05-28T01:07:43.187' }),
      linea({ fechaCarga: '2026-05-28T01:07:43.187' }),
    ]);
    expect(auxiliarRecordKey(rows[0])).not.toBe(auxiliarRecordKey(rows[1]));
  });

  it('entre cargas sobrevive el MÁXIMO de repeticiones de una sola carga', () => {
    const rows = markDuplicateOccurrences([
      linea({ fechaCarga: 'A' }), linea({ fechaCarga: 'A' }),
      linea({ fechaCarga: 'B' }),
    ]);
    expect(new Set(rows.map(auxiliarRecordKey)).size).toBe(2);
  });

  it('el sello no entra a la llave: una fila no repetida conserva llave estable', () => {
    expect(auxiliarRecordKey(linea({ fechaCarga: 'A' }))).toBe(auxiliarRecordKey(linea({})));
  });

  it('sin sello NO numera: colapsa por contenido (evita doblar abril-2026)', () => {
    const rows = markDuplicateOccurrences([linea({}), linea({})]);
    expect(new Set(rows.map(auxiliarRecordKey)).size).toBe(1);
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
