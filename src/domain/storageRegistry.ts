// ─────────────────────────────────────────────────────────────────────────
// storageRegistry — inventario central de TODA la persistencia de Midas.
//
// Midas no tiene backend: el estado vive en `localStorage` + IndexedDB del
// navegador, repartido en ~30 keys y 4 bases IDB que cada módulo declara por
// su cuenta. Este archivo es el único lugar que las enumera, para:
//   1. Documentar qué persiste dónde y quién es el dueño.
//   2. Ofrecer `clearAllMidasStorage()` — un borrado total coordinado
//      (logout / reset / soporte) que no se le escapa ninguna key.
//
// NO reemplaza los helpers de cada módulo (`loadTaxStore`, `loadChangeLog`,
// `loadStore`, …). Esos siguen siendo la vía de lectura/escritura. El
// registro es el mapa, no el cajero.
//
// Si agregas una key nueva: regístrala aquí en el mismo PR.
// ─────────────────────────────────────────────────────────────────────────

export type StorageScope = 'localStorage' | 'indexedDB';

export interface StorageEntry {
  /** Key de localStorage o nombre de base IndexedDB. */
  key: string;
  scope: StorageScope;
  /** Archivo/módulo que es dueño de la key. */
  owner: string;
  /** Qué guarda. */
  description: string;
  /**
   * true → resto de una versión/migración anterior. Se purga en
   * `clearAllMidasStorage()` y puede borrarse en cualquier momento.
   */
  legacy?: boolean;
}

