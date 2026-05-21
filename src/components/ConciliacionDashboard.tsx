import { useMemo } from 'react';
import { ArrowDownCircle, ArrowUpCircle, Banknote, FileWarning } from 'lucide-react';
import PageHeader from './ui/PageHeader';
import { KpiCard, type KpiCardProps } from './ui/KpiCard';
import { fmtInt, fmtKpi, fmtPctInt } from '../formatters';
import type { RealReconciliationResult } from '../domain/realReconciliationEngine';
import type { PaymentReconciliationResult } from '../domain/paymentReconciliationEngine';

/**
 * Conciliación — superficie de SOLO KPIs de conciliación.
 *
 * Cobros: cruce banco (ABONO) ↔ cobranza ↔ IndicadoresCobranza.
 * Pagos:  cruce banco (CARGO) ↔ PagoProveedor ↔ CXP.
 *
 * Es un panel de diagnóstico: muestra dónde está fallando el cruce para que
 * el ingreso/egreso se consolide bien. No edita nada — solo lee los
 * resultados que ya producen `realReconciliationEngine` y
 * `paymentReconciliationEngine`.
 */
interface Props {
  cobranzaReconciliation: RealReconciliationResult;
  paymentReconciliation: PaymentReconciliationResult;
}

/** Tono por porcentaje de cruce: <50 rojo, <80 ámbar, ≥80 verde. */
function toneForPct(pct: number): KpiCardProps['tone'] {
  if (pct < 50) return 'danger';
  if (pct < 80) return 'warning';
  return 'success';
}

const SECTION_TITLE = 'text-[13px] font-bold uppercase tracking-[0.08em]';

