/**
 * Parámetros fijos del API /JDEdwards/AuxiliarContable.
 *
 *   tl      = "AA"   → libro mayor real (Tipo de Libro "General Accounting").
 *   nr      = 999    → parámetro numérico del API (valor documentado).
 *   objetos = [...]  → pares {ini, fin} de objeto contable a traer.
 *
 * Catálogo de objeto contable JDE (confirmado con Palomo 2026-05-25):
 *
 *   1000-1999  ACTIVOS                  (incl. 1010 Caja + 1020 Bancos)
 *   2000-2999  PASIVOS
 *   3000-3999  CAPITAL
 *   4000-4999  INGRESOS
 *   5000-5999  GASTOS DE OPERACIÓN
 *   6000-6999  LOGÍSTICA / MANTENIMIENTO
 *   7000-7999  GASTOS DE VENTA
 *   8000-8999  GASTOS ADMINISTRATIVOS
 *   9000       GASTOS FINANCIEROS
 *   9100       GASTOS DE DEPRECIACIÓN
 *   9300       OTROS GASTOS
 *
 * El API SÍ acepta `objIni ≠ objFin` (rango por categoría). Una request por
 * rango por día por cía. La conciliación banco↔ERP solo cruza 1010+1020,
 * pero traemos el libro completo para alimentar dashboards futuros (P&L,
 * gastos por categoría) sin tener que re-pegarle al API.
 */
export const AUX_RECON_PARAMS = {
  tl: 'AA',
  nr: 999,
  // Rango recortado a 1010-1020 (caja + bancos) — decisión 2026-05-26 #2.
  // Antes 1000-9999 (toda la contabilidad): JDE rebotaba con timeout 4min
  // en chunks de 7 días porque cada response arrastra cientos de miles de
  // records (activos+pasivos+capital+ingresos+gastos+depreciación). El
  // cruce banco↔ERP NO necesita ese histórico — solo objeto 1010+1020.
  // Si en el futuro se quiere alimentar dashboards de P&L o gastos por
  // categoría, añadir un fetch separado con rangos por bucket y cache
  // independiente — NO re-expandir este rango, vuelve a romper la
  // conciliación.
  objetos: [
    { ini: '1010', fin: '1020' },
  ] as const,
} as const;

/**
 * Parámetros del fetch SEPARADO de cuentas de IVA del libro mayor
 * (`fetchAuxiliarContableIvaRange` en jde.ts), con cache independiente
 * (`auxiliarcontable-iva`). NO se mezcla con `AUX_RECON_PARAMS` ni se expande
 * su rango — eso rompe la conciliación banco↔ERP y revive el timeout de 4 min.
 *
 * Descubrimiento en dos fases:
 *   - Fase A (discovery): un mes reciente sobre rangos candidato acotados
 *     (`discoveryObjetos`) para identificar por nombre qué objetos contables
 *     son IVA (ver `classifyIvaAccount` en domain/ivaLedger.ts).
 *   - Fase B (full): el rango histórico completo SOLO de esos objetos exactos.
 *
 * El IVA acreditable vive en ACTIVOS y el IVA trasladado/causado en PASIVOS.
 * El fetch de IVA es separado y cacheado por namespace versionado, así que
 * puede usar rangos más amplios sin tocar la conciliación 1010-1020. Si el
 * diagnóstico (`window.__midas__.ivaLedger`) no encuentra
 * cuentas de IVA, ampliar los rangos vía env `VITE_AUX_IVA_OBJETOS`
 * (CSV de pares `ini-fin`, p.ej. "1000-1999,2000-2999").
 */
function parseObjetoRanges(
  raw: string | undefined,
  fallback: readonly { ini: string; fin: string }[],
): readonly { ini: string; fin: string }[] {
  if (!raw) return fallback;
  const parsed = raw
    .split(',')
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const [ini, fin] = pair.split('-').map((s) => s.trim());
      return ini && fin ? { ini, fin } : null;
    })
    .filter((r): r is { ini: string; fin: string } => r !== null);
  return parsed.length > 0 ? parsed : fallback;
}

