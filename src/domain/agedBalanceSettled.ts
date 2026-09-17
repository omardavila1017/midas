/**
 * Regla ÚNICA de "este documento de CXP ya está pagado".
 *
 * Vive en un módulo hoja porque hay DOS puertas de entrada de registros de
 * antigüedad de saldos —el fetcher de JDE (`services/jde.ts`) y el import CSV
 * manual (`domain/cxpCsv.ts`)— y el mismo documento no puede comportarse
 * distinto según por cuál entró. Duplicar el set en cada puerta es justo cómo
 * se desincronizan.
 */

/**
 * Estados de `edo_pago` que significan DOCUMENTO PAGADO en JDE.
 *
 * Match EXACTO contra un set cerrado, nunca `includes`: en este repo una
 * colisión de substring con `'PAGADO'` dentro de `'NO PAGADO'` ya costó $37.45M
 * (ver `classifyIvaAccount`, 2026-08-10), y aquí el error equivalente
 * —capturar un `'POR PAGAR'`— haría DESAPARECER pasivo real, que es la
 * dirección peor y la que no deja rastro.
 */
export const SETTLED_EDO_PAGO = new Set(['P', 'PAGADO', 'PAID']);

/**
 * Un documento marcado PAGADO no es pasivo, por mucho saldo que declare.
 *
 * `jde.Antiguedad_Saldos` es la antigüedad de saldos ABIERTOS. Evidencia medida
 * 2026-09-17, y conviene ser preciso sobre su alcance porque la tabla **no
 * conserva historia anterior al 14-sep** (nace con el propio desastre, 4 días de
 * observación — no se puede afirmar nada sobre el histórico):
 *   • El snapshot COMPLETO del 17-sep (2,785 filas) no trae **ni una** `'P'`:
 *     sus estados son `A` (2,703), `H` (72), `O` (8) y `#` (2).
 *   • Las cargas normales del 15 y 16-sep **sí** emitieron pagados (32 cada una),
 *     pero **todas con pendiente 0** — inocuas: descartarlas no mueve dinero.
 *   • Un `'P'` con saldo distinto de cero aparece SÓLO en el lote roto del
 *     14-sep: 126,292 documentos por $3,056.1M.
 *
 * O sea: el corte **degrada solo** sobre todo lo observado — byte-idéntico en
 * monto. Lo que lo justifica no es una estadística sino la semántica: un
 * documento marcado pagado no es pasivo, y un pagado que declara saldo es una
 * contradicción de la fuente (por eso se confiesa en Salud de datos en vez de
 * descartarse callando).
 *
 * Muerde cuando la fuente se contradice a sí misma, que es exactamente lo que
 * pasó: una recarga histórica de 2025 dejó esos 126,292 documentos con su
 * `importe_pendiente_pesos` congelado en el valor original, conviviendo con el
 * snapshot vivo de $137.5M. El dedup por llave no los toca —son llaves
 * distintas, no duplicados— así que sin este corte entran enteros a los egresos
 * `cxp:` proyectados, al pasivo, a "A pagar este mes" y a los días en déficit:
 * no se ve vacío, se ve completo y **12x inflado**, que es el modo de falla caro.
 *
 * **Efecto colateral asumido, en la pestaña Pagos y sólo mientras el origen esté
 * roto:** `paymentReconciliationEngine` cruza cada pago contra CXP y contra el
 * CARGO bancario por separado, así que un pago que cruzaba ÚNICAMENTE contra una
 * de estas facturas pasa de `MATCHED_CXP_ONLY` a `UNMATCHED` y, si tenía
 * cobertura bancaria, se cuenta como huérfano real. No es un estado inventado:
 * el cruce era contra un documento que la fuente misma declara pagado, y el día
 * que el origen trunque la tabla esas facturas desaparecen igual y los huérfanos
 * afloran solos. Este corte no crea ese estado — lo adelanta. El dinero
 * PROYECTADO sólo mejora: `paidCxpKeys` sacaba del egreso justo estas facturas,
 * y aquí salen antes y de forma más completa.
 */
export function isSettledAgedBalance(record: { edoPago: string }): boolean {
  return SETTLED_EDO_PAGO.has(record.edoPago.trim().toUpperCase());
}
