/**
 * Clasificación de pago CRUDA de JDE (`Clasificacion_Proveedor` +
 * `Clasificacion_Proveedor_Financiera`) y el overlay proveedor → par.
 *
 * Por qué existe el crudo aparte de `providerCategory`:
 * `usableJdeProviderCategory` (canonicalProjectionShared) normaliza para poder
 * BUCKETIZAR — recorta el prefijo numérico (`180 - Proveedores TI` →
 * `Proveedores TI`) y descarta los centinelas que JDE escribe como texto
 * (`" "`, `-        .`, `220 - Por Clasificar`, `N/A`). Eso es correcto para el
 * bucket generalizado, pero destruye justo lo que Planeación necesita mostrar:
 * el egreso agrupado TAL CUAL lo clasificó JDE, para poder medir cuánto dinero
 * cuelga de un centinela y mandarlo a corregir en el origen.
 *
 * Por qué hace falta un overlay: el par sólo viene completo en la ruta de pagos
 * YA EJECUTADOS (`/pagoproveedor`). `/antiguedadsaldos` (CXP abierto) no manda
 * `Clasificacion_Proveedor_Financiera` y `/compras` no manda ninguna de las dos
 * (sólo el árbol de producto). Sin overlay, el MISMO proveedor cae en un grupo
 * en el pasado y en otro en el futuro. El overlay le presta a la línea futura el
 * par que JDE usó la última vez que a ese proveedor se le pagó de verdad —
 * mismo patrón que `buildComprasCreditOverlay` ("el API actualiza el catálogo").
 *
 * NUNCA inventa: un proveedor sin pago cruzado no recibe entrada y su línea se
 * queda sin clasificación (dato incompleto mostrado como tal).
 */

export interface PayClassPair {
  /** `Clasificacion_Proveedor` crudo (sólo whitespace colapsado). */
  payClass?: string;
  /** `Clasificacion_Proveedor_Financiera` crudo (sólo whitespace colapsado). */
  payClassFinanciera?: string;
}

/**
 * Única normalización permitida sobre la clasificación cruda: colapsar runs de
 * whitespace. Sin esto, `" "` y `"   "` (o el `-` seguido de 30 espacios y un
 * punto que manda JDE) fragmentarían en varios grupos idénticos a la vista.
 *
 * NO recorta el prefijo numérico ni descarta centinelas — ese es exactamente el
 * trabajo de `usableJdeProviderCategory`, y aquí lo queremos intacto.
 */
export function rawPayClass(value: string | null | undefined): string | undefined {
  return value?.trim().replace(/\s+/g, ' ') || undefined;
}

export function payClassPairFrom(
  clasificacionProveedor: string | null | undefined,
  clasificacionProveedorFinanciera: string | null | undefined,
): PayClassPair {
  return {
    payClass: rawPayClass(clasificacionProveedor),
    payClassFinanciera: rawPayClass(clasificacionProveedorFinanciera),
  };
}

function populatedFields(pair: PayClassPair): number {
  return (pair.payClass ? 1 : 0) + (pair.payClassFinanciera ? 1 : 0);
}

type CargoEnrichmentMap = Map<string, {
  status: 'MATCHED' | 'ORPHAN';
  payments?: Array<{
    claveProveedor?: string;
    clasificacionProveedor?: string;
    clasificacionProveedorFinanciera?: string;
  }>;
}>;

/**
 * Overlay `claveProveedor → par de clasificación` derivado de los CARGOs
 * bancarios que ya cruzaron a PagoProveedor. Se alimenta de la MISMA fuente que
 * clasifica el egreso histórico (`inputs.cargoEnrichments`), así que no agrega
 * ningún input nuevo al motor ni tramo nuevo a la llave del cache.
 *
 * `keyFor` se inyecta (mismo idioma que `summarizeBalancesByRole(…, roleOf)`)
 * para reusar la normalización de clave de proveedor del motor en vez de
 * duplicar un normalizador local.
 *
 * Desempate: gana el par con MÁS campos poblados; a igualdad, el primero visto.
 * El enrichment no trae fecha de pago, así que "el más reciente" no es
 * derivable aquí — se prefiere el más completo, que es la señal útil.
 */
export function buildProviderPayClassOverlay(
  cargoEnrichments: CargoEnrichmentMap | undefined,
  keyFor: (value: string | undefined) => string,
): Map<string, PayClassPair> {
  const overlay = new Map<string, PayClassPair>();
  if (!cargoEnrichments) return overlay;
  for (const enrichment of cargoEnrichments.values()) {
    if (enrichment.status !== 'MATCHED') continue;
    for (const payment of enrichment.payments ?? []) {
      const key = keyFor(payment.claveProveedor);
      if (!key) continue;
      const pair = payClassPairFrom(
        payment.clasificacionProveedor,
        payment.clasificacionProveedorFinanciera,
      );
      const score = populatedFields(pair);
      if (score === 0) continue;
      const current = overlay.get(key);
      if (current && populatedFields(current) >= score) continue;
      overlay.set(key, pair);
    }
  }
  return overlay;
}
