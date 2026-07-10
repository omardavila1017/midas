/**
 * DataHealthPanel — la herramienta confiesa qué datos tiene y qué le falta.
 *
 * Midas construye un data lake POR NAVEGADOR (ver services/dataHealth.ts). El
 * diagnóstico vivía solo en consola (`window.__midas__.dataHealth`); este panel
 * lo hace visible al usuario: frescura por dataset, huecos de fetch de la
 * sesión (días/meses/cías que fallaron y se sirven incompletos), estado de la
 * revalidación, y una acción de "resincronizar" que fuerza un re-pull completo.
 *
 * Espejo del patrón de `ActivityFeedPanel` (overlay deslizable a la derecha).
 * Read-only salvo la acción de resync, que la maneja el caller.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  Loader2,
  RefreshCw,
  X,
} from 'lucide-react';
import { getDataGaps, type DataGap } from '../services/dataHealth';

export type DataHealthDatasetStatus = 'idle' | 'loading' | 'ready' | 'stale' | 'error';

export interface DataHealthDatasetRow {
  /** Key interna del dataset (cxp, cobranza, …). */
  key: string;
  /** Etiqueta es-MX para el usuario. */
  label: string;
  status: DataHealthDatasetStatus;
  /** ISO de la última sincronización exitosa, o undefined si nunca. */
  lastSync?: string;
}

interface DataHealthPanelProps {
  open: boolean;
  onClose: () => void;
  datasets: DataHealthDatasetRow[];
  /** Dispara el re-pull completo (limpia cache + markers + recarga). */
  onResync: () => void;
  resyncing: boolean;
}

const STATUS_META: Record<
  DataHealthDatasetStatus,
  { label: string; color: string; Icon: typeof CheckCircle2 }
> = {
  ready: { label: 'Al día', color: 'var(--success, #16a34a)', Icon: CheckCircle2 },
  loading: { label: 'Cargando', color: 'var(--accent-blue, #2563eb)', Icon: Loader2 },
  stale: { label: 'Por refrescar', color: 'var(--warning, #d97706)', Icon: CircleDashed },
  error: { label: 'Error', color: 'var(--danger, #dc2626)', Icon: AlertTriangle },
  idle: { label: 'Sin cargar', color: 'var(--gray-400, #9ca3af)', Icon: CircleDashed },
};

const GAP_KIND_LABEL: Record<DataGap['kind'], string> = {
  'day-failed': 'Día sin cargar',
  'month-failed': 'Mes sin cargar',
  'chunk-failed': 'Rango sin cargar',
  'window-failed': 'Ventana sin cargar',
  'cia-failed': 'Compañía sin cargar',
};

/** Relativo con granularidad de minutos/horas (fmtRelative solo da días). */
function relativeFromNow(iso?: string): string {
  if (!iso) return 'Nunca';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return 'Nunca';
  const mins = Math.floor((Date.now() - t) / 60_000);
  if (mins < 1) return 'Hace un momento';
  if (mins < 60) return `Hace ${mins} min`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `Hace ${hours} h`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Ayer';
  if (days < 30) return `Hace ${days} días`;
  return new Date(iso).toLocaleDateString('es-MX');
}

