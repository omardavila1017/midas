/**
 * RFC genérico del SAT: `XAXX010101000` (público en general, persona física
 * sin RFC) y `XEXX010101000` (residente en el extranjero). NO identifican a
 * nadie — son un marcador de "sin RFC", así que jamás pueden servir de llave
 * de agrupación: colapsarían en una sola entidad a todo el que los use.
 *
 * FUENTE ÚNICA. Lo consumen la higiene de proveedores de Pagos y la
 * agrupación comercial de clientes.
 */
export const GENERIC_RFC_RE = /^X[AE]XX010101000$/i;

export function isGenericRfc(rfc: string | undefined | null): boolean {
  return GENERIC_RFC_RE.test((rfc ?? '').trim());
}
