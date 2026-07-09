/**
 * Catálogo declarativo: clientes con esquema de COMPENSACIÓN en cobranza.
 *
 * Contexto (junta 2026-07-09, cuadre de cobranza con Blanca/Vero): hay clientes
 * cuyo pago NO aparece (completo) como abono bancario de cobranza porque el
 * cobro se liquida por compensación, y el cuadre "cobranza aplicada en Edwards
 * vs banco" (`src/domain/cobranzaBankCuadre.ts`) los reportaba falsamente como
 * "sin-banco" o "descuadre de importe". Dos esquemas distintos:
 *
 *  - `aplica-a-proveedor`: el pago del cliente se aplica primero contra deuda
 *    que el grupo tiene con él como PROVEEDOR — el dinero nunca entra al banco
 *    como cobranza de cliente (caso TLJ).
 *  - `descuento-en-origen`: el cliente descuenta en origen una parte del pago
 *    (compensación) y deposita sólo el neto — el recibo aplicado en Edwards es
 *    mayor que el abono bancario (casos APTIV y CMI).
 *
 * NO es excepción: Corning pagando a Banco del Bajío — ese cobro SÍ aparece
 * como abono bancario normal y debe seguir cuadrando por la vía estándar.
 *
 * Esto es CLASIFICACIÓN de display/agregación sobre lo ya computado por el
 * motor — no re-cruza nada, no toca montos ni fechas, y el motor sigue
 * read-only. El bucket `compensacion` es "esperado, no accionable": sale del
 * % de descuadre para que tesorería no lo lea como error.
 *
 * Estructura — análoga a `glAccountFlowCatalog.ts` / `roles.ts`: catálogo
 * declarativo en código (NO secreto) + resolver puro e inyectable para tests.
 * Cómo agregar un cliente: ver `docs/COMPENSACIONES-COBRANZA.md`.
 */

/** Tipo de esquema de compensación. */
export type CompensationScheme = 'aplica-a-proveedor' | 'descuento-en-origen';

/**
 * Una regla de compensación. Empata por clave JDE (`clientKeys`, exacta y
 * tolerante a ceros a la izquierda) O por patrón de nombre (`namePatterns`,
 * tolerante a mayúsculas/espacios). Basta que UN criterio empate. Primer match
 * en `COMPENSATION_CLIENT_RULES` gana.
 */
export interface CompensationClientRule {
  scheme: CompensationScheme;
  /** Nombre corto visible en el panel (p.ej. "TLJ"). */
  label: string;
  /** Claves JDE `No_Cliente` del cliente (preferible cuando se conocen). */
  clientKeys?: string[];
  /** Patrones tolerantes sobre el nombre del cliente (fallback/refuerzo). */
  namePatterns?: RegExp[];
  /** Cuenta de compensación asociada, cuando se conoce (se muestra en el panel). */
  cuentaCompensacion?: string;
  /** Nota de auditoría (no se muestra al usuario final). */
  nota?: string;
}

/** Etiqueta es-MX por esquema (UI). */
export const COMPENSATION_SCHEME_LABEL: Record<CompensationScheme, string> = {
  'aplica-a-proveedor': 'Aplica a deuda con proveedor',
  'descuento-en-origen': 'Descuento en origen',
};

/**
 * Clientes con esquema de compensación (junta 2026-07-09).
 *
 * Las claves JDE (`clientKeys`) están PENDIENTES de confirmar con cobranza —
 * mientras tanto el match es por nombre. Al confirmarlas, agrégalas a la regla
 * (el patrón de nombre se queda como refuerzo). La `cuentaCompensacion` también
 * se llena cuando contabilidad la confirme.
 */
export const COMPENSATION_CLIENT_RULES: CompensationClientRule[] = [
  {
    scheme: 'aplica-a-proveedor',
    label: 'TLJ',
    namePatterns: [/\bTLJ\b/i],
    nota: 'El pago se aplica primero a la deuda con el proveedor; no se ve en bancos como cobranza de cliente.',
  },
  {
    scheme: 'descuento-en-origen',
    label: 'APTIV',
    namePatterns: [/\bAPTIV?\b/i], // cubre "APTIV ..." y la abreviatura "APTI"
    nota: 'Parte del pago se descuenta en origen (compensación); no entra a bancos pero debe contabilizarse en cobranza.',
  },
  {
    scheme: 'descuento-en-origen',
    label: 'CMI',
    namePatterns: [/\bCMI\b/i],
    nota: 'Parte del pago se descuenta en origen (compensación); no entra a bancos pero debe contabilizarse en cobranza.',
  },
];

/** Clave JDE normalizada: trim + sin ceros a la izquierda (JDE pad-ea). */
function normClientKey(key: string): string {
  const t = String(key ?? '').trim();
  const stripped = t.replace(/^0+/, '');
  return stripped || t;
}

/** Nombre normalizado para los patrones: colapsa whitespace (el case lo maneja /i). */
function normClientName(name: string): string {
  return String(name ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Resuelve la regla de compensación para un cliente (por clave JDE o nombre).
 * `undefined` = cliente normal, sin excepción. `rules` es inyectable para
 * tests herméticos (default: `COMPENSATION_CLIENT_RULES`).
 */
export function resolveCompensationRule(
  noCliente: string,
  cliente: string,
  rules: readonly CompensationClientRule[] = COMPENSATION_CLIENT_RULES,
): CompensationClientRule | undefined {
  const key = normClientKey(noCliente);
  const name = normClientName(cliente);
  for (const rule of rules) {
    if (key && rule.clientKeys?.some(k => normClientKey(k) === key)) return rule;
    if (name && rule.namePatterns?.some(p => p.test(name))) return rule;
  }
  return undefined;
}
