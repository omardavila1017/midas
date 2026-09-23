import type { PagoProveedorRecord } from '../services/jdeTypes';

/**
 * Identidad de UN pago a proveedor. FUENTE ÚNICA — la consumen el dedup del
 * fetcher, los dos merges de `AppCore`, el set de pagos internos del motor de
 * conciliación y la llave de display/foco de la pestaña Pagos. Las cinco DEBEN
 * coincidir: si el dedup conserva dos pagos que la llave de display colapsa, el
 * segundo desaparece igual, sólo que más tarde.
 *
 * POR QUÉ CADA TRAMO (medido contra `jde.Pago_Proveedor`, 2026-09-21, 35,975
 * filas). La llave era `cia::noPago` y eso NO identifica un pago: JDE reutiliza
 * `No_Pago` entre lotes, así que el dedup borraba pagos REALES —distinto
 * proveedor, distinto batch, distinto importe— creyéndolos duplicados. Medido:
 * 69 grupos dentro de UNA MISMA carga con importes distintos, $38.46M de
 * diferencia; p.ej. cía 00011 `PT 428674` es GASNGO por $956,454.66 (batch
 * 84562250) Y CFE por $24,795 (batch 84523892).
 *   • `cia`      — 2,106 `noPago` se repiten entre compañías.
 *   • `tipoPago` — la identidad documentada del pago es el PAR tipo+número
 *                  (ver `PagoProveedorRecord`); hoy no separa nada (sólo hay 2
 *                  tipos y cero colisiones), pero es lo que JDE promete.
 *   • `claveProveedor` + `batchPago` — los dos tramos que rescatan los 1,174
 *                  pagos reales que la llave vieja destruía.
 *
 * Con esta llave, CERO grupos del espejo difieren en importe: todo lo que
 * queda colapsado (1,458 grupos) es reinserción byte-idéntica de la fuente,
 * que es exactamente lo que el dedup debe colapsar.
 */
export function pagoRecordKey(r: PagoProveedorRecord): string {
  return `${r.cia}::${r.tipoPago}::${r.noPago}::${r.claveProveedor}::${r.batchPago}`;
}
