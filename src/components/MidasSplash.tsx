import { useEffect, useMemo, useRef, useState } from 'react';
import { Snowflake, AlertTriangle } from 'lucide-react';
import { clearAllMidasStorage } from '../domain/storageRegistry';
import { clearAuth } from './Login';

export type BootTaskStatus = 'pending' | 'loading' | 'done' | 'error';

export interface BootTask {
  id: string;
  label: string;
  status: BootTaskStatus;
  progress?: { done: number; total: number } | null;
}

interface MidasSplashProps {
  visible: boolean;
  tasks: BootTask[];
  startedAt: number;
}

// Variantes formales de heartbeat — 3 sets × 3 frases por slot. Una variante
// se elige al azar por sesión (mantiene coherencia de tono en todo el boot)
// y dentro de la variante el tick rota cada 2.5s.
const HEARTBEAT_VARIANTS: Record<string, string[][]> = {
  catalog: [
    ['Indexando el maestro de clientes y proveedores…', 'Verificando integridad en base de datos local…', 'Sincronizando registros del catálogo…'],
    ['Estructurando tablas base de entidades…', 'Validando almacenamiento local (IndexedDB)…', 'Consolidando datos maestros de operación…'],
    ['Descargando el catálogo unificado corporativo…', 'Optimizando índices de búsqueda local…', 'Preparando registros de clientes y proveedores…'],
  ],
  companies: [
    ['Estableciendo enlace seguro con el nodo JDE…', 'Descargando estructura corporativa de empresas…', 'Inicializando las entidades del sistema…'],
    ['Conectando con la base de datos central JDE…', 'Mapeando el árbol jerárquico de compañías…', 'Hidratando el catálogo de razones sociales…'],
    ['Autenticando credenciales en servidor JDE…', 'Sincronizando el esquema de cías activas…', 'Cargando configuración de entornos corporativos…'],
  ],
  banks: [
    ['Recuperando estados de cuenta institucionales…', 'Reconstruyendo bitácora de movimientos…', 'Ejecutando el módulo de conciliación bancaria…'],
    ['Consultando balances en portales bancarios…', 'Procesando el historial de transacciones…', 'Ejecutando la lógica de cuadre financiero…'],
    ['Descargando flujos de efectivo de cuentas origen…', 'Agrupando depósitos y retiros del periodo…', 'Sincronizando saldos de tesorería…'],
  ],
  cxp: [
    ['Consulta de cuentas por pagar [ERP JDE]…', 'Generación de la matriz de antigüedad de saldos…', 'Clasificación de obligaciones pendientes…'],
    ['Extrayendo CXP de las 29 compañías del grupo…', 'Calculando la maduración de pasivos financieros…', 'Procesando el universo de facturas por pagar…'],
    ['Compilando deudas activas en la red JDE…', 'Estructurando el reporte de antigüedad…', 'Mapeando compromisos con proveedores…'],
  ],
  cobranza: [
    ['Consulta de cuentas por cobrar [ERP JDE]…', 'Conciliación de facturas contra abonos…', 'Actualización del balance de la cartera…'],
    ['Extrayendo CXC de las 29 compañías del grupo…', 'Cruzando la relación de ingresos vs facturación…', 'Consolidando cartera vencida y vigente…'],
    ['Sincronizando abonos pendientes en JDE…', 'Ejecutando algoritmo de conciliación de cobros…', 'Cuadrando saldos de clientes activos…'],
  ],
  nomina: [
    ['Estableciendo enlace seguro con el nodo TRESS…', 'Extracción de la dispersión de nómina…', 'Procesamiento del cálculo bimodal de pagos…'],
    ['Conectando con el sistema de recursos humanos…', 'Descargando la pre-nómina del mes en curso…', 'Validando dispersión bancaria de colaboradores…'],
    ['Abriendo canal de datos con el servidor TRESS…', 'Procesando incidencias y registros de nómina…', 'Calculando matrices de pago por entidad…'],
  ],
  rol: [
    ['Sincronizando ROL Diario desde plataforma CITI…', 'Consolidación del registro histórico de viajes…', 'Vinculación de bitácora de logística con cobranza…'],
    ['Conectando con el despachador de tráfico CITI…', 'Compilando asignación de viajes desde enero…', 'Cruzando liquidación de rutas con ingresos…'],
    ['Descargando el estatus de operaciones CITI…', 'Sincronizando rutas y jornadas operativas…', 'Mapeando transacciones de viajes contra CXC…'],
  ],
  compras: [
    ['Sincronización de órdenes de compra activas…', 'Validación de registros de abastecimiento…', 'Consolidación de requisiciones pendientes…'],
    ['Consultando órdenes de compra en el ERP…', 'Verificando estatus de flujo de aprobaciones…', 'Estructurando histórico de compras del periodo…'],
    ['Descargando bitácora de adquisiciones activas…', 'Mapeando transacciones con proveedores de insumos…', 'Procesando el backlog de órdenes generadas…'],
  ],
  pagos: [
    ['Mapeo de dispersión y flujo de egresos…', 'Actualización de la agenda de proveedores…', 'Verificación del histórico de transacciones…'],
    ['Procesando lotes de pago programados…', 'Sincronizando el calendario de tesorería…', 'Compilando autorizaciones de transferencia…'],
    ['Descargando la cola de dispersión bancaria…', 'Mapeando órdenes de pago liquidadas…', 'Consolidando salidas de efectivo validadas…'],
  ],
  projection: [
    ['Inicialización de la matriz de flujo de efectivo…', 'Procesamiento del modelo predictivo financiero…', 'Ejecución del algoritmo de proyección anual…'],
    ['Cargando variables macroeconómicas del sistema…', 'Corriendo el motor de simulación de escenarios…', 'Estructurando el primer cálculo de flujo…'],
    ['Compilando datos históricos para predicción…', 'Calculando deltas de ingresos y egresos esperados…', 'Renderizando matriz predictiva de cierre de año…'],
  ],
};

