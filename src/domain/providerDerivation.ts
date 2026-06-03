/**
 * providerDerivation — construye el catálogo de proveedores a partir de las
 * fuentes transaccionales JDE (antigüedad de saldos, compras, pagos a
 * proveedor). El JSON de Alberto se reduce a overlay de `score` (y los 4
 * sub-criterios). La clasificación automática (CRITICO/ALTO/MEDIO/BAJO) se
 * deriva del score por umbrales fijos. Sin score → "Sin score".
 *
 * Llave canónica: número JDE (`normalizeJdeKey`). Nombre normalizado como
 * fallback. Salida: `Provider[]` con `type`/categoría inferida con la
 * mayor especificidad disponible (compras > CXP > pagoProveedor).
 *
 * Reglas de negocio embebidas (no editables por usuario):
 *   - Busbud → categoría "Federal" (cliente + proveedor de Federal).
 */

import type { Provider, ProviderFlexibility, ProviderRisk } from './types';
import type { ComprasRecord, PagoProveedorRecord } from '../services/jdeTypes';
import { normalizeJdeKey, normalizeProviderName } from './providerIdentity';

/**
 * Tipo/categoría canónica asignada a los "proveedores" que en realidad son
 * empleados (nómina / reembolsos / vales). Permite segmentarlos en la UI y
 * sacarlos del conteo de proveedores sin catálogo.
 */
export const EMPLOYEE_PROVIDER_TYPE = 'Prestaciones';

/** Patrones de clasificación textual que delatan un pago a empleado. */
const EMPLOYEE_CLASS_RE = /\b(N[OÓ]MINA|REEMBOLSO|VALE|VI[AÁ]TIC|FINIQUITO|AGUINALDO)/i;

/**
 * Señal autoritativa del API: `PagoProveedorRecord.tipoBusqueda === 'Employees'`
 * marca reembolsos/nómina. Helper compartido (ver `Pagos.tsx::isEmployeePayment`).
 */
export function isEmployeeSearchType(tipoBusqueda?: string | null): boolean {
  return (tipoBusqueda ?? '').trim().toLowerCase().startsWith('employee');
}

/** Fallback por texto de clasificación cuando no hay `tipoBusqueda` (p.ej. CXP). */
export function isEmployeeClassificationText(...texts: Array<string | undefined | null>): boolean {
  return texts.some((t) => !!t && EMPLOYEE_CLASS_RE.test(t));
}

/**
 * Subset shared por `CXPRecord` (persistence) y `AgedBalanceRecord` (jdeTypes).
 * El derivador sólo necesita estos campos para clasificar.
 */
export interface AgedRecordLike {
  noProveedor: string;
  nombre: string;
  clasificacionProveedor: string;
  clasifica: string;
  importePendientePesos: number;
  fechaFactura: string;
  condPago: string;
}

export interface ScoreEntry {
  numProveedor: string;
  nombre: string;
  score: number | null;
  scoreCriterios?: {
    sustituibilidad: number;
    impactoOperativo: number;
    riesgoLegal: number;
    diasCredito: number;
  } | null;
}

/** Umbrales fijos (mismos del JSON original): score → clasificación. */
function clasificacionFromScore(score: number | null | undefined): 'CRITICO' | 'ALTO' | 'MEDIO' | 'BAJO' | null {
  if (score === null || score === undefined || !Number.isFinite(score)) return null;
  if (score >= 80) return 'CRITICO';
  if (score >= 60) return 'ALTO';
  if (score >= 40) return 'MEDIO';
  return 'BAJO';
}

export interface ScoreOverlay {
  byJde: Map<string, ScoreEntry>;
  byName: Map<string, ScoreEntry>;
}

/** Build score overlay from Alberto JSON entries (loaded once, passed in). */
export function buildScoreOverlay(entries: ScoreEntry[]): ScoreOverlay {
  const byJde = new Map<string, ScoreEntry>();
  const byName = new Map<string, ScoreEntry>();
  for (const e of entries) {
    const jdeKey = normalizeJdeKey(e.numProveedor);
    if (jdeKey) byJde.set(jdeKey, e);
    const nameKey = normalizeProviderName(e.nombre);
    if (nameKey && !byName.has(nameKey)) byName.set(nameKey, e);
  }
  return { byJde, byName };
}

