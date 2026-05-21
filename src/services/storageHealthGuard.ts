/**
 * storageHealthGuard — defensa proactiva contra crashes por storage envenenado.
 *
 * Contexto: Midas guarda todo en el navegador (localStorage + 4 bases IDB con
 * datos pesados de JDE/TRESS/CITI). Si un payload crece sin tope o queda
 * corrupto, la pestaña agota memoria al hidratar y Chrome la mata con
 * "Aw, Snap! Error code: 5" (STATUS_OUT_OF_MEMORY). El histórico del repo
 * tiene 3+ commits parchando esto reactivamente — este guard lo previene.
 *
 * Estrategia: corre ANTES de `ReactDOM.createRoot` en main.tsx. Si detecta
 * una de las señales abajo, llama a `clearAllMidasStorage()` y deja un flag
 * en sessionStorage para que la app pueda mostrar un aviso al usuario tras
 * boot exitoso. Como la purga es síncrona en localStorage e IDB es
 * fire-and-forget, no bloquea el boot.
 *
 * Señales de envenenamiento (cualquiera dispara la purga):
 *   1. `midas-v12` no parsea (JSON corrupto).
 *   2. `midas-v12` pesa más que MAX_LIGHT_BYTES (el store light no debe pasar
 *      ~1.5MB; si lo hace es que un heavy se coló por accidente).
 *   3. `localStorage` total > MAX_LOCAL_STORAGE_BYTES (cerca de la cuota
 *      de 5MB de Chrome; el siguiente save tirará QuotaExceededError).
 *   4. Watchdog: la sesión anterior dejó `boot:starting` sin llegar a
 *      `boot:complete` → asumimos que crasheó y purgamos preventivamente.
 *   5. Override manual: `?reset-midas` en la URL.
 *
 * Lo que NO hace: no toca IndexedDB cuota (browser ya rechaza writes al
 * llenarse). No purga si solo hay legacy keys — esas las migra persistence.ts.
 */

import { clearAllMidasStorage } from '../domain/storageRegistry';

// Umbrales conservadores. midas-v12 light en uso normal pesa ~50-200KB;
// 1.5MB es 7× ese tamaño — espacio de sobra para crecimiento orgánico, pero
// muy lejos del nivel donde un `JSON.parse` síncrono empieza a ahogar el main
// thread o donde el siguiente save peta contra la cuota de 5MB.
const STORE_KEY = 'midas-v12';
const MAX_LIGHT_BYTES = 1_500_000; // 1.5 MB
const MAX_LOCAL_STORAGE_BYTES = 4_500_000; // 4.5 MB (de 5 MB de cuota)

const BOOT_FLAG = 'midas.boot.inflight';
const PURGE_REASON_FLAG = 'midas.boot.purgedReason';
const PURGE_TIMESTAMP_FLAG = 'midas.boot.purgedAt';

export type PurgeReason =
  | 'corrupt-light-store'
  | 'oversized-light-store'
  | 'localstorage-near-quota'
  | 'prior-boot-crash'
  | 'manual-reset';

interface HealthReport {
  purged: boolean;
  reason?: PurgeReason;
  details?: Record<string, unknown>;
}

function safeMeasureLocalStorage(): { totalBytes: number; storeBytes: number; storeParsed: boolean } {
  let totalBytes = 0;
  let storeBytes = 0;
  let storeParsed = true;
  try {
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key) continue;
      const value = localStorage.getItem(key) ?? '';
      totalBytes += key.length + value.length;
      if (key === STORE_KEY) {
        storeBytes = value.length;
        try {
          const parsed = JSON.parse(value);
          if (!parsed || typeof parsed !== 'object') storeParsed = false;
        } catch {
          storeParsed = false;
        }
      }
    }
  } catch {
    // localStorage no disponible (modo privado, cuota extrema) — tratamos
    // como saludable: no podemos medir, y purgar a ciegas haría más daño.
  }
  return { totalBytes, storeBytes, storeParsed };
}

function purge(reason: PurgeReason, details?: Record<string, unknown>): HealthReport {
  // eslint-disable-next-line no-console
  console.warn(`[storageHealthGuard] PURGE: ${reason}`, details ?? {});
  try {
    clearAllMidasStorage();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[storageHealthGuard] purge failed', err);
  }
  try {
    sessionStorage.setItem(PURGE_REASON_FLAG, reason);
    sessionStorage.setItem(PURGE_TIMESTAMP_FLAG, String(Date.now()));
  } catch {
    /* ignore */
  }
  return { purged: true, reason, details };
}

/**
 * Verifica el estado del storage y purga si detecta envenenamiento. Diseñado
 * para correr síncrono (o ~síncrono — solo localStorage en el path crítico)
 * antes de montar React. Retorna el reporte; los callers pueden mostrarlo al
 * usuario si así lo deciden.
 */
