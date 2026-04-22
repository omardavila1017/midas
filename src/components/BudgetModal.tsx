import React, { useEffect, useState } from 'react';
import { X, Upload, Download, AlertTriangle, FileSpreadsheet, Check, Trash2 } from 'lucide-react';
import type { Budget, BudgetScale } from '../domain/budget';
import {
  parseBudgetCsv,
  buildBudgetTemplateCsv,
  scaleLabel,
  scaleFactor,
  MONTH_HEADERS,
} from '../domain/budget';
import { fmtCurrency } from '../formatters';

interface Props {
  open: boolean;
  budget: Budget | null;
  onClose: () => void;
  onApply: (b: Budget) => void;
  onClear: () => void;
}

type ParsedState =
  | { status: 'idle' }
  | { status: 'parsing' }
  | { status: 'error'; message: string; warnings: string[] }
  | { status: 'preview'; budget: Budget; detectedScale: BudgetScale | null; scale: BudgetScale; rawText: string; fileName: string; warnings: string[] };

const SCALES: BudgetScale[] = ['millones', 'miles', 'pesos'];

// Validaciones a nivel de archivo antes de leer su contenido. El CSV del
// presupuesto es texto plano pequeño; subir 10 MB o un .xlsx es siempre un
// error de usuario que podemos diagnosticar sin abrir el archivo.
const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5 MB — el CSV real mide <50 KB

function validateFileUpload(file: File): string | null {
  if (file.size === 0) return 'El archivo está vacío.';
  if (file.size > MAX_FILE_BYTES) {
    const mb = (file.size / 1024 / 1024).toFixed(1);
    return `El archivo pesa ${mb} MB; el límite es 5 MB. ¿Seguro que es un CSV de presupuesto?`;
  }
  const name = file.name.toLowerCase();
  if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
    return 'Este es un archivo de Excel. Ábrelo y exporta como CSV (UTF-8) antes de cargarlo.';
  }
  if (name.endsWith('.numbers')) {
    return 'Este es un archivo de Numbers. Ábrelo y exporta como CSV antes de cargarlo.';
  }
  if (name.endsWith('.pdf')) {
    return 'Este es un PDF, no un CSV.';
  }
  // Aceptamos cualquier otra extensión (puede venir sin extensión o con .txt)
  // — el parser detectará binarios por su contenido.
  return null;
}

