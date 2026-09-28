/**
 * ¿Entra al merge esta línea del Auxiliar Contable?
 *
 * FUENTE ÚNICA de la regla que gobierna a los DOS loaders del auxiliar: el de
 * conciliación (`auxiliarContableRecords`) y el del libro mayor de IVA
 * (`auxiliarIvaRecords`). Los dos tienen la misma forma —acumulan en un Map de
 * llaves NUEVAS, con un `Set` de las ya hidratadas para no re-mergear lo que el
 * estado ya tiene— y los dos pasan `revalidateSince` a su fetcher.
 *
 * EL DEFECTO QUE CIERRA. El guard "si ya la vi, la descarto" es correcto para
 * el grueso del rango (mantiene el Map chico), pero NO para los días que el
 * loader está re-pidiendo A PROPÓSITO: ahí el punto es justamente que la línea
 * CAMBIÓ en el origen (importe corregido, una reversa, `estatusConciliado`
 * pasando a 'R'). Con el guard a secas, el refetch de la ventana de
 * revalidación se paga en red y se tira a la basura — sólo entraban llaves
 * nuevas, así que el mecanismo quedaba inerte sin decirlo.
 *
 * POR QUÉ ESTE MÓDULO EXISTE Y NO ESTÁ INLINE. La regla ya divergió una vez:
 * se corrigió en el loader de conciliación (2026-09-21) y su gemelo de IVA se
 * quedó con la versión vieja, así que el IVA ACREDITABLE que publica Impuestos
 * —que sale de ese libro mayor— nunca veía una póliza corregida. Con los dos
 * llamando aquí, no pueden volver a separarse.
 *
 * SEGURIDAD. Dejar pasar la línea revalidada es seguro porque el `flush` de
 * ambos loaders es LAST-WINS (siembra el Map con `prev` y luego escribe las
 * llaves acumuladas encima), así que la versión nueva pisa a la vieja en vez de
 * duplicarla. Y el costo en memoria está acotado a las llaves de la ventana de
 * revalidación (14 días), no al rango completo.
 *
 * DEGRADA SOLO. Una línea sin `fechaContable` usable queda FUERA de la ventana
 * (`'' >= 'YYYY-MM-DD'` es `false`), así que conserva el guard previo: nunca se
 * re-mergea algo por no poder fecharlo.
 */
export interface AuxiliarMergeDecisionInput {
  /** Fecha contable de la línea. Vacía/ausente ⇒ fuera de la ventana. */
  fechaContable?: string;
  /** Piso ISO de la ventana de revalidación (`YYYY-MM-DD`). */
  revalidateSince: string;
  /** La llave ya está en el acumulador de este fetch. */
  alreadyMerged: boolean;
  /** La llave ya está en el estado hidratado. */
  alreadyHydrated: boolean;
}

/** `true` si la línea cae dentro de la ventana que el loader re-pide a propósito. */
export function isInAuxiliarRevalidationWindow(
  fechaContable: string | undefined,
  revalidateSince: string,
): boolean {
  if (!revalidateSince) return false;
  return (fechaContable ?? '') >= revalidateSince;
}

export function shouldMergeAuxiliarLine({
  fechaContable,
  revalidateSince,
  alreadyMerged,
  alreadyHydrated,
}: AuxiliarMergeDecisionInput): boolean {
  if (isInAuxiliarRevalidationWindow(fechaContable, revalidateSince)) return true;
  return !alreadyMerged && !alreadyHydrated;
}
