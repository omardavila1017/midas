/**
 * Shared loading skeleton that mirrors the canonical dashboard layout:
 *   PageHeader · FilterBar · KPI grid (N cards) · optional chart · optional table.
 *
 * Replaces 4 different loading treatments (text spinner, full skeleton, none,
 * none) with a single visually-stable shell. Reduces perceived shift on first
 * paint and keeps the user oriented while engines warm up.
 *
 * Motion: staggered shimmer (uses the existing .shimmer-bar class). All
 * staggering is < 200ms so the table doesn't feel theatrical on every load.
 */

interface Props {
  kpis?: number;
  showFilterBar?: boolean;
  showChart?: boolean;
  tableRows?: number;
  label?: string;
}

export default function DashboardLoadingShell({
  kpis = 4,
  showFilterBar = true,
  showChart = true,
  tableRows = 0,
  label = 'Cargando',
}: Props) {
  return (
    <div
      className="space-y-4 animate-page-in"
      aria-busy="true"
      aria-live="polite"
      aria-label={label}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="shimmer-bar h-4 w-44 rounded-[var(--radius-sm)]" />
          <div className="shimmer-bar mt-2 h-3 w-64 rounded-[var(--radius-sm)] opacity-70" />
        </div>
        <div className="shimmer-bar h-10 w-40 rounded-[var(--radius)] opacity-80" />
      </div>

      {/* Filter bar */}
      {showFilterBar && (
        <div className="rounded-[var(--radius-lg)] border border-[var(--gray-200)] bg-white px-3 py-2.5">
          <div className="flex items-center gap-2">
            <div className="shimmer-bar h-3 w-20 rounded-[var(--radius-sm)]" />
            <div className="shimmer-bar h-9 w-32 rounded-[var(--radius)] stagger-1" />
            <div className="shimmer-bar h-9 w-32 rounded-[var(--radius)] stagger-2" />
          </div>
        </div>
      )}

      {/* KPI grid */}
      {kpis > 0 && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: kpis }).map((_, idx) => (
            <div
              key={idx}
              className={[
                'rounded-[var(--radius-lg)] border border-[var(--gray-200)] bg-white p-4 animate-card-in',
                `stagger-${Math.min(6, idx + 1)}`,
              ].join(' ')}
            >
              <div className="flex items-center justify-between">
                <div className="shimmer-bar h-3 w-24 rounded-[var(--radius-sm)]" />
                <div className="shimmer-bar h-4 w-4 rounded-full opacity-70" />
              </div>
              <div className="shimmer-bar mt-3 h-6 w-32 rounded-[var(--radius-sm)]" />
              <div className="shimmer-bar mt-2 h-3 w-40 rounded-[var(--radius-sm)] opacity-60" />
            </div>
          ))}
        </div>
      )}

      {/* Chart */}
      {showChart && (
        <div className="rounded-[var(--radius-lg)] border border-[var(--gray-200)] bg-white p-4 animate-card-in stagger-5">
          <div className="flex items-center justify-between">
            <div className="shimmer-bar h-3 w-40 rounded-[var(--radius-sm)]" />
            <div className="shimmer-bar h-3 w-24 rounded-[var(--radius-sm)] opacity-60" />
          </div>
          <div className="relative mt-3 h-[280px] overflow-hidden rounded-[var(--radius)]">
            <div className="shimmer-bar absolute inset-0" />
            {/* Faux gridlines */}
            <div className="absolute inset-0 flex flex-col justify-between p-3 opacity-30">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="h-px w-full bg-[var(--gray-200)]" />
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Table rows */}
      {tableRows > 0 && (
        <div className="rounded-[var(--radius-lg)] border border-[var(--gray-200)] bg-white">
          <div className="border-b border-[var(--gray-200)] px-4 py-3">
            <div className="shimmer-bar h-3 w-32 rounded-[var(--radius-sm)]" />
          </div>
          <div className="divide-y divide-[var(--gray-100)]">
            {Array.from({ length: tableRows }).map((_, idx) => (
              <div
                key={idx}
                className={`grid grid-cols-[1fr_auto_auto] items-center gap-4 px-4 py-3 animate-fade-in stagger-${Math.min(6, idx + 1)}`}
              >
                <div className="shimmer-bar h-3 w-3/5 rounded-[var(--radius-sm)]" />
                <div className="shimmer-bar h-3 w-16 rounded-[var(--radius-sm)] opacity-70" />
                <div className="shimmer-bar h-3 w-20 rounded-[var(--radius-sm)] opacity-70" />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