export function DataHealthPanel({
  open,
  onClose,
  datasets,
  onResync,
  resyncing,
}: DataHealthPanelProps) {
  const [isClosing, setIsClosing] = useState(false);
  // getDataGaps es síncrono pero su contenido cambia durante la sesión;
  // releemos cada vez que el panel se abre.
  const [gaps, setGaps] = useState<DataGap[]>([]);

  useEffect(() => {
    if (!open) return;
    setGaps(getDataGaps());
  }, [open]);

  const handleClose = () => {
    setIsClosing(true);
    setTimeout(() => {
      setIsClosing(false);
      onClose();
    }, 200);
  };

  const gapsByDataset = useMemo(() => {
    const map = new Map<string, DataGap[]>();
    for (const gap of gaps) {
      const arr = map.get(gap.dataset);
      if (arr) arr.push(gap);
      else map.set(gap.dataset, [gap]);
    }
    return map;
  }, [gaps]);

  if (!open) return null;

  return (
    <>
      <div
        className={`fixed inset-0 transition-opacity duration-200 ${isClosing ? 'opacity-0' : 'opacity-100'}`}
        style={{ zIndex: 400, backgroundColor: 'rgba(0, 0, 0, 0.5)' }}
        onClick={handleClose}
      />
      <div
        className={`fixed top-0 right-0 h-screen bg-white flex flex-col transition-transform duration-200 ${isClosing ? 'translate-x-full' : 'translate-x-0'}`}
        style={{ zIndex: 410, width: '380px', maxWidth: '100vw', boxShadow: 'var(--shadow-lg)' }}
        role="dialog"
        aria-label="Salud de datos"
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b" style={{ borderColor: 'var(--gray-200)' }}>
          <div className="flex items-center gap-2">
            <Activity className="w-5 h-5" style={{ color: 'var(--primary)' }} />
            <h2 className="text-base font-bold">Salud de datos</h2>
            {gaps.length > 0 && (
              <span
                className="text-xs font-semibold px-2 py-0.5 rounded-full"
                style={{ backgroundColor: 'var(--warning, #d97706)', color: 'white' }}
              >
                {gaps.length}
              </span>
            )}
          </div>
          <button
            onClick={handleClose}
            className="p-1 hover:bg-gray-100 rounded-[var(--radius-md)] transition-colors"
            aria-label="Cerrar"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {/* Frescura por dataset */}
          <div className="px-4 py-3">
            <p className="text-xs font-bold uppercase tracking-[0.08em] mb-2" style={{ color: 'var(--gray-500)' }}>
              Frescura por módulo
            </p>
            <div className="flex flex-col gap-1.5">
              {datasets.map((d) => {
                // Honesto: 'Al día' con lastSync 'Nunca' = el dataset nunca se
                // cargó (permiso faltante, fetch temprano, o sin datos). No lo
                // pintes verde — muéstralo como 'Sin cargar'.
                const effectiveStatus = d.status === 'ready' && !d.lastSync ? 'idle' : d.status;
                const meta = STATUS_META[effectiveStatus];
                const dsGaps = gapsByDataset.get(d.key) ?? [];
                return (
                  <div
                    key={d.key}
                    className="flex items-center justify-between gap-2 py-1.5 px-2 rounded-[var(--radius-md)]"
                    style={{ background: 'var(--gray-50)' }}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <meta.Icon
                        className={`w-4 h-4 flex-shrink-0 ${d.status === 'loading' ? 'animate-spin' : ''}`}
                        style={{ color: meta.color }}
                      />
                      <span className="text-sm font-medium truncate">{d.label}</span>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      {dsGaps.length > 0 && (
                        <span
                          className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full"
                          style={{ backgroundColor: 'var(--warning, #d97706)', color: 'white' }}
                          title={`${dsGaps.length} hueco(s) de carga esta sesión`}
                        >
                          {dsGaps.length} hueco{dsGaps.length === 1 ? '' : 's'}
                        </span>
                      )}
                      <span className="text-[11px]" style={{ color: 'var(--gray-500)' }}>
                        {relativeFromNow(d.lastSync)}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Huecos de la sesión — la "confesión" */}
          <div className="px-4 py-3 border-t" style={{ borderColor: 'var(--gray-100)' }}>
            <p className="text-xs font-bold uppercase tracking-[0.08em] mb-2" style={{ color: 'var(--gray-500)' }}>
              Huecos de esta sesión
            </p>
            {gaps.length === 0 ? (
              <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--success, #16a34a)' }}>
                <CheckCircle2 className="w-4 h-4" />
                <span>Sin huecos. Todos los rangos cargaron completos.</span>
              </div>
            ) : (
              <>
                <p className="text-xs mb-2" style={{ color: 'var(--gray-500)' }}>
                  Estos rangos fallaron al cargar y se muestran incompletos (se
                  sirve el último valor conocido). Se reintentan en el próximo
                  arranque.
                </p>
                <div className="flex flex-col gap-1 max-h-[260px] overflow-y-auto">
                  {gaps.slice(-50).reverse().map((gap, i) => (
                    <div
                      key={`${gap.dataset}-${gap.at}-${i}`}
                      className="flex items-start gap-2 text-xs py-1"
                    >
                      <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" style={{ color: 'var(--warning, #d97706)' }} />
                      <div className="min-w-0">
                        <span className="font-medium">{gap.dataset}</span>
                        <span style={{ color: 'var(--gray-500)' }}> · {GAP_KIND_LABEL[gap.kind]}</span>
                        <div className="truncate" style={{ color: 'var(--gray-500)' }}>{gap.detail}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>

          {/* Revalidación automática — nota informativa */}
          <div className="px-4 py-3 border-t" style={{ borderColor: 'var(--gray-100)' }}>
            <p className="text-xs font-bold uppercase tracking-[0.08em] mb-2" style={{ color: 'var(--gray-500)' }}>
              Revalidación automática
            </p>
            <p className="text-xs" style={{ color: 'var(--gray-500)' }}>
              Cada arranque re-verifica los días/meses recientes contra JDE (las
              capturas llegan con atraso), así todos los equipos convergen a los
              mismos registros sin que tengas que hacer nada.
            </p>
          </div>
        </div>

        {/* Footer — acción de resync */}
        <div className="p-4 border-t" style={{ borderColor: 'var(--gray-200)' }}>
          <button
            onClick={onResync}
            disabled={resyncing}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-[var(--radius-md)] text-sm font-semibold transition-colors disabled:opacity-60"
            style={{ background: 'var(--primary)', color: 'white' }}
          >
            <RefreshCw className={`w-4 h-4 ${resyncing ? 'animate-spin' : ''}`} />
            {resyncing ? 'Resincronizando…' : 'Resincronizar todo'}
          </button>
          <p className="text-[11px] mt-2 text-center" style={{ color: 'var(--gray-400)' }}>
            Borra el caché local y vuelve a descargar todo desde JDE. Recarga la
            app. Úsalo si sospechas que ves datos distintos a otro usuario.
          </p>
        </div>
      </div>
    </>
  );
}
