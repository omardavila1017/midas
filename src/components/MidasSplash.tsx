import { useEffect, useState } from 'react';
import { AlertTriangle, Check, Loader2 } from 'lucide-react';

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

function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

export default function MidasSplash({ visible, tasks, startedAt }: MidasSplashProps) {
  const [leaving, setLeaving] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!visible) {
      setLeaving(true);
      return;
    }
    const id = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(id);
  }, [visible]);

  const total = tasks.length;
  const doneCount = tasks.filter(t => t.status === 'done').length;
  const errorCount = tasks.filter(t => t.status === 'error').length;
  const settled = doneCount + errorCount;
  const overallPct = total > 0 ? Math.min(100, (settled / total) * 100) : 0;
  const allSettled = total > 0 && settled === total;

  const current =
    tasks.find(t => t.status === 'loading') ?? tasks.find(t => t.status === 'pending');
  const headline = allSettled
    ? errorCount > 0
      ? 'Listo · con avisos'
      : 'Listo'
    : current?.label ?? 'Iniciando Midas…';

  const elapsed = formatElapsed(now - startedAt);

  return (
    <div
      className={`splash-root${leaving ? ' splash-leave' : ''}`}
      role="status"
      aria-live="polite"
      aria-label="Cargando Midas"
    >
      <div
        className="flex flex-col items-center gap-5 splash-logo-enter"
        style={{ marginTop: -24, width: 'min(360px, calc(100vw - 48px))' }}
      >
        {/* Brand lockup */}
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
              background: 'var(--shell-border)',
            }}
          />
          <span
            style={{
              fontSize: 28,
              fontWeight: 700,
              letterSpacing: 0,
              lineHeight: 1,
              color: 'var(--shell-text)',
            }}
          >
            Midas
          </span>
        </div>

        {/* Headline */}
        <div
          key={headline}
          className="animate-fade-in"
          style={{
            fontSize: 13,
            fontFamily: 'var(--font-family)',
            color: 'var(--shell-text-muted)',
            letterSpacing: '0.02em',
            minHeight: 18,
            textAlign: 'center',
          }}
        >
          {allSettled ? (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                color: 'var(--shell-text)',
              }}
            >
              <Check size={14} strokeWidth={2.25} aria-hidden="true" />
              {headline}
            </span>
          ) : (
            headline
          )}
        </div>

        {/* Overall progress bar */}
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={settled}
          aria-label={`Progreso ${settled} de ${total}`}
          style={{
            width: '100%',
            height: 4,
            borderRadius: 999,
            background: 'var(--shell-border)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              width: `${overallPct}%`,
              height: '100%',
              background: 'var(--shell-text)',
              borderRadius: 999,
              transition: 'width 360ms var(--ease-smooth)',
            }}
          />
        </div>

        {/* Task list */}
        <ul
          style={{
            width: '100%',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            listStyle: 'none',
            padding: 0,
            margin: 0,
          }}
        >
          {tasks.map(task => (
            <li
              key={task.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 12,
                fontFamily: 'var(--font-family)',
                color:
                  task.status === 'done'
                    ? 'var(--shell-text)'
                    : 'var(--shell-text-muted)',
                letterSpacing: '0.01em',
                opacity: task.status === 'pending' ? 0.55 : 1,
                transition: 'opacity 200ms var(--ease-smooth), color 200ms var(--ease-smooth)',
              }}
            >
              <TaskIcon status={task.status} />
              <span>{task.label}</span>
            </li>
          ))}
        </ul>

        {/* Elapsed timer */}
        <div
          style={{
            fontSize: 11,
            fontFamily: 'var(--font-family)',
            color: 'var(--shell-text-muted)',
            letterSpacing: 'var(--tracking-meta)',
            textTransform: 'uppercase',
            opacity: 0.7,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {allSettled ? 'Tiempo total · ' : 'Tiempo · '}
          <strong style={{ fontWeight: 600, color: 'var(--shell-text)' }}>{elapsed}</strong>
        </div>
      </div>

      {/* Footer wordmark */}
      <div
        style={{
          position: 'absolute',
          bottom: 32,
          left: 0,
          right: 0,
          textAlign: 'center',
          fontSize: 11,
          color: 'var(--shell-text-muted)',
          opacity: 0.5,
          letterSpacing: 'var(--tracking-meta)',
          textTransform: 'uppercase',
        }}
      >
        Treasury workbench · Grupo Senda
      </div>
    </div>
  );
}

function TaskIcon({ status }: { status: BootTaskStatus }) {
  if (status === 'done') {
    return (
      <Check
        size={14}
        strokeWidth={2.25}
        style={{ color: 'var(--shell-text)' }}
        aria-hidden="true"
      />
    );
  }
  if (status === 'error') {
    return (
      <AlertTriangle
        size={14}
        strokeWidth={2}
        style={{ color: 'var(--shell-text-muted)' }}
        aria-hidden="true"
      />
    );
  }
  if (status === 'loading') {
    return (
      <Loader2
        size={14}
        strokeWidth={2.25}
        className="animate-spin"
        style={{ color: 'var(--shell-text)' }}
        aria-hidden="true"
      />
    );
  }
  return (
    <span
      style={{
        width: 12,
        height: 12,
        borderRadius: '50%',
        border: '1px solid var(--shell-border)',
        display: 'inline-block',
      }}
      aria-hidden="true"
    />
  );
}
