import type { AuxiliarContableRecord } from '../services/jdeTypes';

/**
 * Identidad de UNA LÍNEA del libro mayor. FUENTE ÚNICA — la consumen el dedup
 * del fetcher, los tres merges de `AppCore` y el `glKey` de
 * `auxiliarReconciliationEngine`, que además viaja como **id del movimiento**
 * `auxiliar-historic:` de MOTOR 1. Las cinco DEBEN coincidir.
 *
 * POR QUÉ NO BASTA `cia::idCuenta::noDocto::tipoDocto` (la llave anterior):
 * un DOCUMENTO contable tiene VARIAS líneas, así que esa llave identifica el
 * documento, no la línea. Medido en `jde.Auxiliar_Contable` (objetos 1010-1020,
 * `Ano 26`, 354,359 filas): dejaba 56,415 llaves, o sea **descartaba ~180,000
 * filas — más de la mitad del mayor**, y **20,439 de esos grupos caían dentro
 * de UNA MISMA carga** (no eran reinserción de la fuente): 229,530 filas,
 * **$1,356.9M**. Dos casos verificados fila por fila:
 *
 *   • `JX 10098` (cía 00001) es un par de REVERSA: +$942,997.03 y −$942,997.03.
 *     Conservar una sola dejaba un fantasma de ±$943k donde debía netear cero.
 *   • `JT 47200` son la COMISIÓN (−$515.10) y su IVA (−$82.42) del mismo
 *     movimiento bancario. El dedup borraba una de las dos.
 *
 * Con `importe + fechaContable + concepto` la llave sube a 236,929 y ya no
 * puede colapsar dos líneas de distinto importe. Lo que sigue colapsando son
 * filas idénticas en TODO campo que el mapper lee — la fuente no expone número
 * de línea, así que ésas son indistinguibles desde aquí; el dedup sigue siendo
 * necesario porque la tabla NO trunca entre cargas y reinserta cada fila.
 *
 * `importe` va en CENTAVOS enteros: interpolar un float mete la representación
 * de JS en la llave (`0.1+0.2`), y dos corridas podrían formatearlo distinto.
 */
export function auxiliarRecordKey(rec: AuxiliarContableRecord): string {
  const cents = Math.round((Number.isFinite(rec.importe) ? rec.importe : 0) * 100);
  // `fechaCarga` es lo que separa una REINSERCIÓN de una línea repetida
  // legítima. Va al final y vacío cuando el SP no lo manda, así que la llave
  // degrada a la forma previa — pero en ese caso el fetcher NO dedupea
  // (ver `fetchAuxiliarContableRange`), porque sin el sello colapsar destruye
  // renglones reales.
  return `${rec.cia}::${rec.idCuenta}::${rec.tipoDocto}::${rec.noDocto}::${cents}::${rec.fechaContable ?? ''}::${rec.concepto ?? ''}::${rec.fechaCarga ?? ''}`;
}

/**
 * ¿El payload trae el sello de carga? Si NINGUNA fila lo trae, el dedup por
 * contenido no puede distinguir una reinserción de un renglón repetido real y
 * **no debe correr**: medido contra la cifra de Fiscal, colapsar sin el sello
 * borra $17.2M de acreditable real (−11.5%), mientras que no colapsar deja
 * ~$9.9M de reinserción (+6.1%). Entre destruir dinero real y arrastrar
 * duplicados de la fuente, se arrastra — y se confiesa.
 */
export function hasLoadStamp(records: readonly AuxiliarContableRecord[]): boolean {
  for (const r of records) if ((r.fechaCarga ?? '').trim()) return true;
  return false;
}
