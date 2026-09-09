/**
 * Overlay de recibos de cobranza (`/cobranzaindicadores`) sobre el saldo
 * pendiente que reporta `/cobranza`.
 *
 * POR QUÉ EXISTE
 * --------------
 * `jde.Cobranza_Citi` (la fuente de `/cobranza`) NO aplica los recibos: una
 * factura ya cobrada se queda sin `Fecha_Pago` y con su `Importe_Pendiente`
 * completo. Medido contra la BD el 2026-09-07 (carga fresca del día): 1,694
 * facturas con cobro aplicado en `jde.Cobranza_Indicadores` siguen con
 * pendiente > 0 en `/cobranza`, por **$345.3M** — de los cuales **$310.5M son
 * de la cía 00011 (grupo Citi)**, justo donde el cruce bancario factura-por-
 * factura no funciona (por eso existe el prorrateo de la concentradora).
 *
 * Es defecto del ORIGEN, no del motor: Midas reportaba fielmente una fuente
 * desincronizada consigo misma. Este overlay parcha el síntoma.
 *
 * LA REGLA DURA: SÓLO A LA BAJA, NUNCA SUMA INGRESO
 * -------------------------------------------------
 * El overlay únicamente **reduce** el saldo por cobrar. Nunca emite un ingreso
 * a partir del recibo, porque el 90% del hueco es cía 00011, cuyos depósitos
 * entran a la concentradora sin cruzar a factura individual: ese dinero **ya
 * está pintado del lado banco** (`BANK_UNMATCHED` / prorrateo Citi). Emitir
 * además un ingreso desde el recibo lo duplicaría.
 *
 * EL POZO POR FOLIO (por qué NO se compara línea contra bruto)
 * -----------------------------------------------------------
 * Una factura puede venir en VARIAS líneas de `/cobranza` y el merge del repo
 * NO las colapsa por folio a propósito (colapsarlas sub-cuenta Venta/CXC — ver
 * `mergeCobranzaBackfillRange`), mientras que el recibo de Indicadores es del
 * folio **COMPLETO**. Aplicarlo entero a cada línea BORRA saldo real: con dos
 * líneas de $100k y un recibo de $150k, cada línea se iría a cero y los $50k
 * que siguen por cobrar desaparecerían. Es la misma clase de defecto que el
 * overlay vino a cerrar, en la dirección contraria y peor: no infla un
 * pronóstico, hace DESAPARECER cobranza real sin dejar rastro.
 *
 * Por eso el descuento se modela como un pozo:
 *   1. `buildReceiptSurplusByFolio` calcula, UNA vez por folio, lo que sólo
 *      conoce Indicadores = `aplicado − Σ(bruto − pendiente)` de todas sus
 *      líneas (o sea, lo aplicado que `/cobranza` todavía no reconoce).
 *   2. `consumeReceiptSurplus` lo consume línea por línea, sin exceder el saldo
 *      vivo de cada una.
 *
 * Así nunca se descuenta dos veces lo que `/cobranza` ya aplicó, ni se le resta
 * a una línea más de lo que le queda. Con una sola línea el resultado es
 * idéntico a comparar contra el bruto. **Degrada solo**: sin recibos el pozo
 * queda vacío y el pendiente es byte-idéntico al reportado, así que los
 * periodos sin cobertura de Indicadores (ene–may 2026: CERO filas en la tabla)
 * no se mueven un peso.
 *
 * El folio se cruza con `normFactura` CANÓNICO: verificado contra la BD,
 * Indicadores manda `"RI - 92238"` y `/cobranza` manda `"RI-310071"`. NO
 * dupliques un normalizador local.
 */
import type { CobranzaPayment } from '../services/jdeTypes';
import { normFactura } from './rolCobranzaMatch';

/**
 * Llave `cia::folio` con el folio normalizado — los dos endpoints difieren de
 * formato. Devuelve `''` cuando no hay folio reconocible: sin folio no hay
 * factura a la cual descontarle saldo, y compartir la llave `cia::` entre
 * todas las líneas sin folio de una cía las mezclaría en un mismo pozo.
 */
export function receiptOverlayKey(cia: string, noFactura: string | undefined): string {
  const folio = normFactura(noFactura);
  return folio ? `${cia}::${folio}` : '';
}

/** Línea de cobranza, en lo mínimo que el overlay necesita leer. */
export interface ReceiptOverlayLine {
  cia: string;
  noFactura: string;
  importeBrutoPesos: number;
  importePendientePesos: number;
}

/**
 * Importe aplicado por factura según los recibos de `/cobranzaindicadores`.
 * Un mismo folio puede recibir N aplicaciones (de recibos distintos), así que
 * se ACUMULA. Las aplicaciones sin folio reconocible se descartan: sin folio
 * no hay factura a la cual descontarle saldo.
 */
