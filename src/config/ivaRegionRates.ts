/**
 * Catálogo declarativo: empresa/región → tasa de IVA de ingresos (16% ó 8%).
 *
 * ── FUENTE (José Luis Gallegos, Fiscal — 8-jul-2026) ──────────────────────
 * El ingreso, tras la conciliación, se parte en **16% IVA** y **8% IVA**; el
 * 8% corresponde a la **región fronteriza norte** (estímulo fiscal). Cuando el
 * dato sólo trae el monto del depósito (sin desglose de factura), Fiscal deriva:
 *
 *     base = depósito / (1 + tasa/100)      (÷1.16 para 16%, ÷1.08 para 8%)
 *     IVA  = depósito − base                (= base × tasa/100)
 *
 * y lo coteja contra la factura. Este catálogo decide qué **tasa** aplica una
 * empresa/región para esa derivación por depósito.
 *
 * ⚠️ **Arranca VACÍO** (ninguna cía marcada como fronteriza) → TODO se deriva
 * al 16% (comportamiento idéntico al actual). NO todas las empresas aplican el
 * estímulo fronterizo; Fiscal indica cuáles y aquí se listan por **código de
 * cía JDE** (o RFC/nombre como alterno). El estímulo sólo aplica sobre el
 * cálculo por depósito: cuando la factura SÍ trae su IVA, ese IVA manda (se
 * cotejó contra la factura).
 *
 * ── EVIDENCIA (Excel de Fiscal, recibidos 2026-07-09) → se queda VACÍO ─────
 * Las hojas `Ingresos TT`/`Ingresos SIR` traen la tasa POR FACTURA (`tasa iva`
 * = IVA16/IVA08/IVA0/EXTO), y el 8% NO es un atributo por empresa:
 *   · TT:  100% FEDERAL (transporte de pasaje exento) → IVA de ingresos = $0.
 *   · SIR: mayoría 16% ($28.97M de IVA) con una MINORÍA 8% ($2.9M, 82 de ~1,282
 *          facturas gravadas) — el 8% es por factura/servicio en la franja, no
 *          por cía. Marcar SIR como 8% blanket sobre-gravaría su 16%.
 * Como `accumulateCobranzaPaymentIva` usa la tasa de la factura cuando existe y
 * sólo cae a este catálogo para cobros-depósito SIN IVA de factura, dejar la
 * regla 8% vacía es lo correcto: el default 16% coincide con la mayoría real y
 * la factura gobierna el 8% donde aplica. Llenar `cias`/`rfcs` sólo si Fiscal
 * confirma una cía que sea fronteriza de forma uniforme.
 *
 * Estructura — análoga a `coordinadoFiscalCatalog.ts`: catálogo declarativo en
 * código (NO secreto) + resolver. Primer match gana; sin match ⇒ 16%.
 */

export type IvaRate = 8 | 16;

/** Tasa por defecto del IVA de ingresos (régimen general). */
export const DEFAULT_INCOME_IVA_RATE: IvaRate = 16;

export interface IvaRegionRateRule {
  /** Tasa de IVA de ingresos que aplica al grupo. */
  rate: IvaRate;
  /** Códigos `cia` JDE (autoritativo, padding-agnóstico). */
  cias?: string[];
  /** RFC de las empresas (autoritativo alterno). */
  rfcs?: string[];
  /** Patrones de nombre (case-insensitive, sin acentos) — fallback. */
  namePatterns?: RegExp[];
}

/**
 * Empresas/regiones que aplican una tasa distinta de la general (16%).
 *
 * VACÍO a propósito: Fiscal define qué cías aplican el estímulo de la región
 * fronteriza norte (8%). Al llenar `cias`/`rfcs`/`namePatterns` de la regla 8%,
 * esas empresas derivan su IVA de depósito a la tasa fronteriza; el resto sigue
 * al 16%.
 */
export const IVA_REGION_RATE_RULES: IvaRegionRateRule[] = [
  {
    rate: 8,
    cias: [], // p.ej. cías con operación en la franja fronteriza norte
    rfcs: [],
    namePatterns: [],
  },
];

function normalize(text: string): string {
  return (text ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function normalizeRfc(rfc: string): string {
  return (rfc ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

function ciaMatches(a: string, b: string): boolean {
  const ta = a.trim();
  const tb = b.trim();
  if (ta === tb) return true;
  const na = Number.parseInt(ta, 10);
  const nb = Number.parseInt(tb, 10);
  return Number.isFinite(na) && Number.isFinite(nb) && na === nb;
}

/**
 * Resuelve la tasa de IVA de ingresos de una empresa/región. Precedencia
 * cia → RFC → nombre; sin match ⇒ `DEFAULT_INCOME_IVA_RATE` (16%). `rules` es
 * inyectable para tests herméticos.
 */
export function resolveIncomeIvaRate(
  cia?: string,
  nombre?: string,
  rfc?: string,
  rules: IvaRegionRateRule[] = IVA_REGION_RATE_RULES,
): IvaRate {
  const ciaTrim = (cia ?? '').trim();
  const rfcTarget = normalizeRfc(rfc ?? '');
  const name = normalize((nombre ?? '').trim());

  for (const rule of rules) {
    if (ciaTrim && rule.cias?.some((c) => ciaMatches(c, ciaTrim))) return rule.rate;
    if (rfcTarget && rule.rfcs?.some((r) => normalizeRfc(r) === rfcTarget)) return rule.rate;
    if (name && rule.namePatterns?.some((re) => re.test(name))) return rule.rate;
  }
  return DEFAULT_INCOME_IVA_RATE;
}