export function runStorageHealthGuard(): HealthReport {
  if (typeof window === 'undefined') return { purged: false };

  // (5) Override manual — útil para soporte: ?reset-midas en la URL purga
  // todo y recarga limpio. Nos quitamos del medio del query string para que
  // un F5 no re-dispare la purga.
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.has('reset-midas')) {
      const report = purge('manual-reset', { from: 'url-param' });
      url.searchParams.delete('reset-midas');
      window.history.replaceState({}, '', url.toString());
      return report;
    }
  } catch {
    /* ignore */
  }

  // (4) Watchdog de crash previo. Si el boot anterior empezó pero nunca
  // marcó `boot:complete`, asumimos que la pestaña murió hidratando — el
  // patrón Error code 5. Purgamos preventivamente para que esta carga
  // arranque limpia.
  let priorCrash = false;
  try {
    if (sessionStorage.getItem(BOOT_FLAG) === '1') {
      priorCrash = true;
    }
    sessionStorage.setItem(BOOT_FLAG, '1');
  } catch {
    /* ignore */
  }
  if (priorCrash) {
    // ANTES: `purge('prior-boot-crash')` borraba TODO (localStorage + 4 IDBs).
    // Demasiado agresivo: un único OOM transitorio causaba pérdida total de
    // los datasets pesados (rolRecords 65k, cobranza 46k, compras 334k, etc.)
    // y forzaba refetch de ~656 requests / 90MB en el próximo boot — que
    // bajo presión de memoria volvía a tronar → loop infinito de purgas.
    // El storage real NO está corrupto (los otros 3 disparadores cubren ese
    // caso: parse corrupto, oversize, near-quota); el crash previo solo dice
    // "se quedó sin memoria hidratando". La acción correcta es loggear y
    // dejar boot proceder normal — el cache sobrevive y la app rehidrata sin
    // refetch masivo.
    // eslint-disable-next-line no-console
    console.warn('[storageHealthGuard] prior boot did not complete (likely OOM mid-hydrate). Skipping purge — cache preservado.');
    return { purged: false, reason: 'prior-boot-crash', details: { action: 'log-only' } };
  }

  // (1)(2)(3) Inspección de localStorage. Una sola pasada mide todo.
  const measure = safeMeasureLocalStorage();

  if (measure.storeBytes > 0 && !measure.storeParsed) {
    return purge('corrupt-light-store', { storeBytes: measure.storeBytes });
  }
  if (measure.storeBytes > MAX_LIGHT_BYTES) {
    return purge('oversized-light-store', {
      storeBytes: measure.storeBytes,
      thresholdBytes: MAX_LIGHT_BYTES,
    });
  }
  if (measure.totalBytes > MAX_LOCAL_STORAGE_BYTES) {
    return purge('localstorage-near-quota', {
      totalBytes: measure.totalBytes,
      thresholdBytes: MAX_LOCAL_STORAGE_BYTES,
    });
  }

  return { purged: false };
}

/**
 * Marca el boot como completo. Limpia el flag del watchdog para que un F5
 * limpio no se interprete como crash. Se llama desde App.tsx una vez que la
 * primera hidratación terminó sin matar la pestaña.
 */
export function markBootComplete(): void {
  try {
    sessionStorage.removeItem(BOOT_FLAG);
  } catch {
    /* ignore */
  }
}

/**
 * Lee y consume el flag de "purgué tu storage". App.tsx lo lee al montar
 * para mostrar un toast informativo al usuario.
 */
export function consumePurgeNotice(): { reason: PurgeReason; at: number } | null {
  try {
    const reason = sessionStorage.getItem(PURGE_REASON_FLAG) as PurgeReason | null;
    const atRaw = sessionStorage.getItem(PURGE_TIMESTAMP_FLAG);
    if (!reason) return null;
    sessionStorage.removeItem(PURGE_REASON_FLAG);
    sessionStorage.removeItem(PURGE_TIMESTAMP_FLAG);
    return { reason, at: atRaw ? Number(atRaw) : Date.now() };
  } catch {
    return null;
  }
}

/**
 * Mensaje user-facing para cada razón de purga. Se usa en el toast de boot.
 */
export function purgeReasonMessage(reason: PurgeReason): string {
  switch (reason) {
    case 'corrupt-light-store':
      return 'Detecté datos locales corruptos y los limpié. Vuelvo a sincronizar con JDE.';
    case 'oversized-light-store':
      return 'Tu cache local creció demasiado y lo reinicié para evitar un crash. Resincronizando…';
    case 'localstorage-near-quota':
      return 'Tu almacenamiento local estaba al límite. Lo limpié para mantener la app rápida.';
    case 'prior-boot-crash':
      return 'La última sesión no cerró correctamente. Limpié el cache local para arrancar bien.';
    case 'manual-reset':
      return 'Reset manual completado.';
    default:
      return 'Cache local reiniciado.';
  }
}
