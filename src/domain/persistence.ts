/**
 * Persistence layer for Midas — v12.
 *
 * v12 splits heavy record collections out of localStorage into IndexedDB.
 * localStorage tiene cuota ~5MB por origin y los heavies (cobranza 2 años ×
 * N cías + CXP + compras + pagoproveedor + nómina + payments) la rompían:
 * `setItem` lanzaba QuotaExceededError, persistence.saveStore lo silenciaba,
 * y el siguiente boot encontraba el store stale o vacío — refetcheaba JDE
 * desde cero. Ahora los heavies viven en `heavyStoreIDB` (cuota dinámica en
 * GB) y localStorage solo guarda configs ligeros + timestamps.
 *
 * Migración v11 → v12: al primer load detecta heavies embebidos en v11,
 * los empuja a IDB en background, re-escribe v12 light-only y elimina v11.
 *
 * v11 adds PagoProveedor (pagos ejecutados a proveedores) cache from POST
 * /JDEdwards/pagoproveedor, liberado a producción 2026-05-13. Es el
 * espejo egreso de cobranza: cierra el loop CXP/OC ↔ banco al traer los
 * pagos reales ya ejecutados.
 *   - `pagoProveedorRecords` — registros normalizados por (cia, noPago).
 *   - `pagoProveedorLoadedCias` — timestamp del último refresh (el endpoint
 *     no acepta filtro por cia; tracking global con la llave `__all__`).
 *
 * v10 adds Compras (órdenes de compra) cache from POST
 * /JDEdwards/compras, liberado a producción 2026-05-08.
 *   - `comprasRecords` — registros normalizados por (cia, noOrden, lineaOrden).
 *   - `comprasLoadedCias` — timestamps por cia (no aplica filtro de cia en el
 *     endpoint, pero igual lo trackeamos por consistencia con cxp/cobranza).
 *
 * v9 adds Client.jdeAccounts: enlaces persistidos entre el catálogo de
 * clientes y las cuentas JDE de cobranza (cia+noCliente). El primer boot
 * tras la migración deja `jdeAccounts` en undefined, lo que dispara el
 * auto-seed del matcher (clientCobranzaMatcher.ts).
 *
 * v8 adds IndicadoresCobranza payments (recibos/aplicaciones) as the
 * bridge between bank deposits and CXC invoices.
 *
 * v7 adds CXC support (cobranza) alongside the existing CXP records. The
 * cobranza endpoint (POST /JDEdwards/cobranza) was liberated to
 * production on 2026-05-01 by the JDE team; we persist the response so the
 * dashboard can show real receivables (and cross them against bank
 * movements) without re-fetching every load.
 *
 * v6 removes the legacy simulation model (proposals/scenarios/activeScenarioId)
 * that lived alongside the financial-planning native scenarios. Anything
 * scenario-related now lives in the financial-planning module storage; this
 * store only carries shared application data (catalogs, CXP, assumptions,
 * cash-flow overrides).
 *
 * Migrations:
 *   - midas-v11 → midas-v12: heavies (cxp/cobranza/compras/pagoproveedor/
 *     nómina/payments) salen de localStorage a IndexedDB. Pasada idempotente
 *     en background; el v11 se borra hasta que IDB confirma write.
 *   - midas-v7..v10 → midas-v12: misma migración + heavies vacíos seedean
 *     auto-fetch del boot.
 *   - midas-v5/v6 → midas-v12: drop legacy simulation, mismo path heavy.
 *   - flowsense-v5 → midas-v12: rebrand + drop simulation + heavy split.
 *   - flowsense-v1..v4 → midas-v12: incompatibles; preservar solo
 *     catálogos / CXP / assumptions (sin heavies).
 */

import { CashFlowOverrides } from '../types';
import { Provider, Client, CashFlowAssumptions, ConfirmedPayment } from './types';
import type {
  AuxiliarContableRecord,
  CobranzaPayment,
  CobranzaRecord,
  ComprasRecord,
  Company,
  PagoProveedorRecord,
  RolRecord,
  ViajeEspecialRecord,
} from '../services/jdeTypes';
import type { PayrollCostRecord } from '../modules/shared-finance/types';
import {
  emptyHeavyStore,
  loadHeavyStore as loadHeavyStoreFromIDB,
  saveHeavyStore as saveHeavyStoreToIDB,
  type HeavyStore,
} from '../services/heavyStoreIDB';

export type { HeavyKey, HeavyStore } from '../services/heavyStoreIDB';
export {
  loadHeavyStore,
  loadHeavyRecords,
  saveHeavyStore,
  saveHeavyRecords,
  clearHeavyStore,
} from '../services/heavyStoreIDB';

