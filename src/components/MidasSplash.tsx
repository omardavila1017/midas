import { useEffect, useState } from 'react';

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

export default function MidasSplash({ visible }: MidasSplashProps) {
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (!visible) setLeaving(true);
  }, [visible]);

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
      </div>
    </div>
  );
}
