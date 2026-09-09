/**
 * Contrato de datos de cada tab: qué datasets (APIs JDE/TRESS/bancos) consume
 * REALMENTE el componente que se monta en él.
 *
 * `allowedDatasets` (`AppCore.tsx`) es la UNIÓN de este mapa sobre los tabs a
 * los que el usuario tiene permiso, y es el choke point que decide qué se baja.
 * Un admin ve todos los tabs → baja todo, así que **un tab que sub-declara sólo
 * se rompe para un usuario con permisos acotados** — y no se rompe vacío, se
 * rompe con números plausibles: es el modo de falla caro.
 *
 * Ya reincidió tres veces (taxes/concurso/pagos sin `banks` → IVA en $0 y Pagos
 * vacío; `kpisObjectives` sin auxiliar/rol/compras/nómina; y Proyección/
 * Planeación sin `banks`, que deja la caja SIN ancla bancaria — `initialCash`
 * cae al `startingBalance` y MOTOR 1 rellena todo mes cerrado con los sintéticos
 * `cobranza-historic:`/`auxiliar-historic:` en vez de la verdad del banco).
 * Por eso vive en su propio módulo con test: `tabDatasets.test.ts` pinea las
 * declaraciones que mueven dinero, así que quitarle un dataset a un tab truena
 * en vez de derivar en silencio.
 *
 * REGLA: si le pasas a un tab un prop con registros de una API, declara su
 * dataset aquí en el MISMO PR.
 */
import { TabId } from '../types';

export type DatasetKey =
  | 'cxp'
  | 'cobranza'
  | 'compras'
  | 'pagos'
  | 'nomina'
  | 'rol'
  | 'banks'
  | 'auxiliar';

/** Los 7 datasets de records + bancos. Orden estable para tests/diagnóstico. */
export const ALL_DATASETS: readonly DatasetKey[] = [
  'cxp',
  'cobranza',
  'compras',
  'pagos',
  'nomina',
  'rol',
  'banks',
  'auxiliar',
];

export const TAB_DATASETS: Partial<Record<TabId, DatasetKey[]>> = {
  netflow: ['banks'],
  bancos: ['banks'],
  // `banks` alimenta el panel "Posibles pagos en banco" del drilldown
  // (`findPossibleBankPayments`). Sin él ese panel sale vacío, que el usuario
  // lee como "esta factura no tiene cargo en banco" — un hecho falso.
  cxp: ['cxp', 'pagos', 'banks'],
  concursoMercantil: ['cxp', 'banks'],
  venta: ['cobranza', 'rol'],
  collections: ['cobranza', 'banks', 'rol'],
  fideicomiso: ['banks'],
  compras: ['compras'],
  pasivoDistribuir: ['compras'],
  pagos: ['pagos', 'banks', 'compras'],
  payroll: ['nomina'],
  // `banks` es load-bearing en los dos: la caja histórica se ANCLA al estado de
  // cuenta (`calculateInitialCash` + `bankCoverage` de MOTOR 1). Sin bancos el
  // tablero NO se ve vacío (`hasProjectionInputs` pasa con cxp/cobranza) — se ve
  // completo y con la caja equivocada.
  financialProjection: ['cxp', 'cobranza', 'compras', 'pagos', 'nomina', 'rol', 'auxiliar', 'banks'],
  financialPlanning: ['cxp', 'cobranza', 'compras', 'pagos', 'nomina', 'rol', 'auxiliar', 'banks'],
  taxes: ['cxp', 'cobranza', 'compras', 'pagos', 'nomina', 'auxiliar', 'banks'],
  // El catálogo de proveedores que pinta este tab NO es el bundle: lo DERIVA
  // `deriveProvidersFromJde(cxp, compras, pagoProveedor)`, y `spendIndex` sale de
  // pagoProveedor. Con `[]` la pestaña salía prácticamente en blanco para un
  // usuario acotado a Proveedores.
  providers: ['cxp', 'compras', 'pagos'],
  // Cobranza alimenta la jerarquía de clientes, el historial de facturación, el
  // pronóstico por cliente y el matcher/creditDays. Con `[]` el tab mostraba el
  // catálogo sin una sola factura.
  clients: ['cobranza'],
  // Declares everything KpisObjectivesDashboard consumes (auxiliar/rol/compras/
  // nomina feed the auto-calculated KPIs) so a kpis-scoped user gets complete
  // numbers, not just the admin who happens to hold every permission.
  kpisObjectives: ['cxp', 'cobranza', 'banks', 'compras', 'nomina', 'rol', 'auxiliar'],
  // TEMPORAL fuentes-datos: cada sub-tab declara solo lo que su vista lee,
  // para no obligar a un usuario con un solo sub-tab a bajar todo el lake.
  fuentesBancos: ['banks'],
  fuentesJde: ['cxp', 'cobranza', 'compras', 'pagos', 'banks', 'auxiliar'],
  fuentesTress: ['nomina'],
  fuentesRol: ['rol'],
};
