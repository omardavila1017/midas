/**
 * Definición ÚNICA de "¿está vencida esta CXP?" — la comparten la tarjeta
 * "Vencido" de Antigüedad de Saldo, su desglose por proveedor y el KPI de
 * Objetivos, para que las tres cifras coincidan (audit #3.3).
 *
 * Vencida = JDE ya la marca con días de atraso, O su fecha de vencimiento ya
 * pasó aunque `diasVencida` siga en 0 (drift entre el corte de JDE y el "hoy"
 * del navegador). `dueDate` y `today` son ISO `YYYY-MM-DD` (comparación lexical).
 */
export function isCxpOverdue(
  diasVencida: number | string | null | undefined,
  dueDate: string | null | undefined,
  today: string,
): boolean {
  return (Number(diasVencida) || 0) > 0 || (!!dueDate && dueDate < today);
}
