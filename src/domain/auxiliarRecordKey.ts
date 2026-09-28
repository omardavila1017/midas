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
function baseKey(rec: AuxiliarContableRecord): string {
  const cents = Math.round((Number.isFinite(rec.importe) ? rec.importe : 0) * 100);
  // `fechaCarga` NO va en la llave, a propósito: la misma línea reinsertada por
  // otra carga DEBE colapsar con su original. Lo que separa las líneas
  // repetidas legítimas de UNA carga es el ordinal (`markDuplicateOccurrences`),
  // que se numera POR CARGA. Ver el docblock de esa función.
  return `${rec.cia}::${rec.idCuenta}::${rec.tipoDocto}::${rec.noDocto}::${cents}::${rec.fechaContable ?? ''}::${rec.concepto ?? ''}`;
}

export function auxiliarRecordKey(rec: AuxiliarContableRecord): string {
  // La primera ocurrencia nunca lleva ordinal, así que toda fila no repetida
  // conserva una llave estable (también es el id del `auxiliar-historic:`).
  return rec.occurrence ? `${baseKey(rec)}::#${rec.occurrence}` : baseKey(rec);
}

/**
 * Numera las ocurrencias repetidas de una línea DENTRO DE CADA CARGA de un
 * payload. La regla que resulta es la medida en la BD (2026-09-24, IVA
 * acreditable `Ano 26` P<=8 sin cía 33):
 *
 *   • DENTRO de una carga, las repeticiones son líneas reales (el origen no
 *     expone número de línea): 4,416 grupos difieren en factura/proveedor/pago.
 *     El ordinal las separa → se conservan todas.
 *   • ENTRE cargas, la misma línea con el mismo ordinal colisiona y colapsa
 *     (last-wins). Eso cancela las REINSERCIONES del origen: el 2026-05-28 el
 *     mes de abril se cargó dos veces (01:07 y 01:16), duplicando 24,942 líneas
 *     de IVA y 26,493 de bancos. Con esta regla el acreditable a agosto es
 *     $135,045,844.80; sin ella, $151,741,050.81 (abril contado dos veces).
 *
 * Por eso el sello se compara COMPLETO (con hora): las dos corridas de abril
 * son del mismo día.
 *
 * SIN sello NO se numera (la fila queda sin ordinal y colapsa por contenido).
 * No hay forma de separar la reinserción de una línea real, y de los dos
 * errores posibles éste es el menor, medido: en IVA da $126.5M contra $135.0M
 * correctos (conservar todo daría $151.7M), y en la conciliación conservar
 * metería las 41,863 líneas de abril reinsertadas — $506.7M de ellas con marca
 * 'R', que cuentan como cruzadas sin consumir banco y doblarían el histórico
 * de abril en `reconciledByCompanyMonth`.
 *
 * Estable entre refetches (un día vuelve con las mismas filas) e idempotente
 * (`baseKey` ignora `occurrence`).
 */
export function markDuplicateOccurrences(
  records: AuxiliarContableRecord[],
): AuxiliarContableRecord[] {
  const seen = new Map<string, number>();
  for (const rec of records) {
    const stamp = (rec.fechaCarga ?? '').trim();
    if (!stamp) { rec.occurrence = undefined; continue; }
    const key = `${baseKey(rec)}|${stamp}`;
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    rec.occurrence = n > 0 ? n : undefined;
  }
  return records;
}

/**
 * ¿El payload trae el sello de carga? Sin él el dedup colapsa por contenido
 * (ver `markDuplicateOccurrences`) y el fetcher lo confiesa en Salud de datos.
 */
export function hasLoadStamp(records: readonly AuxiliarContableRecord[]): boolean {
  for (const r of records) if ((r.fechaCarga ?? '').trim()) return true;
  return false;
}
