/**
 * runtimeGuardian — observabilidad + defensa proactiva contra crashes
 * silenciosos del navegador (Chrome/Edge "Aw, Snap! Error code: 5").
 *
 * Qué hace:
 *   1. Handler global `error` y `unhandledrejection`. Hasta ahora estos eventos
 *      morían en silencio: si un effect tiraba una promise sin .catch, no
 *      había rastro. Los enviamos a `console.error` con etiqueta consistente
 *      y los acumulamos en un ring buffer para diagnóstico (ver
 *      `getRuntimeIncidents`).
 *   2. Monitor de memoria. Usa `performance.memory` (Chromium-only) para
 *      avisar cuando el heap JS pasa umbrales. Antes de Error code: 5 hay
 *      una ventana de segundos donde el heap se infla; loggearlo nos da una
 *      pista de cuál acción del usuario lo precedió. NO intentamos
 *      "limpiar memoria" desde JS (no podemos); el objetivo es diagnóstico.
 *   3. Tracker de navegación. Registra cambios de pestaña con timestamp y
 *      heap delta. Si el crash siempre ocurre tras X minutos en Planeación,
 *      el log lo dirá.
 *   4. Detector de long tasks. Usa PerformanceObserver para reportar
 *      bloqueos del main thread > 200ms con stack si está disponible.
 *
 * Diseñado para correr una sola vez desde `main.tsx` (después del
 * storageHealthGuard) y nunca tirar. Toda excepción se traga.
 */

interface RuntimeIncident {
  type: 'error' | 'unhandledrejection' | 'heap-warning' | 'long-task' | 'memory-pressure';
  timestamp: number;
  message: string;
  detail?: string;
  meta?: Record<string, unknown>;
}

interface NavigationEvent {
  timestamp: number;
  fromTab?: string;
  toTab: string;
  heapMb?: number;
}

// Ring buffers acotados — nunca creceremos sin tope.
const MAX_INCIDENTS = 100;
const MAX_NAV_EVENTS = 200;
const incidents: RuntimeIncident[] = [];
const navEvents: NavigationEvent[] = [];

// Callbacks invocados cuando el heap entra en estado crítico (>85% del límite
// del browser). Los módulos con caches grandes (projectionRunCache,
// financialProjectionService LRU, etc.) se registran aquí para liberar
// memoria proactivamente ANTES de que Chrome dispare Error code: 5.
type MemoryPressureHandler = () => void;
const pressureHandlers = new Set<MemoryPressureHandler>();
let lastPressureFiredAt = 0;
const PRESSURE_COOLDOWN_MS = 30_000; // No re-disparar dentro de 30s — los
// caches tardan en repoblarse y queremos evitar fight-loop.

export function onMemoryPressure(handler: MemoryPressureHandler): () => void {
  pressureHandlers.add(handler);
  return () => { pressureHandlers.delete(handler); };
}

function firePressureHandlers(): void {
  const now = Date.now();
  if (now - lastPressureFiredAt < PRESSURE_COOLDOWN_MS) return;
  lastPressureFiredAt = now;
  // eslint-disable-next-line no-console
  console.warn(`[runtimeGuardian] firing ${pressureHandlers.size} memory-pressure handler(s)`);
  for (const handler of pressureHandlers) {
    try { handler(); } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[runtimeGuardian] pressure handler threw', err);
    }
  }
}

// Umbrales del monitor de memoria (en MB). Chrome típicamente desktops permite
// ~2-4GB por tab antes de OOM-kill. Avisamos a 70% (warn) y 85% (critical).
// `performance.memory.jsHeapSizeLimit` da el techo dinámico del browser.
const HEAP_WARN_RATIO = 0.70;
const HEAP_CRITICAL_RATIO = 0.85;

// Cuánta frecuencia muestrear. 15s da suficiente granularidad sin spamear.
const HEAP_SAMPLE_INTERVAL_MS = 15_000;

// Long task threshold. 200ms es la regla de oro de Chrome devtools "long task".
const LONG_TASK_THRESHOLD_MS = 200;

interface ChromeMemoryInfo {
  jsHeapSizeLimit: number;
  totalJSHeapSize: number;
  usedJSHeapSize: number;
}

