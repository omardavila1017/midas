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
 *   5. Trail persistente (localStorage). Cada muestreo de heap y cada
 *      navegación escribe un resumen ligero (últimas navegaciones + muestras
 *      de heap + último incidente + flag `cleanExit`). Cuando Chrome mata el
 *      renderer por OOM ("Aw Snap"), los ring buffers en memoria se pierden;
 *      el trail en disco sobrevive a la recarga y deja ver QUÉ módulo estaba
 *      activo y a qué heap reventó. `cleanExit` distingue un cierre normal
 *      (pagehide dispara) de un OOM-kill (pagehide NO dispara). Léelo desde la
 *      consola con `window.__midas__.runtime.getLastTrail()`.
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

// Handlers de EMERGENCIA — disparados a >90% del límite, DESPUÉS de que los
// pressure handlers ya tuvieron chance de liberar caches y el heap siguió
// crítico. Aquí va la última línea de defensa "suave": navegar a un tab
// ligero, desmontar el árbol pesado y avisar, en vez de dejar que Chrome mate
// la pestaña sin aviso. Separados de los pressure handlers a propósito: liberar
// caches es barato y se hace seguido; degradar la UI es disruptivo y se hace
// solo en el borde del precipicio.
type MemoryEmergencyHandler = () => void;
const emergencyHandlers = new Set<MemoryEmergencyHandler>();
let lastEmergencyFiredAt = 0;
const EMERGENCY_COOLDOWN_MS = 60_000;

export function onMemoryEmergency(handler: MemoryEmergencyHandler): () => void {
  emergencyHandlers.add(handler);
  return () => { emergencyHandlers.delete(handler); };
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

function fireEmergencyHandlers(): void {
  // Solo si ya intentamos liberar caches antes (los pressure handlers
  // corrieron) — así le damos a la liberación + GC su oportunidad antes de
  // degradar la UI.
  if (lastPressureFiredAt === 0) return;
  const now = Date.now();
  if (now - lastEmergencyFiredAt < EMERGENCY_COOLDOWN_MS) return;
  lastEmergencyFiredAt = now;
  // eslint-disable-next-line no-console
  console.warn(`[runtimeGuardian] EMERGENCY firing ${emergencyHandlers.size} handler(s)`);
  for (const handler of emergencyHandlers) {
    try { handler(); } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[runtimeGuardian] emergency handler threw', err);
    }
  }
}

// Umbrales del monitor de memoria. Chrome desktop típicamente permite ~2-4GB
// por tab antes de OOM-kill. `performance.memory.jsHeapSizeLimit` da el techo
// dinámico del browser.
//   - warn 60%: solo loggea + sube la frecuencia de muestreo.
//   - critical 75%: dispara pressure handlers (libera caches rebuildables).
//     Bajado de 85% → 75% porque un spike (construir el canónico, abrir Nómina)
//     llega a OOM en menos de un intervalo de muestreo; necesitamos margen.
//   - emergency 90%: última línea de defensa suave (degradar la UI).
const HEAP_WARN_RATIO = 0.60;
const HEAP_CRITICAL_RATIO = 0.75;
const HEAP_EMERGENCY_RATIO = 0.90;

// Muestreo ADAPTATIVO. En reposo (heap bajo) 15s basta y no spamea; cuando el
// heap ya va alto muestreamos cada 2.5s para atrapar el spike antes del OOM —
// con 15s fijos el chequeo ni alcanzaba a correr entre que el heap se infla y
// Chrome mata el renderer.
const HEAP_SAMPLE_INTERVAL_LOW_MS = 15_000;
const HEAP_SAMPLE_INTERVAL_HIGH_MS = 2_500;

// localStorage key del trail persistente (registrada en storageRegistry.ts).
const LAST_TRAIL_KEY = 'midas.runtime.lastTrail.v1';

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

// Ring buffer chico de muestras de heap (para el trail post-mortem). Acotado.
interface HeapSample { t: number; usedMb: number; ratio: number; }
const MAX_HEAP_SAMPLES = 40;
const heapSamples: HeapSample[] = [];
let lastHeapRatio = 0;

function pushHeapSample(sample: HeapSample): void {
  heapSamples.push(sample);
  if (heapSamples.length > MAX_HEAP_SAMPLES) {
    heapSamples.splice(0, heapSamples.length - MAX_HEAP_SAMPLES);
  }
}

// ── Trail persistente ──────────────────────────────────────────────────────
// Escribimos un resumen MINÚSCULO (no el estado completo) a localStorage para
// sobrevivir al OOM-kill. JSON.stringify aquí es seguro: ~8 navs + ~12 muestras
// + 1 incidente = unos pocos KB, no los objetos gordos prohibidos en el hot path.
interface RuntimeTrail {
  savedAt: number;
  cleanExit: boolean;
  heap: { usedMb: number; limitMb: number; ratio: number } | null;
  recentNav: NavigationEvent[];
  recentHeap: HeapSample[];
  lastIncident: RuntimeIncident | null;
}

let previousTrail: RuntimeTrail | null = null;
let lastTrailWriteAt = 0;
const TRAIL_WRITE_THROTTLE_MS = 1_500;