export interface CXPRecord {
  cia: string;
  noProveedor: string;
  nombre: string;
  noFactura: string;
  fechaFactura: string;
  fechaVence: string;
  fechaProgramacionPago: string;
  diasVencida: number;
  importeBrutoPesos: number;
  importePendientePesos: number;
  importeSubtotalPesos: number;
  importeImpuestosPesos: number;
  importeBrutoDolares: number;
  importePendienteDolares: number;
  moneda: string;
  condPago: string;
  clasifica: string;
  clasificacionProveedor: string;
  edoPago: string;
  tipoCambio: number;
  porVencer: number;
  v1_30: number;
  v31_60: number;
  v61_90: number;
  v91_120: number;
  v121_150: number;
  v151_180: number;
  mas180: number;
}

export interface AuxiliarIvaLoadedCiaMeta {
  version: string;
  loadedThrough: string;
  refreshedAt: string;
}

export interface MidasStore {
  providers: Provider[];
  clients: Client[];
  assumptions: CashFlowAssumptions;
  confirmedPayments: ConfirmedPayment[];
  cxpRecords: CXPRecord[];
  cxpLoadedCias: Record<string, string>;
  /**
   * Cobranza (CXC) records cached from POST /JDEdwards/cobranza.
   * One row per (cia, noFactura). Reset by clearStore() and refreshed
   * sequentially per cia at app boot — same pattern as cxpRecords.
   */
  cobranzaRecords: CobranzaRecord[];
  /**
   * Per-cia ISO timestamp of the last successful /cobranza response. Drives
   * the staleness UI badge in the Cobranza tab and lets us skip fetches
   * that were just refreshed in another browser tab.
   */
  cobranzaLoadedCias: Record<string, string>;
  /**
   * Pagos/recibos de IndicadoresCobranza, agrupados por Id Pago. Se usan
   * como capa intermedia banco → recibo → facturas.
   */
  cobranzaPayments: CobranzaPayment[];
  /** Per-cia ISO timestamp del último refresh exitoso de IndicadoresCobranza. */
  cobranzaPaymentsLoadedCias: Record<string, string>;
  /**
   * Compras (órdenes de compra) cacheadas de POST /JDEdwards/compras.
   * El endpoint es global (no por cia) y se consume por rangos de 30 días.
   */
  comprasRecords: ComprasRecord[];
  /**
   * Per-cia ISO timestamp del último refresh de Compras. El endpoint no acepta
   * filtro por cia, pero como los registros traen cia, lo trackeamos así para
   * consistencia con el resto del store.
   */
  comprasLoadedCias: Record<string, string>;
  /**
   * Pagos a proveedor cacheados de POST /JDEdwards/pagoproveedor.
   * Espejo egreso de cobranza. Endpoint global (no filtra por cia). Una row
   * por (cia, noPago). El loop banco↔CXP↔OC se cierra con estos datos.
   */
  pagoProveedorRecords: PagoProveedorRecord[];
  /**
   * Timestamp del último refresh de PagoProveedor. Endpoint global ⇒ trackeo
   * con la llave fija `__all__` (mismo patrón que `comprasLoadedCias`).
   */
  pagoProveedorLoadedCias: Record<string, string>;
  /**
   * Catálogo de compañías JDE cacheado del último fetch a /empresas. Permite
   * arrancar la app contra el catálogo conocido mientras la red repuebla en
   * background. Si está vacío, el boot espera al fetch para hidratar.
   */
  companies: Company[];
  /** ISO timestamp del último refresh exitoso de /empresas. */
  companiesLoadedAt?: string;
  /**
   * Registros de nómina TRESS normalizados (POST /v1/erp/tress/nomina).
   * Cache aditivo: el módulo de Nómina hace fetch por (idEmpresa, tipoNomina,
   * anio, mes) y mergea los registros nuevos sobre los existentes. Reset por
   * `clearStore()`.
   */
  nominaRecords: PayrollCostRecord[];
  /**
   * ISO timestamp del último fetch exitoso, indexado por la llave compuesta
   * `${idEmpresa}:${tipoNomina}:${anio}:${mes}`. El módulo lo consulta para
   * decidir si refresca o sirve cache.
   */
  nominaLoadedKeys: Record<string, string>;
  /**
   * ROL diario CITI: viajes ejecutados. Cache aditivo desde enero del año en
   * curso hasta hoy (ver `refreshRol` en App.tsx). Una row por
   * (cia, kCliente, anio, semana, ruta, tipoViaje). Heavy → vive en IDB.
   */
  rolRecords: RolRecord[];
  /**
   * ISO timestamp del último fetch ROL exitoso, indexado por
   * `${anio}:${semana}` (o `${anio}:full` cuando se fetcheó el año completo).
   * El boot decide si refrescar comparando contra la semana actual.
   */
  rolLoadedKeys: Record<string, string>;
  /**
   * Viajes Especiales (API srv-desarrollo:95/ViajesEspeciales/Servicios):
   * viajes ad-hoc con Factura_JDE + Fecha_Factura + Dias_Credito por viaje.
   * Cache aditivo año en curso. Heavy → vive en IDB. Una row por K_Renta.
   */
  viajesEspecialesRecords: ViajeEspecialRecord[];
  /**
   * ISO timestamp del último fetch Viajes Especiales exitoso, indexado por
   * `${anio}:full` (la ventana fija es Y-01-01..hoy, igual que ROL).
   */
  viajesEspecialesLoadedKeys: Record<string, string>;
  /**
   * Auxiliar contable JDE (POST /JDEdwards/AuxiliarContable): libro mayor
   * posteado contra cuentas de banco/caja. Fuente del motor de conciliación
   * histórica. Una row por (cia, idCuenta, noDocto, tipoDocto). Heavy → IDB.
   */
  auxiliarContableRecords: AuxiliarContableRecord[];
  /** Libro mayor de cuentas de IVA (acreditable + causado). Heavy → IDB. */
  auxiliarIvaRecords: AuxiliarContableRecord[];
  /**
   * Per-cia ISO timestamp del último refresh de AuxiliarContable. Mismo
   * patrón que `comprasLoadedCias` — UNA compañía por request.
   */
  auxiliarContableLoadedCias: Record<string, string>;
  /**
   * Cursor por cía del ledger de IVA. Versionado porque el cache diario depende
   * del set de objetos contables incluidos; v1 podía quedar incompleto.
   */
  auxiliarIvaLoadedCias: Record<string, AuxiliarIvaLoadedCiaMeta>;
  cashFlowOverrides: CashFlowOverrides;
  lastSaved: string;
}

