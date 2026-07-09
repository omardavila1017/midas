import { createContext, useContext } from 'react';

/**
 * Carga diferida de años históricos.
 *
 * El boot sólo baja la ventana por defecto (`defaultWindowFloor`: año en curso
 * + 12 meses atrás). Cuando una vista con navegación por año (Venta, Cobranza,
 * …) muestra un año MÁS ANTIGUO que el piso cargado, llama `ensureYearLoaded`
 * con los datasets que necesita; `AppCore` baja ese rango bajo demanda, lo
 * mergea al heavy-store y re-renderiza. `isLoadingHistorical` deja a la vista
 * pintar un indicador mientras el backfill corre.
 *
 * Las llaves de dataset son las de `DatasetKey` de AppCore (`'cobranza'`,
 * `'rol'`, `'banks'`, `'nomina'`, …); se tipan como `string` aquí para no
 * acoplar el contexto a AppCore (evita un ciclo de imports).
 *
 * IMPORTANTE: el valor por defecto es un no-op funcional. Los componentes que
 * consumen este contexto (SalesCalendarDashboard, CollectionProjection) se
 * renderizan de forma aislada en sus tests SIN provider — con el no-op siguen
 * comportándose igual que antes (sin carga diferida), así que no rompen.
 */
export interface DataWindowValue {
  /** Piso ISO (`YYYY-MM-DD`) de la ventana por defecto cargada al boot. */
  defaultFloor: string;
  /** Piso solicitado por dataset (baja al consultar años previos). */
  floorByDataset: Record<string, string>;
  /** ¿Hay un backfill en curso para este dataset? */
  loadingByDataset: Record<string, boolean>;
  /**
   * Garantiza que los datasets dados cubran desde el 1° de enero de `year`.
   * Sube (baja el piso) sólo cuando `year` es más antiguo que lo ya cargado.
   */
  ensureYearLoaded: (year: number, datasets: string[]) => void;
  /** ¿Alguno de los datasets dados está bajando historia ahora mismo? */
  isLoadingHistorical: (datasets: string[]) => boolean;
}

const NO_OP: DataWindowValue = {
  defaultFloor: '',
  floorByDataset: {},
  loadingByDataset: {},
  ensureYearLoaded: () => {},
  isLoadingHistorical: () => false,
};

const DataWindowContext = createContext<DataWindowValue>(NO_OP);

export const DataWindowProvider = DataWindowContext.Provider;

export function useDataWindow(): DataWindowValue {
  return useContext(DataWindowContext);
}
