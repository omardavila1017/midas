/**
 * Quiet placeholders shown while heavy projection subtrees mount. These match
 * the eventual layout so first paint doesn't shift, and use the existing
 * `.skeleton` shimmer token so the visual language is consistent.
 */

export function ChartSkeleton({ height = 340 }: { height?: number }) {
  return (
    <div
      className="rounded-[var(--radius)] bg-[var(--gray-50)]"
      style={{ height }}
      aria-hidden="true"
    >
      <div className="skeleton h-full w-full rounded-[var(--radius)] opacity-60" />
    </div>
  );
}

export function TableSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="px-4 py-3" aria-hidden="true">
      <div className="space-y-2">
        {Array.from({ length: rows }).map((_, idx) => (
          <div key={idx} className="skeleton h-9 w-full rounded-[var(--radius-md)] opacity-60" />
        ))}
      </div>
    </div>
  );
}

export function StatsSkeleton({ items = 4 }: { items?: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 p-4 md:grid-cols-4" aria-hidden="true">
      {Array.from({ length: items }).map((_, idx) => (
        <div key={idx} className="rounded-[var(--radius)] border border-[var(--gray-200)] bg-[var(--gray-50)] px-3 py-3">
          <div className="skeleton h-3 w-1/2 rounded opacity-60" />
          <div className="skeleton mt-2 h-4 w-3/4 rounded opacity-60" />
        </div>
      ))}
    </div>
  );
}
