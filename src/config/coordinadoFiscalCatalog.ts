/**
 * Catálogo declarativo: empresa interna (cia) → coordinado fiscal.
 *
 * Propósito: agrupar los totales fiscales por **coordinado fiscal** (un nivel
 * arriba de la empresa individual) en el módulo de Impuestos, además del
 * consolidado. Un coordinado agrupa varias personas morales del grupo que
 * declaran de forma CONJUNTA ante el SAT bajo el régimen de coordinados
 * (Título II, Cap. VII LISR — autotransporte).
 *
 * Estructura — análoga a `glAccountFlowCatalog.ts` / `roles.ts`: catálogo
 * declarativo en código (NO secreto) + resolver. Primer match gana.
 *
 * ── FUENTE AUTORITATIVA (José Luis Gallegos, Fiscal — 8-jul-2026) ──────────
 * Los escritos oficiales CANAPAT al SAT (29-ene-2026) listan las empresas
 * integrantes de cada coordinado. Hay DOS coordinados:
 *
 *   • **TT**  — Transportes Tamaulipas (cabeza: cía 00001, RFC TTA4906038F4)
 *   • **SIR** — Servicio Industrial Regiomontano (cabeza: cía 00011, RFC SIR870615345)
 *
 * El mapeo empresa→código de cía JDE se amarra con:
 *   1. El RFC de cada persona moral, tomado directo del escrito CANAPAT
 *      (2026-01-29). Tras recibir los adjuntos de José Luis (2026-07-09) TODOS
 *      los RFC de ambos coordinados quedaron confirmados (ver `docs/fiscal/`).
 *   2. Los registros de cía autoritativos que ya viven en este repo:
 *        - `AUXILIAR_CIA_ALLOWLIST` (`domain/auxiliarReconciliationConfig.ts`):
 *          00001 TAMAULIPAS · 00011 SIR · 00033 MULTICARGA · 00038 STDN ·
 *          00042 TICH · 00043 SES.
 *        - El mapa TRESS `idEmpresa` (`services/jdeTypes.ts`):
 *          1 Federal(=Tamaulipas) · 11 SIR · 17 SIT · 33 Multicarga · 42 TICH.
 *        - `bankAccountsCatalog.json` (razón social × `unidadNegocio`).
 *
 * ⚠️ Los reportes `SIR/TT. Reporte Egreso - Ingreso JDE.xlsx` (recibidos
 * 2026-07-09) resultaron estar filtrados por la empresa **cabeza**: su columna
 * `Cia`/`Nombre Cia` sólo trae `00001` (TT) / `00011` (SIR). Los demás
 * integrantes aparecen únicamente como proveedores "Filiales" (con su RFC), NO
 * como `Cia` — así que el Excel NO entrega los códigos JDE de los miembros. Por
 * eso el RFC del escrito es la llave autoritativa de los integrantes cuyo código
 * de cía aún no está en el allowlist/TRESS; el nombre queda sólo como red de
 * seguridad.
 *
 * Precedencia del resolver: **código de cía (autoritativo) → RFC (autoritativo)
 * → patrón de nombre (fallback)**. El patrón de nombre YA NO es una siembra
 * provisional: son las razones sociales exactas del escrito CANAPAT, y sólo se
 * usa como red de seguridad para cías cuyo código JDE aún no se confirmó.
 *
 * ⚠️ MULTICARGA (cía 00033) aparece en el escrito del coordinado TT pero con la
 * bandera **"opta por coordinado: NO"** — declara por separado. Se mantiene
 * FUERA de TT vía `COORDINADO_OPT_OUT` (cae a `SIN_COORDINADO`).
 *
 * Editar este archivo NO altera montos ni el motor `buildTaxByCompany`: sólo
 * decide bajo qué grupo se suma cada empresa en la vista.
 */

import type { Company } from '../services/jdeTypes';

export type CoordinadoFiscal = 'SIR' | 'TT';

/** Etiqueta es-MX del coordinado para la UI. */
export const COORDINADO_LABEL: Record<CoordinadoFiscal, string> = {
  SIR: 'SIR',
  TT: 'Tamaulipas',
};

/** Grupo para las cias sin coordinado asignado (o que optan por no coordinarse). */
export const SIN_COORDINADO = 'Sin coordinado';

