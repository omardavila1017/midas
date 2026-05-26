/**
 * Simple pause/resume gate for async dispatch loops.
 *
 * Usage:
 *   const gate = new PauseGate();
 *   // inside a worker loop, before dispatching the next unit of work:
 *   await gate.wait();
 *   // UI:
 *   gate.pause(); gate.resume();
 *
 * Semantics:
 *   - `pause()` marks gate as paused; future `wait()` calls block until
 *     `resume()` is called.
 *   - In-flight work is NOT canceled — pause only stops NEW dispatches.
 *   - `resume()` releases all blocked waiters synchronously (they then race
 *     against the worker pool's concurrency cap normally).
 *   - Idempotent: pause() while paused is a no-op; resume() while running too.
 */
export interface PauseGateError {
  /** API path / endpoint that failed (e.g. "/AuxiliarContable"). */
  path: string;
  /** HTTP status if known; 0 = network/CORS; -1 = abort/cancel; -2 = unknown. */
  status: number;
  /** Human-readable summary for the UI. */
  message: string;
}

export class PauseGate {
  private paused = false;
  private waiters: Array<() => void> = [];
  private listeners = new Set<() => void>();
  /**
   * Auto-pause solo dispara UNA vez por reload — después de eso si el
   * usuario reanuda, los errores subsecuentes se ignoran (cargar a pesar
   * del problema). Reload reinicia (instancia nueva del módulo).
   */
  private autoPauseFired = false;
  private lastError: PauseGateError | null = null;

  isPaused(): boolean { return this.paused; }
  getLastError(): PauseGateError | null { return this.lastError; }
  hasAutoPaused(): boolean { return this.autoPauseFired; }

  pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.notify();
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    // Clear el error display — el usuario ya vio el aviso y decidió
    // continuar. `autoPauseFired` se mantiene en true para que no
    // re-pausen errores subsecuentes en este reload.
    this.lastError = null;
    const w = this.waiters;
    this.waiters = [];
    for (const fn of w) fn();
    this.notify();
  }

  toggle(): void {
    if (this.paused) this.resume();
    else this.pause();
  }

  /**
   * Auto-pause por error de API. No-op si ya disparó una vez en este reload.
   * Guarda el último error para que la UI lo muestre.
   */
  tryAutoPause(err: PauseGateError): boolean {
    if (this.autoPauseFired) return false;
    this.autoPauseFired = true;
    this.lastError = err;
    if (!this.paused) this.paused = true;
    this.notify();
    return true;
  }

  /** Blocks until the gate is open (resolves immediately if not paused). */
  async wait(): Promise<void> {
    if (!this.paused) return;
    await new Promise<void>(resolve => this.waiters.push(resolve));
  }

  /** Subscribe to gate-state changes (paused + lastError). Returns unsubscribe. */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private notify(): void {
    for (const fn of this.listeners) {
      try { fn(); } catch { /* swallow listener bugs */ }
    }
  }
}

/**
 * Gate global del cliente JDE. Todas las requests pasan por jdeClient.request
 * → `await jdeFetchPauseGate.wait()` antes de adquirir el semáforo, así
 * pausar bloquea TODOS los fetches (boot + auto-refresh + manual) sin
 * cancelar in-flight. UI suscribe vía `subscribe()`.
 */
export const jdeFetchPauseGate = new PauseGate();