export default function ConciliacionDashboard({
  cobranzaReconciliation,
  paymentReconciliation,
}: Props) {
  const cobros = useMemo(() => {
    const s = cobranzaReconciliation.summary;
    const pagosInd = s.totalPagosIndicadores ?? 0;
    const pagosConcil = s.pagosConciliadosBanco ?? 0;
    return {
      pctAbonos: s.pctAbonosCruzados,
      totalAbonos: s.totalAbonos,
      totalAbonoMonto: s.totalAbonoMonto,
      abonosConFactura: s.abonosFacturaCobrada,
      abonosSinFactura: s.abonosSinFactura,
      abonosInternos: s.abonosTraspasoInterno,
      pctFacturas: s.pctFacturasCruzadas,
      totalFacturas: s.totalFacturas,
      facturasBanco: s.facturasCobradasBanco,
      facturasJdeSinBanco: s.facturasCobradasJdeSinBanco,
      facturasPendientes: s.facturasPendientes,
      cobradoBanco: s.totalCobradoBanco,
      saldoPendiente: s.totalSaldoPendiente,
      pagosInd,
      pagosConcil,
      pagosSinBanco: s.pagosSinBanco ?? 0,
      pctPagosInd: pagosInd > 0 ? (pagosConcil / pagosInd) * 100 : 0,
      ciaBreakdown: s.ciaBreakdown ?? [],
    };
  }, [cobranzaReconciliation]);

  const pagos = useMemo(() => {
    const t = paymentReconciliation.totals;
    const activos = Math.max(0, t.payments - t.internalPayments);
    return {
      payments: t.payments,
      activos,
      internalPayments: t.internalPayments,
      matchedCxp: t.matchedCxp,
      matchedCargo: t.matchedCargo,
      matchedFull: t.matchedFull,
      unmatched: t.unmatched,
      totalPaidPesos: t.totalPaidPesos,
      totalInternalPesos: t.totalInternalPesos,
      totalUnmatchedPesos: t.totalUnmatchedPesos,
      pctConciliado: activos > 0 ? (t.matchedCargo / activos) * 100 : 0,
    };
  }, [paymentReconciliation]);

  const reconciliationVacia = cobros.totalAbonos === 0 && pagos.payments === 0;

  return (
    <div className="space-y-8">
      <PageHeader
        title="Conciliación"
        meta="Diagnóstico"
        subtitle="Cruce banco ↔ cobranza (cobros) y banco ↔ pago proveedor (pagos). Solo KPIs."
      />

      {reconciliationVacia && (
        <div
          className="rounded-[var(--radius-lg)] border p-4 text-[13px]"
          style={{
            borderColor: 'color-mix(in oklch, var(--warning) 30%, var(--gray-200))',
            background: 'var(--warning-muted)',
            color: 'var(--gray-700)',
          }}
        >
          La conciliación aún no ha corrido (0 ABONOs y 0 pagos). Espera a que
          termine la carga de bancos + cobranza, o revisa que los datos estén
          sincronizados.
        </div>
      )}

      {/* ── COBROS ─────────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <ArrowDownCircle className="h-4 w-4" style={{ color: 'var(--success)' }} aria-hidden />
          <h2 className={SECTION_TITLE} style={{ color: 'var(--gray-700)' }}>
            Cobros · Banco ↔ Cobranza
          </h2>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <KpiCard
            label="ABONOs cruzados a factura"
            value={fmtPctInt(cobros.pctAbonos)}
            tone={toneForPct(cobros.pctAbonos)}
            icon={<Banknote className="h-4 w-4" />}
            sublabel={`${fmtInt(cobros.abonosConFactura)} de ${fmtInt(cobros.totalAbonos)} ABONOs`}
            breakdown={[
              { label: 'Con factura', value: fmtInt(cobros.abonosConFactura), valueColor: 'var(--success)' },
              { label: 'Sin factura', value: fmtInt(cobros.abonosSinFactura), valueColor: 'var(--danger)' },
              { label: 'Traspaso interno', value: fmtInt(cobros.abonosInternos) },
            ]}
          />
          <KpiCard
            label="Monto ABONOs (banco)"
            value={fmtKpi(cobros.totalAbonoMonto)}
            sublabel={`${fmtInt(cobros.totalAbonos)} movimientos`}
          />
          <KpiCard
            label="Facturas cruzadas a banco"
            value={fmtPctInt(cobros.pctFacturas)}
            tone={toneForPct(cobros.pctFacturas)}
            sublabel={`${fmtInt(cobros.facturasBanco)} de ${fmtInt(cobros.totalFacturas)} facturas`}
            breakdown={[
              { label: 'Cobrada + banco', value: fmtInt(cobros.facturasBanco), valueColor: 'var(--success)' },
              { label: 'Cobrada JDE sin banco', value: fmtInt(cobros.facturasJdeSinBanco), valueColor: 'var(--warning)' },
              { label: 'Pendiente', value: fmtInt(cobros.facturasPendientes) },
            ]}
          />
          <KpiCard
            label="Cobrado validado en banco"
            value={fmtKpi(cobros.cobradoBanco)}
            tone="neutral"
            breakdown={[
              { label: 'Saldo pendiente', value: fmtKpi(cobros.saldoPendiente), valueColor: 'var(--warning)' },
            ]}
          />
        </div>
        {cobros.pagosInd > 0 && (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <KpiCard
              label="Pagos IndicadoresCobranza conciliados"
              value={fmtPctInt(cobros.pctPagosInd)}
              tone={toneForPct(cobros.pctPagosInd)}
              sublabel={`${fmtInt(cobros.pagosConcil)} de ${fmtInt(cobros.pagosInd)} pagos`}
              breakdown={[
                { label: 'Conciliados a banco', value: fmtInt(cobros.pagosConcil), valueColor: 'var(--success)' },
                { label: 'Sin banco', value: fmtInt(cobros.pagosSinBanco), valueColor: 'var(--danger)' },
              ]}
            />
          </div>
        )}

        {/* Desglose por compañía — diagnóstico de 0% de cruce. */}
        {cobros.ciaBreakdown.length > 0 && (
          <div
            className="overflow-hidden rounded-[var(--radius-lg)] border"
            style={{ borderColor: 'var(--gray-200)', background: 'var(--surface)' }}
          >
            <table className="w-full text-[12px]">
              <thead>
                <tr style={{ background: 'var(--gray-50)', color: 'var(--gray-500)' }}>
                  <th className="px-3 py-2 text-left font-medium uppercase tracking-[0.06em]">Compañía</th>
                  <th className="px-3 py-2 text-right font-medium uppercase tracking-[0.06em]">Facturas</th>
                  <th className="px-3 py-2 text-right font-medium uppercase tracking-[0.06em]">ABONOs</th>
                  <th className="px-3 py-2 text-right font-medium uppercase tracking-[0.06em]">Cruces</th>
                  <th className="px-3 py-2 text-right font-medium uppercase tracking-[0.06em]">% Cruce</th>
                </tr>
              </thead>
              <tbody>
                {cobros.ciaBreakdown.map((row) => {
                  const pct = row.abonos > 0 ? (row.matches / row.abonos) * 100 : 0;
                  return (
                    <tr key={row.cia} className="border-t" style={{ borderColor: 'var(--gray-100)' }}>
                      <td className="px-3 py-1.5 font-medium tabular-nums" style={{ color: 'var(--gray-950)' }}>{row.cia}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums" style={{ color: 'var(--gray-700)' }}>{fmtInt(row.facturas)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums" style={{ color: 'var(--gray-700)' }}>{fmtInt(row.abonos)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums" style={{ color: 'var(--gray-700)' }}>{fmtInt(row.matches)}</td>
                      <td
                        className="px-3 py-1.5 text-right font-semibold tabular-nums"
                        style={{ color: pct < 50 ? 'var(--danger)' : pct < 80 ? 'var(--warning)' : 'var(--success)' }}
                      >
                        {fmtPctInt(pct)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── PAGOS ──────────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <ArrowUpCircle className="h-4 w-4" style={{ color: 'var(--danger)' }} aria-hidden />
          <h2 className={SECTION_TITLE} style={{ color: 'var(--gray-700)' }}>
            Pagos · Banco ↔ Pago Proveedor
          </h2>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <KpiCard
            label="Pagos conciliados a banco"
            value={fmtPctInt(pagos.pctConciliado)}
            tone={toneForPct(pagos.pctConciliado)}
            icon={<Banknote className="h-4 w-4" />}
            sublabel={`${fmtInt(pagos.matchedCargo)} de ${fmtInt(pagos.activos)} pagos activos`}
            breakdown={[
              { label: 'Match banco + CXP', value: fmtInt(pagos.matchedFull), valueColor: 'var(--success)' },
              { label: 'Match solo CXP', value: fmtInt(pagos.matchedCxp) },
              { label: 'Match solo banco', value: fmtInt(pagos.matchedCargo) },
            ]}
          />
          <KpiCard
            label="Pagos sin cruce"
            value={fmtInt(pagos.unmatched)}
            tone={pagos.unmatched > 0 ? 'danger' : 'success'}
            icon={<FileWarning className="h-4 w-4" />}
            sublabel={`${fmtKpi(pagos.totalUnmatchedPesos)} sin identificar`}
          />
          <KpiCard
            label="Monto pagado validado"
            value={fmtKpi(pagos.totalPaidPesos)}
            sublabel={`${fmtInt(pagos.payments)} pagos PagoProveedor`}
          />
          <KpiCard
            label="Pagos internos (excluidos)"
            value={fmtInt(pagos.internalPayments)}
            tone="neutral"
            sublabel={`${fmtKpi(pagos.totalInternalPesos)} traspasos entre cuentas propias`}
          />
        </div>
      </section>
    </div>
  );
}