export interface CoordinadoRule {
  coordinado: CoordinadoFiscal;
  /** Códigos `cia` JDE exactos (autoritativo, padding-agnóstico). */
  cias?: string[];
  /** RFC de las personas morales integrantes (autoritativo, del escrito CANAPAT). */
  rfcs?: string[];
  /**
   * Patrones de nombre (case-insensitive, sin acentos) — red de seguridad para
   * cías cuyo código JDE aún no se confirmó. Razones sociales del escrito CANAPAT.
   */
  namePatterns?: RegExp[];
}

/**
 * Empresas que un escrito CANAPAT lista pero que NO se coordinan (bandera
 * "opta por coordinado: NO"). Fuerzan `SIN_COORDINADO` aunque un patrón de
 * nombre/RFC de un coordinado las alcanzara. Autoritativo, del escrito TT.
 */
export const COORDINADO_OPT_OUT: Pick<CoordinadoRule, 'cias' | 'rfcs' | 'namePatterns'> = {
  cias: ['00033'], // MULTICARGA — declara por separado
  rfcs: ['MUL9707108M3'],
  namePatterns: [/multicarga/i],
};

/**
 * Reglas cia → coordinado. `cias` = códigos JDE confirmados; `rfcs` = personas
 * morales del escrito CANAPAT (llave autoritativa alterna); `namePatterns` =
 * razones sociales del escrito (fallback).
 *
 *  - **TT** (Transportes Tamaulipas): cabeza cía 00001. Integrantes confirmados
 *    por código: 00038 STDN, 00043 SES. Resto por RFC del escrito (Turimex,
 *    Operadora de Ventas, Adventur, Oficios y Proyectos, Inmuebles Autobuses
 *    Coahuilenses) — su código de cía JDE no está en el allowlist/TRESS.
 *  - **SIR** (Servicio Industrial Regiomontano): cabeza cía 00011. Integrantes
 *    confirmados por código: 00042 TICH, 00017 SIT (familia Servicio Industrial,
 *    TRESS idEmpresa 17 — no aparece por nombre en el escrito SIR). Resto por RFC
 *    del escrito (Potosino, Zacatecano, Senda Servicio Industrial, Servicios
 *    Industriales Senda).
 */
export const COORDINADO_FISCAL_RULES: CoordinadoRule[] = [
  {
    coordinado: 'TT',
    // 00001 Transportes Tamaulipas (cabeza) · 00038 Servicios T de N (STDN)
    // · 00043 Servicios Especializados Senda (SES).
    cias: ['00001', '00038', '00043'],
    rfcs: [
      'TTA4906038F4', // Transportes Tamaulipas (cabeza)
      'STN041111521', // Servicios T de N
      'SES051125TR5', // Servicios Especializados Senda
      'TNO010131U98', // Turimex del Norte
      'OVG1003022X6', // Operadora de Ventas Grupo Senda
      'AAD040311G68', // Autotransporte Adventur
      'OPR100525RU0', // Oficios y Proyectos en Reclutamiento y Clasificación de Personal de NL
      'IAC0708207S2', // Inmuebles Autobuses Coahuilenses
    ],
    namePatterns: [
      /tamaulipas/i,
      /turimex/i,
      /especializados\s+senda/i,
      /servicios\s+t\s+de\s+n/i,
      /operadora\s+de\s+ventas\s+grupo\s+senda/i,
      /adventur/i,
      /oficios\s+y\s+proyectos/i,
      /autobuses\s+coahuilenses/i,
      /\bTVN\b/i,
    ],
  },
  {
    coordinado: 'SIR',
    // 00011 Servicio Industrial Regiomontano (cabeza) · 00042 Transportes
    // Industriales Chihuahuenses (TICH) · 00017 SIT (familia Servicio Industrial,
    // TRESS idEmpresa 17).
    cias: ['00011', '00042', '00017'],
    rfcs: [
      'SIR870615345', // Servicio Industrial Regiomontano (cabeza)
      'SIP990527FA0', // Servicio Industrial Potosino
      'SSI0502091T6', // Senda Servicio Industrial
      'TIC0510111G4', // Transportes Industriales Chihuahuenses (TICH) — cía 00042
      'TIJ051011HF9', // Servicios Industriales Senda
      'SIZ1309177E6', // Servicio Industrial Zacatecano
    ],
    namePatterns: [
      /regiomontano/i,
      /industriales\s+chihuahuenses/i,
      /industrial\s+potosino/i,
      /industrial\s+zacatecano/i,
      /senda\s+servicio\s+industrial/i,
      /servicios\s+industriales\s+senda/i,
      /\bTICH\b/i,
    ],
  },
];