export interface DeriveProvidersInputs {
  agedBalanceRecords?: AgedRecordLike[];
  comprasRecords?: ComprasRecord[];
  pagoProveedorRecords?: PagoProveedorRecord[];
  scoreOverlay?: ScoreOverlay;
}

interface ProviderAccumulator {
  jdeKey: string;
  numProveedor: string;
  /** All name variants seen, with source weight. */
  names: Array<{ name: string; weight: number }>;
  /** Category signals collected with priority (lower = more specific). */
  categorySignals: Array<{ source: CategorySource; value: string }>;
  /** Total monetary volume seen — used to break ties between providers. */
  volume: number;
  /** Number of distinct invoices/orders/payments. */
  txCount: number;
  /** Source systems where this provider appeared. */
  sources: Set<'CXP' | 'COMPRAS' | 'PAGOS'>;
  /** Days of credit hint (from CXP condPago / Compras diasCredito). */
  diasCreditoHint?: number;
  /** Most recent activity ISO. */
  lastSeen?: string;
  /** Empleado disfrazado de proveedor (nómina/reembolsos) según señal del API. */
  isEmployee?: boolean;
}

type CategorySource =
  | 'compras-familia'      // Desc_Familia from compras (most specific)
  | 'compras-categoria'    // Desc_Categoria
  | 'cxp-clasificacion'    // CXP clasificacionProveedor
  | 'cxp-clasifica'        // CXP clasifica (raw)
  | 'pp-clasificacion'     // PagoProveedor clasificacionProveedor
  | 'pp-financiera';       // PagoProveedor clasificacionProveedorFinanciera ("220 - ...")

const SOURCE_PRIORITY: CategorySource[] = [
  'compras-familia',
  'compras-categoria',
  'cxp-clasificacion',
  'cxp-clasifica',
  'pp-clasificacion',
  'pp-financiera',
];

/**
 * Busbud: cliente Y proveedor de Federal. Hardcoded para que la categoría
 * Federal aplique aún si el dato JDE viene con otra clasificación o vacío.
 */
const BUSBUD_NAME_PATTERN = /\bBUSBUD\b/i;

function pickBestName(names: Array<{ name: string; weight: number }>): string {
  if (names.length === 0) return '';
  // Pondera por (weight, longitud, no contiene "(NO USAR)").
  const scored = names.map((n) => {
    let s = n.weight * 100 + n.name.length;
    if (/NO USAR/i.test(n.name)) s -= 1000;
    return { ...n, s };
  });
  scored.sort((a, b) => b.s - a.s);
  return scored[0].name;
}

function pickCategorySignal(signals: ProviderAccumulator['categorySignals']): string {
  if (signals.length === 0) return '';
  // Priorizar por SOURCE_PRIORITY. Strip prefijos "220 - " de pp-financiera.
  for (const source of SOURCE_PRIORITY) {
    const hit = signals.find((s) => s.source === source && s.value.trim());
    if (hit) return stripFinancieraPrefix(hit.value).trim();
  }
  return '';
}

function stripFinancieraPrefix(value: string): string {
  // PagoProveedor.clasificacionProveedorFinanciera viene como "220 - Por Clasificar".
  // Quitar el prefijo numérico para alinear con las otras fuentes.
  return value.replace(/^\d{2,4}\s*-\s*/, '');
}

function pushName(acc: ProviderAccumulator, name: string, weight: number) {
  const trimmed = (name || '').trim();
  if (!trimmed) return;
  acc.names.push({ name: trimmed, weight });
}

function pushSignal(acc: ProviderAccumulator, source: CategorySource, value: string | undefined) {
  const trimmed = (value || '').trim();
  if (!trimmed) return;
  // Saltar los placeholders más comunes que no aportan.
  if (/^POR\s*CLASIFICAR$/i.test(trimmed)) return;
  if (/^SIN\s*CLASIFICAR$/i.test(trimmed)) return;
  if (/^N\/?A$/i.test(trimmed)) return;
  acc.categorySignals.push({ source, value: trimmed });
}

