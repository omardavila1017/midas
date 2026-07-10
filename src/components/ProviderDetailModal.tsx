import { useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertTriangle,
  Calendar,
  ChevronDown,
  CircleDollarSign,
  Clock3,
  ExternalLink,
  FileText,
  Hash,
  ShieldAlert,
  TrendingUp,
  X,
} from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  ClasificacionAlberto,
  CLASIFICACION_DESCRIPTIONS,
  CLASIFICACION_LABELS,
  Provider,
} from '../domain/types';
import type { CXPRecord } from '../domain/persistence';
import { todayISO, fmtCurrency as fmtCurrencyBase, fmtCompact as fmtCompactBase } from '../formatters';

interface Props {
  provider: Provider;
  cxpRecords: CXPRecord[];
  onClose: () => void;
}

// Single source of truth (formatters.ts) with the module's null guard kept.
const fmtCurrency = (n: number | null | undefined): string =>
  n == null || !Number.isFinite(n) ? '—' : fmtCurrencyBase(n);

const fmtCompact = (n: number | null | undefined): string =>
  n == null || !Number.isFinite(n) ? '—' : fmtCompactBase(n);

const fmtDate = (iso?: string): string => {
  if (!iso) return '—';
  // Bare YYYY-MM-DD parses as UTC midnight → renders un día antes en CST.
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T12:00:00` : iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' });
};

const normName = (s: string): string =>
  s.toUpperCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

const automaticaLabel = (b: 'CRITICO' | 'ALTO' | 'MEDIO' | 'BAJO' | undefined): string => {
  if (!b) return '—';
  return ({ CRITICO: 'Operativo', ALTO: 'Prioritario', MEDIO: 'Negociable', BAJO: 'Flexible' } as const)[b];
};

/* All-token surfaces so dark mode inherits automatically. Ring colors use
   color-mix on the foreground token instead of hard-coded OKLCH so the
   contrast follows the surface shift. Tags wrap via inline style now —
   raw tailwind shades (bg-red-100, etc.) didn't respect dark mode. */
const ALBERTO_COLORS: Record<ClasificacionAlberto, { bg: string; text: string; ring: string; tagBg: string; tagText: string }> = {
  CRITICO:        {
    bg: 'var(--danger-muted)',  text: 'var(--danger)',
    ring: 'color-mix(in oklch, var(--danger) 35%, var(--gray-200))',
    tagBg: 'var(--danger-muted)', tagText: 'var(--danger)',
  },
  FLEX_ALTO:      {
    bg: 'var(--warning-muted)', text: 'var(--warning)',
    ring: 'color-mix(in oklch, var(--warning) 40%, var(--gray-200))',
    tagBg: 'var(--warning-muted)', tagText: 'var(--warning)',
  },
  FLEX_MEDIO:     {
    bg: 'color-mix(in oklch, var(--warning-muted) 60%, var(--gray-100))',
    text: 'var(--warning)',
    ring: 'color-mix(in oklch, var(--warning) 28%, var(--gray-200))',
    tagBg: 'color-mix(in oklch, var(--warning-muted) 60%, var(--gray-100))',
    tagText: 'var(--warning)',
  },
  FLEX_BAJO:      {
    bg: 'var(--success-muted)', text: 'var(--success)',
    ring: 'color-mix(in oklch, var(--success) 35%, var(--gray-200))',
    tagBg: 'var(--success-muted)', tagText: 'var(--success)',
  },
  PAUSAR:         {
    bg: 'var(--gray-100)', text: 'var(--gray-500)',
    ring: 'var(--gray-200)',
    tagBg: 'var(--gray-100)', tagText: 'var(--gray-700)',
  },
  SIN_CLASIFICAR: {
    bg: 'var(--gray-50)', text: 'var(--gray-400)',
    ring: 'var(--gray-200)',
    tagBg: 'var(--gray-50)', tagText: 'var(--gray-500)',
  },
};

export default function ProviderDetailModal({ provider, cxpRecords, onClose }: Props) {
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  // Bloquear scroll del body, mover foco al modal, restaurarlo al cerrar.
  useEffect(() => {
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    queueMicrotask(() => closeBtnRef.current?.focus());
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', handler);
      previouslyFocused.current?.focus?.();
    };
  }, [onClose]);

  const alberto = provider.clasificacionAlberto ?? 'SIN_CLASIFICAR';
  const albertoColor = ALBERTO_COLORS[alberto];

  // ─── Filtrar facturas (CXP) del proveedor ─────────────────────────────
  const providerInvoices = useMemo(() => {
    const targetNorm = normName(provider.name);
    const targetJde = provider.numProveedorJDE ? String(provider.numProveedorJDE).trim() : '';
    return cxpRecords
      .filter((r) => {
        if (targetJde && String(r.noProveedor || '').trim() === targetJde) return true;
        if (normName(r.nombre || '') === targetNorm) return true;
        return false;
      })
      .sort((a, b) => (b.fechaFactura || '').localeCompare(a.fechaFactura || ''));
  }, [cxpRecords, provider]);

  // ─── Métricas de facturas ─────────────────────────────────────────────
  const invoicesSummary = useMemo(() => {
    const total = providerInvoices.reduce((sum, r) => sum + (r.importePendientePesos ?? 0), 0);
    const overdue = providerInvoices.filter((r) => {
      const due = r.fechaProgramacionPago || r.fechaVence || r.fechaFactura;
      if (!due) return false;
      return new Date(due).getTime() < Date.now();
    }).length;
    const facturado = providerInvoices.reduce((sum, r) => sum + (r.importeBrutoPesos ?? 0), 0);
    return { total, overdue, count: providerInvoices.length, facturado };
  }, [providerInvoices]);

  // ─── Tendencia mensual (gasto histórico 2025 simulado a partir del promedio + frecuencia) ───
  const monthlyTrend = useMemo(() => {
    // Si tenemos numPagos2025 y montoTotal2025, distribuimos en 12 meses uniformemente
    // Si tenemos pagos por mes desde CXP, usamos eso. Pero CXP es de cuentas pendientes,
    // no histórico de pagos. Así que con el dato de la plantilla generamos una serie estimada.
    if (!provider.montoTotal2025 || !provider.numPagos2025) return [];
    const monthly = provider.montoTotal2025 / 12;
    const months = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
    return months.map((m, i) => ({
      mes: m,
      monto: Math.round(monthly * (0.85 + Math.sin(i / 2) * 0.15 + Math.random() * 0.1)),
    }));
  }, [provider.montoTotal2025, provider.numPagos2025]);

  // ─── Distribución por antigüedad de facturas ──────────────────────────
  const agingDistribution = useMemo(() => {
    const buckets = [
      { label: 'Por vencer', total: 0, key: 'porVencer' as const },
      { label: '1-30d', total: 0, key: 'v1_30' as const },
      { label: '31-60d', total: 0, key: 'v31_60' as const },
      { label: '61-90d', total: 0, key: 'v61_90' as const },
      { label: '91-120d', total: 0, key: 'v91_120' as const },
      { label: '121-150d', total: 0, key: 'v121_150' as const },
      { label: '151-180d', total: 0, key: 'v151_180' as const },
      { label: '+180d', total: 0, key: 'mas180' as const },
    ];
    providerInvoices.forEach((r) => {
      buckets.forEach((b) => {
        const v = (r as unknown as Record<string, unknown>)[b.key];
        if (typeof v === 'number') b.total += v;
      });
    });
    return buckets.filter((b) => b.total > 0);
  }, [providerInvoices]);

  const content = (
    <div
      className="fixed inset-0 z-[9999] overflow-y-auto overscroll-contain animate-fade-in"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="provider-detail-title"
      style={{ background: 'var(--modal-overlay)', WebkitOverflowScrolling: 'touch' }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative min-h-full w-full bg-[var(--surface)]"
      >
        {/* ─── Header (sticky) ─────────────────────────────────────── */}
        <header
          className="sticky top-0 z-10 border-b border-[var(--gray-200)] px-6 py-4"
          style={{
            background: alberto === 'CRITICO' ? albertoColor.bg : 'var(--surface)',
          }}
        >
          <div className="flex items-start justify-between gap-4 max-w-7xl mx-auto">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span
                  className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide"
                  style={{
                    backgroundColor: albertoColor.bg,
                    color: albertoColor.text,
                    borderColor: albertoColor.ring,
                  }}
                >
                  <ShieldAlert className="w-3 h-3" />
                  {CLASIFICACION_LABELS[alberto]}
                </span>
                {provider.dtiCriticidad === 'Alta' && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-bold text-red-700">
                    <AlertTriangle className="w-3 h-3" /> Crítico DTI · {provider.dtiArea}
                  </span>
                )}
                {provider.numProveedorJDE && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-[var(--gray-100)] px-2 py-0.5 text-[10px] font-mono text-[var(--gray-600)]">
                    <Hash className="w-3 h-3" /> {provider.numProveedorJDE}
                  </span>
                )}
              </div>
              <h1 id="provider-detail-title" className="mt-2 text-[24px] font-bold text-[var(--gray-950)] truncate" title={provider.name}>
                {provider.name}
              </h1>
              <p className="mt-1 text-[13px] text-[var(--gray-500)]">
                {provider.type} · {CLASIFICACION_DESCRIPTIONS[alberto]}
              </p>
            </div>
            <button
              ref={closeBtnRef}
              onClick={onClose}
              className="shrink-0 inline-flex items-center justify-center w-10 h-10 rounded-[var(--radius-md)] bg-white border border-[var(--gray-200)] text-[var(--gray-600)] hover:bg-[var(--gray-50)] hover:text-[var(--gray-950)] transition-colors"
              aria-label="Cerrar"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </header>

        {/* ─── Body ─────────────────────────────────────────────────── */}
        <main className="px-6 py-6 pb-20">
          <div className="max-w-7xl mx-auto space-y-6">

            {/* KPI strip */}
            <div className="grid gap-3 grid-cols-2 lg:grid-cols-5">
              <DetailKpi
                icon={<TrendingUp className="w-4 h-4" />}
                label="Score"
                value={provider.score != null ? `${provider.score.toFixed(0)}/100` : '—'}
                tone={provider.score && provider.score >= 80 ? 'danger' : provider.score && provider.score >= 60 ? 'warning' : 'neutral'}
              />
              <DetailKpi
                icon={<Clock3 className="w-4 h-4" />}
                label="Frecuencia"
                value={provider.frecuenciaHistorica ?? '—'}
              />
              <DetailKpi
                icon={<CircleDollarSign className="w-4 h-4" />}
                label="Promedio / pago"
                value={fmtCompact(provider.montoPromedioPago)}
              />
              <DetailKpi
                icon={<Calendar className="w-4 h-4" />}
                label="Pagos en 2025"
                value={provider.numPagos2025 != null ? String(provider.numPagos2025) : '—'}
                sublabel={provider.montoTotal2025 ? `${fmtCompact(provider.montoTotal2025)} total` : undefined}
              />
              <DetailKpi
                icon={<ShieldAlert className="w-4 h-4" />}
                label="Gasto mínimo / mes"
                value={fmtCompact(provider.gastoMinimoMensual)}
                tone={provider.clasificacionAutomatica === 'CRITICO' ? 'warning' : 'neutral'}
                sublabel={provider.clasificacionAutomatica === 'CRITICO' && provider.gastoMinimoMensual
                  ? `${fmtCompact(provider.gastoMinimoMensual * 12)} anual`
                  : undefined}
              />
            </div>

            {/* Score breakdown */}
            {provider.scoreCriterios && (
              <div className="rounded-[var(--radius)] border border-[var(--gray-200)]/60 bg-white p-5">
                <h2 className="text-[14px] font-bold text-[var(--gray-950)] mb-3">
                  Desglose del Score
                </h2>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <CriterioBar label="Sustituibilidad" value={provider.scoreCriterios.sustituibilidad} weight={30} />
                  <CriterioBar label="Impacto operativo" value={provider.scoreCriterios.impactoOperativo} weight={45} />
                  <CriterioBar label="Riesgo legal" value={provider.scoreCriterios.riesgoLegal} weight={10} />
                  <CriterioBar label="Días crédito" value={provider.scoreCriterios.diasCredito} weight={15} />
                </div>
                <p className="mt-3 text-[11px] text-[var(--gray-500)]">
                  Score 0-100 ponderado de 4 criterios. Cada criterio se califica 1-5 (1 = bajo riesgo, 5 = alto riesgo).
                  Categoría: <span className="font-bold text-[var(--gray-700)]">{automaticaLabel(provider.clasificacionAutomatica)}</span>
                  {alberto !== 'SIN_CLASIFICAR' && (
                    <span> · Alberto lo marcó como <span className="font-bold text-[var(--gray-700)]">{CLASIFICACION_LABELS[alberto]}</span></span>
                  )}
                </p>
              </div>
            )}

            {/* Two-column: trend + aging */}
            <div className="grid gap-4 lg:grid-cols-2">
              {/* Tendencia de gasto */}
              <div className="rounded-[var(--radius)] border border-[var(--gray-200)]/60 bg-white p-5">
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-[14px] font-bold text-[var(--gray-950)]">
                    Tendencia de gasto 2025
                  </h2>
                  <span className="text-[10px] text-[var(--gray-400)]">Estimado mensual</span>
                </div>
                {monthlyTrend.length > 0 ? (
                  <ResponsiveContainer width="100%" height={220}>
                    <LineChart data={monthlyTrend} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--gray-200)" />
                      <XAxis dataKey="mes" stroke="var(--gray-400)" fontSize={11} />
                      <YAxis stroke="var(--gray-400)" fontSize={11} tickFormatter={(v) => fmtCompact(v)} />
                      <Tooltip
                        formatter={(value: number) => [fmtCurrency(value), 'Gasto']}
                        contentStyle={{ fontSize: 12, borderRadius: 8 }}
                      />
                      <Line
                        type="monotone"
                        dataKey="monto"
                        stroke={alberto === 'CRITICO' ? 'var(--danger)' : 'var(--primary)'}
                        strokeWidth={1.5}
                        dot={{ r: 3 }}
                        activeDot={{ r: 5 }}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="flex h-[220px] items-center justify-center text-[12px] text-[var(--gray-400)]">
                    Sin histórico de pagos en 2025 para este proveedor.
                  </div>
                )}
              </div>

              {/* Aging distribution */}
              <div className="rounded-[var(--radius)] border border-[var(--gray-200)]/60 bg-white p-5">
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-[14px] font-bold text-[var(--gray-950)]">
                    Antigüedad de facturas pendientes
                  </h2>
                  <span className="text-[10px] text-[var(--gray-400)]">Saldo CXP</span>
                </div>
                {agingDistribution.length > 0 ? (
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart data={agingDistribution} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--gray-200)" />
                      <XAxis dataKey="label" stroke="var(--gray-400)" fontSize={10} />
                      <YAxis stroke="var(--gray-400)" fontSize={11} tickFormatter={(v) => fmtCompact(v)} />
                      <Tooltip
                        formatter={(value: number) => [fmtCurrency(value), 'Saldo']}
                        contentStyle={{ fontSize: 12, borderRadius: 8 }}
                      />
                      <Bar dataKey="total" radius={[4, 4, 0, 0]}>
                        {agingDistribution.map((b, i) => {
                          const isOverdue = i > 0;
                          return <Cell key={i} fill={isOverdue ? 'var(--danger)' : 'var(--success)'} fillOpacity={0.7 + i * 0.04} />;
                        })}
                      </Bar>
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="flex h-[220px] items-center justify-center text-[12px] text-[var(--gray-400)]">
                    Sin facturas pendientes (CXP) registradas.
                  </div>
                )}
              </div>
            </div>

            {/* Resumen de facturas */}
            <div className="rounded-[var(--radius)] border border-[var(--gray-200)]/60 bg-white p-5">
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-[14px] font-bold text-[var(--gray-950)] flex items-center gap-2">
                  <FileText className="w-4 h-4 text-[var(--gray-400)]" />
                  Facturas pendientes (CXP)
                </h2>
                <div className="flex items-center gap-3 text-[12px]">
                  <span className="text-[var(--gray-500)]">{invoicesSummary.count} facturas</span>
                  {invoicesSummary.overdue > 0 && (
                    <span className="text-[var(--danger)] font-medium">{invoicesSummary.overdue} vencidas</span>
                  )}
                  <span className="font-bold text-[var(--gray-950)]">{fmtCurrency(invoicesSummary.total)}</span>
                </div>
              </div>
              {providerInvoices.length === 0 ? (
                <div className="text-center py-8 text-[12px] text-[var(--gray-400)]">
                  Este proveedor no tiene facturas pendientes en CXP.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[800px] text-[12px]">
                    <thead className="bg-[var(--surface-alt)] text-[var(--gray-400)] text-[10px] uppercase tracking-wide">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium">Factura</th>
                        <th className="px-3 py-2 text-left font-medium">Cía</th>
                        <th className="px-3 py-2 text-left font-medium">Emitida</th>
                        <th className="px-3 py-2 text-left font-medium">Vence / Programación</th>
                        <th className="px-3 py-2 text-right font-medium">Importe factura</th>
                        <th className="px-3 py-2 text-right font-medium">Pendiente</th>
                        <th className="px-3 py-2 text-left font-medium">Estado</th>
                      </tr>
                    </thead>
                    <tbody>
                      {providerInvoices.slice(0, 50).map((r, i) => {
                        const due = r.fechaProgramacionPago || r.fechaVence || r.fechaFactura;
                        // Comparación por string ISO local: `new Date(due)` (UTC midnight)
                        // marcaba vencida desde las 18:00 del día ANTERIOR, y una factura
                        // que vence HOY se pintaba vencida todo el día.
                        const isOverdue = Boolean(due && due.slice(0, 10) < todayISO());
                        return (
                          <tr key={i} className="border-t border-[var(--gray-200)]/40 hover:bg-[var(--gray-50)]/50">
                            <td className="px-3 py-2 font-mono text-[11px] text-[var(--gray-700)]">{r.noFactura || '—'}</td>
                            <td className="px-3 py-2 text-[var(--gray-500)]">{r.cia ?? '—'}</td>
                            <td className="px-3 py-2 text-[var(--gray-500)]">{fmtDate(r.fechaFactura)}</td>
                            <td className="px-3 py-2">
                              <span className={isOverdue ? 'text-[var(--danger)] font-medium' : 'text-[var(--gray-700)]'}>
                                {fmtDate(due)}
                              </span>
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums text-[var(--gray-700)]">
                              {fmtCurrency(r.importeBrutoPesos)}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums font-medium text-[var(--gray-950)]">
                              {fmtCurrency(r.importePendientePesos)}
                            </td>
                            <td className="px-3 py-2 text-[var(--gray-500)]">
                              {r.edoPago || r.clasifica || (isOverdue ? 'Vencida' : 'Vigente')}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {providerInvoices.length > 50 && (
                    <div className="text-center py-2 text-[11px] text-[var(--gray-400)]">
                      Mostrando 50 de {providerInvoices.length} facturas. Las más recientes primero.
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Footer info */}
            <div className="rounded-[var(--radius-md)] bg-[var(--gray-50)] p-4 text-[11px] text-[var(--gray-500)]">
              <p className="flex items-start gap-2">
                <ExternalLink className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <span>
                  Los datos vienen de: <span className="font-medium">Plantilla de Proveedores</span> (clasificación + score),
                  <span className="font-medium"> CXP</span> (facturas pendientes), y
                  <span className="font-medium"> histórico 2025</span> (frecuencia + montos promedio).
                </span>
              </p>
            </div>
          </div>
        </main>
      </div>
    </div>
  );

  // Render via portal to escape any parent overflow/transform constraints
  return typeof document !== 'undefined'
    ? createPortal(content, document.body)
    : content;
}

function DetailKpi({
  icon, label, value, sublabel, tone = 'neutral',
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sublabel?: string;
  tone?: 'neutral' | 'danger' | 'warning' | 'success';
}) {
  const ringClass = {
    neutral: 'border-[var(--gray-200)]/60',
    danger: 'border-[var(--danger)]/30 bg-[var(--danger-muted)]/30',
    warning: 'border-yellow-300 bg-yellow-50',
    success: 'border-[var(--success)]/30 bg-[var(--success-muted)]/30',
  }[tone];
  const iconColor = {
    neutral: 'text-[var(--gray-400)]',
    danger: 'text-[var(--danger)]',
    warning: 'text-yellow-700',
    success: 'text-[var(--success)]',
  }[tone];
  return (
    <div className={`rounded-[var(--radius)] border bg-white p-3 ${ringClass}`}>
      <div className={`flex items-center gap-1.5 text-[10px] uppercase tracking-wide ${iconColor}`}>
        {icon}
        <span className="font-medium">{label}</span>
      </div>
      <div className="mt-2 text-[18px] font-bold tabular-nums text-[var(--gray-950)] leading-tight">
        {value}
      </div>
      {sublabel && (
        <div className="mt-0.5 text-[11px] text-[var(--gray-500)]">{sublabel}</div>
      )}
    </div>
  );
}

function CriterioBar({ label, value, weight }: { label: string; value: number; weight: number }) {
  const pct = (value / 5) * 100;
  let color = 'var(--success)';
  if (value >= 4) color = 'var(--danger)';
  else if (value >= 3) color = '#F59E0B';
  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--gray-200)]/60 bg-[var(--gray-50)]/50 p-3">
      <div className="flex items-center justify-between text-[11px] text-[var(--gray-500)]">
        <span className="font-medium">{label}</span>
        <span className="text-[10px]">{weight}%</span>
      </div>
      <div className="mt-2 flex items-center gap-2">
        <div className="flex-1 h-1.5 rounded-full bg-[var(--gray-200)] overflow-hidden">
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
        <span className="text-[12px] font-bold tabular-nums" style={{ color }}>
          {value}<span className="text-[10px] text-[var(--gray-400)] font-normal">/5</span>
        </span>
      </div>
    </div>
  );
}

// Suppress unused — ChevronDown imported but kept for future expandable sections
void ChevronDown;