const STORE_VERSION = 12;
const STORAGE_KEY = 'midas-v12';
// v5-v11 live at compatible shapes minus newer fields — `normalizeStore`
// defaults them to empty arrays / undefined jdeAccounts / empty compras /
// pagoProveedor caches, so those payloads load transparently y los auto-fetch
// loops del primer boot rellenan los caches faltantes. v11 además incluye los
// heavies inline en localStorage; el migrador los extrae a IDB y vuelve a
// escribir como v12 light-only.
const SAME_SCHEMA_LEGACY_KEYS = [
  'midas-v11',
  'midas-v10',
  'midas-v9',
  'midas-v8',
  'midas-v7',
  'midas-v6',
  'midas-v5',
  'flowsense-v5',
];
const LEGACY_KEYS = ['flowsense-v4', 'flowsense-v3', 'flowsense-v2', 'flowsense-v1'];

// Orphan keys de OperatingProjection (módulo eliminado). Se limpian al primer
// boot tras el cut para que el localStorage del usuario quede ordenado.
const ORPHAN_OPERATING_KEYS = [
  'midas.operating.scenarios.v1',
  'midas.operating.activeScenario.v1',
  'midas.operating.manualAdjustments.v1',
  'midas.operating.manualExpenseEvents.v1',
];

function purgeOrphanKeys(): void {
  for (const key of ORPHAN_OPERATING_KEYS) {
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  }
}

function isoNow(): string {
  return new Date().toISOString();
}

export function getDefaultStore(): MidasStore {
  return {
    providers: [],
    clients: [],
    assumptions: {
      year: new Date().getFullYear(),
      globalCompliance: 1,
      factorajeDays: 30,
    },
    confirmedPayments: [],
    cxpRecords: [],
    cxpLoadedCias: {},
    cobranzaRecords: [],
    cobranzaLoadedCias: {},
    cobranzaPayments: [],
    cobranzaPaymentsLoadedCias: {},
    comprasRecords: [],
    comprasLoadedCias: {},
    pagoProveedorRecords: [],
    pagoProveedorLoadedCias: {},
    companies: [],
    companiesLoadedAt: undefined,
    nominaRecords: [],
    nominaLoadedKeys: {},
    rolRecords: [],
    rolLoadedKeys: {},
    viajesEspecialesRecords: [],
    viajesEspecialesLoadedKeys: {},
    auxiliarContableRecords: [],
    auxiliarIvaRecords: [],
    auxiliarContableLoadedCias: {},
    auxiliarIvaLoadedCias: {},
    cashFlowOverrides: {},
    lastSaved: isoNow(),
  };
}

// ── Normalizadores defensivos ────────────────────────────────────────────

function isObjectWithStringId(v: unknown): v is Record<string, unknown> & { id: string } {
  return !!v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string';
}

