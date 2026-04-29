import { useEffect, useState } from 'react';
import { Check } from 'lucide-react';

export type BootStep = 'init' | 'catalog' | 'jde' | 'banks' | 'ready';

interface MidasSplashProps {
  visible: boolean;
  step: BootStep;
  hasError?: boolean;
}

const STEP_LABEL: Record<BootStep, string> = {
  init: 'Iniciando Midas…',
  catalog: 'Cargando catálogos…',
  jde: 'Conectando con JDE…',
  banks: 'Sincronizando bancos…',
  ready: 'Listo',
};

const STEP_LABEL_ERROR: Partial<Record<BootStep, string>> = {
  jde: 'JDE no respondió — continuando…',
};

export default function MidasSplash({ visible, step, hasError }: MidasSplashProps) {
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (!visible) setLeaving(true);
  }, [visible]);

  const label =
    (hasError && STEP_LABEL_ERROR[step]) ||
    STEP_LABEL[step];

  return (
    <div
      className={`splash-root${leaving ? ' splash-leave' : ''}`}
      role="status"
      aria-live="polite"
      aria-label="Cargando Midas"
    >
      <div
        className="flex flex-col items-center gap-6 splash-logo-enter"
        style={{ marginTop: -24 }}
      >
        {/* Brand lockup — replicates header App.tsx:654–681 */}
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

        {/* Status line — re-mounts on step change for fade-in */}
        <div
          key={step}
          className="animate-fade-in"
          style={{
            fontSize: 13,
            fontFamily: 'var(--font-family)',
            color: 'var(--shell-text-muted)',
            letterSpacing: '0.02em',
            minHeight: 18,
          }}
        >
          {label}
        </div>

        {/* Dots → checkmark */}
        <div className="flex items-center justify-center" style={{ height: 12, gap: 8 }}>
          {step === 'ready' ? (
            <Check
              className="animate-fade-in"
              size={16}
              strokeWidth={2.25}
              style={{ color: 'var(--shell-text)' }}
              aria-hidden="true"
            />
          ) : (
            <>
              <span
                data-splash-dot
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: 'var(--shell-text-muted)',
                  opacity: 0.5,
                  animation: 'softPulse 1.2s var(--ease-smooth) infinite',
                  animationDelay: '0ms',
                }}
              />
              <span
                data-splash-dot
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: 'var(--shell-text-muted)',
                  opacity: 0.5,
                  animation: 'softPulse 1.2s var(--ease-smooth) infinite',
                  animationDelay: '160ms',
                }}
              />
              <span
                data-splash-dot
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: 'var(--shell-text-muted)',
                  opacity: 0.5,
                  animation: 'softPulse 1.2s var(--ease-smooth) infinite',
                  animationDelay: '320ms',
                }}
              />
            </>
          )}
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