function persistTrail(cleanExit = false, force = false): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const now = Date.now();
    // pagehide (cleanExit) y navegación (force) escriben siempre; el muestreo
    // periódico de heap throttlea para no martillar localStorage.
    if (!cleanExit && !force && now - lastTrailWriteAt < TRAIL_WRITE_THROTTLE_MS) return;
    lastTrailWriteAt = now;
    const mem = readMemory();
    const trail: RuntimeTrail = {
      savedAt: now,
      cleanExit,
      heap: mem
        ? {
            usedMb: bytesToMb(mem.usedJSHeapSize),
            limitMb: bytesToMb(mem.jsHeapSizeLimit),
            ratio: Math.round((mem.usedJSHeapSize / mem.jsHeapSizeLimit) * 100) / 100,
          }
        : null,
      recentNav: navEvents.slice(-8),
      recentHeap: heapSamples.slice(-12),
      lastIncident: incidents.length ? incidents[incidents.length - 1] : null,
    };
    localStorage.setItem(LAST_TRAIL_KEY, JSON.stringify(trail));
  } catch {
    /* ignore quota / serialize errors — el trail es best-effort */
  }
}

function loadPreviousTrail(): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const raw = localStorage.getItem(LAST_TRAIL_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as RuntimeTrail;
    previousTrail = parsed;
    const lastNav = parsed.recentNav?.length ? parsed.recentNav[parsed.recentNav.length - 1] : null;
    const tab = lastNav?.toTab ?? '?';
    const heap = parsed.heap;
    const heapStr = heap ? `${heap.usedMb}/${heap.limitMb}MB (${(heap.ratio * 100).toFixed(0)}%)` : 'sin dato';
    if (parsed.cleanExit === false) {
      // pagehide nunca disparó → el renderer murió sin avisar (probable OOM).
      // eslint-disable-next-line no-console
      console.warn(
        `[runtimeGuardian] ⚠️ la sesión anterior NO cerró limpio (probable OOM/"Aw Snap"). ` +
        `Último módulo activo: "${tab}", heap ${heapStr}. ` +
        `Detalle: window.__midas__.runtime.getLastTrail()`,
      );
    } else {
      // eslint-disable-next-line no-console
      console.info(`[runtimeGuardian] sesión anterior cerró limpio en "${tab}", heap ${heapStr}.`);
    }
  } catch {
    /* ignore */
  }
}

function checkHeap(): void {
  const mem = readMemory();
  if (!mem) return;
  const ratio = mem.usedJSHeapSize / mem.jsHeapSizeLimit;
  const usedMb = bytesToMb(mem.usedJSHeapSize);
  const limitMb = bytesToMb(mem.jsHeapSizeLimit);
  lastHeapRatio = ratio;
  pushHeapSample({ t: Date.now(), usedMb, ratio: Math.round(ratio * 100) / 100 });
  // Actualiza el trail en disco con la muestra fresca (throttled internamente).
  persistTrail(false);
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

  // Emergencia: fuera del gate de `lastWarnLevel` para que pueda dispararse en
  // una muestra POSTERIOR — i.e. ya liberamos caches en un tick previo, el GC
  // tuvo su chance y el heap SIGUE >90%. `fireEmergencyHandlers` aplica su
  // propio cooldown y exige que los pressure handlers hayan corrido antes.
  if (ratio >= HEAP_EMERGENCY_RATIO) {
    fireEmergencyHandlers();
  }
}

let started = false;

export function installRuntimeGuardian(): void {
  if (started) return;
  started = true;
  if (typeof window === 'undefined') return;

  // (0) Trail post-mortem. Lee el de la sesión anterior (¿cerró limpio o murió
  // por OOM?) ANTES de pisarlo, y marca esta sesión como "aún no cerrada
  // limpio" — si Chrome mata el renderer, `cleanExit` queda en false y el
  // próximo boot lo detecta.
  try {
    loadPreviousTrail();
    persistTrail(false); // siembra cleanExit=false para la sesión actual
    // pagehide / beforeunload = cierre/recarga controlada → marca cleanExit.
    // Un OOM-kill NO dispara estos eventos, de ahí el valor del flag.
    const markClean = () => persistTrail(true);
    window.addEventListener('pagehide', markClean);
    window.addEventListener('beforeunload', markClean);
  } catch {
    /* ignore */
  }

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

  // (3) Memory monitor con muestreo ADAPTATIVO. Solo en Chromium con
  // performance.memory. Self-scheduling: rápido (2.5s) cuando el heap ya va
  // alto, lento (15s) en reposo. Un setInterval fijo de 15s no atrapaba el
  // spike que precede al OOM.
  try {
    const mem = readMemory();
    if (mem) {
      const scheduleNextHeapCheck = () => {
        const delay = lastHeapRatio >= HEAP_WARN_RATIO
          ? HEAP_SAMPLE_INTERVAL_HIGH_MS
          : HEAP_SAMPLE_INTERVAL_LOW_MS;
        window.setTimeout(() => {
          try { checkHeap(); } catch { /* ignore */ }
          scheduleNextHeapCheck();
        }, delay);
      };
      // Sample inicial inmediato + loop. Si la app crashea por OOM, la muestra
      // cercana al evento queda en el trail persistente para post-mortem.
      checkHeap();
      scheduleNextHeapCheck();
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
        getHeapSamples: () => heapSamples.slice(),
        getLastTrail: () => previousTrail,
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
    // Captura el módulo activo en el trail de inmediato: si el crash ocurre
    // justo tras navegar a un tab pesado, queremos ese tab en el post-mortem.
    persistTrail(false, true);
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
