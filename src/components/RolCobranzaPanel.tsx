import { useMemo, useState } from 'react';
import { ChevronDown, Route } from 'lucide-react';
import type { CobranzaPayment, CobranzaRecord, RolRecord } from '../services/jdeTypes';
import { buildRolCobranzaCross, summarizeRolCrossByClient } from '../domain/rolCobranzaMatch';
import { fmtCurrency } from '../formatters';

/**
 * Panel ROL ↔ Cobranza dentro de la pestaña Cobranza.
 *
 * Cruza los viajes ejecutados del ROL diario CITI contra las facturas de
 * cobranza JDE (folio exacto / UUID / núcleo numérico del folio) y los pagos
 * aplicados de CobranzaIndicadores, y los clasifica en:
 *   - Facturado: viaje con factura encontrada en cobranza o en pagos.
 *   - Predicho:  viaje ejecutado aún sin factura.
 *   - Huérfano:  viaje marcado como facturado pero sin match en ningún
 *                índice (objetivo de negocio: 0 — un huérfano es señal de
 *                folio fuera del rango cargado o formato no reconocido).
 */

interface Props {
  rolRecords: RolRecord[];
  cobranzaRecords: CobranzaRecord[];
  /** Pagos CobranzaIndicadores — rescatan facturas cobradas fuera del CXC. */
  cobranzaPayments?: CobranzaPayment[];
}

export default function RolCobranzaPanel({ rolRecords, cobranzaRecords, cobranzaPayments = [] }: Props) {
  const [expanded, setExpanded] = useState(false);

  const cross = useMemo(
    () => buildRolCobranzaCross(rolRecords, cobranzaRecords, cobranzaPayments),
    [rolRecords, cobranzaRecords, cobranzaPayments],
  );
  const byClient = useMemo(() => summarizeRolCrossByClient(cross), [cross]);

  if (rolRecords.length === 0) return null;

  const invoicedAmount = cross.matches.reduce((s, m) => s + m.rol.subTotal, 0);
  const predictedAmount = cross.predicted.reduce((s, r) => s + r.subTotal, 0);
  const orphanAmount = cross.invoicedOrphans.reduce((s, r) => s + r.subTotal, 0);

  return (
    <div className="bg-white border border-[var(--gray-200)] rounded-[var(--radius)] animate-card-in">
      <div className="flex items-center gap-2 p-4">
        <Route className="w-4 h-4 text-[var(--primary)]" />
        <div className="font-semibold text-[14px] text-[var(--gray-950)]">
          ROL Citi ↔ Cobranza
        </div>
        <span className="text-[11px] text-[var(--gray-400)]">
          {rolRecords.length} viaje{rolRecords.length !== 1 ? 's' : ''} ejecutado{rolRecords.length !== 1 ? 's' : ''}
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 px-4 pb-4">
        <Kpi
          label="Facturado"
          hint="Viaje con factura encontrada en cobranza o pagos"
          trips={cross.matches.length}
          amount={invoicedAmount}
          tone="var(--success)"
        />
        <Kpi
          label="Predicho"
          hint="Viaje ejecutado, aún sin factura"
          trips={cross.predicted.length}
          amount={predictedAmount}
          tone="var(--primary)"
        />
        <Kpi
          label="Huérfano"
          hint="Marcado facturado sin match en cobranza ni pagos"
          trips={cross.invoicedOrphans.length}
          amount={orphanAmount}
          tone="var(--warning)"
        />
      </div>

      {byClient.length > 0 && (
        <>
          <button
            onClick={() => setExpanded((v) => !v)}
            className="flex items-center gap-1.5 px-4 py-2.5 w-full border-t border-[var(--gray-200)]/60 text-[12px] text-[var(--gray-500)] hover:text-[var(--gray-950)] hover:bg-[var(--gray-50)]"
          >
            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`} />
            Desglose por cliente ({byClient.length})
          </button>
          {expanded && (
            <div className="overflow-x-auto border-t border-[var(--gray-200)]/60">
              <table className="w-full text-[12px]">
                <thead>
                  <tr className="text-[11px] uppercase tracking-wide text-[var(--gray-400)] text-left">
                    <th className="px-4 py-2 font-medium">Cliente</th>
                    <th className="px-4 py-2 font-medium text-right">Facturado</th>
                    <th className="px-4 py-2 font-medium text-right">Predicho</th>
                    <th className="px-4 py-2 font-medium text-right">Huérfano</th>
                  </tr>
                </thead>
                <tbody>
                  {byClient.map((c) => (
                    <tr key={c.claveJDE} className="border-t border-[var(--gray-200)]/40">
                      <td className="px-4 py-2 text-[var(--gray-950)]">{c.dCliente || c.claveJDE}</td>
                      <td className="px-4 py-2 text-right tabular-nums text-[var(--gray-700)]">
                        {fmtCurrency(c.invoicedAmount)}
                        <span className="text-[var(--gray-400)]"> · {c.invoicedTrips}</span>
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-[var(--gray-700)]">
                        {fmtCurrency(c.predictedAmount)}
                        <span className="text-[var(--gray-400)]"> · {c.predictedTrips}</span>
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-[var(--gray-700)]">
                        {fmtCurrency(c.orphanAmount)}
                        <span className="text-[var(--gray-400)]"> · {c.orphanTrips}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Kpi({
  label,
  hint,
  trips,
  amount,
  tone,
}: {
  label: string;
  hint: string;
  trips: number;
  amount: number;
  tone: string;
}) {
  return (
    <div className="rounded-[var(--radius-md)] border border-[var(--gray-200)]/60 bg-[var(--surface-alt)] p-3">
      <div className="text-[11px] uppercase tracking-wide font-medium" style={{ color: tone }}>
        {label}
      </div>
      <div className="text-lg font-bold tabular-nums text-[var(--gray-950)] mt-0.5">
        {fmtCurrency(amount)}
      </div>
      <div className="text-[11px] text-[var(--gray-400)]">
        {trips} viaje{trips !== 1 ? 's' : ''} · {hint}
      </div>
    </div>
  );
}