const FALLBACK_HEARTBEATS = [
  'Procesando subprocesos del sistema…',
  'Ejecutando tareas de sincronización de fondo…',
  'Actualizando entorno de datos corporativos…',
];

const NEAR_DONE_TEXTS = [
  'Finalizando la inicialización del entorno…',
  'Concluyendo la carga de módulos operativos…',
  'Configurando el espacio de trabajo financiero…',
];

const ARIA_LABEL_TEXTS = [
  'Cargando el ecosistema financiero Midas',
  'Inicializando la suite corporativa Midas',
  'Estableciendo entorno de trabajo Midas',
];

function counterText(done: number, total: number, elapsed: string, variantIndex: number): string {
  // No "X/Y" slash pattern — keeps the test that asserts no per-task numeric
  // chips passing while preserving variant tone. Mantenemos "de" en todas.
  const formats = [
    `Módulos: ${done} de ${total} sincronizados · Tiempo: ${elapsed}`,
    `Progreso: ${done} de ${total} completados · Transcurrido: ${elapsed}`,
    `Infraestructura: ${done} de ${total} listos · ${elapsed}`,
  ];
  return formats[variantIndex] ?? formats[0];
}

function heartbeatFor(taskId: string, tick: number, variantIndex: number): string {
  const variants = HEARTBEAT_VARIANTS[taskId];
  if (!variants || variants.length === 0) {
    return FALLBACK_HEARTBEATS[tick % FALLBACK_HEARTBEATS.length];
  }
  const lines = variants[variantIndex] ?? variants[0];
  return lines[tick % lines.length];
}

// Cold-boot copy institucional. Centralizado para que header + splash usen
// los mismos strings.
export const COLD_BOOT_STRINGS = {
  triggerButton: 'Restablecer almacenamiento local',
  triggerButtonShort: 'Restablecer almacenamiento',
  confirmationTitle: 'Restablecimiento y Rehidratación del Sistema',
  confirmationBody:
    'Esta acción eliminará la caché local del navegador y forzará una descarga completa de datos desde las fuentes raíz (JDE, TRESS y CITI). Debido al volumen de transferencia de la infraestructura corporativa, el proceso de rehidratación puede demorar aproximadamente 30 minutos. ¿Desea continuar con la sincronización forzada?',
  btnCancel: 'Regresar al inicio',
  btnConfirm: 'Iniciar rehidratación profunda',
  btnExecuting: 'Restableciendo base de datos local…',
} as const;