function ensureAcc(map: Map<string, ProviderAccumulator>, num: string): ProviderAccumulator | null {
  const jdeKey = normalizeJdeKey(num);
  if (!jdeKey) return null;
  let acc = map.get(jdeKey);
  if (!acc) {
    acc = {
      jdeKey,
      numProveedor: num,
      names: [],
      categorySignals: [],
      volume: 0,
      txCount: 0,
      sources: new Set(),
    };
    map.set(jdeKey, acc);
  }
  return acc;
}

function updateLastSeen(acc: ProviderAccumulator, date: string | undefined) {
  if (!date) return;
  if (!acc.lastSeen || date > acc.lastSeen) acc.lastSeen = date;
}

function flexFromAutomatica(cls: 'CRITICO' | 'ALTO' | 'MEDIO' | 'BAJO' | null): ProviderFlexibility {
  switch (cls) {
    case 'CRITICO': return 'inamovible';
    case 'ALTO':
    case 'MEDIO': return 'revisar';
    case 'BAJO': return 'flexible';
    default: return 'unknown';
  }
}

function riskFromAutomatica(cls: 'CRITICO' | 'ALTO' | 'MEDIO' | 'BAJO' | null): ProviderRisk {
  switch (cls) {
    case 'CRITICO':
    case 'ALTO': return 'Alto';
    case 'MEDIO': return 'Medio';
    case 'BAJO': return 'Bajo';
    default: return 'Medio';
  }
}

function paymentPeriodFromDays(days: number | undefined): Provider['paymentPeriod'] {
  if (days === undefined || days === null || !Number.isFinite(days)) return '30 días';
  if (days <= 0) return 'Contado';
  if (days <= 15) return '15 días';
  if (days <= 30) return '30 días';
  if (days <= 45) return '45 días';
  if (days <= 60) return '60 días';
  return '90 días';
}

function applyBusinessRules(name: string, categoria: string): string {
  // Busbud → Federal (cliente + proveedor de Federal por regla de negocio).
  if (BUSBUD_NAME_PATTERN.test(name)) return 'Federal';
  return categoria;
}

/**
 * Derive providers from JDE transactional data.
 *
 * Score-only overlay: si un proveedor matchea el overlay de Alberto, se le
 * adjuntan score / clasificacionAlberto / scoreCriterios. Sin match →
 * clasificacionAlberto = 'SIN_CLASIFICAR', score = undefined.
 */
