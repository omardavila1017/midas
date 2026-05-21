/**
 * Drill-down de "Pagos sin cruce" — diagnóstico trazable.
 *
 * Abre desde la tarjeta KPI homónima de `ConciliacionDashboard`. Toma los
 * `paymentMatches` del motor `paymentReconciliationEngine` y los desglosa:
 *
 *   - Pestaña "Sin cruce": pagos UNMATCHED (no internos) clasificados por
 *     causa probable — intercompañía, empleado/nómina, rastro a otra cuenta,
 *     rastro a la misma cuenta, posible comisión, o sin rastro. Cada fila
 *     muestra el CARGO bancario más parecido que el motor halló pero no pudo
 *     confirmar (`unmatchedCandidate`).
 *   - Pestaña "Cruce débil": pagos cruzados vía `cross-account` o `subset`
 *     (2a pasada, baja confianza) — para que el usuario los valide.
 *
 * Es solo lectura: ni edita ni reclasifica nada. La meta es depurar a mano.
 */
import { useMemo, useState } from 'react';
import { X, Search } from 'lucide-react';
import { fmtCurrency, fmtCompact, fmtDate } from '../formatters';
import type { PaymentMatch } from '../domain/paymentReconciliationEngine';
import { isInternalCounterparty } from '../domain/netCashFlowEngine';

interface Props {
  paymentMatches: PaymentMatch[];
  internalPaymentKeys: Set<string>;
  onClose: () => void;
}

type UnmatchedCategory =
  | 'intercompany'
  | 'employee'
  | 'trace-other-account'
  | 'trace-same-account'
  | 'commission'
  | 'no-trace';

const COMMISSION_MAX_PESOS = 5000;

const CATEGORY_ORDER: UnmatchedCategory[] = [
  'intercompany',
  'employee',
  'trace-other-account',
  'trace-same-account',
  'commission',
  'no-trace',
];

interface CategoryMeta {
  label: string;
  desc: string;
  color: string;
  bg: string;
}

const CATEGORY_META: Record<UnmatchedCategory, CategoryMeta> = {
  intercompany: {
    label: 'Intercompañía',
    desc: 'La contraparte es una empresa del grupo — probablemente traspaso interno, no un pago a proveedor externo.',
    color: 'var(--info)',
    bg: 'var(--info-muted)',
  },
  employee: {
    label: 'Empleado / nómina',
    desc: 'Nómina, reembolso o vale. No pasa por CXP; solo debería cruzar contra banco.',
    color: 'oklch(48% 0.12 290)',
    bg: 'color-mix(in oklch, oklch(48% 0.12 290) 12%, transparent)',
  },
  'trace-other-account': {
    label: 'Rastro: otra cuenta',
    desc: 'Hay un CARGO del mismo importe en OTRA cuenta — fuera de la ventana de fecha o ya cruzado a otro pago. Candidato a cuenta concentradora.',
    color: 'var(--warning)',
    bg: 'var(--warning-muted)',
  },
  'trace-same-account': {
    label: 'Rastro: misma cuenta',
    desc: 'Hay un CARGO del mismo importe en la misma cuenta, pero fuera de la ventana de fecha o ya cruzado a otro pago.',
    color: 'var(--warning)',
    bg: 'var(--warning-muted)',
  },
  commission: {
    label: 'Posible comisión',
    desc: 'Monto chico (<$5,000) sin rastro bancario — posible comisión o cargo no registrado en el sistema.',
    color: 'var(--gray-500)',
    bg: 'var(--gray-100)',
  },
  'no-trace': {
    label: 'Sin rastro',
    desc: 'Ningún CARGO de importe parecido en el rango cargado. Requiere revisión manual.',
    color: 'var(--danger)',
    bg: 'var(--danger-muted)',
  },
};

function paymentKey(cia: string, noPago: string): string {
  return `${cia}::${noPago}`;
}

function isEmployeeLike(p: PaymentMatch['payment']): boolean {
  return (
    /trabajador|employee|emplead/i.test(p.tipoBusqueda || '') ||
    /n[oó]min|reembolso|vale/i.test(p.clasificacionProveedor || '')
  );
}

