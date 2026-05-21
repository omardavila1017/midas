/**
 * Señal de "primer paint real de la Proyección".
 *
 * Producto (req 6): "cuando entro por primera vez carga toda la información y
 * no muestra nada hasta que tiene suficiente información para cargar". El
 * splash NO debe soltarse en cuanto catálogo+empresas están (eso dejaba ver
 * el dashboard a medias con "Calculando proyección"). Debe esperar a que la
 * vista de aterrizaje (Proyección Financiera) tenga su PRIMER run real.
 *
 * El árbol de la app se renderiza bajo el splash (opacity 0) mientras
 * `!isBooted`, así que el dashboard SÍ computa durante el splash — el overlay
 * es sólo visual, no cambia memoria. El OOM histórico al gatear NO lo causaba
 * el splash sino el churn de cold-boot (el source se reconstruía 5-6×); eso
 * se ataca con el debounce de 12s en FinancialProjectionDashboard que coalesce
 * las olas de datos en ~1 build. Con el churn acotado + SOURCE_CACHE=2 el pico
 * de heap se mantiene <4GB y gatear el splash es seguro.
 *
 * Anti-hang preservado: App mantiene un tope duro (cap) — esta señal sólo
 * adelanta el dismiss; nunca lo puede colgar para siempre.
 *
 * Latched: si el dashboard painta ANTES de que App se suscriba, el
 * suscriptor tardío recibe la señal de inmediato (replay).
 */

let painted = false;
const listeners = new Set<() => void>();

/** El dashboard de Proyección llama esto cuando tiene su primer run real. */
export function signalProjectionFirstPaint(): void {
  if (painted) return;
  painted = true;
  for (const cb of listeners) {
    try {
      cb();
    } catch {
      /* un listener no debe romper a los demás ni al dashboard */
    }
  }
  listeners.clear();
}

/** ¿Ya pintó la Proyección por primera vez en esta sesión? */
export function hasProjectionPainted(): boolean {
  return painted;
}

/**
 * Suscribe al primer paint. Si ya ocurrió, invoca `cb` de inmediato
 * (replay). Devuelve una función para desuscribir.
 */
export function subscribeProjectionFirstPaint(cb: () => void): () => void {
  if (painted) {
    cb();
    return () => {};
  }
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Sólo para tests: resetea el latch. */
export function __resetProjectionBootSignalForTests(): void {
  painted = false;
  listeners.clear();
}