export const MIDAS_STORAGE_REGISTRY: StorageEntry[] = [
  // ── Core store ──────────────────────────────────────────────────────────
  { key: 'midas-v12', scope: 'localStorage', owner: 'domain/persistence.ts', description: 'MidasStore (light): catálogos, assumptions, *LoadedCias, cashFlowOverrides.' },
  { key: 'midas-db', scope: 'indexedDB', owner: 'domain/persistence.ts', description: 'Base IDB del MidasStore (payloads pesados extraídos del store light).' },

  // ── Heavy records (IndexedDB) ───────────────────────────────────────────
  { key: 'midas-heavy-store', scope: 'indexedDB', owner: 'services/heavyStoreIDB.ts', description: 'Records JDE/TRESS/CITI pesados: cxp, cobranza, cobranzaPayments, compras, pagoProveedor, nomina, rol, viajesEspeciales, auxiliarContable + caches de banco.' },
  { key: 'midas-daily-cache', scope: 'indexedDB', owner: 'services/dailyApiCache.ts', description: 'Cache por día de respuestas JDE (5s open-timeout, fallback a memoria).' },
  { key: 'midas-financial-projection-cache', scope: 'indexedDB', owner: 'modules/financial-projection/services/financialProjectionPersistentCache.ts', description: 'Cache persistente de proyecciones financieras.' },

  // ── App.tsx (caches de banco + UI) ──────────────────────────────────────
  { key: 'midas.bankLastQuery.v2', scope: 'localStorage', owner: 'App.tsx', description: 'Último rango/estado de consulta de bancos. Guardado idle-debounced (~2.5s).' },
  { key: 'midas.navFocus', scope: 'localStorage', owner: 'App.tsx', description: 'Foco de navegación entre tabs.' },
  { key: 'midas.bankStatements.v2', scope: 'localStorage', owner: 'App.tsx', description: 'Cache de estados de cuenta JDE.', legacy: true },
  { key: 'midas.bankSupplementalStatements.v1', scope: 'localStorage', owner: 'App.tsx', description: 'Cache de estados de cuenta subidos manualmente.', legacy: true },

  // ── Financial planning ──────────────────────────────────────────────────
  { key: 'midas.financialPlanning.scenarios.v1', scope: 'localStorage', owner: 'modules/financial-planning/services/financialPlanningStorage.ts', description: 'FinancialScenario[] (Escenarios).' },
  { key: 'midas.financialPlanning.adjustments.v1', scope: 'localStorage', owner: 'modules/financial-planning/services/financialPlanningStorage.ts', description: 'FinancialAdjustment[] (Propuestas).' },
  { key: 'midas.financialPlanning.changeLog.v1', scope: 'localStorage', owner: 'modules/financial-planning/services/changeLogStorage.ts', description: 'ScenarioChangeLogEntry[] — historial visible en ChangeLogDrawer (única fuente de historial).' },
  { key: 'midas.financialPlanning.cellOverrides.v1', scope: 'localStorage', owner: 'modules/financial-planning/services/cellOverridesStorage.ts', description: 'CellOverride[] — ediciones manuales por celda.' },
  { key: 'midas.financialPlanning.customRows.v1', scope: 'localStorage', owner: 'modules/financial-planning/services/customRowsStorage.ts', description: 'PlanningCustomRow[] — filas personalizadas del spreadsheet.' },
  { key: 'midas.financialPlanning.manualEntries.v1', scope: 'localStorage', owner: 'modules/financial-planning/services/manualPlanningEntries.ts', description: 'ManualPlanningEntry[] — líneas tecleadas a mano.' },
  { key: 'midas.financialPlanning.audit.v1', scope: 'localStorage', owner: 'modules/financial-planning/services/financialPlanningStorage.ts', description: 'Audit log write-only retirado; historial unificado en changeLog.', legacy: true },
  { key: 'midas.activeScenarioId', scope: 'localStorage', owner: 'modules/shared-finance/components/ScenarioSelectionContext.tsx', description: 'Escenario activo seleccionado en el shell.' },
  { key: 'midas.firstSimulationNudge.dismissed.v1', scope: 'localStorage', owner: 'modules/financial-planning/components/FirstSimulationNudge.tsx', description: 'Flag: nudge de primera simulación descartado.' },
  { key: 'midas.troughBannerDismissed.v1', scope: 'localStorage', owner: 'modules/financial-planning', description: 'Flag: banner de alerta de valle de caja descartado.' },

  // ── Financial projection ────────────────────────────────────────────────
  { key: 'midas.financialProjection.cache.index.v1', scope: 'localStorage', owner: 'modules/financial-projection/services/financialProjectionPersistentCache.ts', description: 'Índice del cache persistente de proyección.' },
  { key: 'midas.financialProjection.taxAdjustments.v1', scope: 'localStorage', owner: 'modules/financial-projection/services/taxPlanningService.ts', description: 'Ajustes de impuestos de proyección (legacy de IVA — ver midas.taxes.v1).' },
  { key: 'midas.dashboard.projectionOverrides.v1', scope: 'localStorage', owner: 'modules/shared-finance/calculation-engine/canonicalProjection.ts', description: 'Overrides de proyección del Dashboard.' },
  { key: 'midas.projection.trendTopOff', scope: 'localStorage', owner: 'modules/financial-projection/pages/FinancialProjectionDashboard.tsx', description: 'Flag: toggle "Proyectar tendencia histórica" (top-off Holt-Winters) activo.' },

  // ── KPIs y Objetivos ────────────────────────────────────────────────────
  { key: 'midas.kpisObjectives.customKpis.v1', scope: 'localStorage', owner: 'modules/kpis-objectives/services/customKpisStorage.ts', description: 'CustomKpi[] — KPIs definidos por el usuario con valor manual.' },
  { key: 'midas.kpisObjectives.objectives.v1', scope: 'localStorage', owner: 'modules/kpis-objectives/services/objectivesStorage.ts', description: 'Objective[] — metas y su seguimiento (numérico mensual, umbral de KPI, cualitativo).' },

  // ── Taxes ───────────────────────────────────────────────────────────────
  { key: 'midas.taxes.v1', scope: 'localStorage', owner: 'modules/taxes/services/taxModuleService.ts', description: 'TaxStore: obligaciones, ajustes y overrides de tasa.' },

  // ── Operating projection ────────────────────────────────────────────────
  { key: 'midas.operating.scenarios.v1', scope: 'localStorage', owner: 'domain/operatingProjection*', description: 'Escenarios de proyección operativa.' },
  { key: 'midas.operating.activeScenario.v1', scope: 'localStorage', owner: 'domain/operatingProjection*', description: 'Escenario operativo activo.' },
  { key: 'midas.operating.manualAdjustments.v1', scope: 'localStorage', owner: 'domain/operatingProjection*', description: 'Ajustes manuales de proyección operativa.' },
  { key: 'midas.operating.manualExpenseEvents.v1', scope: 'localStorage', owner: 'domain/operatingProjection*', description: 'Eventos de gasto manuales de proyección operativa.' },

  // ── Treasury / domain ───────────────────────────────────────────────────
  { key: 'midas.budget.v1', scope: 'localStorage', owner: 'domain/budgetPersistence.ts', description: 'Budget (presupuesto OPEX).' },
  { key: 'midas.companyGroups', scope: 'localStorage', owner: 'domain/companyGroups.ts', description: 'Agrupación de compañías.' },
  { key: 'midas.cashFlowSummary.v1', scope: 'localStorage', owner: 'domain/cashFlowSummaryCache.ts', description: 'Cache del resumen de flujo de caja.' },
  { key: 'midas.clientsCatalog.cache.v1', scope: 'localStorage', owner: 'domain/loadClientsCatalog.ts', description: 'Cache del Client[] parseado desde /clientes-db.json. Hash del raw text como invalidador.' },
  { key: 'midas/reconciliation-confirmations/v1', scope: 'localStorage', owner: 'domain/reconciliationConfirmations.ts', description: 'Set de cruces banco↔cobranza confirmados manualmente.' },
  { key: 'flujo-senda::minimum-expense-overrides', scope: 'localStorage', owner: 'domain/minimumOperatingExpense.ts', description: 'Overrides del gasto operativo mínimo.' },

  // ── UI / misc ───────────────────────────────────────────────────────────
  { key: 'midas.theme', scope: 'localStorage', owner: 'components/ui/DarkModeToggle.tsx', description: 'Tema claro/oscuro.' },
  { key: 'midas.activityFeed', scope: 'localStorage', owner: 'components/ActivityFeed.tsx', description: 'Feed de actividad de la sesión.' },
  { key: 'midas.midasAi.conversations.v1', scope: 'localStorage', owner: 'modules/midas-ai/services/midasStorage.ts', description: 'Conversaciones del bot Midas AI.' },

  // ── Legacy (flowsense / versiones previas — purgables) ──────────────────
  { key: 'midas-v11', scope: 'localStorage', owner: 'domain/persistence.ts', description: 'Store v11 previo.', legacy: true },
  { key: 'midas-v10', scope: 'localStorage', owner: 'domain/persistence.ts', description: 'Store v10 previo.', legacy: true },
  { key: 'midas-v9', scope: 'localStorage', owner: 'domain/persistence.ts', description: 'Store v9 previo.', legacy: true },
  { key: 'midas-v8', scope: 'localStorage', owner: 'domain/persistence.ts', description: 'Store v8 previo.', legacy: true },
  { key: 'midas-v7', scope: 'localStorage', owner: 'domain/persistence.ts', description: 'Store v7 previo.', legacy: true },
  { key: 'midas-v6', scope: 'localStorage', owner: 'domain/persistence.ts', description: 'Store v6 previo.', legacy: true },
  { key: 'midas-v5', scope: 'localStorage', owner: 'domain/persistence.ts', description: 'Store v5 previo.', legacy: true },
  { key: 'flowsense-v5', scope: 'localStorage', owner: 'domain/persistence.ts', description: 'Store flowsense (mismo esquema).', legacy: true },
  { key: 'flowsense-v4', scope: 'localStorage', owner: 'domain/persistence.ts', description: 'Store flowsense legacy.', legacy: true },
  { key: 'flowsense-v3', scope: 'localStorage', owner: 'domain/persistence.ts', description: 'Store flowsense legacy.', legacy: true },
  { key: 'flowsense-v2', scope: 'localStorage', owner: 'domain/persistence.ts', description: 'Store flowsense legacy.', legacy: true },
  { key: 'flowsense-v1', scope: 'localStorage', owner: 'domain/persistence.ts', description: 'Store flowsense legacy.', legacy: true },
  { key: 'flowsense.activityFeed', scope: 'localStorage', owner: 'components/ActivityFeed.tsx', description: 'Feed de actividad flowsense.', legacy: true },
  { key: 'flowsense.budget.v1', scope: 'localStorage', owner: 'domain/budgetPersistence.ts', description: 'Budget flowsense.', legacy: true },
  { key: 'flowsense.companyGroups', scope: 'localStorage', owner: 'domain/companyGroups.ts', description: 'Agrupación de compañías flowsense.', legacy: true },
];