export function deriveProvidersFromJde(inputs: DeriveProvidersInputs): Provider[] {
  const accs = new Map<string, ProviderAccumulator>();

  // 1) CXP / Antigüedad de saldos.
  for (const rec of inputs.agedBalanceRecords ?? []) {
    const acc = ensureAcc(accs, rec.noProveedor);
    if (!acc) continue;
    acc.sources.add('CXP');
    pushName(acc, rec.nombre, 1);
    pushSignal(acc, 'cxp-clasificacion', rec.clasificacionProveedor);
    pushSignal(acc, 'cxp-clasifica', rec.clasifica);
    // CXP no trae `tipoBusqueda`; detectamos empleados sólo por texto.
    if (isEmployeeClassificationText(rec.clasificacionProveedor, rec.clasifica)) {
      acc.isEmployee = true;
    }
    acc.volume += Math.abs(rec.importePendientePesos || 0);
    acc.txCount += 1;
    updateLastSeen(acc, rec.fechaFactura);
    // condPago "30", "15", "C", etc. Take first numeric hint.
    if (acc.diasCreditoHint === undefined) {
      const days = parseCondPagoToDays(rec.condPago);
      if (days !== undefined) acc.diasCreditoHint = days;
    }
  }

  // 2) Compras (OC). Más específico para categoría (familia/categoria).
  for (const rec of inputs.comprasRecords ?? []) {
    const acc = ensureAcc(accs, rec.noProveedor);
    if (!acc) continue;
    acc.sources.add('COMPRAS');
    pushName(acc, rec.nombreProveedor, 2);
    pushSignal(acc, 'compras-familia', rec.descFamilia);
    pushSignal(acc, 'compras-categoria', rec.descCategoria);
    acc.volume += Math.abs(rec.importeTotal || 0);
    acc.txCount += 1;
    updateLastSeen(acc, rec.fechaPedido);
    if (acc.diasCreditoHint === undefined && rec.diasCredito > 0) {
      acc.diasCreditoHint = rec.diasCredito;
    }
  }

  // 3) PagoProveedor. Confirmado (ejecutado), pero clasificación más genérica.
  for (const rec of inputs.pagoProveedorRecords ?? []) {
    const acc = ensureAcc(accs, rec.claveProveedor);
    if (!acc) continue;
    acc.sources.add('PAGOS');
    pushName(acc, rec.nombreProveedor, 1);
    pushSignal(acc, 'pp-clasificacion', rec.clasificacionProveedor);
    pushSignal(acc, 'pp-financiera', rec.clasificacionProveedorFinanciera);
    // Señal autoritativa del API: tipoBusqueda 'Employees' o texto de clasificación.
    if (isEmployeeSearchType(rec.tipoBusqueda) || isEmployeeClassificationText(rec.clasificacionProveedor)) {
      acc.isEmployee = true;
    }
    acc.volume += Math.abs(rec.importePesos || 0);
    acc.txCount += 1;
    updateLastSeen(acc, rec.fechaPago);
  }

  // 4) Build Provider[] desde acumuladores. Sin match con overlay → SIN SCORE.
  const overlay = inputs.scoreOverlay;
  const providers: Provider[] = [];

  for (const acc of accs.values()) {
    const rawName = pickBestName(acc.names) || `Proveedor ${acc.numProveedor}`;
    const categoriaRaw = pickCategorySignal(acc.categorySignals);
    const categoria = applyBusinessRules(rawName, categoriaRaw);
    // Empleados disfrazados de proveedor: tipo canónico propio para sacarlos
    // del bucket "Sin clasificar" / del conteo de proveedores sin catálogo.
    const resolvedType = acc.isEmployee
      ? EMPLOYEE_PROVIDER_TYPE
      : (categoria || 'Sin categoría');

    // Score overlay match: by JDE key first, fallback to normalized name.
    let overlayEntry: ScoreEntry | undefined;
    if (overlay) {
      overlayEntry = overlay.byJde.get(acc.jdeKey);
      if (!overlayEntry) {
        const nameKey = normalizeProviderName(rawName);
        if (nameKey) overlayEntry = overlay.byName.get(nameKey);
      }
    }

    const score = overlayEntry?.score ?? null;
    const clasificacionAutomatica = clasificacionFromScore(score);
    const flexibility = flexFromAutomatica(clasificacionAutomatica);
    const risk = riskFromAutomatica(clasificacionAutomatica);

    providers.push({
      id: `derived-${acc.jdeKey}`,
      name: rawName,
      type: resolvedType,
      isEmployee: acc.isEmployee || undefined,
      risk,
      flexibility,
      paymentPeriod: paymentPeriodFromDays(acc.diasCreditoHint),
      flexibilityComment: undefined,
      riskComment: undefined,
      creditLimit: undefined,
      lastUpdatedAt: acc.lastSeen ? `${acc.lastSeen}T00:00:00.000Z` : undefined,
      dtiArea: undefined,
      dtiCriticidad: undefined,
      clasificacionAlberto: 'SIN_CLASIFICAR',
      clasificacionAlbertoRaw: undefined,
      clasificacionAutomatica: clasificacionAutomatica ?? undefined,
      score: score ?? undefined,
      scoreCriterios: overlayEntry?.scoreCriterios ?? undefined,
      numProveedorJDE: acc.numProveedor,
      frecuenciaHistorica: undefined,
      montoPromedioPago: undefined,
      numPagos2025: undefined,
      montoTotal2025: undefined,
      gastoMinimoMensual: undefined,
    });
  }

  providers.sort((a, b) => a.name.localeCompare(b.name, 'es'));
  return providers;
}

function parseCondPagoToDays(condPago: string | undefined): number | undefined {
  if (!condPago) return undefined;
  const trimmed = condPago.trim().toUpperCase();
  if (trimmed === 'C' || trimmed === 'CONTADO' || trimmed === '0') return 0;
  const n = parseInt(trimmed, 10);
  return Number.isFinite(n) ? n : undefined;
}