function normalizeAssumptions(v: unknown, fallback: CashFlowAssumptions): CashFlowAssumptions {
  if (!v || typeof v !== 'object') return fallback;
  const o = v as Record<string, unknown>;
  const year = typeof o.year === 'number' && Number.isFinite(o.year) && o.year > 1900 && o.year < 3000
    ? Math.floor(o.year)
    : fallback.year;
  // globalCompliance debe estar en [0, 1].
  const rawCompliance = typeof o.globalCompliance === 'number' && Number.isFinite(o.globalCompliance)
    ? o.globalCompliance
    : fallback.globalCompliance;
  const globalCompliance = Math.min(1, Math.max(0, rawCompliance));
  const factorajeDays = typeof o.factorajeDays === 'number' && Number.isFinite(o.factorajeDays) && o.factorajeDays >= 0
    ? Math.floor(o.factorajeDays)
    : fallback.factorajeDays;
  return { year, globalCompliance, factorajeDays };
}

function normalizeConfirmedPayment(v: unknown): ConfirmedPayment | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (typeof o.key !== 'string' || typeof o.clientId !== 'string') return null;
  if (typeof o.realDate !== 'string' || typeof o.invoiceDate !== 'string') return null;
  if (typeof o.amount !== 'number' || !Number.isFinite(o.amount)) return null;
  if (typeof o.confirmedAt !== 'string') return null;
  return {
    key: o.key, clientId: o.clientId, realDate: o.realDate,
    invoiceDate: o.invoiceDate, amount: o.amount, confirmedAt: o.confirmedAt,
  };
}

