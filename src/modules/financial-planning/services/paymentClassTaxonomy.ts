/**
 * Agrupamiento de EGRESOS de Planeación por la CLASIFICACIÓN DE PAGO de JDE,
 * tal cual la manda el API.
 *
 * Reemplaza al bucket generalizado (`macroBucketForSupplier` →
 * `generalizeCategoria`: Flota / Personal y nómina / Servicios / "Proveedores
 * sin categoría"), que deduce el destino del gasto con patrones regex. Esa capa
 * hace tres cosas que Finanzas NO quiere ver aquí:
 *
 *   1. TRADUCE — `180 - Proveedores TI` se vuelve el bucket `Proveedor TI`, y se
 *      pierde el código con el que Contabilidad trabaja.
 *   2. DESCARTA los centinelas que JDE escribe como texto (`" "`, `-  .`,
 *      `220 - Por Clasificar`): ese egreso terminaba en el cajón de sastre
 *      "Proveedores sin categoría", donde es indistinguible del que
 *      genuinamente no se pudo clasificar.
 *   3. DESPRIORIZA los genéricos (`Servicios`, `Varios`, `Bancario`…).
 *
 * El objetivo del agrupamiento crudo es exactamente el contrario: poder MEDIR
 * cuánto dinero cuelga de cada valor de JDE —incluidos los feos— y mandarlo a
 * corregir en el origen. Por eso aquí no se normaliza nada más allá de colapsar
 * whitespace (ver `rawPayClass`).
 *
 * `macroBucketForSupplier` NO se borra: sigue siendo el bucketing de las demás
 * superficies, y su test data-driven es el guardrail del vocabulario.
 *
 * Es capa de PRESENTACIÓN: sólo decide la etiqueta del grupo. Nunca toca monto,
 * fecha, `category` ni `type`, así que el cuadre Planeación↔banco no se mueve.
 */

import type { FinancialMovement } from '../../shared-finance/types';
import { isInternalCounterparty, isInternalProviderClassification } from '../../../domain/netCashFlowEngine';
import { INTERNAL_GROUP_BUCKET } from './providerCategoryGeneralization';
import { rawPayClass } from '../../shared-finance/calculation-engine/providerPayClassOverlay';

/** Egreso a proveedor cuyo par de clasificación viene vacío en las dos fuentes. */
export const SIN_PAY_CLASS_BUCKET = 'Sin clasificación de pago';

/** Separador entre los dos niveles del par. Mismo glifo que ya usa el grid. */
const PAIR_SEPARATOR = ' · ';

/**
 * Etiqueta del grupo a partir del par crudo. Ambos presentes → `c1 · c2`; sólo
 * uno → ese; ninguno → `null` (el caller decide el bucket de "sin clasificar").
 *
 * Re-aplica `rawPayClass` aunque los motores ya lo hagan al emitir: la llave de
 * agrupamiento no debe depender de que TODO productor se acuerde de colapsar el
 * whitespace. Un movimiento servido del cache persistente de un build anterior
 * partiría el grupo en dos etiquetas idénticas a la vista.
 */
export function payClassLabel(
  payClass: string | undefined,
  payClassFinanciera: string | undefined,
): string | null {
  const parts = [rawPayClass(payClass), rawPayClass(payClassFinanciera)]
    .filter((v): v is string => !!v);
  if (parts.length === 0) return null;
  // Un proveedor cuya financiera repite la clasificación general no debe pintar
  // `Servicios · Servicios`.
  if (parts.length === 2 && parts[0] === parts[1]) return parts[0];
  return parts.join(PAIR_SEPARATOR);
}

/**
 * Grupo de egreso de un movimiento. Devuelve `null` cuando el movimiento NO es
 * un pago a proveedor clasificable — el caller cae entonces a la etiqueta de
 * categoría en español (Nómina / Impuestos / Deuda / …), que ya existe en
 * `planningRowTaxonomy`.
 */
export function payClassBucketForMovement(movement: FinancialMovement): string | null {
  if (movement.type !== 'OUTFLOW' || movement.category !== 'AP_PAYMENT') return null;
  // CARGO de una cuenta pagadora PROPIA promovido a AP por el rol de la cuenta
  // pero sin proveedor cruzado: su única identidad es nuestra cuenta de banco
  // origen. No es un tercero, así que no tiene clasificación de pago que mostrar
  // — conserva su bucket interno (mismo criterio que el agrupamiento previo).
  if (movement.counterpartyType === 'BANK') return null;
  // Pago intercompañía (filial del grupo): traspaso, no gasto con un tercero.
  if (
    isInternalProviderClassification(movement.providerCategory)
    || isInternalProviderClassification(movement.payClass)
    || isInternalCounterparty(undefined, movement.counterpartyName)
  ) {
    return INTERNAL_GROUP_BUCKET;
  }
  return payClassLabel(movement.payClass, movement.payClassFinanciera) ?? SIN_PAY_CLASS_BUCKET;
}