const BudgetModal: React.FC<Props> = ({ open, budget, onClose, onApply, onClear }) => {
  const [parsed, setParsed] = useState<ParsedState>({ status: 'idle' });
  const [downloadScale, setDownloadScale] = useState<BudgetScale>('millones');
  const [dragActive, setDragActive] = useState(false);

  // Esc cierra el modal; además bloqueamos scroll del body mientras está
  // abierto para que no se pueda hacer scroll detrás del backdrop.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  const handleFile = async (file: File) => {
    // Pre-validación: tamaño / extensión obvia, antes de leer bytes.
    const fileErr = validateFileUpload(file);
    if (fileErr) {
      setParsed({ status: 'error', message: fileErr, warnings: [] });
      return;
    }
    setParsed({ status: 'parsing' });
    try {
      const text = await file.text();
      const r = parseBudgetCsv(text, { fileName: file.name });
      if (r.error || !r.budget) {
        setParsed({ status: 'error', message: r.error ?? 'No se pudo parsear el CSV.', warnings: r.warnings });
        return;
      }
      setParsed({
        status: 'preview',
        budget: r.budget,
        detectedScale: r.detectedScale,
        scale: r.budget.scale,
        rawText: text,
        fileName: file.name,
        warnings: r.warnings,
      });
    } catch (e) {
      setParsed({
        status: 'error',
        message: e instanceof Error ? e.message : 'Error al leer el archivo.',
        warnings: [],
      });
    }
  };

  const onDrop = (e: React.DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    setDragActive(false);
    const f = e.dataTransfer.files?.[0];
    if (f) handleFile(f);
  };
  const onDragOver = (e: React.DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    if (!dragActive) setDragActive(true);
  };
  const onDragLeave = (e: React.DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    setDragActive(false);
  };

  const reparseWithScale = (scale: BudgetScale) => {
    if (parsed.status !== 'preview') return;
    const r = parseBudgetCsv(parsed.rawText, { scale, fileName: parsed.fileName });
    if (r.error || !r.budget) {
      setParsed({ status: 'error', message: r.error ?? 'Error al re-parsear.', warnings: r.warnings });
      return;
    }
    setParsed({
      ...parsed,
      scale,
      budget: r.budget,
      warnings: r.warnings,
    });
  };

  const applyPreview = () => {
    if (parsed.status !== 'preview') return;
    onApply(parsed.budget);
    setParsed({ status: 'idle' });
    onClose();
  };

  const downloadTemplate = () => {
    const csv = buildBudgetTemplateCsv(downloadScale, new Date().getFullYear());
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `presupuesto-plantilla-${downloadScale}-${new Date().getFullYear()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      {/* Backdrop: gris oscuro con blur suave — mantiene la jerarquía visual
          sin el look de "pantalla negra". El z-index vive por debajo del
          modal para que el clic fuera cierre sin bloquear la interacción. */}
      <div
        className="fixed inset-0 z-[300] animate-fade-in"
        onClick={onClose}
        aria-hidden="true"
        style={{
          background: 'color-mix(in srgb, var(--gray-950) 38%, transparent)',
          backdropFilter: 'blur(4px)',
          WebkitBackdropFilter: 'blur(4px)',
        }}
      />

      {/* Modal container — dialog separado, centrado, con scroll interno
          y animación spring. */}
      <div
        className="fixed inset-0 z-[400] flex items-center justify-center p-4 pointer-events-none"
        role="dialog"
        aria-modal="true"
        aria-labelledby="budget-modal-title"
      >
        <div
          className="pointer-events-auto w-full max-w-2xl max-h-[calc(100vh-2rem)] rounded-2xl bg-white flex flex-col overflow-hidden animate-scale-in"
          style={{
            boxShadow: 'var(--shadow-lg)',
            border: '1px solid var(--gray-200)',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <header className="flex items-center justify-between px-5 py-4 border-b border-[var(--gray-100)] flex-shrink-0">
            <div className="flex items-center gap-2.5">
              <span
                className="w-8 h-8 rounded-lg flex items-center justify-center"
                style={{ background: 'var(--primary-muted)' }}
              >
                <FileSpreadsheet className="w-4 h-4" style={{ color: 'var(--primary)' }} />
              </span>
              <div>
                <h2
                  id="budget-modal-title"
                  className="text-[15px] font-semibold tracking-tight"
                  style={{ color: 'var(--gray-950)' }}
                >
                  Presupuesto anual
                </h2>
                <p className="text-[11px]" style={{ color: 'var(--gray-400)' }}>
                  Importa o descarga el CSV del presupuesto del año.
                </p>
              </div>
            </div>
            <button
              onClick={onClose}
              aria-label="Cerrar"
              className="w-8 h-8 flex items-center justify-center rounded-lg text-[var(--gray-400)] hover:bg-[var(--gray-100)] hover:text-[var(--gray-950)] transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </header>

          {/* Body */}
          <div className="flex-1 overflow-y-auto p-5 space-y-5">
          {/* Current budget pill */}
          {budget && parsed.status === 'idle' && (
            <div className="rounded-xl border border-[var(--success)]/30 bg-[var(--success)]/5 p-4 flex items-start gap-3">
              <Check className="w-5 h-5 mt-0.5 flex-shrink-0" style={{ color: 'var(--success)' }} />
              <div className="flex-1 min-w-0">
                <p className="text-[13px] font-semibold" style={{ color: 'var(--gray-950)' }}>
                  Presupuesto {budget.year} cargado
                </p>
                <p className="text-[12px] mt-0.5" style={{ color: 'var(--gray-500)' }}>
                  {budget.fileName ?? 'Archivo sin nombre'} · escala original: {scaleLabel(budget.scale)} ·
                  {' '}{budget.incomeByConcept.length + 1} filas de ingresos, {budget.expenseByConcept.length} de egresos.
                </p>
              </div>
              <button
                onClick={onClear}
                className="flex items-center gap-1.5 h-8 px-3 rounded-lg border border-[var(--danger)]/30 text-[12px] text-[var(--danger)] hover:bg-[var(--danger)]/10"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Quitar
              </button>
            </div>
          )}

          {/* Upload area */}
          {parsed.status !== 'preview' && (
            <div>
              <p className="text-[12px] font-medium uppercase tracking-wider mb-2" style={{ color: 'var(--gray-400)' }}>
                Cargar archivo
              </p>
              <label
                onDrop={onDrop}
                onDragOver={onDragOver}
                onDragLeave={onDragLeave}
                className="flex flex-col items-center justify-center gap-2 border-2 border-dashed rounded-xl p-8 cursor-pointer transition-colors"
                style={{
                  borderColor: dragActive ? 'var(--primary)' : 'var(--gray-200)',
                  background: dragActive ? 'var(--primary-muted)' : 'transparent',
                }}
              >
                <Upload className="w-6 h-6" style={{ color: dragActive ? 'var(--primary)' : 'var(--gray-400)' }} />
                <p className="text-[13px] font-medium" style={{ color: 'var(--gray-950)' }}>
                  {dragActive ? 'Suelta el archivo' : 'Arrastra un CSV o haz clic para seleccionar'}
                </p>
                <p className="text-[11px]" style={{ color: 'var(--gray-400)' }}>
                  Formato: "Presupuesto &lt;año&gt; — Resumen Mensual" con Concepto y columnas Ene..Dic. Máx. 5 MB.
                </p>
                <input
                  type="file"
                  accept=".csv,text/csv"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleFile(f);
                    // Permite re-subir el mismo archivo tras corregir un error.
                    e.target.value = '';
                  }}
                />
              </label>
              {parsed.status === 'parsing' && (
                <p className="text-[12px] mt-2" style={{ color: 'var(--gray-400)' }}>Parseando…</p>
              )}
              {parsed.status === 'error' && (
                <div className="mt-3 rounded-lg border border-[var(--danger)]/30 bg-[var(--danger)]/5 p-3 flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: 'var(--danger)' }} />
                  <div>
                    <p className="text-[12px] font-medium" style={{ color: 'var(--danger)' }}>
                      {parsed.message}
                    </p>
                    {parsed.warnings.length > 0 && (
                      <ul className="mt-1 text-[11px] list-disc list-inside" style={{ color: 'var(--gray-500)' }}>
                        {parsed.warnings.map((w, i) => <li key={i}>{w}</li>)}
                      </ul>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Preview */}
          {parsed.status === 'preview' && (
            <BudgetPreview
              state={parsed}
              onScaleChange={reparseWithScale}
              onApply={applyPreview}
              onCancel={() => setParsed({ status: 'idle' })}
            />
          )}

          {/* Template download */}
          {parsed.status !== 'preview' && (
            <div className="border-t border-[var(--gray-100)] pt-5">
              <p className="text-[12px] font-medium uppercase tracking-wider mb-2" style={{ color: 'var(--gray-400)' }}>
                Descargar plantilla
              </p>
              <p className="text-[12px] mb-3" style={{ color: 'var(--gray-500)' }}>
                Descarga un CSV de ejemplo con la estructura correcta. Elige la escala en la que quieres que salgan los valores.
              </p>
              <div className="flex items-center gap-2 flex-wrap">
                <div className="flex items-center gap-1 rounded-xl p-1" style={{ background: 'var(--gray-50)' }}>
                  {SCALES.map((s) => (
                    <button
                      key={s}
                      onClick={() => setDownloadScale(s)}
                      className="px-3 h-8 rounded-lg text-[12px] font-medium"
                      style={{
                        background: downloadScale === s ? 'white' : 'transparent',
                        color: downloadScale === s ? 'var(--gray-950)' : 'var(--gray-500)',
                        boxShadow: downloadScale === s ? 'var(--shadow-sm)' : 'none',
                      }}
                    >
                      {scaleLabel(s)}
                    </button>
                  ))}
                </div>
                <button
                  onClick={downloadTemplate}
                  className="flex items-center gap-1.5 h-8 px-3 rounded-lg border border-[var(--primary)]/30 text-[12px] text-[var(--primary)] hover:bg-[var(--primary)]/5"
                >
                  <Download className="w-3.5 h-3.5" />
                  Descargar plantilla
                </button>
              </div>
            </div>
          )}
          </div>
        </div>
      </div>
    </>
  );
};

// ── Preview ──────────────────────────────────────────────────────────────

const BudgetPreview: React.FC<{
  state: Extract<ParsedState, { status: 'preview' }>;
  onScaleChange: (s: BudgetScale) => void;
  onApply: () => void;
  onCancel: () => void;
}> = ({ state, onScaleChange, onApply, onCancel }) => {
  const { budget, detectedScale, scale, warnings, fileName } = state;
  const yearIncomeTotal = budget.incomeTotal.reduce((s, v) => s + v, 0);
  const yearExpenseTotal = budget.expenseTotal.reduce((s, v) => s + v, 0);
  const netFlow = yearIncomeTotal - yearExpenseTotal;

  return (
    <div className="space-y-4">
      <div>
        <p className="text-[12px] font-medium uppercase tracking-wider mb-1" style={{ color: 'var(--gray-400)' }}>
          Vista previa
        </p>
        <p className="text-[13px] font-semibold" style={{ color: 'var(--gray-950)' }}>
          Presupuesto {budget.year} · {fileName}
        </p>
        {detectedScale
          ? (
            <p className="text-[11px] mt-0.5" style={{ color: 'var(--gray-500)' }}>
              Escala detectada en el archivo: <strong>{scaleLabel(detectedScale)}</strong>
            </p>
          )
          : (
            <p className="text-[11px] mt-0.5" style={{ color: 'var(--warning)' }}>
              No se detectó la escala en el header. Confirma abajo antes de aplicar.
            </p>
          )
        }
      </div>

      {/* Scale picker */}
      <div>
        <p className="text-[11px] font-medium mb-1.5" style={{ color: 'var(--gray-500)' }}>
          Los valores del archivo están en:
        </p>
        <div className="flex items-center gap-1 rounded-xl p-1 inline-flex" style={{ background: 'var(--gray-50)' }}>
          {SCALES.map((s) => (
            <button
              key={s}
              onClick={() => onScaleChange(s)}
              className="px-3 h-8 rounded-lg text-[12px] font-medium"
              style={{
                background: scale === s ? 'white' : 'transparent',
                color: scale === s ? 'var(--gray-950)' : 'var(--gray-500)',
                boxShadow: scale === s ? 'var(--shadow-sm)' : 'none',
              }}
            >
              {scaleLabel(s)}
            </button>
          ))}
        </div>
      </div>

      {/* Totals */}
      <div className="grid grid-cols-3 gap-3">
        <StatCard label="Ingresos año" value={yearIncomeTotal} color="var(--success)" />
        <StatCard label="Egresos año" value={yearExpenseTotal} color="var(--danger)" />
        <StatCard label="Flujo neto" value={netFlow} color={netFlow >= 0 ? 'var(--success)' : 'var(--danger)'} />
      </div>

      {/* Month preview table */}
      <div className="overflow-x-auto rounded-xl border border-[var(--gray-200)]">
        <table className="w-full text-[11px]">
          <thead className="bg-[var(--gray-50)] text-left" style={{ color: 'var(--gray-400)' }}>
            <tr>
              <th className="px-3 py-2">Concepto</th>
              {MONTH_HEADERS.map((m) => (
                <th key={m} className="px-2 py-2 text-right tabular-nums">{m}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            <MonthRow label="Ingresos Totales" monthly={budget.incomeTotal} tone="var(--success)" bold />
            {budget.expenseByConcept.map((r) => (
              <MonthRow key={r.concept} label={r.concept} monthly={r.monthly} tone="var(--danger)" />
            ))}
            <MonthRow label="Total Egresos" monthly={budget.expenseTotal} tone="var(--danger)" bold />
            <MonthRow
              label="Flujo Neto"
              monthly={budget.incomeTotal.map((v, i) => v - budget.expenseTotal[i])}
              tone="var(--gray-950)"
              bold
              signed
            />
          </tbody>
        </table>
      </div>

      {warnings.length > 0 && (
        <ul className="rounded-lg border border-[var(--warning)]/30 bg-[var(--warning)]/5 p-3 text-[11px] list-disc list-inside" style={{ color: 'var(--gray-700)' }}>
          {warnings.map((w, i) => <li key={i}>{w}</li>)}
        </ul>
      )}

      <div className="flex items-center justify-end gap-2 pt-2 border-t border-[var(--gray-100)]">
        <button
          onClick={onCancel}
          className="h-9 px-4 rounded-lg border border-[var(--gray-200)] text-[13px] text-[var(--gray-500)] hover:bg-[var(--gray-50)]"
        >
          Cancelar
        </button>
        <button
          onClick={onApply}
          className="h-9 px-4 rounded-lg bg-[var(--primary)] text-white text-[13px] font-medium hover:bg-[var(--primary-hover)]"
        >
          Aplicar presupuesto
        </button>
      </div>
    </div>
  );
};

const StatCard: React.FC<{ label: string; value: number; color: string }> = ({ label, value, color }) => (
  <div className="rounded-lg border border-[var(--gray-200)] bg-white p-3">
    <p className="text-[10px] font-medium uppercase tracking-wider mb-1" style={{ color: 'var(--gray-400)' }}>
      {label}
    </p>
    <p className="text-[14px] font-semibold tabular-nums" style={{ color }}>
      {fmtCurrency(value)}
    </p>
  </div>
);

const MonthRow: React.FC<{
  label: string;
  monthly: number[];
  tone: string;
  bold?: boolean;
  signed?: boolean;
}> = ({ label, monthly, tone, bold, signed }) => (
  <tr className="border-t border-[var(--gray-100)]">
    <td className="px-3 py-1.5 whitespace-nowrap" style={{ color: 'var(--gray-700)', fontWeight: bold ? 600 : 400 }}>
      {label}
    </td>
    {monthly.map((v, i) => (
      <td
        key={i}
        className="px-2 py-1.5 text-right tabular-nums"
        style={{ color: signed && v < 0 ? 'var(--danger)' : tone, fontWeight: bold ? 600 : 400 }}
      >
        {v === 0 ? '—' : shortAmount(v)}
      </td>
    ))}
  </tr>
);

function shortAmount(v: number): string {
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}${Math.round(abs / 1_000)}K`;
  return `${sign}${abs.toFixed(0)}`;
}

export default BudgetModal;

// Helper exportado para que Dashboard pueda aplicar scale en un flujo simple si hace falta
export { scaleFactor };
