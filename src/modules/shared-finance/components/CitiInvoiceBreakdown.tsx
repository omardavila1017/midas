/**
 * Desglose por factura de una celda de Clientes Citi.
 *
 * Vive en su propio módulo porque lo pintan DOS superficies: el panel de detalle
 * de la celda (Planeación, sin segundo clic — es donde el usuario está mirando)
 * y el drilldown del movimiento. Importarlo desde `MovementDrillDownDrawer`
 * arrastraría ese módulo entero al chunk de Planeación.
 *
 * El renglón "Factor aplicado" es load-bearing, no decorativo: hay DOS causas
 * por las que las facturas no suman el importe atribuido —el reparto
 * proporcional, y que el motor haya descontado del peso la parte del cliente
 * que ya se atribuyó por su propio depósito identificado— y sin declararlo el
 * desglose se leería como error de captura. La nota NO afirma una sola causa a
 * propósito: en el caso del descuento el depósito SÍ alcanzaba, así que decir
 * "el depósito no alcanza" sería falso.
 */
import { fmtCurrency, fmtDate, fmtPctInt } from '../../../formatters';
import type { CitiCellBreakdown } from '../calculation-engine/citiClientCollection';

function safeDate(value: string | undefined | null): string {
  if (!value) return '—';
  if (value.length < 10) return value;
  try {
    return fmtDate(value);
  } catch {
    return value;
  }
}

export function CitiInvoiceBreakdown({
  breakdown,
  compact = false,
}: {
  breakdown: CitiCellBreakdown;
  /** `true` dentro del panel de la celda: sin encabezado propio ni nota larga. */
  compact?: boolean;
}) {
  const { invoices, invoicedTotal, attributedAmount, factor } = breakdown;
  // Los importes vienen de JDE al centavo, así que 0.5% de holgura sólo absorbe
  // el redondeo del reparto, nunca una diferencia real.
  const isFullyCredited = Math.abs(factor - 1) <= 0.005;
  return (
    <div className={compact ? '' : 'rounded-[var(--radius-md)] border border-[var(--gray-200)]'}>
      {!compact && (
        <div className="border-b border-[var(--gray-200)] bg-[var(--gray-50)] px-3 py-2 text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--gray-400)]">
          {invoices.length === 1 ? 'Factura CXC JDE' : `Facturas CXC JDE (${invoices.length})`}
        </div>
      )}
      {compact && (
        <div className="mb-1 text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--gray-400)]">
          {invoices.length === 1 ? 'Factura que respalda el importe' : `Facturas que respaldan el importe (${invoices.length})`}
        </div>
      )}
      <table className="w-full text-[11px]">
        <thead>
          <tr className="text-[10px] uppercase tracking-[0.06em] text-[var(--gray-400)]">
            <th className={`${compact ? '' : 'px-3'} py-1 text-left font-medium`}>Folio</th>
            <th className="py-1 text-left font-medium">Factura</th>
            <th className="py-1 text-left font-medium">Cobro</th>
            <th className="py-1 text-left font-medium">Recibo</th>
            <th className={`${compact ? '' : 'px-3'} py-1 text-right font-medium`}>Importe</th>
          </tr>
        </thead>
        <tbody>
          {invoices.map((invoice, idx) => (
            <tr key={`${invoice.noFactura}-${idx}`} className="border-t border-[var(--gray-100)]">
              <td className={`${compact ? '' : 'px-3'} py-1 font-medium text-[var(--gray-950)]`}>
                {invoice.noFactura || 'sin folio'}
              </td>
              <td className="py-1 text-[var(--gray-500)]">{safeDate(invoice.fechaFactura)}</td>
              <td className="py-1 text-[var(--gray-500)]">{safeDate(invoice.fechaCobro)}</td>
              <td className="py-1 text-[var(--gray-500)]">{invoice.noRecibo ?? '—'}</td>
              <td className={`${compact ? '' : 'px-3'} py-1 text-right tabular-nums text-[var(--gray-950)]`}>
                {fmtCurrency(invoice.importeBrutoPesos)}
              </td>
            </tr>
          ))}
          <tr className="border-t border-[var(--gray-300)]">
            <td colSpan={4} className={`${compact ? '' : 'px-3'} py-1 text-[var(--gray-500)]`}>Suma de facturas</td>
            <td className={`${compact ? '' : 'px-3'} py-1 text-right font-semibold tabular-nums text-[var(--gray-950)]`}>
              {fmtCurrency(invoicedTotal)}
            </td>
          </tr>
          <tr>
            <td colSpan={4} className={`${compact ? '' : 'px-3'} pb-1 text-[var(--gray-500)]`}>Importe atribuido</td>
            <td className={`${compact ? '' : 'px-3'} pb-1 text-right font-semibold tabular-nums text-[var(--gray-950)]`}>
              {fmtCurrency(attributedAmount)}
            </td>
          </tr>
          <tr>
            <td colSpan={4} className={`${compact ? '' : 'px-3'} pb-1 text-[var(--gray-500)]`}>Factor aplicado</td>
            <td className={`${compact ? '' : 'px-3'} pb-1 text-right font-semibold tabular-nums text-[var(--gray-950)]`}>
              {factor.toFixed(3)}
            </td>
          </tr>
        </tbody>
      </table>
      <div className={`${compact ? 'pt-1' : 'px-3 pb-3'} text-[10.5px] leading-snug text-[var(--gray-500)]`}>
        {isFullyCredited
          ? 'Las facturas suman el importe atribuido: el depósito se acreditó completo.'
          : `A este cliente se le atribuyó el ${fmtPctInt(factor * 100)} de sus facturas del periodo. El resto ya se acreditó por su propio depósito identificado, o entró por otra cuenta, se compensó, o cayó en otro periodo.`}
      </div>
    </div>
  );
}