export function buildAppliedAmountByFactura(
  payments: CobranzaPayment[] | undefined,
): Map<string, number> {
  const applied = new Map<string, number>();
  for (const payment of payments ?? []) {
    for (const application of payment.applications ?? []) {
      const folio = normFactura(application.noFactura);
      if (!folio) continue;
      const amount = application.importeCobrado;
      if (!Number.isFinite(amount) || amount <= 0) continue;
      const key = `${application.cia || payment.cia}::${folio}`;
      applied.set(key, (applied.get(key) ?? 0) + amount);
    }
  }
  return applied;
}

/**
 * Excedente del recibo POR FOLIO: lo aplicado que `/cobranza` todavía NO
 * reconoce, pendiente de repartir entre las líneas del folio.
 *
 * `lines` debe ser el set COMPLETO de líneas (sin dedupear por folio): la Σ de
 * `bruto − pendiente` es lo que `/cobranza` ya aplicó al folio entero, y
 * calcularla sobre un set dedupeado la subestimaría → sobreestimaría el
 * excedente → descontaría de más.
 *
 * El Map devuelto es MUTABLE a propósito: `consumeReceiptSurplus` lo va
 * agotando mientras el motor recorre las líneas.
 */
export function buildReceiptSurplusByFolio(
  lines: Iterable<ReceiptOverlayLine>,
  appliedByFactura: Map<string, number>,
): Map<string, number> {
  const surplusByFolio = new Map<string, number>();
  if (appliedByFactura.size === 0) return surplusByFolio;

  const cobradoByFolio = new Map<string, number>();
  for (const line of lines) {
    const folioKey = receiptOverlayKey(line.cia, line.noFactura);
    if (!folioKey) continue;
    const bruto = Number.isFinite(line.importeBrutoPesos) ? line.importeBrutoPesos : 0;
    const pendiente = Number.isFinite(line.importePendientePesos) ? line.importePendientePesos : 0;
    const cobrado = Math.max(0, bruto - pendiente);
    cobradoByFolio.set(folioKey, (cobradoByFolio.get(folioKey) ?? 0) + cobrado);
  }

  for (const [folioKey, applied] of appliedByFactura) {
    const surplus = applied - (cobradoByFolio.get(folioKey) ?? 0);
    if (surplus > 0) surplusByFolio.set(folioKey, surplus);
  }
  return surplusByFolio;
}

/**
 * Consume del pozo del folio el ajuste que le toca a ESTA línea, acotado a su
 * saldo vivo. **Muta** `surplusByFolio` (descuenta lo consumido) para que la
 * siguiente línea del mismo folio no vuelva a cobrarlo.
 *
 * Devuelve 0 cuando no hay pozo, la línea no tiene folio reconocible o su
 * pendiente no es positivo.
 */
export function consumeReceiptSurplus(
  surplusByFolio: Map<string, number>,
  folioKey: string,
  importePendientePesos: number,
): number {
  if (!folioKey || surplusByFolio.size === 0) return 0;
  const surplus = surplusByFolio.get(folioKey) ?? 0;
  if (surplus <= 0) return 0;
  const pendiente = Number.isFinite(importePendientePesos) ? importePendientePesos : 0;
  if (pendiente <= 0) return 0;
  const adjustment = Math.min(surplus, pendiente);
  surplusByFolio.set(folioKey, surplus - adjustment);
  return adjustment;
}

/**
 * Pendiente EFECTIVO por línea, indexado por la línea misma.
 *
 * Para superficies que necesitan el saldo ajustado de una línea CONCRETA (un
 * export, un detalle por factura) en vez de un agregado. El pozo se construye
 * y se agota sobre el set COMPLETO — `lines` — porque el excedente es del folio
 * entero: agotarlo sobre un subconjunto filtrado le aplicaría a las líneas
 * visibles el ajuste de las que el filtro escondió, y eso hace DESAPARECER
 * cobranza real (el defecto contrario y peor, ver el docblock del módulo).
 * El consumidor toma del Map sólo las líneas que le interesan.
 *
 * Sin recibos devuelve un Map VACÍO, no uno lleno de pendientes crudos: así el
 * caller distingue "no hay ajuste que aplicar" y sirve el valor de la fuente.
 */
export function buildEffectivePendingByLine<T extends ReceiptOverlayLine>(
  lines: readonly T[],
  appliedByFactura: Map<string, number>,
): Map<T, number> {
  const byLine = new Map<T, number>();
  if (appliedByFactura.size === 0) return byLine;
  const surplusByFolio = buildReceiptSurplusByFolio(lines, appliedByFactura);
  if (surplusByFolio.size === 0) return byLine;
  for (const line of lines) {
    const pendiente = Number.isFinite(line.importePendientePesos) ? line.importePendientePesos : 0;
    const ajuste = consumeReceiptSurplus(
      surplusByFolio,
      receiptOverlayKey(line.cia, line.noFactura),
      pendiente,
    );
    if (ajuste > 0) byLine.set(line, Math.max(0, pendiente - ajuste));
  }
  return byLine;
}