/**
 * Nombres de bases IndexedDB que pertenecen a Midas. `clearAllMidasStorage()`
 * las elimina por nombre.
 */
export const MIDAS_INDEXED_DB_NAMES: string[] = MIDAS_STORAGE_REGISTRY
  .filter((entry) => entry.scope === 'indexedDB')
  .map((entry) => entry.key);

/**
 * Prefijos que identifican localStorage de Midas. El sweep por prefijo del
 * borrado total no depende de que el inventario esté 100% completo — atrapa
 * cualquier key `midas*` / `flowsense*` aunque se haya olvidado registrar.
 */
const LOCAL_STORAGE_PREFIXES = ['midas', 'flowsense'];
const LOCAL_STORAGE_EXTRA_KEYS = ['flujo-senda::minimum-expense-overrides'];

function isMidasLocalStorageKey(key: string): boolean {
  if (LOCAL_STORAGE_EXTRA_KEYS.includes(key)) return true;
  return LOCAL_STORAGE_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/**
 * Borrado total coordinado de la persistencia de Midas — localStorage + todas
 * las bases IndexedDB. Pensado para logout / reset / soporte.
 *
 * localStorage se barre por prefijo (robusto ante keys no registradas).
 * IndexedDB se borra por nombre desde el registro. Fire-and-forget en IDB:
 * si falla, el próximo boot re-hidrata desde el API.
 */
export function clearAllMidasStorage(): void {
  try {
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key && isMidasLocalStorageKey(key)) toRemove.push(key);
    }
    for (const key of toRemove) localStorage.removeItem(key);
  } catch {
    /* ignore quota / access errors */
  }

  if (typeof indexedDB !== 'undefined') {
    for (const dbName of MIDAS_INDEXED_DB_NAMES) {
      try {
        indexedDB.deleteDatabase(dbName);
      } catch {
        /* ignore */
      }
    }
  }
}