export const AUX_IVA_PARAMS = {
  tl: 'AA',
  nr: 999,
  // Rangos candidato para la fase de discovery (un mes). Acotados a la zona
  // donde vive el IVA: activos (acreditable) + pasivos (trasladado/causado).
  // v2 usaba 1100-1299/2100-2299 y dejó fuera cuentas pasivas reales de IVA
  // causado en algunos catálogos JDE. NO toca AUX_RECON_PARAMS.
  discoveryObjetos: parseObjetoRanges(
    typeof import.meta !== 'undefined' ? import.meta.env?.VITE_AUX_IVA_OBJETOS : undefined,
    [
      { ini: '1000', fin: '1999' },
      { ini: '2000', fin: '2999' },
    ],
  ),
} as const;

/**
 * Allowlist de cías a fetchear para AuxiliarContable (decisión 2026-05-25).
 *
 *   00001 TAMAULIPAS · 00011 SIR · 00033 MULTICARGA · 00038 STDN
 *   00043 SES · 00042 TICH
 *
 * Las demás cías se ignoran. Cía 33 (multicarga) está en la exclusión global
 * pero para auxiliar contable se incluye explícitamente — el bypass vive en
 * el boot loader (AppCore) y en `fetchAuxiliarContable` (jde.ts), no se toca
 * `EXCLUSION_RULES`.
 */
export const AUXILIAR_CIA_ALLOWLIST: readonly string[] = [
  '00001', '00011', '00033', '00038', '00042', '00043',
] as const;

/** Numeric form (padding-agnostic) for membership checks. */
export const AUXILIAR_CIA_ALLOWLIST_NUMS: ReadonlySet<number> = new Set(
  AUXILIAR_CIA_ALLOWLIST.map(s => parseInt(s, 10)),
);

export function isAuxiliarAllowlistedCia(cia: unknown): boolean {
  if (cia == null) return false;
  const n = typeof cia === 'number' ? cia : parseInt(String(cia).trim(), 10);
  return Number.isFinite(n) && AUXILIAR_CIA_ALLOWLIST_NUMS.has(n);
}

/**
 * Tipos de Batch que representan movimientos bancarios reales (cargo/abono
 * que pega cuenta 1010/1020). Catálogo JDE confirmado 2026-05-26.
 *
 *   Estados de cuenta:
 *     "+"   Estado de cuenta bancario
 *     "+B"  Estados de cuenta (variante)
 *   Cheques:
 *     "K"   Cheques de C/P (Automáticos)
 *     "L"   Cheques ALRS
 *     "M"   Cheques manuales y nulos con cotejamiento
 *     "W"   Cheques manuales sin cotejamiento
 *   Recibos / cobranza:
 *     "R"   Recibos de caja y ajustes
 *     "RB"  Recibos y ajustes
 *     "9"   Lockbox / Batch de recibos caja
 *     "9B"  Recibos automáticos
 *   Pagos directos / vouchers:
 *     "Q"   Pagos directos
 *     "V"   Registro de comprobantes (voucher → pago proveedor que pega 1020)
 *   Giros:
 *     "&"   Giros de C/P
 *     "&B"  Registro de giros
 *     "DB"  Recibos de giros
 *   General:
 *     "G"   Contabilidad general (asientos manuales que pueden afectar 1020)
 *
 * Quedan fuera a propósito:
 *   "I"/"IB" facturas — reconocimiento CXC, no cobro
 *   "#"/"#1" comprobantes nómina — reconocimiento, no dispersión
 *   "X", "XX", "N", "O", "F", "FB", "AR", "E", etc. — GL/operativo sin
 *   impacto bancario directo.
 *
 * Cualquier Tipo_Batch fuera de esta lista con cuenta_objeto=1020 es
 * sospechoso — el engine lo reporta como inconsistencia
 * (`non-bank-batch-in-1020`) para auditoría.
 */
export const BANK_TIPO_BATCH: ReadonlySet<string> = new Set([
  '+', '+B',
  'K', 'L', 'M', 'W',
  'R', 'RB', '9', '9B',
  'Q', 'V',
  '&', '&B', 'DB',
  'G',
]);
