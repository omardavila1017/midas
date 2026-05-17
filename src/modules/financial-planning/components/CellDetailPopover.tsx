import { useEffect, useState } from 'react';
import { Lock, X } from 'lucide-react';
import { fmtCurrency } from '../../../formatters';

export interface CellDetailData {
  conceptKey: string;
  conceptLabel: string;
  bucketKey: string;
  bucketLabel: string;
  scenarioName: string;
  isBaseScenario: boolean;
  baseValue: number;
  manualOverride: number | null;
  overrideComment?: string | null;
  totalValue: number;
  diffVsBase: number;
}

interface Props {
  data: CellDetailData | null;
  onClose: () => void;
  onApplyOverride?: (value: number) => void;
}

export function CellDetailPopover({ data, onClose, onApplyOverride }: Props) {
  const [pct, setPct] = useState(0);

  useEffect(() => {
    setPct(0);
  }, [data?.conceptKey, data?.bucketKey, data?.scenarioName]);

  useEffect(() => {
    if (!data) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' || event.key.toLowerCase() === 'i') {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [data, onClose]);

  if (!data) return null;

  const overrideDelta = data.manualOverride !== null ? data.manualOverride - data.baseValue : 0;
  const previewValue = Math.max(0, data.baseValue * (1 + pct / 100));
  const previewDelta = previewValue - data.baseValue;
  const canEdit = !data.isBaseScenario && Boolean(onApplyOverride);

  return (
    <div
      className="fixed inset-0 z-[70] flex items-start justify-end p-6"
      role="dialog"
      aria-label={`Detalle de ${data.conceptLabel} en ${data.bucketLabel}`}
      onClick={onClose}
    >
      <div
        className="pointer-events-auto w-[380px] overflow-hidden rounded-[var(--radius-lg)] border border-[var(--gray-200)] bg-[var(--surface)] shadow-2xl animate-card-in"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-3 border-b border-[var(--gray-100)] px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--gray-500)]">
              Detalle de celda
            </div>
            <h3 className="mt-0.5 truncate text-[14px] font-bold leading-tight text-[var(--gray-950)]">
              {data.conceptLabel}
            </h3>
            <p className="mt-0.5 text-[11px] text-[var(--gray-500)]">
              {data.bucketLabel} · {data.scenarioName}
              {data.isBaseScenario && (
                <span className="ml-1.5 inline-flex items-center gap-1 rounded-[var(--radius-sm)] bg-[var(--gray-100)] px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-[0.08em] text-[var(--gray-500)]">
                  <Lock className="h-2.5 w-2.5" strokeWidth={1.5} /> base
                </span>
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--radius-md)] text-[var(--gray-400)] transition-colors duration-150 hover:bg-[var(--gray-50)] hover:text-[var(--gray-700)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]/30"
          >
            <X className="h-3.5 w-3.5" strokeWidth={1.5} />
          </button>
        </header>

        <div className="space-y-3 p-4">
          <Row label="Valor base" value={data.baseValue} muted />
          {data.manualOverride !== null && !data.isBaseScenario && (
            <>
              <Row label="Δ manual" value={overrideDelta} delta />
              {data.overrideComment && (
                <p className="rounded-[var(--radius-md)] bg-[var(--gray-50)] px-3 py-2 text-[11px] leading-relaxed text-[var(--gray-700)]">
                  <span className="font-medium text-[var(--gray-500)]">Nota: </span>
                  {data.overrideComment}
                </p>
              )}
            </>
          )}
          <div className="my-2 h-px bg-[var(--gray-100)]" />
          <Row label="Total" value={data.totalValue} bold />
          {!data.isBaseScenario && (
            <Row label="Δ vs Base" value={data.diffVsBase} delta />
          )}
        </div>

        {canEdit && (
          <div className="border-t border-[var(--gray-100)] bg-[var(--surface-alt)] p-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--gray-500)]">
                Sensibilidad
              </span>
              <span
                className="text-[11px] tabular-nums font-bold"
                style={{ color: pct > 0 ? 'var(--success)' : pct < 0 ? 'var(--danger)' : 'var(--gray-700)' }}
              >
                {pct > 0 ? '+' : ''}{pct}%
              </span>
            </div>
            <input
              type="range"
              min={-50}
              max={50}
              step={1}
              value={pct}
              onChange={(event) => setPct(Number(event.target.value))}
              aria-label="Ajuste porcentual sobre el valor base"
              className="w-full accent-[var(--primary)]"
            />
            <div className="mt-3 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--gray-500)]">
                  Vista previa
                </p>
                <p className="text-[13px] tabular-nums font-bold text-[var(--gray-950)]">
                  {fmtCurrency(previewValue)}
                  {pct !== 0 && (
                    <span
                      className="ml-1.5 text-[11px] font-medium"
                      style={{ color: previewDelta > 0 ? 'var(--success)' : 'var(--danger)' }}
                    >
                      ({previewDelta > 0 ? '+' : ''}{fmtCurrency(previewDelta)})
                    </span>
                  )}
                </p>
              </div>
              <button
                type="button"
                disabled={pct === 0}
                onClick={() => {
                  if (pct === 0) return;
                  onApplyOverride?.(previewValue);
                }}
                className="inline-flex h-9 shrink-0 items-center rounded-[var(--radius)] px-3 text-[12px] font-medium text-white transition-colors duration-150 hover:bg-[var(--primary-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]/30 disabled:cursor-not-allowed disabled:opacity-40"
                style={{ background: 'var(--primary)' }}
              >
                Aplicar
              </button>
            </div>
          </div>
        )}

        <footer className="border-t border-[var(--gray-100)] bg-[var(--surface-alt)] px-4 py-2.5 text-[10px] text-[var(--gray-500)]">
          <kbd className="rounded-[var(--radius-sm)] bg-white px-1 py-0.5 font-mono text-[10px] text-[var(--gray-700)] shadow-sm">i</kbd>
          {' '}o{' '}
          <kbd className="rounded-[var(--radius-sm)] bg-white px-1 py-0.5 font-mono text-[10px] text-[var(--gray-700)] shadow-sm">Esc</kbd>
          {' '}para cerrar
        </footer>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  delta = false,
  bold = false,
  muted = false,
}: {
  label: string;
  value: number;
  delta?: boolean;
  bold?: boolean;
  muted?: boolean;
}) {
  const sign = delta && value !== 0 ? (value > 0 ? '+' : '') : '';
  const color = delta
    ? value > 0
      ? 'var(--success)'
      : value < 0
        ? 'var(--danger)'
        : 'var(--gray-700)'
    : muted
      ? 'var(--gray-500)'
      : 'var(--gray-950)';
  return (
    <div className="flex items-center justify-between">
      <span className="text-[12px] text-[var(--gray-500)]">{label}</span>
      <span
        className={`tabular-nums text-[13px] ${bold ? 'font-bold' : 'font-medium'}`}
        style={{ color }}
      >
        {sign}
        {fmtCurrency(value)}
      </span>
    </div>
  );
}