function normalizeStore(raw: unknown): MidasStore {
  const base = getDefaultStore();
  if (!raw || typeof raw !== 'object') return base;
  const o = raw as Record<string, unknown>;

  // Filtramos por shape mínima: cualquier item que no tenga `id: string` se
  // descarta. CXPRecords no se modela con id; aceptamos cualquier objeto.
  const providers = Array.isArray(o.providers)
    ? (o.providers.filter(isObjectWithStringId) as unknown as Provider[])
    : [];
  const clients = Array.isArray(o.clients)
    ? (o.clients.filter(isObjectWithStringId) as unknown as Client[])
    : [];
  const confirmedPayments = Array.isArray(o.confirmedPayments)
    ? (o.confirmedPayments.map(normalizeConfirmedPayment).filter(Boolean) as ConfirmedPayment[])
    : [];
  const cxpRecords = Array.isArray(o.cxpRecords)
    ? (o.cxpRecords.filter((r) => !!r && typeof r === 'object') as CXPRecord[])
    : [];
  const cxpLoadedCias: Record<string, string> = {};
  if (o.cxpLoadedCias && typeof o.cxpLoadedCias === 'object') {
    for (const [k, val] of Object.entries(o.cxpLoadedCias as Record<string, unknown>)) {
      if (typeof val === 'string') cxpLoadedCias[k] = val;
    }
  }

  // Cobranza (CXC) — v7+. Older payloads simply lack these keys and fall back
  // to empty defaults, which lets the auto-fetch effect populate them on boot.
  // Importante: si el record cargado trae `raw` (heredado de un cache de
  // antes del fix de crash), lo eliminamos al cargar para que el siguiente
  // save no vuelva a persistirlo. Esto cura los browsers de los usuarios
  // que ya tenían un store inflado en localStorage.
  const cobranzaRecords = Array.isArray(o.cobranzaRecords)
    ? (o.cobranzaRecords
        .filter((r) => !!r && typeof r === 'object')
        .map((r) => {
          const rec = r as Record<string, unknown>;
          if ('raw' in rec) {
            const { raw: _drop, ...rest } = rec;
            void _drop;
            return rest as unknown as CobranzaRecord;
          }
          return r as CobranzaRecord;
        }) as CobranzaRecord[])
    : [];
  // Si la cache existente NO trae el nuevo campo `noClientePadre` (API
  // actualizado 2026-05-14 agregó padre + diasCredito + diaPago), invalidamos
  // timestamps para forzar refetch en el próximo boot. Una vez fresca, los
  // registros nuevos tendrán los campos y el grouping pasa a 'jde-padre'.
  const hasPadreField = cobranzaRecords.some((r) => 'noClientePadre' in r);
  const cobranzaLoadedCias: Record<string, string> = {};
  if (hasPadreField && o.cobranzaLoadedCias && typeof o.cobranzaLoadedCias === 'object') {
    for (const [k, val] of Object.entries(o.cobranzaLoadedCias as Record<string, unknown>)) {
      if (typeof val === 'string') cobranzaLoadedCias[k] = val;
    }
  } else if (!hasPadreField && cobranzaRecords.length > 0) {
    // eslint-disable-next-line no-console
    console.info('[persistence] cobranza cache pre-2026-05-14 detectada; invalidando timestamps para forzar refetch con campos nuevos (padre/diasCredito/diaPago).');
  }
  const cobranzaPayments = Array.isArray(o.cobranzaPayments)
    ? (o.cobranzaPayments.filter((r) => !!r && typeof r === 'object') as CobranzaPayment[])
    : [];
  const cobranzaPaymentsLoadedCias: Record<string, string> = {};
  if (o.cobranzaPaymentsLoadedCias && typeof o.cobranzaPaymentsLoadedCias === 'object') {
    for (const [k, val] of Object.entries(o.cobranzaPaymentsLoadedCias as Record<string, unknown>)) {
      if (typeof val === 'string') cobranzaPaymentsLoadedCias[k] = val;
    }
  }

  // Compras (Órdenes de Compra) — v10+. Payloads más viejos no traen estos
  // campos; el auto-fetch del boot los rellena en el primer arranque.
  const comprasRecords = Array.isArray(o.comprasRecords)
    ? (o.comprasRecords.filter((r) => !!r && typeof r === 'object') as ComprasRecord[])
    : [];
  const comprasLoadedCias: Record<string, string> = {};
  if (o.comprasLoadedCias && typeof o.comprasLoadedCias === 'object') {
    for (const [k, val] of Object.entries(o.comprasLoadedCias as Record<string, unknown>)) {
      if (typeof val === 'string') comprasLoadedCias[k] = val;
    }
  }

  // PagoProveedor — v11+. Mismo patrón: payloads viejos default a vacío,
  // auto-fetch boot rellena.
  const pagoProveedorRecords = Array.isArray(o.pagoProveedorRecords)
    ? (o.pagoProveedorRecords.filter((r) => !!r && typeof r === 'object') as PagoProveedorRecord[])
    : [];
  const pagoProveedorLoadedCias: Record<string, string> = {};
  if (o.pagoProveedorLoadedCias && typeof o.pagoProveedorLoadedCias === 'object') {
    for (const [k, val] of Object.entries(o.pagoProveedorLoadedCias as Record<string, unknown>)) {
      if (typeof val === 'string') pagoProveedorLoadedCias[k] = val;
    }
  }

  // Companies cache — payloads v10 y anteriores no traen este campo; default
  // a [] dispara el fetch normal en el primer boot tras el upgrade.
  const companies = Array.isArray(o.companies)
    ? (o.companies.filter((c) => {
        if (!c || typeof c !== 'object') return false;
        const rec = c as Record<string, unknown>;
        return typeof rec.cia === 'string' && typeof rec.nombre === 'string';
      }) as Company[])
    : [];
  const companiesLoadedAt = typeof o.companiesLoadedAt === 'string'
    ? o.companiesLoadedAt
    : undefined;

  // Nómina TRESS — aditivo desde el primer boot post-PR. Stores legacy
  // simplemente no traen estas keys y caen al default vacío; el módulo de
  // Nómina hará fetch on-demand en su primera apertura.
  const nominaRecords = Array.isArray(o.nominaRecords)
    ? (o.nominaRecords.filter((r) => !!r && typeof r === 'object') as PayrollCostRecord[])
    : [];
  const nominaLoadedKeys: Record<string, string> = {};
  if (o.nominaLoadedKeys && typeof o.nominaLoadedKeys === 'object') {
    for (const [k, val] of Object.entries(o.nominaLoadedKeys as Record<string, unknown>)) {
      if (typeof val === 'string') nominaLoadedKeys[k] = val;
    }
  }

  // ROL CITI — viajes ejecutados. Aditivo desde el primer boot post-PR.
  const rolRecords = Array.isArray(o.rolRecords)
    ? (o.rolRecords.filter((r) => !!r && typeof r === 'object') as RolRecord[])
    : [];
  const rolLoadedKeys: Record<string, string> = {};
  if (o.rolLoadedKeys && typeof o.rolLoadedKeys === 'object') {
    for (const [k, val] of Object.entries(o.rolLoadedKeys as Record<string, unknown>)) {
      if (typeof val === 'string') rolLoadedKeys[k] = val;
    }
  }

  // Viajes Especiales — aditivo. Stores legacy default a vacío; el boot
  // lo rellena en el primer arranque.
  const viajesEspecialesRecords = Array.isArray(o.viajesEspecialesRecords)
    ? (o.viajesEspecialesRecords.filter((r) => !!r && typeof r === 'object') as ViajeEspecialRecord[])
    : [];
  const viajesEspecialesLoadedKeys: Record<string, string> = {};
  if (o.viajesEspecialesLoadedKeys && typeof o.viajesEspecialesLoadedKeys === 'object') {
    for (const [k, val] of Object.entries(o.viajesEspecialesLoadedKeys as Record<string, unknown>)) {
      if (typeof val === 'string') viajesEspecialesLoadedKeys[k] = val;
    }
  }

  // Auxiliar contable JDE — aditivo. Stores legacy default a vacío; el boot
  // lo rellena por-cia en el primer arranque.
  const auxiliarContableRecords = Array.isArray(o.auxiliarContableRecords)
    ? (o.auxiliarContableRecords.filter((r) => !!r && typeof r === 'object') as AuxiliarContableRecord[])
    : [];
  const auxiliarIvaRecords = Array.isArray(o.auxiliarIvaRecords)
    ? (o.auxiliarIvaRecords.filter((r) => !!r && typeof r === 'object') as AuxiliarContableRecord[])
    : [];
  const auxiliarContableLoadedCias: Record<string, string> = {};
  if (o.auxiliarContableLoadedCias && typeof o.auxiliarContableLoadedCias === 'object') {
    for (const [k, val] of Object.entries(o.auxiliarContableLoadedCias as Record<string, unknown>)) {
      if (typeof val === 'string') auxiliarContableLoadedCias[k] = val;
    }
  }
  const auxiliarIvaLoadedCias: Record<string, AuxiliarIvaLoadedCiaMeta> = {};
  if (o.auxiliarIvaLoadedCias && typeof o.auxiliarIvaLoadedCias === 'object') {
    for (const [k, val] of Object.entries(o.auxiliarIvaLoadedCias as Record<string, unknown>)) {
      if (!val || typeof val !== 'object') continue;
      const meta = val as Record<string, unknown>;
      if (
        typeof meta.version === 'string' &&
        typeof meta.loadedThrough === 'string' &&
        typeof meta.refreshedAt === 'string'
      ) {
        auxiliarIvaLoadedCias[k] = {
          version: meta.version,
          loadedThrough: meta.loadedThrough,
          refreshedAt: meta.refreshedAt,
        };
      }
    }
  }

  return {
    providers,
    clients,
    confirmedPayments,
    cxpRecords,
    cxpLoadedCias,
    cobranzaRecords,
    cobranzaLoadedCias,
    cobranzaPayments,
    cobranzaPaymentsLoadedCias,
    comprasRecords,
    comprasLoadedCias,
    pagoProveedorRecords,
    pagoProveedorLoadedCias,
    companies,
    companiesLoadedAt,
    nominaRecords,
    nominaLoadedKeys,
    rolRecords,
    rolLoadedKeys,
    viajesEspecialesRecords,
    viajesEspecialesLoadedKeys,
    auxiliarContableRecords,
    auxiliarIvaRecords,
    auxiliarContableLoadedCias,
    auxiliarIvaLoadedCias,
    cashFlowOverrides: normalizeOverrides(o.cashFlowOverrides),
    assumptions: normalizeAssumptions(o.assumptions, base.assumptions),
    lastSaved: typeof o.lastSaved === 'string' ? o.lastSaved : base.lastSaved,
  };
}

