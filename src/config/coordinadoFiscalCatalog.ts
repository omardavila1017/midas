/**
 * Catálogo declarativo: empresa interna (cia) → coordinado fiscal.
 *
 * Propósito: agrupar los totales fiscales por **coordinado fiscal** (un nivel
 * arriba de la empresa individual) en el módulo de Impuestos, además del
 * consolidado. Los coordinados agrupan varias cias del grupo bajo un mismo
 * régimen/coordinación fiscal (Taller 8-jul-2026).
 *
 * Estructura — análoga a `glAccountFlowCatalog.ts` / `roles.ts`: catálogo
 * declarativo en código (NO secreto) + resolver. Primer match gana.
 *
 * ⚠️ MAPEO PROVISIONAL: los códigos `cia` exactos por coordinado los confirma
 * José Luis por correo. Mientras tanto se siembra por **patrón de nombre**
 * (resuelto en runtime contra el nombre de la empresa que trae JDE), que es una
 * aproximación. Cuando lleguen los códigos, muévelos a `cias` (autoritativo) —
 * ahí `namePatterns` deja de ser necesario para esa cia. Una cia sin match cae
 * a `SIN_COORDINADO` ("Sin coordinado") y sigue apareciendo en el desglose.
 *
 * Editar este archivo NO altera montos ni el motor `buildTaxByCompany`: sólo
 * decide bajo qué grupo se suma cada empresa en la vista.
 */

import type { Company } from '../services/jdeTypes';

export type CoordinadoFiscal = 'SIRES' | 'FEDERAL';

/** Etiqueta es-MX del coordinado para la UI. */
export const COORDINADO_LABEL: Record<CoordinadoFiscal, string> = {
  SIRES: 'SIRES',
  FEDERAL: 'Federal',
};

/** Grupo para las cias sin coordinado asignado. */
export const SIN_COORDINADO = 'Sin coordinado';

export interface CoordinadoRule {
  coordinado: CoordinadoFiscal;
  /** Códigos `cia` exactos (autoritativo). Vacío hasta que se confirmen. */
  cias?: string[];
  /**
   * Patrones de nombre para sembrar provisional (case-insensitive, sin acentos).
   * Se prueban contra el `nombre` de la empresa (JDE) cuando `cias` no empata.
   */
  namePatterns?: RegExp[];
}

/**
 * Reglas cia → coordinado. `cias` vacío a propósito (pendiente de José Luis);
 * `namePatterns` es la siembra provisional por nombre.
 *
 *  - SIRES: transporte de personal (CIR, Tich, Potosino, Zacatecano, …).
 *  - Federal: Tamaulipas, TVN, Turimex.
 */
export const COORDINADO_FISCAL_RULES: CoordinadoRule[] = [
  {
    coordinado: 'SIRES',
    cias: [],
    namePatterns: [/\bCIR\b/i, /\bTICH/i, /potosin/i, /zacatecan/i],
  },
  {
    coordinado: 'FEDERAL',
    cias: [],
    namePatterns: [/tamaulipas/i, /\bTVN\b/i, /turimex/i],
  },
];

function normalize(text: string): string {
  // Quita marcas diacríticas combinantes (U+0300–U+036F) tras NFD.
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * Resuelve el coordinado fiscal de una cia. Prueba primero los códigos exactos
 * (`cias`), luego los patrones de nombre. Regresa `undefined` (→ SIN_COORDINADO)
 * cuando ninguna regla aplica. `rules` es inyectable para tests herméticos.
 */
export function resolveCoordinadoForCia(
  cia: string,
  nombre?: string,
  rules: CoordinadoRule[] = COORDINADO_FISCAL_RULES,
): CoordinadoFiscal | undefined {
  const ciaTrim = (cia ?? '').trim();
  for (const rule of rules) {
    if (rule.cias && rule.cias.some((c) => c.trim() === ciaTrim)) return rule.coordinado;
  }
  const name = normalize((nombre ?? '').trim());
  if (name) {
    for (const rule of rules) {
      if (rule.namePatterns && rule.namePatterns.some((re) => re.test(name))) return rule.coordinado;
    }
  }
  return undefined;
}

/** Etiqueta de grupo de una cia: nombre del coordinado o `SIN_COORDINADO`. */
export function coordinadoLabelForCia(
  cia: string,
  companies: ReadonlyArray<Pick<Company, 'cia' | 'nombre'>> = [],
  rules: CoordinadoRule[] = COORDINADO_FISCAL_RULES,
): string {
  const nombre = companies.find((c) => c.cia === cia)?.nombre;
  const coordinado = resolveCoordinadoForCia(cia, nombre, rules);
  return coordinado ? COORDINADO_LABEL[coordinado] : SIN_COORDINADO;
}
