import { useEffect, useState } from 'react';
import { Sparkles, X } from 'lucide-react';

const STORAGE_KEY = 'midas.firstSimulationNudge.dismissed.v1';

interface Props {
  onCreateDraft: () => void;
}

/**
 * Senda DS:
 *   - Tarjeta blanca sólida (no gradient — el DS prohíbe degradados).
 *   - Lucide stroke 1.5. Roboto 400/500/700.
 *   - Radius via tokens. Hover sutil, focus-visible para keyboard.
 *   - El icono no es decorativo: `Sparkles` señala "primer momento".
 */
export function FirstSimulationNudge({ onCreateDraft }: Props) {
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try { return localStorage.getItem(STORAGE_KEY) === '1'; } catch { return false; }
  });

  useEffect(() => {
    if (!dismissed) return;
    try { localStorage.setItem(STORAGE_KEY, '1'); } catch { /* ignore */ }
  }, [dismissed]);

  if (dismissed) return null;

  return (
    <section
      role="region"
      aria-label="Sugerencia de primera simulación"
      className="relative overflow-hidden rounded-[var(--radius-lg)] border border-[var(--gray-200)] bg-[var(--surface)] px-5 py-4 animate-card-in"
    >
      <button
        type="button"
        aria-label="Descartar sugerencia"
        onClick={() => setDismissed(true)}
        className="absolute right-3 top-3 inline-flex h-7 w-7 items-center justify-center rounded-full text-[var(--gray-400)] transition-colors duration-150 hover:bg-[var(--gray-100)] hover:text-[var(--gray-700)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]/30"
      >
        <X className="h-3.5 w-3.5" strokeWidth={1.5} />
      </button>

      <div className="flex items-start gap-3 pr-8">
        <div
          className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius)]"
          style={{ background: 'var(--primary)', color: 'white' }}
          aria-hidden="true"
        >
          <Sparkles className="h-4 w-4" strokeWidth={1.5} />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-[14px] font-bold leading-tight text-[var(--gray-950)]">
            Tu pronóstico está listo
          </h3>
          <p className="mt-1 text-[12px] leading-relaxed text-[var(--gray-600)]">
            Crea tu primera propuesta y observa cómo cambia la caja. Por ejemplo:{' '}
            <span className="font-medium text-[var(--gray-800)]">¿qué pasa si suben los ingresos 10%?</span>
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => { onCreateDraft(); setDismissed(true); }}
              className="inline-flex h-9 items-center gap-2 rounded-[var(--radius)] bg-[var(--primary)] px-3 text-[12px] font-medium text-white transition-colors duration-150 hover:bg-[var(--primary-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]/30"
            >
              Crear primera propuesta
            </button>
            <button
              type="button"
              onClick={() => setDismissed(true)}
              className="inline-flex h-9 items-center gap-2 rounded-[var(--radius)] px-3 text-[12px] font-medium text-[var(--gray-600)] transition-colors duration-150 hover:bg-[var(--gray-100)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]/30"
            >
              Más tarde
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