function normalizeOverrides(v: unknown): CashFlowOverrides {
  if (!v || typeof v !== 'object') return {};
  const out: CashFlowOverrides = {};
  for (const [ym, val] of Object.entries(v as Record<string, unknown>)) {
    if (!/^\d{4}-\d{2}$/.test(ym) || !val || typeof val !== 'object') continue;
    const entry = val as Record<string, unknown>;
    const income = typeof entry.income === 'number' && isFinite(entry.income) ? entry.income : undefined;
    const expense = typeof entry.expense === 'number' && isFinite(entry.expense) ? entry.expense : undefined;
    if (income === undefined && expense === undefined) continue;
    out[ym] = { ...(income !== undefined ? { income } : {}), ...(expense !== undefined ? { expense } : {}) };
  }
  return out;
}

// ── Backend IndexedDB (preferido) ────────────────────────────────────────
// localStorage tiene un cap de ~5MB y serializa/parsea SÍNCRONAMENTE en el
// main thread. Con datasets grandes (cobranza productiva: ~30k facturas en
// las 8 cías → ~6-8MB serializado) chocábamos contra el quota y, aunque el
// catch silenciaba el throw, el costo del JSON.stringify de 4MB ya bloqueaba
// el thread varios cientos de ms en cada escritura. IndexedDB no tiene cap
// práctico (cuotas por origen del orden de cientos de MB) y la transacción
// corre fuera del main thread una vez disparada. Mantenemos localStorage
// como fallback sincrónico (tests, browsers viejos, unload flush).

const IDB_NAME = 'midas-db';
const IDB_VERSION = 1;
const IDB_STORE = 'kv';
const IDB_KEY = STORAGE_KEY; // mismo nombre que en localStorage para simetría.

function openIdb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(IDB_NAME, IDB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

async function idbDelete(): Promise<void> {
  const db = await openIdb();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).delete(IDB_KEY);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); resolve(); };
      tx.onabort = () => { db.close(); resolve(); };
    } catch {
      db.close();
      resolve();
    }
  });
}

// ── API pública ──────────────────────────────────────────────────────────