function normalize(text: string): string {
  // Quita marcas diacríticas combinantes (U+0300–U+036F) tras NFD.
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** RFC en forma canónica (sin espacios/guiones, mayúsculas). */
function normalizeRfc(rfc: string): string {
  return rfc.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

/** True si dos códigos de cía representan la misma empresa (padding-agnóstico). */
function ciaMatches(a: string, b: string): boolean {
  const ta = a.trim();
  const tb = b.trim();
  if (ta === tb) return true;
  const na = Number.parseInt(ta, 10);
  const nb = Number.parseInt(tb, 10);
  return Number.isFinite(na) && Number.isFinite(nb) && na === nb;
}

function matchesCia(rule: Pick<CoordinadoRule, 'cias'>, cia: string): boolean {
  return !!rule.cias && rule.cias.some((c) => ciaMatches(c, cia));
}

function matchesRfc(rule: Pick<CoordinadoRule, 'rfcs'>, rfc: string): boolean {
  const target = normalizeRfc(rfc);
  return !!target && !!rule.rfcs && rule.rfcs.some((r) => normalizeRfc(r) === target);
}

function matchesName(rule: Pick<CoordinadoRule, 'namePatterns'>, nombre: string): boolean {
  const name = normalize(nombre.trim());
  return !!name && !!rule.namePatterns && rule.namePatterns.some((re) => re.test(name));
}

/**
 * Resuelve el coordinado fiscal de una empresa. Precedencia:
 * **código de cía → RFC → patrón de nombre**. Una empresa marcada en
 * `COORDINADO_OPT_OUT` (p.ej. Multicarga) regresa `undefined` (→ SIN_COORDINADO)
 * aunque un patrón la alcanzara. `rules` es inyectable para tests herméticos.
 */
export function resolveCoordinadoForCia(
  cia: string,
  nombre?: string,
  rfc?: string,
  rules: CoordinadoRule[] = COORDINADO_FISCAL_RULES,
  optOut: typeof COORDINADO_OPT_OUT = COORDINADO_OPT_OUT,
): CoordinadoFiscal | undefined {
  const ciaTrim = (cia ?? '').trim();
  const rfcTrim = (rfc ?? '').trim();
  const name = nombre ?? '';

  // Bandera "opta por coordinado: NO" — gana sobre cualquier regla.
  if (
    (ciaTrim && matchesCia(optOut, ciaTrim))
    || (rfcTrim && matchesRfc(optOut, rfcTrim))
    || matchesName(optOut, name)
  ) {
    return undefined;
  }

  // 1. Código de cía JDE (autoritativo).
  if (ciaTrim) {
    for (const rule of rules) if (matchesCia(rule, ciaTrim)) return rule.coordinado;
  }
  // 2. RFC (autoritativo alterno).
  if (rfcTrim) {
    for (const rule of rules) if (matchesRfc(rule, rfcTrim)) return rule.coordinado;
  }
  // 3. Patrón de nombre (fallback).
  if (name.trim()) {
    for (const rule of rules) if (matchesName(rule, name)) return rule.coordinado;
  }
  return undefined;
}

/** Etiqueta de grupo de una cia: nombre del coordinado o `SIN_COORDINADO`. */
export function coordinadoLabelForCia(
  cia: string,
  companies: ReadonlyArray<Pick<Company, 'cia' | 'nombre' | 'rfc'>> = [],
  rules: CoordinadoRule[] = COORDINADO_FISCAL_RULES,
): string {
  const company = companies.find((c) => ciaMatches(c.cia, cia));
  const coordinado = resolveCoordinadoForCia(cia, company?.nombre, company?.rfc, rules);
  return coordinado ? COORDINADO_LABEL[coordinado] : SIN_COORDINADO;
}
