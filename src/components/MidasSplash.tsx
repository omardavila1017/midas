import { useEffect, useMemo, useRef, useState } from 'react';

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

// Rotación de mensajes "vivos" mientras esperamos que un slot termine. Dan
// señal de que el thread no está pegado aunque el slot tarde.
const HEARTBEAT_PHRASES: Record<string, string[]> = {
  catalog: ['Cargando catálogos…', 'Leyendo IndexedDB…', 'Preparando clientes y proveedores…'],
  companies: ['Conectando con JDE…', 'Leyendo /empresas…', 'Hidratando catálogo de cías…'],
  banks: ['Pidiendo estados de cuenta…', 'Reconstruyendo movimientos…', 'Reconciliando bancos…'],
  cxp: ['Pidiendo CXP a JDE (29 cías)…', 'Acumulando antigüedad de saldos…', 'Procesando facturas pendientes…'],
  cobranza: ['Pidiendo cobranza a JDE (29 cías)…', 'Cruzando facturas vs pagos…', 'Reconciliando cartera…'],
  nomina: ['Conectando con TRESS…', 'Cargando nómina del mes…', 'Calculando bimodal de pagos…'],
  rol: ['Conectando con CITI…', 'Pidiendo ROL Diario desde enero…', 'Cruzando viajes con cobranza…'],
};

function heartbeatFor(taskId: string, tick: number): string {
  const list = HEARTBEAT_PHRASES[taskId];
  if (!list || list.length === 0) return 'Trabajando…';
  return list[tick % list.length];
}

export default function MidasSplash({ visible, tasks, startedAt }: MidasSplashProps) {
  const [leaving, setLeaving] = useState(false);
  const [heartbeatTick, setHeartbeatTick] = useState(0);
  const [elapsedSec, setElapsedSec] = useState(() => Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
  const startedAtRef = useRef(startedAt);

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

  const subtext = activeTask
    ? activeTask.progress && activeTask.progress.total > 0
      ? `${activeTask.label} · ${activeTask.progress.done}/${activeTask.progress.total}`
      : `${activeTask.label} — ${heartbeatFor(activeTask.id, heartbeatTick)}`
    : 'Casi listo…';

  const elapsedLabel = elapsedSec >= 60
    ? `${Math.floor(elapsedSec / 60)}m ${elapsedSec % 60}s`
    : `${elapsedSec}s`;

  return (
    <div
      className={`splash-root${leaving ? ' splash-leave' : ''}`}
      role="status"
      aria-live="polite"
      aria-label="Cargando Midas"
    >
      <div
        className="flex flex-col items-center gap-6 splash-logo-enter splash-plaque"
        style={{ marginTop: -24 }}
      >
        <div className="flex items-center gap-3">
          <img
            src={`${import.meta.env.BASE_URL}logos/senda-corporativo.svg`}
            alt="Senda"
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
            {subtext}
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
            {doneCount}/{totalCount} listos · {elapsedLabel}
          </p>
        </div>
      </div>
    </div>
  );
}