function readMemory(): ChromeMemoryInfo | null {
  try {
    const perf = performance as Performance & { memory?: ChromeMemoryInfo };
    if (perf.memory && typeof perf.memory.usedJSHeapSize === 'number') {
      return perf.memory;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function bytesToMb(n: number): number {
  return Math.round((n / 1_048_576) * 10) / 10;
}

function pushIncident(incident: RuntimeIncident): void {
  incidents.push(incident);
  if (incidents.length > MAX_INCIDENTS) {
    incidents.splice(0, incidents.length - MAX_INCIDENTS);
  }
}

function pushNav(event: NavigationEvent): void {
  navEvents.push(event);
  if (navEvents.length > MAX_NAV_EVENTS) {
    navEvents.splice(0, navEvents.length - MAX_NAV_EVENTS);
  }
}

let lastWarnLevel: 'none' | 'warn' | 'critical' = 'none';

function checkHeap(): void {
  const mem = readMemory();
  if (!mem) return;
  const ratio = mem.usedJSHeapSize / mem.jsHeapSizeLimit;
  const usedMb = bytesToMb(mem.usedJSHeapSize);
  const limitMb = bytesToMb(mem.jsHeapSizeLimit);
  if (ratio >= HEAP_CRITICAL_RATIO) {
    if (lastWarnLevel !== 'critical') {
      lastWarnLevel = 'critical';
      const message = `[runtimeGuardian] CRITICAL heap ${usedMb}/${limitMb}MB (${(ratio * 100).toFixed(0)}%)`;
      // eslint-disable-next-line no-console
      console.warn(message);
      pushIncident({
        type: 'memory-pressure',
        timestamp: Date.now(),
        message,
        meta: { usedMb, limitMb, ratio },
      });
      // Libera caches "rebuildable" — vale la pena pagar un recompute
      // (segundos) si evitamos Error code: 5 (sesión muerta).
      firePressureHandlers();
    }
  } else if (ratio >= HEAP_WARN_RATIO) {
    if (lastWarnLevel === 'none') {
      lastWarnLevel = 'warn';
      const message = `[runtimeGuardian] heap warning ${usedMb}/${limitMb}MB (${(ratio * 100).toFixed(0)}%)`;
      // eslint-disable-next-line no-console
      console.info(message);
      pushIncident({
        type: 'heap-warning',
        timestamp: Date.now(),
        message,
        meta: { usedMb, limitMb, ratio },
      });
    }
  } else if (ratio < HEAP_WARN_RATIO * 0.9) {
    // Histéresis: solo "reseteamos" el nivel al bajar bien debajo del umbral.
    lastWarnLevel = 'none';
  }
}

let started = false;

export function installRuntimeGuardian(): void {
  if (started) return;
  started = true;
  if (typeof window === 'undefined') return;

  // (1) Handler global de error. Captura excepciones sincronas no atrapadas.
  try {
    window.addEventListener('error', (event) => {
      try {
        const err = event.error;
        const message = err instanceof Error ? err.message : String(event.message ?? 'unknown');
        const detail = err instanceof Error ? err.stack : `${event.filename}:${event.lineno}:${event.colno}`;
        // eslint-disable-next-line no-console
        console.error('[runtimeGuardian] window.error', message, detail);
        pushIncident({ type: 'error', timestamp: Date.now(), message, detail });
      } catch {
        /* never throw from a handler */
      }
    });
  } catch {
    /* ignore */
  }

  // (2) Handler de promesas no atrapadas. La fuga más sutil — si un effect
  // hace `void someAsync()` sin .catch y throwa, nadie se entera. Acá sí.
  try {
    window.addEventListener('unhandledrejection', (event) => {
      try {
        const reason = event.reason;
        const message = reason instanceof Error ? reason.message : String(reason);
        const detail = reason instanceof Error ? reason.stack : undefined;
        // eslint-disable-next-line no-console
        console.error('[runtimeGuardian] unhandledrejection', message, detail);
        pushIncident({ type: 'unhandledrejection', timestamp: Date.now(), message, detail });
      } catch {
        /* never throw from a handler */
      }
    });
  } catch {
    /* ignore */
  }

  // (3) Memory monitor. Solo en Chromium con performance.memory.
  try {
    const mem = readMemory();
    if (mem) {
      // Sample inicial inmediato + intervalo. Si la app crashea por OOM, la
      // muestra cercana al evento queda en consola para post-mortem.
      checkHeap();
      window.setInterval(checkHeap, HEAP_SAMPLE_INTERVAL_MS);
    }
  } catch {
    /* ignore */
  }

  // (4) Long task observer. Reporta bloqueos del main thread > 200ms. Útil
  // para diagnosticar "freeze" en navegación entre módulos pesados.
  try {
    const PO = (window as unknown as { PerformanceObserver?: typeof PerformanceObserver }).PerformanceObserver;
    if (PO) {
      const observer = new PO((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration < LONG_TASK_THRESHOLD_MS) continue;
          const message = `[runtimeGuardian] long task ${entry.duration.toFixed(0)}ms ${entry.name || 'unknown'}`;
          // eslint-disable-next-line no-console
          console.info(message);
          pushIncident({
            type: 'long-task',
            timestamp: Date.now(),
            message,
            meta: { durationMs: entry.duration, name: entry.name },
          });
        }
      });
      try {
        observer.observe({ entryTypes: ['longtask'] });
      } catch {
        // Browser doesn't support 'longtask' entryType — Edge / Firefox.
      }
    }
  } catch {
    /* ignore */
  }

  // Expone una API mínima en `window.__midas__` para debugging desde la
  // consola del navegador. Solo lectura.
  try {
    (window as unknown as { __midas__?: Record<string, unknown> }).__midas__ = {
      ...((window as unknown as { __midas__?: Record<string, unknown> }).__midas__ ?? {}),
      runtime: {
        getIncidents: () => incidents.slice(),
        getNavEvents: () => navEvents.slice(),
        getMemory: () => {
          const m = readMemory();
          return m ? { usedMb: bytesToMb(m.usedJSHeapSize), limitMb: bytesToMb(m.jsHeapSizeLimit) } : null;
        },
      },
    };
  } catch {
    /* ignore */
  }
}

/**
 * Registra una transición de pestaña/módulo. Llamado desde AppCore cuando
 * `activeTab` cambia. Útil para correlacionar crashes con la última nav.
 */
export function trackNavigation(toTab: string, fromTab?: string): void {
  try {
    const mem = readMemory();
    pushNav({
      timestamp: Date.now(),
      fromTab,
      toTab,
      heapMb: mem ? bytesToMb(mem.usedJSHeapSize) : undefined,
    });
  } catch {
    /* ignore */
  }
}

export function getRuntimeIncidents(): RuntimeIncident[] {
  return incidents.slice();
}

export function getNavigationEvents(): NavigationEvent[] {
  return navEvents.slice();
}