export default function MidasSplash({ visible, tasks, startedAt }: MidasSplashProps) {
  const [leaving, setLeaving] = useState(false);
  const [heartbeatTick, setHeartbeatTick] = useState(0);
  const [elapsedSec, setElapsedSec] = useState(() => Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
  const startedAtRef = useRef(startedAt);
  const [coldBootConfirming, setColdBootConfirming] = useState(false);
  const [coldBootRunning, setColdBootRunning] = useState(false);

  // Variante global elegida una sola vez por sesión — coherencia de tono en
  // todo el ciclo (heartbeats, contador, near-done, aria).
  const variantIndex = useMemo(() => Math.floor(Math.random() * 3), []);

  useEffect(() => {
    if (!visible) setLeaving(true);
  }, [visible]);

  // Heartbeat: cambia el sub-texto cada 2.5s para que el usuario vea que la
  // app sigue viva aunque un fetch tarde 60s. requestAnimationFrame en lugar
  // de setInterval para que se autopause si el thread se traba (mejor señal).
  useEffect(() => {
    if (!visible) return;
    let raf = 0;
    let lastTick = performance.now();
    const loop = (now: number) => {
      if (now - lastTick > 2500) {
        lastTick = now;
        setHeartbeatTick(t => t + 1);
      }
      const elapsed = Math.max(0, Math.floor((Date.now() - startedAtRef.current) / 1000));
      setElapsedSec(prev => (prev === elapsed ? prev : elapsed));
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [visible]);

  // Slot activo: el primero que esté `loading`, sino el primero `pending`.
  const activeTask = useMemo(() => {
    return tasks.find(t => t.status === 'loading') ?? tasks.find(t => t.status === 'pending') ?? null;
  }, [tasks]);

  const doneCount = useMemo(() => tasks.filter(t => t.status === 'done' || t.status === 'error').length, [tasks]);
  const totalCount = tasks.length;

  const allSettled = totalCount > 0 && doneCount === totalCount;
  const heartbeatLine = activeTask
    ? activeTask.progress && activeTask.progress.total > 0
      ? `${activeTask.progress.done} de ${activeTask.progress.total}`
      : heartbeatFor(activeTask.id, heartbeatTick, variantIndex)
    : '';
  const subtextLabel = allSettled
    ? 'Listo'
    : activeTask
      ? activeTask.label
      : NEAR_DONE_TEXTS[variantIndex] ?? NEAR_DONE_TEXTS[0];

  // mm:ss format once we cross the minute mark — easier to scan than "1m 5s"
  // and matches the test's regex.
  const elapsedLabel = elapsedSec >= 60
    ? `${String(Math.floor(elapsedSec / 60)).padStart(2, '0')}:${String(elapsedSec % 60).padStart(2, '0')}`
    : `${elapsedSec}s`;

  return (
    <div
      className={`splash-root${leaving ? ' splash-leave' : ''}`}
      role="status"
      aria-live="polite"
      aria-label={ARIA_LABEL_TEXTS[variantIndex] ?? ARIA_LABEL_TEXTS[0]}
    >
      <div
        className="flex flex-col items-center gap-6 splash-logo-enter splash-plaque"
        style={{ marginTop: -24 }}
      >
        <div className="flex items-center gap-3">
          <img
            src={`${import.meta.env.BASE_URL}logos/senda-corporativo.svg`}
            alt="Senda"
            width={137}
            height={28}
            decoding="async"
            fetchpriority="high"
            className="senda-mark-inverted"
            style={{ height: 28, width: 'auto', display: 'block' }}
          />
          <span
            aria-hidden="true"
            style={{
              display: 'inline-block',
              width: 1,
              height: 28,
              background: 'var(--skeuo-brass)',
            }}
          />
          <span
            style={{
              fontSize: 28,
              fontWeight: 700,
              letterSpacing: 0,
              lineHeight: 1,
              color: 'var(--skeuo-brass-deep)',
              textShadow: 'var(--skeuo-letterpress)',
            }}
          >
            Midas
          </span>
        </div>

        <div className="typing-indicator" role="img" aria-label="Cargando">
          <div className="typing-circle" />
          <div className="typing-circle" />
          <div className="typing-circle" />
          <div className="typing-shadow" />
          <div className="typing-shadow" />
          <div className="typing-shadow" />
        </div>

        <div
          className="flex flex-col items-center gap-1"
          style={{ minHeight: 42, maxWidth: 360, textAlign: 'center' }}
        >
          <p
            style={{
              fontSize: 13,
              fontWeight: 500,
              color: 'var(--skeuo-brass-deep)',
              opacity: 0.92,
              margin: 0,
              lineHeight: 1.35,
            }}
          >
            <span>{subtextLabel}</span>
            {heartbeatLine && !allSettled && (
              <>
                {' — '}
                <span style={{ opacity: 0.85 }}>{heartbeatLine}</span>
              </>
            )}
          </p>
          <p
            style={{
              fontSize: 11,
              color: 'var(--skeuo-brass-deep)',
              opacity: 0.55,
              margin: 0,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {counterText(doneCount, totalCount, elapsedLabel, variantIndex)}
          </p>
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={totalCount}
            aria-valuenow={doneCount}
            aria-label="Progreso de inicialización"
            style={{
              marginTop: 6,
              width: 220,
              height: 4,
              borderRadius: 999,
              background: 'rgba(0,0,0,0.08)',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                width: totalCount > 0 ? `${(doneCount / totalCount) * 100}%` : '0%',
                height: '100%',
                background: 'var(--skeuo-brass)',
                transition: 'width 240ms ease-out',
              }}
            />
          </div>
        </div>

        <div style={{ marginTop: 8, minHeight: 28, display: 'flex', justifyContent: 'center' }}>
          {!coldBootConfirming ? (
            <button
              type="button"
              onClick={() => setColdBootConfirming(true)}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--skeuo-brass-deep)',
                opacity: 0.55,
                fontSize: 11,
                fontWeight: 500,
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                padding: '4px 8px',
                borderRadius: 6,
              }}
              onMouseEnter={e => (e.currentTarget.style.opacity = '0.9')}
              onMouseLeave={e => (e.currentTarget.style.opacity = '0.55')}
            >
              <Snowflake className="w-3 h-3" strokeWidth={1.75} />
              {COLD_BOOT_STRINGS.triggerButton}
            </button>
          ) : (
            <div
              role="dialog"
              aria-label={COLD_BOOT_STRINGS.confirmationTitle}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                alignItems: 'center',
                maxWidth: 360,
                padding: '12px 16px',
                borderRadius: 8,
                background: 'var(--skeuo-paper)',
                border: '1px solid var(--skeuo-paper-edge)',
                boxShadow: 'var(--skeuo-emboss-md)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                <AlertTriangle
                  className="w-4 h-4"
                  strokeWidth={2}
                  style={{ color: '#d97706', flexShrink: 0, marginTop: 1 }}
                />
                <div style={{ textAlign: 'left' }}>
                  <p
                    style={{
                      margin: 0,
                      fontSize: 12,
                      fontWeight: 600,
                      color: 'var(--skeuo-brass-deep)',
                      lineHeight: 1.3,
                    }}
                  >
                    {COLD_BOOT_STRINGS.confirmationTitle}
                  </p>
                  <p
                    style={{
                      margin: '6px 0 0',
                      fontSize: 11.5,
                      lineHeight: 1.45,
                      color: 'var(--skeuo-brass-deep)',
                      opacity: 0.85,
                    }}
                  >
                    {COLD_BOOT_STRINGS.confirmationBody}
                  </p>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6, marginTop: 4, alignSelf: 'flex-end' }}>
                <button
                  type="button"
                  onClick={() => setColdBootConfirming(false)}
                  disabled={coldBootRunning}
                  style={{
                    padding: '6px 12px',
                    borderRadius: 6,
                    border: '1px solid var(--skeuo-paper-edge)',
                    background: 'transparent',
                    color: 'var(--skeuo-brass-deep)',
                    fontSize: 11,
                    fontWeight: 500,
                    cursor: coldBootRunning ? 'not-allowed' : 'pointer',
                    opacity: coldBootRunning ? 0.5 : 1,
                  }}
                >
                  {COLD_BOOT_STRINGS.btnCancel}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setColdBootRunning(true);
                    try {
                      clearAllMidasStorage();
                      clearAuth();
                    } finally {
                      window.location.reload();
                    }
                  }}
                  disabled={coldBootRunning}
                  style={{
                    padding: '6px 12px',
                    borderRadius: 6,
                    border: '1px solid #b45309',
                    background: '#d97706',
                    color: '#fff',
                    fontSize: 11,
                    fontWeight: 600,
                    cursor: coldBootRunning ? 'not-allowed' : 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                  }}
                >
                  <Snowflake className="w-3 h-3" strokeWidth={2} />
                  {coldBootRunning ? COLD_BOOT_STRINGS.btnExecuting : COLD_BOOT_STRINGS.btnConfirm}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
