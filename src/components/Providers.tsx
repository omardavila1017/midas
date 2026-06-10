import { useMemo, useState } from 'react';
import {
  CLASIFICACION_LABELS,
  Provider,
} from '../domain/types';
import { SCORE_BUCKETS, SCORE_LABELS, type ScoreBucket } from '../domain/providerScore';
import { fetchProviderCatalog } from '../services/catalog.service';
import {
  AlertTriangle,
  Calendar,
  Clock3,
  Info,
  Plus,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import PageHeader from './ui/PageHeader';
import ProviderDetailModal from './ProviderDetailModal';
import type { CXPRecord } from '../domain/persistence';
import { lookupRecentSpend, type ProviderSpendIndex } from '../domain/providerRecentSpend';

/**
 * Catálogo de Proveedores — pestaña Catálogos → Proveedores.
 *
 * Refleja la Plantilla de Proveedores (Excel de Alberto), pero mejorada:
 *   - Clasificación Alberto como chip dominante (override manual humano).
 *   - Score automático (0-100) con barra visual.
 *   - Frecuencia de pago real (del histórico 2025).
 *   - Monto promedio por pago, # de pagos, monto total 2025.
 *   - Gasto mínimo mensual (resaltado amarillo cuando es CRÍTICO).
 *   - Número de proveedor JDE para conciliación con CXP.
 *
 * El catálogo NO se edita aquí — su fuente de verdad es la Plantilla de
 * Proveedores de Alberto. Cualquier cambio se hace en el Excel y se
 * regenera el JSON.
 */

interface ChipStyle { bg: string; text: string; border: string; dot: string; label: string; description: string }

const SCORE_STYLES: Record<ScoreBucket, ChipStyle> = {
  CRITICO: {
    bg: 'var(--danger-muted)', text: 'var(--danger)', border: 'oklch(88% 0.08 25)', dot: 'var(--danger)',
    label: SCORE_LABELS.CRITICO, description: 'Score ≥ 80. Crítico para la operación: NO PAUSAR. Su gasto mínimo se suma al piso operativo.',
  },
  ALTO: {
    bg: '#FEF3C7', text: '#92400E', border: '#FCD34D', dot: '#F59E0B',
    label: SCORE_LABELS.ALTO, description: 'Score 60–79. Alta prioridad: pagar a tiempo siempre que la caja lo permita.',
  },
  MEDIO: {
    bg: '#FFEDD5', text: '#9A3412', border: '#FED7AA', dot: '#F97316',
    label: SCORE_LABELS.MEDIO, description: 'Score 40–59. Negociable: se puede mover fecha o monto si falta caja.',
  },
  BAJO: {
    bg: 'var(--success-muted)', text: 'var(--success)', border: 'oklch(88% 0.08 145)', dot: 'var(--success)',
    label: SCORE_LABELS.BAJO, description: 'Score < 40. Flexible: el último en cobrar prioridad cuando la caja escasea.',
  },
};

const PAUSAR_BADGE: ChipStyle = {
  bg: 'var(--gray-100)', text: 'var(--gray-500)', border: 'var(--gray-200)', dot: 'var(--gray-400)',
  label: CLASIFICACION_LABELS.PAUSAR, description: 'Alberto pidió pausar pagos. Bandera operativa independiente del score.',
};

const EMPLOYEE_CHIP: ChipStyle = {
  bg: 'var(--gray-50)', text: 'var(--gray-600)', border: 'var(--gray-200)', dot: 'var(--gray-400)',
  label: 'Prestaciones',
  description: 'Empleados pagados vía CXP (nómina, finiquitos, pensiones alimenticias, reembolsos). No son proveedores comerciales — clic para verlos.',
};

const FREQ_ORDER = ['Diario', 'Semanal', 'Quincenal', 'Mensual', 'Bimestral/Trimestral', 'Bimestral', 'Trimestral', 'Semestral', 'Anual/Esporádico', 'Anual', 'Pago único', 'Esporádico'];

interface Props {
  providers: Provider[];
  cxpRecords?: CXPRecord[];
  /** Índice de gasto reciente (últimos N meses calendario desde PagoProveedor real). */
  spendIndex?: ProviderSpendIndex;
  onReplace: (providers: Provider[]) => void;
  onAdd: (p: Provider) => void;
  onUpdate: (p: Provider) => void;
  onDelete: (id: string) => void;
}

type ScoreFilter = 'all' | ScoreBucket;
type FreqFilter = 'all' | string;
type CategoryFilter = 'all' | string;

const bucketOf = (p: Provider): ScoreBucket => p.clasificacionAutomatica ?? 'BAJO';

const fmtCurrency = (n: number | null | undefined): string => {
  if (n == null || !Number.isFinite(n)) return '—';
  return new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN', maximumFractionDigits: 0 }).format(n);
};

export default function Providers({ providers, cxpRecords, spendIndex, onReplace, onAdd, onUpdate: _onUpdate, onDelete: _onDelete }: Props) {
  void _onUpdate; void _onDelete;
  const [query, setQuery] = useState('');
  const [scoreFilter, setScoreFilter] = useState<ScoreFilter>('all');
  const [freqFilter, setFreqFilter] = useState<FreqFilter>('all');
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('all');
  const [showEmployees, setShowEmployees] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<Provider | null>(null);

  // ─── Segmento empleados (Prestaciones) vs proveedores comerciales ─────
  // Los empleados pagados vía CXP (isEmployee) salen del listado y de los
  // conteos por default; el chip "Prestaciones" los muestra aparte.
  const employeeCount = useMemo(() => providers.reduce((n, p) => n + (p.isEmployee ? 1 : 0), 0), [providers]);
  const baseProviders = useMemo(
    () => providers.filter((p) => (showEmployees ? p.isEmployee : !p.isEmployee)),
    [providers, showEmployees],
  );

  // ─── Conteos por bucket de score ──────────────────────────────────────
  const scoreCounts = useMemo(() => {
    const out: Record<ScoreBucket, number> = { CRITICO: 0, ALTO: 0, MEDIO: 0, BAJO: 0 };
    for (const p of baseProviders) out[bucketOf(p)]++;
    return out;
  }, [baseProviders]);

  // ─── Listas únicas para filtros ───────────────────────────────────────
  const frequencies = useMemo(() => {
    const set = new Set<string>();
    baseProviders.forEach((p) => {
      if (p.frecuenciaHistorica) set.add(p.frecuenciaHistorica);
    });
    return Array.from(set).sort((a, b) => {
      const ai = FREQ_ORDER.indexOf(a);
      const bi = FREQ_ORDER.indexOf(b);
      if (ai !== -1 && bi !== -1) return ai - bi;
      return a.localeCompare(b);
    });
  }, [baseProviders]);

  const categories = useMemo(() => {
    const set = new Set<string>();
    baseProviders.forEach((p) => {
      if (p.type) set.add(p.type);
    });
    return Array.from(set).sort();
  }, [baseProviders]);

  // ─── Filtrado ─────────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return baseProviders
      .filter((p) => {
        if (scoreFilter !== 'all' && bucketOf(p) !== scoreFilter) return false;
        if (freqFilter !== 'all' && p.frecuenciaHistorica !== freqFilter) return false;
        if (categoryFilter !== 'all' && p.type !== categoryFilter) return false;
        if (q) {
          const haystack = [
            p.name, p.type, p.numProveedorJDE, p.frecuenciaHistorica,
          ].filter(Boolean).join(' ').toLowerCase();
          if (!haystack.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => {
        // Operativos (score ≥ 80) primero, luego por score desc, luego por nombre
        const aCritico = a.clasificacionAutomatica === 'CRITICO' ? 1 : 0;
        const bCritico = b.clasificacionAutomatica === 'CRITICO' ? 1 : 0;
        if (aCritico !== bCritico) return bCritico - aCritico;
        const aScore = a.score ?? 0;
        const bScore = b.score ?? 0;
        if (aScore !== bScore) return bScore - aScore;
        return a.name.localeCompare(b.name, 'es');
      });
  }, [baseProviders, query, scoreFilter, freqFilter, categoryFilter]);

  const filtersActive = query.length > 0 || scoreFilter !== 'all' || freqFilter !== 'all' || categoryFilter !== 'all' || showEmployees;
  const clearFilters = () => {
    setQuery('');
    setScoreFilter('all');
    setFreqFilter('all');
    setCategoryFilter('all');
    setShowEmployees(false);
  };

  const handleSyncCatalog = async () => {
    setSyncing(true);
    setSyncError(null);
    try {
      // El catálogo se reconstruye en App.tsx desde los records JDE en cuanto
      // se hidratan. Aquí ya no hay un seed manual; el botón queda como hook
      // futuro pero no debe pisar el catálogo vivo con un array vacío.
      const next = await fetchProviderCatalog();
      if (next.length > 0) onReplace(next);
    } catch (error) {
      setSyncError(error instanceof Error ? error.message : 'No se pudo sincronizar el catálogo.');
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Proveedores"
        actions={
          <button
            onClick={handleSyncCatalog}
            disabled={syncing}
            title="Sincronizar plantilla"
            aria-label="Sincronizar plantilla"
            className="flex items-center justify-center w-9 h-9 rounded-[var(--radius-md)] text-[var(--gray-400)] hover:text-[var(--primary)] hover:bg-[var(--gray-50)] hover-press disabled:opacity-40"
          >
            <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} strokeWidth={1.5} />
          </button>
        }
      />

      {syncError && (
        <p className="text-[13px] text-white/80 bg-[var(--danger)]/25 border border-[var(--danger)]/40 rounded-[var(--radius-md)] px-3 py-2">
          {syncError}
        </p>
      )}

      {/* ─── Chips filtro por bucket de score ─────────────────────────── */}
      {providers.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {SCORE_BUCKETS.map((k) => {
            const s = SCORE_STYLES[k];
            return (
              <StatChip
                key={k}
                label={s.label}
                count={scoreCounts[k]}
                style={s}
                active={scoreFilter === k}
                onClick={() => setScoreFilter(scoreFilter === k ? 'all' : k)}
              />
            );
          })}
          {employeeCount > 0 && (
            <StatChip
              label={EMPLOYEE_CHIP.label}
              count={employeeCount}
              style={EMPLOYEE_CHIP}
              active={showEmployees}
              onClick={() => setShowEmployees((v) => !v)}
            />
          )}
        </div>
      )}

      {/* ─── Toolbar: search + filtros ─────────────────────────────── */}
      {providers.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[240px] max-w-md">
            <Search className="w-4 h-4 text-[var(--gray-400)] absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar por nombre, # JDE, categoría…"
              className="input pl-9 w-full"
            />
          </div>
          <select
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
            className="input h-9 max-w-[180px]"
            title="Filtrar por categoría"
          >
            <option value="all">Categoría</option>
            {categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <select
            value={freqFilter}
            onChange={(e) => setFreqFilter(e.target.value)}
            className="input h-9 max-w-[160px]"
            title="Filtrar por frecuencia"
          >
            <option value="all">Frecuencia</option>
            {frequencies.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
          {filtersActive && (
            <button
              onClick={clearFilters}
              className="flex items-center gap-1 px-3 h-9 rounded-[var(--radius-md)] text-[12px] font-medium text-[var(--gray-500)] hover:text-[var(--gray-950)] hover:bg-[var(--gray-50)] hover-press"
            >
              <X className="w-3.5 h-3.5" /> Limpiar
            </button>
          )}
          <div className="ml-auto text-[12px] text-[var(--gray-400)] tabular-nums">
            {filtered.length === baseProviders.length
              ? `${baseProviders.length} total`
              : `${filtered.length} de ${baseProviders.length}`}
          </div>
        </div>
      )}

      {/* ─── Table ─────────────────────────────────────────────────────── */}
      <div className="bg-white border border-[var(--gray-200)]/60 rounded-[var(--radius)] overflow-hidden animate-card-in">
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead className="bg-[var(--surface-alt)] text-[var(--gray-400)] text-left text-[11px] uppercase tracking-wide sticky top-0 z-10">
              <tr>
                <Th className="pl-5">Proveedor</Th>
                <Th>Categoría</Th>
                <Th>Clasif.</Th>
                <Th align="center">Score</Th>
                <Th>Frecuencia</Th>
                <Th align="right">Monto promedio</Th>
                <Th align="right"># Pagos 2025</Th>
                <Th align="right">Total pagado 2025</Th>
                <Th align="right">Gasto mínimo / mes</Th>
                <Th>Num JDE</Th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={10} className="text-center text-[var(--gray-400)] py-12">
                    {providers.length === 0 ? (
                      <div className="flex flex-col items-center gap-2">
                        <RefreshCw className="w-5 h-5 text-[var(--gray-300)]" />
                        <div>Sin proveedores. Sincroniza la plantilla.</div>
                      </div>
                    ) : (
                      <div className="flex flex-col items-center gap-2">
                        <Search className="w-5 h-5 text-[var(--gray-300)]" />
                        <div>Sin coincidencias con el filtro.</div>
                        {filtersActive && (
                          <button onClick={clearFilters} className="text-[12px] text-[var(--primary)] hover:underline">
                            Limpiar filtros
                          </button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ) : (
                filtered.map((p, idx) => {
                  const bucket = bucketOf(p);
                  const bucketStyle = SCORE_STYLES[bucket];
                  const isCritico = bucket === 'CRITICO';
                  const showPausarBadge = p.clasificacionAlberto === 'PAUSAR';
                  const recentStats = spendIndex ? lookupRecentSpend(spendIndex, p) : null;
                  const monthlyAvg = recentStats?.monthlyAverage ?? p.gastoMinimoMensual ?? null;
                  const avgPerPayment = recentStats && recentStats.paymentCount > 0
                    ? recentStats.totalSpend / recentStats.paymentCount
                    : (p.montoPromedioPago ?? null);
                  return (
                    <tr
                      key={p.id}
                      onClick={() => setSelectedProvider(p)}
                      className={`group cursor-pointer border-t border-[var(--gray-200)]/40 hover-row hover:bg-[var(--primary-muted)]/30 ${
                        idx % 2 === 1 ? 'bg-[var(--gray-50)]/40' : ''
                      } ${isCritico ? 'bg-yellow-50/30' : ''}`}
                      title="Clic para ver detalle del proveedor"
                    >
                      <Td className="pl-5">
                        <div className="font-medium text-[var(--gray-950)] truncate max-w-[200px]" title={p.name}>
                          {p.name}
                        </div>
                        {p.dtiCriticidad === 'Alta' && (
                          <div className="text-[10px] text-[var(--danger)] mt-0.5 flex items-center gap-1">
                            <AlertTriangle className="w-3 h-3" /> Crítico DTI · {p.dtiArea}
                          </div>
                        )}
                        {showPausarBadge && (
                          <div
                            className="text-[10px] mt-0.5 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 border"
                            style={{ backgroundColor: PAUSAR_BADGE.bg, color: PAUSAR_BADGE.text, borderColor: PAUSAR_BADGE.border }}
                            title={PAUSAR_BADGE.description}
                          >
                            <span className="inline-block w-1 h-1 rounded-full" style={{ backgroundColor: PAUSAR_BADGE.dot }} />
                            {PAUSAR_BADGE.label}
                          </div>
                        )}
                      </Td>
                      <Td>
                        <span className="inline-block max-w-[120px] truncate text-[var(--gray-700)]" title={p.type}>
                          {p.type}
                        </span>
                      </Td>
                      <Td>
                        <Chip style={bucketStyle} title={bucketStyle.description}>
                          {bucketStyle.label}
                        </Chip>
                      </Td>
                      <Td align="center">
                        <ScoreBar score={p.score} />
                      </Td>
                      <Td>
                        {p.frecuenciaHistorica ? (
                          <span className="inline-flex items-center gap-1 text-[var(--gray-700)]">
                            <Clock3 className="w-3 h-3 text-[var(--gray-400)]" />
                            {p.frecuenciaHistorica}
                          </span>
                        ) : (
                          <span className="text-[var(--gray-300)]">—</span>
                        )}
                      </Td>
                      <Td align="right">
                        <span className="tabular-nums text-[var(--gray-700)]">
                          {fmtCurrency(avgPerPayment)}
                        </span>
                      </Td>
                      <Td align="right">
                        <span className="tabular-nums text-[var(--gray-700)]">
                          {p.numPagos2025 ?? '—'}
                        </span>
                      </Td>
                      <Td align="right">
                        <span className="tabular-nums text-[var(--gray-950)] font-medium">
                          {fmtCurrency(p.montoTotal2025)}
                        </span>
                      </Td>
                      <Td align="right">
                        {monthlyAvg && isCritico ? (
                          <div className="flex flex-col items-end gap-0.5">
                            <span
                              className="inline-flex items-center gap-1 rounded-md bg-yellow-100 px-2 py-1 text-[12px] font-bold tabular-nums text-yellow-900 ring-1 ring-yellow-300"
                              title={recentStats
                                ? `Promedio últimos ${recentStats.monthsInWindow} meses (${recentStats.paymentCount} pagos). Se suma al piso amarillo.`
                                : 'Gasto mínimo del catálogo — se suma al piso amarillo en la proyección.'}
                            >
                              {fmtCurrency(monthlyAvg)}
                            </span>
                            {recentStats && (
                              <span className="text-[9px] text-[var(--gray-400)]">
                                prom. {recentStats.monthsInWindow} m.
                              </span>
                            )}
                          </div>
                        ) : monthlyAvg ? (
                          <div className="flex flex-col items-end gap-0.5">
                            <span className="tabular-nums text-[var(--gray-500)]">
                              {fmtCurrency(monthlyAvg)}
                            </span>
                            {recentStats && (
                              <span className="text-[9px] text-[var(--gray-400)]">
                                prom. {recentStats.monthsInWindow} m.
                              </span>
                            )}
                          </div>
                        ) : (
                          <span className="text-[var(--gray-300)]">—</span>
                        )}
                      </Td>
                      <Td>
                        <span className="font-mono text-[11px] text-[var(--gray-500)]">
                          {p.numProveedorJDE ?? '—'}
                        </span>
                      </Td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ─── Footer info ───────────────────────────────────────────────── */}
      {providers.length > 0 && (
        <div className="rounded-[var(--radius-md)] border border-[var(--gray-200)]/60 bg-[var(--gray-50)] px-4 py-3 text-[11px] text-[var(--gray-500)]">
          <div className="flex items-start gap-2">
            <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p>
                Los <span className="font-bold text-yellow-700">Operativos</span> (score ≥ 80) aparecen con fondo amarillo y su
                gasto mínimo mensual se suma automáticamente al piso operativo en Proyección Operativa.
              </p>
              <p>
                <span className="font-bold">Score 0-100</span> calculado de 4 criterios:
                Sustituibilidad (30%), Impacto operativo (45%), Riesgo legal (10%), Días crédito (15%).
                Score ≥ 80 = <span className="font-bold">Operativo</span> · 60-79 = Prioritario · 40-59 = Negociable · &lt;40 = Flexible.
              </p>
              <p className="flex items-center gap-1">
                <Calendar className="w-3 h-3" />
                Datos del histórico 2025 vienen de la pestaña "Resumen proveedores 2025" de la plantilla.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Hint para nuevos proveedores fuera de plantilla */}
      <div className="rounded-[var(--radius-md)] border border-dashed border-[var(--gray-300)] bg-white px-4 py-3">
        <div className="flex items-start gap-2 text-[12px]">
          <Plus className="w-4 h-4 text-[var(--gray-400)] mt-0.5" />
          <div>
            <p className="font-medium text-[var(--gray-700)]">¿Falta un proveedor?</p>
            <p className="text-[var(--gray-500)] mt-0.5">
              Agrégalo en la <span className="font-medium">Plantilla de Proveedores</span> de Alberto y vuelve a sincronizar.
              Esto mantiene la fuente única de verdad y la consistencia con el scoring.
            </p>
          </div>
        </div>
      </div>

      {/* ─── Modal full-screen de detalle del proveedor ───────────────── */}
      {selectedProvider && (
        <ProviderDetailModal
          provider={selectedProvider}
          cxpRecords={cxpRecords ?? []}
          onClose={() => setSelectedProvider(null)}
        />
      )}
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function Th({ children, align = 'left', className = '' }: { children?: React.ReactNode; align?: 'left' | 'right' | 'center'; className?: string }) {
  const alignCls = align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left';
  return <th className={`px-2.5 py-2.5 font-medium ${alignCls} ${className}`}>{children}</th>;
}

function Td({ children, align = 'left', className = '' }: { children?: React.ReactNode; align?: 'left' | 'right' | 'center'; className?: string }) {
  const alignCls = align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left';
  return <td className={`px-2.5 py-2.5 text-[var(--gray-950)] align-middle ${alignCls} ${className}`}>{children}</td>;
}

function Chip({ children, style, title }: { children: React.ReactNode; style: ChipStyle; title?: string }) {
  return (
    <div
      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[11px] font-medium"
      style={{ backgroundColor: style.bg, borderColor: style.border, color: style.text }}
      title={title}
    >
      <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ backgroundColor: style.dot }} />
      {children}
    </div>
  );
}

function StatChip({
  label, count, style, active, onClick,
}: {
  label: string;
  count: number;
  style: ChipStyle;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 px-2.5 h-7 rounded-full border text-[12px] font-medium hover-press transition-shadow ${active ? 'shadow-sm ring-1' : ''}`}
      style={{
        backgroundColor: style.bg,
        borderColor: active ? style.text : style.border,
        color: style.text,
        ['--tw-ring-color' as string]: style.text,
      } as React.CSSProperties}
      title={active ? 'Quitar filtro' : `Filtrar por ${label.toLowerCase()}`}
    >
      <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ backgroundColor: style.dot }} />
      <span>{label}</span>
      <span className="tabular-nums opacity-70">{count}</span>
    </button>
  );
}

function ScoreBar({ score }: { score: number | undefined }) {
  if (score == null || !Number.isFinite(score)) {
    return <span className="text-[11px] text-[var(--gray-300)]">—</span>;
  }
  const pct = Math.max(0, Math.min(100, score));
  // color por banda
  let color = 'var(--success)';
  if (pct >= 80) color = 'var(--danger)';
  else if (pct >= 60) color = '#F59E0B';
  else if (pct >= 40) color = '#F97316';
  return (
    <div className="flex flex-col items-center gap-0.5">
      <div className="w-12 h-1.5 rounded-full bg-[var(--gray-100)] overflow-hidden">
        <div
          className="h-full w-full rounded-full"
          style={{
            backgroundColor: color,
            transform: `scaleX(${Math.max(0, Math.min(100, pct)) / 100})`,
            transformOrigin: 'left center',
            transition: 'transform var(--motion-state) var(--ease-smooth)',
          }}
        />
      </div>
      <span className="text-[10px] tabular-nums font-medium" style={{ color }}>
        {pct.toFixed(0)}
      </span>
    </div>
  );
}