function categorize(m: PaymentMatch): UnmatchedCategory {
  const p = m.payment;
  if (isInternalCounterparty(p.rfcProveedor, p.nombreProveedor)) return 'intercompany';
  if (isEmployeeLike(p)) return 'employee';
  if (m.unmatchedCandidate) {
    return m.unmatchedCandidate.sameAccount ? 'trace-same-account' : 'trace-other-account';
  }
  if (p.importePesos < COMMISSION_MAX_PESOS) return 'commission';
  return 'no-trace';
}

function CategoryChip({ category }: { category: UnmatchedCategory }) {
  const meta = CATEGORY_META[category];
  return (
    <span
      className="inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-medium"
      style={{ background: meta.bg, color: meta.color }}
      title={meta.desc}
    >
      {meta.label}
    </span>
  );
}

const TH = 'px-3 py-2 text-left font-medium uppercase tracking-[0.06em]';
const TD = 'px-3 py-1.5 align-top';

export default function ConciliacionPagosDrilldown({
  paymentMatches,
  internalPaymentKeys,
  onClose,
}: Props) {
  const [tab, setTab] = useState<'unmatched' | 'weak'>('unmatched');
  const [categoryFilter, setCategoryFilter] = useState<UnmatchedCategory | 'all'>('all');
  const [query, setQuery] = useState('');

  const { unmatched, weak } = useMemo(() => {
    const u: Array<{ match: PaymentMatch; category: UnmatchedCategory }> = [];
    const w: PaymentMatch[] = [];
    for (const m of paymentMatches) {
      if (internalPaymentKeys.has(paymentKey(m.payment.cia, m.payment.noPago))) continue;
      if (m.status === 'UNMATCHED') {
        u.push({ match: m, category: categorize(m) });
      } else if (
        m.cargoMatch &&
        (m.cargoMatch.tier === 'cross-account' || m.cargoMatch.tier === 'subset')
      ) {
        w.push(m);
      }
    }
    u.sort((a, b) => b.match.payment.importePesos - a.match.payment.importePesos);
    w.sort((a, b) => b.payment.importePesos - a.payment.importePesos);
    return { unmatched: u, weak: w };
  }, [paymentMatches, internalPaymentKeys]);

  const categoryCounts = useMemo(() => {
    const counts: Record<UnmatchedCategory, { count: number; pesos: number }> = {
      intercompany: { count: 0, pesos: 0 },
      employee: { count: 0, pesos: 0 },
      'trace-other-account': { count: 0, pesos: 0 },
      'trace-same-account': { count: 0, pesos: 0 },
      commission: { count: 0, pesos: 0 },
      'no-trace': { count: 0, pesos: 0 },
    };
    for (const { match, category } of unmatched) {
      counts[category].count += 1;
      counts[category].pesos += match.payment.importePesos;
    }
    return counts;
  }, [unmatched]);

  const unmatchedTotalPesos = useMemo(
    () => unmatched.reduce((acc, u) => acc + u.match.payment.importePesos, 0),
    [unmatched],
  );

  const visibleUnmatched = useMemo(() => {
    const q = query.trim().toLowerCase();
    return unmatched.filter(({ match, category }) => {
      if (categoryFilter !== 'all' && category !== categoryFilter) return false;
      if (!q) return true;
      const p = match.payment;
      return (
        p.noPago.toLowerCase().includes(q) ||
        p.nombreProveedor.toLowerCase().includes(q) ||
        p.cia.toLowerCase().includes(q)
      );
    });
  }, [unmatched, categoryFilter, query]);

  return (
    <section
      className="space-y-4 rounded-[var(--radius-lg)] border p-4"
      style={{ borderColor: 'var(--gray-200)', background: 'var(--surface)' }}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-[14px] font-bold" style={{ color: 'var(--gray-950)' }}>
            Pagos sin cruce — diagnóstico
          </h3>
          <p className="mt-0.5 text-[12px]" style={{ color: 'var(--gray-500)' }}>
            {unmatched.length} pagos sin cruce ({fmtCompact(unmatchedTotalPesos)}) ·{' '}
            {weak.length} cruzados con baja confianza
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Cerrar diagnóstico"
          className="inline-flex h-7 w-7 items-center justify-center rounded-[var(--radius-sm)] border transition-colors hover:bg-[var(--gray-100)]"
          style={{ borderColor: 'var(--gray-200)', color: 'var(--gray-500)' }}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b" style={{ borderColor: 'var(--gray-200)' }}>
        {([
          ['unmatched', `Sin cruce (${unmatched.length})`],
          ['weak', `Cruce débil — revisar (${weak.length})`],
        ] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className="px-3 py-1.5 text-[12px] font-medium transition-colors"
            style={{
              color: tab === id ? 'var(--accent-blue)' : 'var(--gray-500)',
              borderBottom: tab === id ? '2px solid var(--accent-blue)' : '2px solid transparent',
              marginBottom: '-1px',
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'unmatched' && (
        <>
          {/* Filtros por categoría */}
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              onClick={() => setCategoryFilter('all')}
              className="rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors"
              style={{
                borderColor: categoryFilter === 'all' ? 'var(--accent-blue)' : 'var(--gray-200)',
                background: categoryFilter === 'all' ? 'var(--accent-blue)' : 'transparent',
                color: categoryFilter === 'all' ? '#fff' : 'var(--gray-700)',
              }}
            >
              Todos ({unmatched.length})
            </button>
            {CATEGORY_ORDER.map((cat) => {
              const c = categoryCounts[cat];
              if (c.count === 0) return null;
              const active = categoryFilter === cat;
              const meta = CATEGORY_META[cat];
              return (
                <button
                  key={cat}
                  type="button"
                  onClick={() => setCategoryFilter(active ? 'all' : cat)}
                  title={meta.desc}
                  className="rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors"
                  style={{
                    borderColor: active ? meta.color : 'var(--gray-200)',
                    background: active ? meta.bg : 'transparent',
                    color: meta.color,
                  }}
                >
                  {meta.label} ({c.count} · {fmtCompact(c.pesos)})
                </button>
              );
            })}
          </div>

          {/* Buscador */}
          <div
            className="flex items-center gap-2 rounded-[var(--radius-sm)] border px-2.5 py-1.5"
            style={{ borderColor: 'var(--gray-200)' }}
          >
            <Search className="h-3.5 w-3.5" style={{ color: 'var(--gray-400)' }} />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar por proveedor, no. de pago o compañía…"
              className="w-full bg-transparent text-[12px] outline-none"
              style={{ color: 'var(--gray-950)' }}
            />
          </div>

          {/* Tabla sin cruce */}
          <div
            className="overflow-x-auto rounded-[var(--radius-lg)] border"
            style={{ borderColor: 'var(--gray-200)' }}
          >
            <table className="w-full text-[12px]">
              <thead>
                <tr style={{ background: 'var(--gray-50)', color: 'var(--gray-500)' }}>
                  <th className={TH}>Pago</th>
                  <th className={TH}>Proveedor</th>
                  <th className={TH}>Fecha</th>
                  <th className={`${TH} text-right`}>Importe</th>
                  <th className={TH}>Causa probable</th>
                  <th className={TH}>Rastro bancario (CARGO más parecido)</th>
                </tr>
              </thead>
              <tbody>
                {visibleUnmatched.map(({ match, category }) => {
                  const p = match.payment;
                  const cand = match.unmatchedCandidate;
                  return (
                    <tr
                      key={paymentKey(p.cia, p.noPago)}
                      className="border-t"
                      style={{ borderColor: 'var(--gray-100)' }}
                    >
                      <td className={`${TD} font-mono`} style={{ color: 'var(--gray-700)' }}>
                        {p.noPago}
                        <div className="text-[10px]" style={{ color: 'var(--gray-400)' }}>
                          cía {p.cia}
                        </div>
                      </td>
                      <td className={TD} style={{ color: 'var(--gray-950)' }}>
                        <div className="max-w-[220px] truncate" title={p.nombreProveedor}>
                          {p.nombreProveedor}
                        </div>
                        <div className="text-[10px]" style={{ color: 'var(--gray-400)' }}>
                          {p.clasificacionProveedor || '—'}
                        </div>
                      </td>
                      <td className={TD} style={{ color: 'var(--gray-700)' }}>
                        {fmtDate(p.fechaPago)}
                      </td>
                      <td
                        className={`${TD} text-right font-semibold tabular-nums`}
                        style={{ color: 'var(--gray-950)' }}
                      >
                        {fmtCurrency(p.importePesos)}
                      </td>
                      <td className={TD}>
                        <CategoryChip category={category} />
                      </td>
                      <td className={TD}>
                        {cand ? (
                          <div className="text-[11px]" style={{ color: 'var(--gray-700)' }}>
                            <span className="font-semibold tabular-nums">
                              {fmtCurrency(Math.abs(cand.movement.importe))}
                            </span>{' '}
                            · cuenta <span className="font-mono">{cand.cuenta}</span> ·{' '}
                            {fmtDate(cand.movement.fechaOperacion)}
                            <div className="mt-0.5 text-[10px]" style={{ color: 'var(--gray-500)' }}>
                              {cand.sameAccount ? 'misma cuenta' : 'otra cuenta'} · ±{cand.daysOff} d ·{' '}
                              <span
                                style={{
                                  color: cand.claimed ? 'var(--warning)' : 'var(--success)',
                                }}
                              >
                                {cand.claimed ? 'ya cruzado a otro pago' : 'CARGO libre'}
                              </span>
                            </div>
                          </div>
                        ) : (
                          <span className="text-[11px] italic" style={{ color: 'var(--gray-400)' }}>
                            sin rastro
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {visibleUnmatched.length === 0 && (
                  <tr>
                    <td
                      colSpan={6}
                      className="px-3 py-6 text-center text-[12px]"
                      style={{ color: 'var(--gray-400)' }}
                    >
                      Sin pagos en esta categoría.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {tab === 'weak' && (
        <div
          className="overflow-x-auto rounded-[var(--radius-lg)] border"
          style={{ borderColor: 'var(--gray-200)' }}
        >
          <table className="w-full text-[12px]">
            <thead>
              <tr style={{ background: 'var(--gray-50)', color: 'var(--gray-500)' }}>
                <th className={TH}>Pago</th>
                <th className={TH}>Proveedor</th>
                <th className={TH}>Fecha pago</th>
                <th className={`${TH} text-right`}>Importe</th>
                <th className={TH}>Tipo de cruce</th>
                <th className={TH}>CARGO(s) bancario(s)</th>
              </tr>
            </thead>
            <tbody>
              {weak.map((m) => {
                const p = m.payment;
                const cm = m.cargoMatch!;
                const movements = [cm.movement, ...(cm.extraMovements ?? [])];
                const isSubset = cm.tier === 'subset';
                return (
                  <tr
                    key={paymentKey(p.cia, p.noPago)}
                    className="border-t"
                    style={{ borderColor: 'var(--gray-100)' }}
                  >
                    <td className={`${TD} font-mono`} style={{ color: 'var(--gray-700)' }}>
                      {p.noPago}
                      <div className="text-[10px]" style={{ color: 'var(--gray-400)' }}>
                        cía {p.cia}
                      </div>
                    </td>
                    <td className={TD} style={{ color: 'var(--gray-950)' }}>
                      <div className="max-w-[220px] truncate" title={p.nombreProveedor}>
                        {p.nombreProveedor}
                      </div>
                    </td>
                    <td className={TD} style={{ color: 'var(--gray-700)' }}>
                      {fmtDate(p.fechaPago)}
                    </td>
                    <td
                      className={`${TD} text-right font-semibold tabular-nums`}
                      style={{ color: 'var(--gray-950)' }}
                    >
                      {fmtCurrency(p.importePesos)}
                    </td>
                    <td className={TD}>
                      <span
                        className="inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-medium"
                        style={{ background: 'var(--warning-muted)', color: 'var(--warning)' }}
                        title={`Confianza ${(cm.confidence * 100).toFixed(0)}%`}
                      >
                        {isSubset ? 'pago partido' : 'otra cuenta'} ·{' '}
                        {(cm.confidence * 100).toFixed(0)}%
                      </span>
                    </td>
                    <td className={TD}>
                      <div className="space-y-0.5">
                        {movements.map((mv, idx) => (
                          <div
                            key={idx}
                            className="text-[11px]"
                            style={{ color: 'var(--gray-700)' }}
                          >
                            <span className="font-semibold tabular-nums">
                              {fmtCurrency(Math.abs(mv.importe))}
                            </span>{' '}
                            · cuenta <span className="font-mono">{mv.cuenta || cm.cuenta}</span> ·{' '}
                            {fmtDate(mv.fechaOperacion)}
                          </div>
                        ))}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {weak.length === 0 && (
                <tr>
                  <td
                    colSpan={6}
                    className="px-3 py-6 text-center text-[12px]"
                    style={{ color: 'var(--gray-400)' }}
                  >
                    Sin cruces de baja confianza.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