/**
 * Extrae los campos heavy de un MidasStore para snapshotearlos por separado.
 * Los heavies viven en IDB (cuota dinámica en GB); el resto vive en
 * localStorage (cuota ~5MB pero suficiente para configs + timestamps).
 */
function pickHeavy(store: MidasStore): HeavyStore {
  return {
    cxpRecords: store.cxpRecords,
    cobranzaRecords: store.cobranzaRecords,
    cobranzaPayments: store.cobranzaPayments,
    comprasRecords: store.comprasRecords,
    pagoProveedorRecords: store.pagoProveedorRecords,
    nominaRecords: store.nominaRecords,
    rolRecords: store.rolRecords,
    viajesEspecialesRecords: store.viajesEspecialesRecords,
    auxiliarContableRecords: store.auxiliarContableRecords,
    auxiliarIvaRecords: store.auxiliarIvaRecords,
  };
}

/**
 * Reemplaza los heavies de un MidasStore con arrays vacíos. Lo que va a
 * localStorage en v12 — los heavies salen a IDB vía `saveHeavyStore`.
 */
function stripHeavy(store: MidasStore): MidasStore {
  return { ...store, ...emptyHeavyStore() };
}

/**
 * Persiste el store. En v12 los heavies salen a IndexedDB; localStorage
 * solo guarda configs ligeros (catalogs, timestamps, assumptions). Si
 * IDB falla, los heavies se pierden pero el resto de la app sigue viva.
 *
 * El write a IDB es fire-and-forget (la promesa se descarta); el caller
 * debe coalescer las llamadas (debounce) para no saturarlo.
 */
export function saveStore(store: MidasStore): void {
  saveLightStore(store);
  void saveHeavyStoreToIDB(pickHeavy(store));
}

/**
 * Persiste SOLO el light (a localStorage). NO toca IDB heavy. Útil cuando
 * sabes que solo cambió data ligera (assumptions, providers, etc.) y quieres
 * evitar el costo de re-serializar los heavies (que cargan 100k+ records).
 */
export function saveLightStore(store: MidasStore): void {
  const light = stripHeavy({ ...store, lastSaved: new Date().toISOString() });
  const payload = { version: STORE_VERSION, data: light };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch (err) {
    // Silenciar quota — la app debe seguir viva aunque persistencia falle.
    // Con v12 esto solo debería pasar si el catálogo de clientes/providers
    // crece a megabytes; si pasa, hay que mover esos también a IDB.
    // eslint-disable-next-line no-console
    console.warn('[persistence] saveLightStore failed:', err);
  }
}

/**
 * Carga el store completo. Async porque los heavies viven en IDB.
 *
 * Migración v11 → v12:
 *   1. Detecta payload v11 (legacy) en localStorage con heavies inline.
 *   2. Construye MidasStore desde v11.
 *   3. Escribe heavies a IDB (await).
 *   4. Re-escribe v12 light-only a localStorage.
 *   5. Borra v11.
 *
 * En boots normales (v12 ya existente), lee light de localStorage + heavies
 * de IDB en paralelo y los une.
 */
