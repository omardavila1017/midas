/**
 * Regla ÚNICA de "esta fila viene de la carga MÁS RECIENTE de la antigüedad de
 * saldos".
 *
 * Vive en un módulo hoja por la misma razón que `agedBalanceSettled`: hay DOS
 * puertas de entrada de registros de CXP —el fetcher de JDE (`services/jde.ts`)
 * y el import CSV manual (`domain/cxpCsv.ts`)— y el mismo documento no puede
 * comportarse distinto según por cuál entró.
 */

/**
 * Fecha en que se tomó el snapshot al que pertenece la fila (`YYYY-MM-DD`), o
 * `null` si la fila no trae señal utilizable.
 *
 * **Cada fila carga su propia fecha de corte**, y eso es lo que hace posible
 * separar el snapshot vivo de los restos de cargas anteriores sin pedirle nada
 * al backend: `Dias_Vencida` lo calcula el origen CONTRA EL DÍA DE LA CARGA, así
 * que `fecha_vence + Dias_Vencida` reconstruye ese día. Verificado contra la BD
 * el 2026-09-18 sobre las 7,791 filas abiertas de `jde.Antiguedad_Saldos`: las
 * cuatro cargas que conviven en la tabla producen CUATRO sellos, y cada uno
 * coincide EXACTAMENTE con el `F_Carga` de su lote (14-sep: 4,907 filas ·
 * 16-sep: 75 · 17-sep: 49 · 18-sep: 2,760), con CERO filas sin señal.
 *
 * `F_Carga` no sirve para esto: no viaja en el payload (cero hits en `src/`).
 */
export function agedBalanceSnapshotStamp(
  record: { fechaVence: string; diasVencida: number },
): string | null {
  const vence = record.fechaVence;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(vence)) return null;
  const dias = record.diasVencida;
  if (!Number.isFinite(dias)) return null;
  const ms = Date.parse(`${vence}T00:00:00Z`);
  if (Number.isNaN(ms)) return null;
  return new Date(ms + Math.trunc(dias) * 86_400_000).toISOString().slice(0, 10);
}

export interface LatestSnapshotCut<T> {
  /** Filas de la carga más reciente + las que no traen señal. */
  kept: T[];
  /** Cuántas filas se descartaron por venir de una carga anterior. */
  dropped: number;
  /** Pendiente que sumaban esas filas (lo que se dejaría de reportar). */
  droppedAmount: number;
  /** Sello de la carga que se conservó, o `null` si no se aplicó el corte. */
  latestStamp: string | null;
  /** Sellos descartados, del más reciente al más viejo. */
  staleStamps: string[];
}

/**
 * Conserva SÓLO las filas del snapshot más reciente del payload.
 *
 * `jde.Antiguedad_Saldos` es un SNAPSHOT de saldos ABIERTOS —se trunca y se
 * recarga—, así que una fila de una carga anterior está superseded por
 * definición: si el documento siguiera abierto, la carga de hoy lo volvería a
 * emitir. El corte de pagados (`isSettledAgedBalance`) no alcanza para esto:
 * los restos de una carga vieja siguen marcados ABIERTOS, son llaves distintas
 * (no duplicados, así que el dedup tampoco los toca) y entran enteros al pasivo,
 * a los egresos `cxp:` proyectados, a "A pagar este mes" y a los días en
 * déficit.
 *
 * Medido 2026-09-18, con la tabla aún sin truncar en el origen: de $183.91M
 * abiertos, **$95.51M (5,031 filas) venían de cargas de días anteriores** — o
 * sea Midas publicaba **2.08× el CXP real** ($88.40M / 2,760 filas es lo que
 * declara el snapshot de hoy). No se ve vacío: se ve completo y al doble.
 *
 * **Degrada solo, en las dos direcciones que importan:**
 *   • Origen sano (una sola carga) ⇒ todas las filas comparten sello ⇒ el
 *     resultado es byte-idéntico a la entrada.
 *   • Fila sin señal (`fechaVence` no ISO o `diasVencida` no numérico) ⇒ se
 *     CONSERVA. Nunca se descarta pasivo por falta de dato.
 *
 * Dos guardas contra el modo de falla caro —que una fila corrupta se vuelva el
 * sello ganador y tire el snapshot entero—:
 *   1. Un sello POSTERIOR a `asOf` se ignora: una carga no se pudo correr en el
 *      futuro.
 *   2. El sello ganador necesita al menos DOS filas que lo respalden. Una fila
 *      sola no es evidencia de una carga; con esto una fila internamente
 *      inconsistente no puede dejar el CXP en ceros.
 * Sin sello ganador el corte no se aplica y se devuelve todo.
 */
export function keepLatestAgedBalanceSnapshot<
  T extends { fechaVence: string; diasVencida: number; importePendientePesos: number },
>(records: T[], asOf: string = new Date().toISOString().slice(0, 10)): LatestSnapshotCut<T> {
  const countByStamp = new Map<string, number>();
  const stamps: (string | null)[] = new Array(records.length);
  for (let i = 0; i < records.length; i += 1) {
    const stamp = agedBalanceSnapshotStamp(records[i]);
    stamps[i] = stamp;
    if (stamp && stamp <= asOf) countByStamp.set(stamp, (countByStamp.get(stamp) ?? 0) + 1);
  }

  let latestStamp: string | null = null;
  for (const [stamp, count] of countByStamp) {
    if (count < 2) continue;
    if (latestStamp === null || stamp > latestStamp) latestStamp = stamp;
  }
  if (latestStamp === null) {
    return { kept: records, dropped: 0, droppedAmount: 0, latestStamp: null, staleStamps: [] };
  }

  const kept: T[] = [];
  const stale = new Set<string>();
  let dropped = 0;
  let droppedAmount = 0;
  for (let i = 0; i < records.length; i += 1) {
    const stamp = stamps[i];
    if (stamp === null || stamp >= latestStamp) {
      kept.push(records[i]);
      continue;
    }
    dropped += 1;
    droppedAmount += records[i].importePendientePesos;
    stale.add(stamp);
  }
  return {
    kept,
    dropped,
    droppedAmount,
    latestStamp,
    staleStamps: Array.from(stale).sort().reverse(),
  };
}