export async function loadStore(): Promise<MidasStore | null> {
  purgeOrphanKeys();

  // Path 1: v12 light-only en localStorage + heavies en IDB.
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const payload = JSON.parse(raw) as { version?: number; data?: unknown };
      if (payload && typeof payload === 'object' && payload.data !== undefined) {
        const light = normalizeStore(payload.data);
        const heavy = await loadHeavyStoreFromIDB();
        return { ...light, ...heavy };
      }
    }
  } catch {
    // fallthrough
  }

  // Path 2: Same-shape migrations (v5..v11 + flowsense-v5). v11 trae
  // heavies inline en localStorage; los movemos a IDB antes de marcar
  // la migración como completa (delete v11 tras IDB confirmar write).
  for (const legacyKey of SAME_SCHEMA_LEGACY_KEYS) {
    try {
      const raw = localStorage.getItem(legacyKey);
      if (!raw) continue;
      const payload = JSON.parse(raw) as { version?: number; data?: unknown };
      if (payload && typeof payload === 'object' && payload.data !== undefined) {
        const dropsLegacySimulation = legacyKey === 'midas-v5' || legacyKey === 'flowsense-v5';
        const isV11Heavy = legacyKey === 'midas-v11';
        // eslint-disable-next-line no-console
        console.info(
          `[persistence] migrando ${legacyKey} → ${STORAGE_KEY}` +
            (dropsLegacySimulation
              ? '; descartando propuestas/escenarios legacy.'
              : isV11Heavy
                ? '; moviendo heavies (cobranza/cxp/compras/pagoproveedor/nómina) a IndexedDB.'
                : '; agregando caches/jdeAccounts faltantes.'),
        );
        const migrated = normalizeStore(payload.data);
        // Escribimos heavies a IDB ANTES de borrar legacy key, para no
        // perder datos si IDB falla. Si el await no resuelve heavy a tiempo,
        // legacy queda intacto y el siguiente boot reintenta migración.
        await saveHeavyStoreToIDB(pickHeavy(migrated));
        // CRÍTICO: borrar legacy ANTES de intentar escribir v12. El v11 ocupa
        // hasta 50MB en localStorage (heavies inline) — escribir v12 con v11
        // todavía dentro tira QuotaExceededError, el v12 se pierde y el boot
        // siguiente repite la migración en loop, congelando la app.
        // El v11 ya quedó copiado a IDB (heavies) + memoria (`migrated`); es
        // seguro borrarlo. Si crasheamos entre estos pasos, perdemos light
        // (clients/providers metadata) pero IDB sobrevive y el next-boot hace
        // cold-fetch desde JDE — degradación graceful, no estado corrupto.
        try { localStorage.removeItem(legacyKey); } catch { /* ignore */ }
        const lightPayload = { version: STORE_VERSION, data: stripHeavy(migrated) };
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(lightPayload));
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn('[persistence] no se pudo escribir v12 light tras migración:', err);
        }
        return migrated;
      }
    } catch {
      // fallthrough
    }
  }

  // Path 3: Stores legacy v1..v4: modelo de propuestas/escenarios totalmente
  // incompatible. Conservamos los datos independientes (clientes, proveedores,
  // cxp, assumptions, confirmedPayments).
  for (const legacyKey of LEGACY_KEYS) {
    try {
      const raw = localStorage.getItem(legacyKey);
      if (!raw) continue;
      const payload = JSON.parse(raw) as { version?: number; data?: unknown };
      const legacy = (payload && typeof payload === 'object' && payload.data
        ? payload.data
        : payload) as Record<string, unknown>;
      // eslint-disable-next-line no-console
      console.info(`[persistence] encontrado store legacy ${legacyKey}; migrando datos independientes y descartando propuestas/escenarios.`);
      const seed: MidasStore = {
        ...getDefaultStore(),
        providers: Array.isArray(legacy.providers) ? (legacy.providers as Provider[]) : [],
        clients: Array.isArray(legacy.clients) ? (legacy.clients as Client[]) : [],
        confirmedPayments: Array.isArray(legacy.confirmedPayments) ? (legacy.confirmedPayments as ConfirmedPayment[]) : [],
        cxpRecords: Array.isArray(legacy.cxpRecords) ? (legacy.cxpRecords as CXPRecord[]) : [],
        cxpLoadedCias: (legacy.cxpLoadedCias && typeof legacy.cxpLoadedCias === 'object'
          ? (legacy.cxpLoadedCias as Record<string, string>) : {}),
        assumptions: (legacy.assumptions && typeof legacy.assumptions === 'object'
          ? (legacy.assumptions as CashFlowAssumptions)
          : getDefaultStore().assumptions),
      };
      await saveHeavyStoreToIDB(pickHeavy(seed));
      saveStore(seed);
      try { localStorage.removeItem(legacyKey); } catch { /* ignore */ }
      return seed;
    } catch {
      // try next legacy key
    }
  }

  return null;
}

/**
 * Carga solo el store ligero. No toca IndexedDB heavy; sirve para que el shell
 * inicial pinte con catálogos/timestamps y difiera las colecciones grandes
 * hasta que una pestaña las pida.
 */
export async function loadLightStore(): Promise<MidasStore | null> {
  purgeOrphanKeys();

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const payload = JSON.parse(raw) as { version?: number; data?: unknown };
      if (payload && typeof payload === 'object' && payload.data !== undefined) {
        return normalizeStore(payload.data);
      }
    }
  } catch {
    // fall through to migration/full loader
  }

  // Legacy stores may still carry heavies inline and need the existing
  // migration path. This only happens once per browser profile.
  return loadStore();
}

export function clearStore(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
    for (const k of SAME_SCHEMA_LEGACY_KEYS) localStorage.removeItem(k);
    for (const k of LEGACY_KEYS) localStorage.removeItem(k);
  } catch {
    // ignore
  }
  // Best-effort fire-and-forget: limpia IDB también. Si falla no importa
  // (la app re-fetchea data del API en el próximo boot).
  void idbDelete();
}

/**
 * Export incluye heavies en el blob — los respaldos son user-driven y deben
 * preservar todo. El consumer (download as JSON) puede manejar el tamaño.
 */
export function exportStore(store: MidasStore): string {
  return JSON.stringify({ version: STORE_VERSION, data: store }, null, 2);
}

export function importStore(json: string): MidasStore {
  const parsed = JSON.parse(json) as { version?: number; data?: unknown };
  if (!parsed || typeof parsed !== 'object' || parsed.data === undefined) {
    throw new Error('Formato de respaldo inválido.');
  }
  return normalizeStore(parsed.data);
}
