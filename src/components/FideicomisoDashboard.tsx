import { useMemo, useState } from 'react';
import {
  ShieldCheck, RefreshCw, AlertTriangle, CheckCircle2, ArrowDownLeft, ArrowUpRight,
  Calendar, Banknote, Building2, Info, Loader2,
} from 'lucide-react';
import type { BankAccountStatement, BankStatementLine, CobranzaPayment, CobranzaRecord } from '../services/jde';
import { isBajioStatement } from '../domain/bankStatements';
import { fmtCurrency, fmtCompact, fmtDate } from '../formatters';
import PageHeader from './ui/PageHeader';
import KpiCard from './ui/KpiCard';

/**
 * Fideicomiso (Bajío → DINA → SIR 8436).
 *
 * Regla de negocio:
 *  - CORNING paga 100% de su CXC en la cuenta Bajío de la compañía operadora.
 *  - El día 15 de cada mes, el fideicomiso liquida ~$14.4M a Transportes Logística
 *    Jalisco (DINA) por arrendamiento. Si la cuenta Bajío no alcanza, la operadora
 *    fondea el faltante al fideicomiso; el excedente se regresa a la concentradora
 *    SIR (cuenta termina en 8436).
 *
 * Esta vista consume los mismos endpoints JDE que ya cargan Cobranza y Bancos
 * (no agrega APIs nuevas) — sólo filtra y agrupa: Bajío vs 8436 vs Corning.
 */

const DINA_MONTHLY_OBLIGATION = 14_400_000;
const DINA_PAYMENT_DAY = 15;
const SIR_ACCOUNT_SUFFIX = '8436';
const CORNING_PATTERN = /CORNING/i;
// Concepto típico del SPEI de Corning hacia Bajío:
//   "SPEI Recibido: | Institucion contraparte: BANK OF AMERICA
//    Ordenante: CORNING OPTICAL COMMUNICATIONS Cuenta Orden..."
// También llega de otras entidades del grupo (CORNING SCIENCE MEXICO, etc.),
// así que el patrón captura cualquier ordenante CORNING — Santiago confirmó
// que "todo lo que diga CORNING en Bajío son pagos del cliente Corning".
const CORNING_SPEI_PATTERN = /CORNING/i;
// Conceptos típicos JDE que delatan flujo fideicomiso/Bajío en la concentradora.
const FIDEICOMISO_CONCEPT_PATTERN = /FIDEICOMISO|BAJIO|BAJÍO|REMANENTE|ARRENDAMIENTO|DINA|LOGISTICA JALISCO/i;

function movHaystack(m: BankStatementLine): string {
  return [m.concepto, m.referencia, m.infAdi1, m.infAdi2, m.infAdi3]
    .filter(Boolean).join(' ');
}

function isCorningSpei(m: BankStatementLine): boolean {
  return m.tipoMovimiento === 'ABONO' && CORNING_SPEI_PATTERN.test(movHaystack(m));
}

interface Props {
  bankStatements: BankAccountStatement[];
  cobranzaRecords: CobranzaRecord[];
  cobranzaPayments: CobranzaPayment[];
  companies: { cia: string; nombre: string }[];
  selectedCia: string;
  onRefreshBanks?: () => void;
  onRefreshCobranza?: () => void;
  bankFetchStatus?: 'idle' | 'priming' | 'ranging';
  cobranzaRefreshing?: boolean;
}

function isoToDate(iso: string): Date {
  // Forzar parseo local — `new Date('YYYY-MM-DD')` lo interpreta UTC.
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

function nextPaymentDate(from: Date = new Date()): Date {
  const year = from.getFullYear();
  const month = from.getMonth();
  const candidate = new Date(year, month, DINA_PAYMENT_DAY);
  if (from.getDate() <= DINA_PAYMENT_DAY) return candidate;
  return new Date(year, month + 1, DINA_PAYMENT_DAY);
}

function sameYearMonth(iso: string, ref: Date): boolean {
  const d = isoToDate(iso);
  return d.getFullYear() === ref.getFullYear() && d.getMonth() === ref.getMonth();
}

function lineSignedAmount(m: BankStatementLine): number {
  const abs = Math.abs(m.importe ?? 0);
  return m.tipoMovimiento === 'CARGO' ? -abs : abs;
}

function lineCia(m: BankStatementLine, fallback: string): string {
  return m.cia || fallback;
}

export default function FideicomisoDashboard({
  bankStatements,
  cobranzaRecords,
  cobranzaPayments,
  companies,
  selectedCia,
  onRefreshBanks,
  onRefreshCobranza,
  bankFetchStatus = 'idle',
  cobranzaRefreshing = false,
}: Props) {
  // ── 1. Separar cuentas Bajío vs SIR 8436 ───────────────────────────────
  const { bajioStatements, sirStatements } = useMemo(() => {
    const bajio: BankAccountStatement[] = [];
    const sir: BankAccountStatement[] = [];
    for (const s of bankStatements) {
      if (isBajioStatement(s)) bajio.push(s);
      else if ((s.cuenta ?? '').trim().endsWith(SIR_ACCOUNT_SUFFIX)) sir.push(s);
    }
    return { bajioStatements: bajio, sirStatements: sir };
  }, [bankStatements]);

  // Lista de Cías que pueden estar en el filtro global. Las usamos para mostrar
  // contexto si Bajío aparece bajo más de una compañía.
  const ciaNameByCode = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of companies) map.set(c.cia, c.nombre);
    return map;
  }, [companies]);

  // ── 2. Saldo y movimientos consolidados Bajío ──────────────────────────
  const bajioSummary = useMemo(() => {
    let saldoFinal = 0;
    let saldoInicial = 0;
    let abonosMes = 0;
    let cargosMes = 0;
    let abonosTotal = 0;
    let cargosTotal = 0;
    let corningSpeiMes = 0;
    let corningSpeiTotal = 0;
    let corningSpeiCount = 0;
    let corningSpeiMesCount = 0;
    let latestFecha = '';
    const allMovs: { mov: BankStatementLine; cia: string; cuenta: string; isCorning: boolean }[] = [];
    const today = new Date();
    for (const s of bajioStatements) {
      saldoFinal += s.saldoFinal ?? 0;
      saldoInicial += s.saldoInicial ?? 0;
      if (s.fechaEstadoCuenta > latestFecha) latestFecha = s.fechaEstadoCuenta;
      for (const m of s.movimientos) {
        const isCorning = isCorningSpei(m);
        allMovs.push({ mov: m, cia: lineCia(m, s.cia), cuenta: s.cuenta, isCorning });
        const signed = lineSignedAmount(m);
        if (signed >= 0) abonosTotal += signed;
        else cargosTotal += -signed;
        if (sameYearMonth(m.fechaOperacion, today)) {
          if (signed >= 0) abonosMes += signed;
          else cargosMes += -signed;
        }
        if (isCorning) {
          const amt = Math.abs(m.importe ?? 0);
          corningSpeiTotal += amt;
          corningSpeiCount += 1;
          if (sameYearMonth(m.fechaOperacion, today)) {
            corningSpeiMes += amt;
            corningSpeiMesCount += 1;
          }
        }
      }
    }
    allMovs.sort((a, b) => b.mov.fechaOperacion.localeCompare(a.mov.fechaOperacion));
    return {
      saldoFinal, saldoInicial, abonosMes, cargosMes, abonosTotal, cargosTotal,
      corningSpeiMes, corningSpeiTotal, corningSpeiCount, corningSpeiMesCount,
      latestFecha, allMovs,
    };
  }, [bajioStatements]);

  // ── 3. Cobranza Corning ────────────────────────────────────────────────
  const corningCobranza = useMemo(() => {
    const records = cobranzaRecords.filter(r => CORNING_PATTERN.test(r.nombreCliente ?? ''));
    let pendiente = 0;
    let bruto = 0;
    let cobrado = 0;
    let vencidoPendiente = 0;
    const facturas = records.map(r => {
      pendiente += r.importePendientePesos ?? 0;
      bruto += r.importeBrutoPesos ?? 0;
      if ((r.importePendientePesos ?? 0) > 0 && (r.diasVencida ?? 0) > 0) {
        vencidoPendiente += r.importePendientePesos ?? 0;
      }
      cobrado += (r.importeBrutoPesos ?? 0) - (r.importePendientePesos ?? 0);
      return r;
    });
    facturas.sort((a, b) => (b.fechaVence ?? '').localeCompare(a.fechaVence ?? ''));
    return { facturas, pendiente, bruto, cobrado, vencidoPendiente };
  }, [cobranzaRecords]);

  const corningPayments = useMemo(() => {
    const list = cobranzaPayments.filter(p => CORNING_PATTERN.test(p.cliente ?? ''));
    list.sort((a, b) => (b.fechaCobro ?? '').localeCompare(a.fechaCobro ?? ''));
    return list;
  }, [cobranzaPayments]);

  // ── 4. Próxima obligación día 15 ───────────────────────────────────────
  const obligation = useMemo(() => {
    const next = nextPaymentDate();
    const todayDt = new Date();
    const daysToNext = Math.max(0, Math.ceil((next.getTime() - todayDt.getTime()) / 86_400_000));
    // Saldo proyectado = saldo actual + ABONOs ya registrados hasta hoy del mes en curso.
    // (No proyectamos cobranza futura — el principio es ser conservador.)
    const proyectado = bajioSummary.saldoFinal;
    const faltante = Math.max(0, DINA_MONTHLY_OBLIGATION - proyectado);
    const sobrante = Math.max(0, proyectado - DINA_MONTHLY_OBLIGATION);
    return {
      fechaProxima: next,
      diasRestantes: daysToNext,
      monto: DINA_MONTHLY_OBLIGATION,
      saldoProyectado: proyectado,
      faltante,
      sobrante,
      cubierto: proyectado >= DINA_MONTHLY_OBLIGATION,
    };
  }, [bajioSummary.saldoFinal]);

  // ── 5. Retornos fideicomiso → SIR 8436 ─────────────────────────────────
  const sirReturns = useMemo(() => {
    const today = new Date();
    let abonosMes = 0;
    const movs: { mov: BankStatementLine; cuenta: string; cia: string }[] = [];
    for (const s of sirStatements) {
      for (const m of s.movimientos) {
        if (m.tipoMovimiento !== 'ABONO') continue;
        const concepto = `${m.concepto ?? ''} ${m.referencia ?? ''} ${m.infAdi1 ?? ''} ${m.infAdi2 ?? ''} ${m.infAdi3 ?? ''}`;
        if (!FIDEICOMISO_CONCEPT_PATTERN.test(concepto)) continue;
        movs.push({ mov: m, cuenta: s.cuenta, cia: lineCia(m, s.cia) });
        if (sameYearMonth(m.fechaOperacion, today)) {
          abonosMes += Math.abs(m.importe ?? 0);
        }
      }
    }
    movs.sort((a, b) => b.mov.fechaOperacion.localeCompare(a.mov.fechaOperacion));
    return { movs, abonosMes };
  }, [sirStatements]);

  // ── 6. Pagos a DINA (CARGOs grandes desde Bajío) ───────────────────────
  const dinaPayments = useMemo(() => {
    const items: { mov: BankStatementLine; cuenta: string; cia: string; cerca15: boolean }[] = [];
    for (const s of bajioStatements) {
      for (const m of s.movimientos) {
        if (m.tipoMovimiento !== 'CARGO') continue;
        const importe = Math.abs(m.importe ?? 0);
        if (importe < 1_000_000) continue;
        const d = isoToDate(m.fechaOperacion);
        const cerca15 = Math.abs(d.getDate() - DINA_PAYMENT_DAY) <= 3;
        items.push({ mov: m, cuenta: s.cuenta, cia: lineCia(m, s.cia), cerca15 });
      }
    }
    items.sort((a, b) => b.mov.fechaOperacion.localeCompare(a.mov.fechaOperacion));
    return items;
  }, [bajioStatements]);

  // ── UI ─────────────────────────────────────────────────────────────────
  const [movsTab, setMovsTab] = useState<'bajio' | 'sir' | 'dina'>('bajio');
  const refreshing = bankFetchStatus !== 'idle' || cobranzaRefreshing;

  const hasBajio = bajioStatements.length > 0;
  const hasSir = sirStatements.length > 0;
  const hasCorning = corningCobranza.facturas.length > 0 || corningPayments.length > 0;

  return (
    <div className="space-y-5 animate-page-in">
      <PageHeader
        meta="Operación"
        title="Fideicomiso Bajío → DINA"
        subtitle="Cobranza CORNING en Bajío, obligación mensual a Transportes Logística Jalisco, remanente a concentradora SIR (8436)."
        actions={
          <button
            onClick={() => { onRefreshBanks?.(); onRefreshCobranza?.(); }}
            disabled={refreshing}
            className="inline-flex items-center gap-1.5 rounded-[var(--radius)] border border-white/30 bg-white/10 px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-white/20 disabled:opacity-50"
          >
            {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Actualizar datos
          </button>
        }
      />

      {/* KPIs */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard
          label="Saldo Bajío"
          value={fmtCompact(bajioSummary.saldoFinal)}
          icon={<Banknote className="h-4 w-4" />}
          sublabel={
            hasBajio
              ? bajioSummary.latestFecha
                ? `Al ${fmtDate(bajioSummary.latestFecha)}`
                : `${bajioStatements.length} cuenta(s)`
              : 'Sin estados de cuenta Bajío'
          }
        />
        <KpiCard
          label="SPEI Corning del mes"
          value={fmtCompact(bajioSummary.corningSpeiMes)}
          icon={<ArrowDownLeft className="h-4 w-4" />}
          color="var(--success)"
          sublabel={
            bajioSummary.corningSpeiMesCount > 0
              ? `${bajioSummary.corningSpeiMesCount} SPEI Ordenante CORNING este mes`
              : `Histórico cargado: ${fmtCompact(bajioSummary.corningSpeiTotal)} · ${bajioSummary.corningSpeiCount} SPEI`
          }
          breakdown={
            bajioSummary.abonosTotal > bajioSummary.corningSpeiTotal
              ? [
                  { label: 'Total ABONOs Bajío (histórico)', value: fmtCompact(bajioSummary.abonosTotal) },
                  {
                    label: 'Otros (no-Corning)',
                    value: fmtCompact(bajioSummary.abonosTotal - bajioSummary.corningSpeiTotal),
                  },
                ]
              : undefined
          }
        />
        <KpiCard
          label="Obligación DINA día 15"
          value={fmtCompact(obligation.monto)}
          icon={<Calendar className="h-4 w-4" />}
          sublabel={`Próximo: ${fmtDate(obligation.fechaProxima)} · en ${obligation.diasRestantes}d`}
        />
        <KpiCard
          label={obligation.cubierto ? 'Sobrante a SIR (8436)' : 'Faltante a depositar'}
          value={fmtCompact(obligation.cubierto ? obligation.sobrante : obligation.faltante)}
          icon={obligation.cubierto ? <CheckCircle2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
          color={obligation.cubierto ? 'var(--success)' : 'var(--danger)'}
          tone={obligation.cubierto ? 'neutral' : 'warning'}
          sublabel={
            obligation.cubierto
              ? 'Excedente proyectado a regresar'
              : 'Operadora debe fondear fideicomiso'
          }
        />
      </div>

      {/* Próxima obligación — tarjeta detallada */}
      <section
        className="rounded-[var(--radius-lg)] border bg-white p-5"
        style={{ borderColor: 'var(--gray-200)' }}
      >
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <ShieldCheck className="h-4 w-4" style={{ color: 'var(--brand)' }} />
              <h2 className="text-[14px] font-semibold" style={{ color: 'var(--gray-950)' }}>
                Próxima obligación del fideicomiso
              </h2>
            </div>
            <p className="text-[12px] leading-snug" style={{ color: 'var(--gray-500)' }}>
              Pago de arrendamiento a Transportes Logística Jalisco (DINA). Si el saldo Bajío no
              alcanza, la operadora deposita el faltante al fideicomiso; el remanente regresa a SIR.
            </p>
          </div>
          <div
            className="text-right rounded-[var(--radius)] border px-3 py-2"
            style={{ borderColor: 'var(--gray-200)', background: 'var(--gray-50)' }}
          >
            <p className="text-[10px] uppercase tracking-[0.06em] font-medium" style={{ color: 'var(--gray-500)' }}>Fecha</p>
            <p className="text-[14px] font-semibold tabular-nums" style={{ color: 'var(--gray-950)' }}>
              {fmtDate(obligation.fechaProxima)}
            </p>
            <p className="text-[11px]" style={{ color: 'var(--gray-500)' }}>en {obligation.diasRestantes} días</p>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-3">
          <ObligationStat label="Obligación" value={fmtCurrency(obligation.monto)} />
          <ObligationStat
            label="Saldo Bajío hoy"
            value={fmtCurrency(obligation.saldoProyectado)}
            color={obligation.cubierto ? 'var(--success)' : 'var(--danger)'}
          />
          <ObligationStat
            label={obligation.cubierto ? 'Sobrante a SIR (8436)' : 'Faltante a depositar'}
            value={fmtCurrency(obligation.cubierto ? obligation.sobrante : obligation.faltante)}
            color={obligation.cubierto ? 'var(--success)' : 'var(--danger)'}
            emphasis
          />
        </div>
        {!hasBajio && (
          <p className="mt-3 inline-flex items-start gap-2 rounded-[var(--radius)] border border-dashed px-3 py-2 text-[12px]"
             style={{ borderColor: 'var(--gray-300)', color: 'var(--gray-500)' }}>
            <Info className="h-3.5 w-3.5 mt-0.5" />
            No hay estado de cuenta Bajío cargado. Pulsa "Actualizar datos" para traer el último corte de JDE.
          </p>
        )}
      </section>

      {/* Cobranza CORNING */}
      <section
        className="rounded-[var(--radius-lg)] border bg-white p-5"
        style={{ borderColor: 'var(--gray-200)' }}
      >
        <div className="flex items-start justify-between gap-4 mb-3 flex-wrap">
          <div>
            <h2 className="text-[14px] font-semibold mb-0.5" style={{ color: 'var(--gray-950)' }}>
              CORNING — Cobranza JDE
            </h2>
            <p className="text-[12px]" style={{ color: 'var(--gray-500)' }}>
              Facturas y pagos del único cliente que abona en Bajío.
            </p>
          </div>
          <div className="flex gap-4">
            <MiniStat label="Facturas" value={String(corningCobranza.facturas.length)} />
            <MiniStat label="Pendiente" value={fmtCompact(corningCobranza.pendiente)} color="var(--warning)" />
            <MiniStat label="Cobrado" value={fmtCompact(corningCobranza.cobrado)} color="var(--success)" />
            <MiniStat label="Vencido" value={fmtCompact(corningCobranza.vencidoPendiente)} color="var(--danger)" />
          </div>
        </div>

        {hasCorning ? (
          <div className="overflow-x-auto -mx-1">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="text-left" style={{ color: 'var(--gray-500)' }}>
                  <th className="py-1.5 px-2 font-medium">Factura</th>
                  <th className="py-1.5 px-2 font-medium">Cía</th>
                  <th className="py-1.5 px-2 font-medium">Emisión</th>
                  <th className="py-1.5 px-2 font-medium">Vence</th>
                  <th className="py-1.5 px-2 font-medium text-right">Bruto</th>
                  <th className="py-1.5 px-2 font-medium text-right">Pendiente</th>
                  <th className="py-1.5 px-2 font-medium text-right">Días</th>
                </tr>
              </thead>
              <tbody>
                {corningCobranza.facturas.slice(0, 25).map((r, idx) => {
                  const vencida = (r.diasVencida ?? 0) > 0 && (r.importePendientePesos ?? 0) > 0;
                  return (
                    <tr key={`${r.cia}-${r.noFactura}-${idx}`} className="border-t" style={{ borderColor: 'var(--gray-100)' }}>
                      <td className="py-1.5 px-2 font-medium tabular-nums" style={{ color: 'var(--gray-950)' }}>{r.noFactura}</td>
                      <td className="py-1.5 px-2" style={{ color: 'var(--gray-700)' }}>{ciaNameByCode.get(r.cia) ?? r.cia}</td>
                      <td className="py-1.5 px-2 tabular-nums" style={{ color: 'var(--gray-700)' }}>{r.fechaFactura ? fmtDate(r.fechaFactura) : '—'}</td>
                      <td className="py-1.5 px-2 tabular-nums" style={{ color: 'var(--gray-700)' }}>{r.fechaVence ? fmtDate(r.fechaVence) : '—'}</td>
                      <td className="py-1.5 px-2 text-right tabular-nums" style={{ color: 'var(--gray-700)' }}>{fmtCurrency(r.importeBrutoPesos ?? 0)}</td>
                      <td className="py-1.5 px-2 text-right tabular-nums font-medium"
                          style={{ color: vencida ? 'var(--danger)' : 'var(--gray-950)' }}>
                        {fmtCurrency(r.importePendientePesos ?? 0)}
                      </td>
                      <td className="py-1.5 px-2 text-right tabular-nums"
                          style={{ color: vencida ? 'var(--danger)' : 'var(--gray-500)' }}>
                        {r.diasVencida ?? 0}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {corningCobranza.facturas.length > 25 && (
              <p className="mt-2 text-[11px]" style={{ color: 'var(--gray-500)' }}>
                Mostrando 25 de {corningCobranza.facturas.length} facturas — ver detalle completo en Cobranza.
              </p>
            )}
          </div>
        ) : (
          <EmptyState
            icon={<Building2 className="h-4 w-4" />}
            text="No hay cobranza CORNING en el cache. Carga /cobranza desde JDE."
          />
        )}
      </section>

      {/* Movimientos: Bajío / Pagos DINA / Retornos SIR */}
      <section
        className="rounded-[var(--radius-lg)] border bg-white p-5"
        style={{ borderColor: 'var(--gray-200)' }}
      >
        <div className="flex items-center justify-between gap-4 mb-3 flex-wrap">
          <div>
            <h2 className="text-[14px] font-semibold mb-0.5" style={{ color: 'var(--gray-950)' }}>
              Movimientos del fideicomiso
            </h2>
            <p className="text-[12px]" style={{ color: 'var(--gray-500)' }}>
              Bancos JDE: entradas Bajío (Corning), pagos a DINA, retornos a SIR 8436.
            </p>
          </div>
          <div className="inline-flex rounded-[var(--radius)] border p-0.5 text-[12px]" style={{ borderColor: 'var(--gray-200)' }}>
            <TabBtn active={movsTab === 'bajio'} onClick={() => setMovsTab('bajio')}>Bajío ({bajioSummary.allMovs.length})</TabBtn>
            <TabBtn active={movsTab === 'dina'} onClick={() => setMovsTab('dina')}>Pagos DINA ({dinaPayments.length})</TabBtn>
            <TabBtn active={movsTab === 'sir'} onClick={() => setMovsTab('sir')}>Retornos SIR ({sirReturns.movs.length})</TabBtn>
          </div>
        </div>

        {movsTab === 'bajio' && (
          hasBajio
            ? <MovementTable rows={bajioSummary.allMovs.slice(0, 30).map(({ mov, cia, cuenta, isCorning }) => ({
                fecha: mov.fechaOperacion,
                concepto: mov.concepto || mov.referencia || '—',
                referencia: mov.referencia,
                cuenta,
                cia: ciaNameByCode.get(cia) ?? cia,
                tipo: mov.tipoMovimiento,
                importe: lineSignedAmount(mov),
                badge: isCorning ? 'CORNING' : undefined,
                badgeTone: isCorning ? 'success' : undefined,
              }))} />
            : <EmptyState icon={<Banknote className="h-4 w-4" />} text="Sin movimientos Bajío cargados." />
        )}

        {movsTab === 'dina' && (
          dinaPayments.length > 0
            ? <MovementTable rows={dinaPayments.slice(0, 30).map(({ mov, cia, cuenta, cerca15 }) => ({
                fecha: mov.fechaOperacion,
                concepto: mov.concepto || mov.referencia || '—',
                referencia: mov.referencia,
                cuenta,
                cia: ciaNameByCode.get(cia) ?? cia,
                tipo: mov.tipoMovimiento,
                importe: lineSignedAmount(mov),
                badge: cerca15 ? 'Día 15' : undefined,
              }))} />
            : <EmptyState
                icon={<ArrowUpRight className="h-4 w-4" />}
                text="No se detectaron CARGOs ≥ $1M en Bajío. Si el pago a DINA ya ocurrió, debe aparecer aquí."
              />
        )}

        {movsTab === 'sir' && (
          hasSir
            ? sirReturns.movs.length > 0
              ? <MovementTable rows={sirReturns.movs.slice(0, 30).map(({ mov, cia, cuenta }) => ({
                  fecha: mov.fechaOperacion,
                  concepto: mov.concepto || mov.referencia || '—',
                  referencia: mov.referencia,
                  cuenta,
                  cia: ciaNameByCode.get(cia) ?? cia,
                  tipo: mov.tipoMovimiento,
                  importe: lineSignedAmount(mov),
                }))} />
              : <EmptyState
                  icon={<ArrowDownLeft className="h-4 w-4" />}
                  text="Cuenta 8436 cargada, pero no se detectaron retornos de fideicomiso recientes."
                />
            : <EmptyState
                icon={<ArrowDownLeft className="h-4 w-4" />}
                text={`Sin estados de cuenta para SIR (cuenta terminada en ${SIR_ACCOUNT_SUFFIX}).`}
              />
        )}
      </section>

      {/* Pagos recientes Corning (CobranzaIndicadores) */}
      {corningPayments.length > 0 && (
        <section
          className="rounded-[var(--radius-lg)] border bg-white p-5"
          style={{ borderColor: 'var(--gray-200)' }}
        >
          <h2 className="text-[14px] font-semibold mb-1" style={{ color: 'var(--gray-950)' }}>
            Pagos CORNING aplicados (JDE Indicadores)
          </h2>
          <p className="text-[12px] mb-3" style={{ color: 'var(--gray-500)' }}>
            Recibos por cuenta bancaria — confirma cuándo el dinero efectivamente cae en Bajío.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead>
                <tr className="text-left" style={{ color: 'var(--gray-500)' }}>
                  <th className="py-1.5 px-2 font-medium">Id Pago</th>
                  <th className="py-1.5 px-2 font-medium">Fecha cobro</th>
                  <th className="py-1.5 px-2 font-medium">Banco</th>
                  <th className="py-1.5 px-2 font-medium">Cuenta</th>
                  <th className="py-1.5 px-2 font-medium text-right">Importe</th>
                  <th className="py-1.5 px-2 font-medium text-right">Pte. aplicar</th>
                </tr>
              </thead>
              <tbody>
                {corningPayments.slice(0, 15).map(p => (
                  <tr key={p.idPago} className="border-t" style={{ borderColor: 'var(--gray-100)' }}>
                    <td className="py-1.5 px-2 tabular-nums" style={{ color: 'var(--gray-950)' }}>{p.idPago}</td>
                    <td className="py-1.5 px-2 tabular-nums" style={{ color: 'var(--gray-700)' }}>{p.fechaCobro ? fmtDate(p.fechaCobro) : '—'}</td>
                    <td className="py-1.5 px-2" style={{ color: 'var(--gray-700)' }}>{p.banco}</td>
                    <td className="py-1.5 px-2 tabular-nums" style={{ color: 'var(--gray-700)' }}>{p.cuentaBancaria}</td>
                    <td className="py-1.5 px-2 text-right tabular-nums font-medium" style={{ color: 'var(--gray-950)' }}>{fmtCurrency(p.importeRecibo)}</td>
                    <td className="py-1.5 px-2 text-right tabular-nums" style={{ color: p.pendienteAplicar > 0 ? 'var(--warning)' : 'var(--gray-500)' }}>
                      {fmtCurrency(p.pendienteAplicar)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <p className="text-[11px]" style={{ color: 'var(--gray-500)' }}>
        Fuente: JDE Orchestrator · /bancos (Bajío y cuenta {SIR_ACCOUNT_SUFFIX}), /cobranza y /cobranzaindicadores (CORNING).
        Cía global: <strong>{selectedCia === 'all' ? 'Todas' : (ciaNameByCode.get(selectedCia) ?? selectedCia)}</strong>.
      </p>
    </div>
  );
}

function ObligationStat({ label, value, color, emphasis }: { label: string; value: string; color?: string; emphasis?: boolean }) {
  return (
    <div
      className="rounded-[var(--radius)] border p-3"
      style={{
        borderColor: emphasis ? (color ?? 'var(--gray-200)') : 'var(--gray-200)',
        background: emphasis ? 'color-mix(in oklch, ' + (color ?? 'var(--gray-200)') + ' 8%, white)' : 'white',
      }}
    >
      <p className="text-[10px] uppercase tracking-[0.06em] font-medium" style={{ color: 'var(--gray-500)' }}>{label}</p>
      <p className="mt-1 text-[18px] font-bold tabular-nums" style={{ color: color ?? 'var(--gray-950)' }}>{value}</p>
    </div>
  );
}

function MiniStat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="text-right">
      <p className="text-[10px] uppercase tracking-[0.06em] font-medium" style={{ color: 'var(--gray-500)' }}>{label}</p>
      <p className="text-[14px] font-semibold tabular-nums" style={{ color: color ?? 'var(--gray-950)' }}>{value}</p>
    </div>
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="rounded-[calc(var(--radius)-2px)] px-2.5 py-1 text-[12px] font-medium transition-colors"
      style={
        active
          ? { background: 'var(--brand)', color: 'white' }
          : { color: 'var(--gray-700)' }
      }
    >
      {children}
    </button>
  );
}

function EmptyState({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div
      className="rounded-[var(--radius)] border border-dashed px-4 py-6 text-center text-[12px] flex flex-col items-center gap-2"
      style={{ borderColor: 'var(--gray-300)', color: 'var(--gray-500)' }}
    >
      <span style={{ color: 'var(--gray-400)' }}>{icon}</span>
      {text}
    </div>
  );
}

interface MovementRow {
  fecha: string;
  concepto: string;
  referencia?: string;
  cuenta: string;
  cia: string;
  tipo: string;
  importe: number;
  badge?: string;
  badgeTone?: 'success' | 'warning' | 'info';
}

function MovementTable({ rows }: { rows: MovementRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12px]">
        <thead>
          <tr className="text-left" style={{ color: 'var(--gray-500)' }}>
            <th className="py-1.5 px-2 font-medium">Fecha</th>
            <th className="py-1.5 px-2 font-medium">Concepto</th>
            <th className="py-1.5 px-2 font-medium">Referencia</th>
            <th className="py-1.5 px-2 font-medium">Cía</th>
            <th className="py-1.5 px-2 font-medium">Cuenta</th>
            <th className="py-1.5 px-2 font-medium text-right">Importe</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, idx) => (
            <tr key={idx} className="border-t" style={{ borderColor: 'var(--gray-100)' }}>
              <td className="py-1.5 px-2 tabular-nums" style={{ color: 'var(--gray-700)' }}>{fmtDate(r.fecha)}</td>
              <td className="py-1.5 px-2" style={{ color: 'var(--gray-950)' }}>
                <span className="truncate">{r.concepto}</span>
                {r.badge && (
                  <span
                    className="ml-2 inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium"
                    style={
                      r.badgeTone === 'success'
                        ? { background: 'color-mix(in oklch, var(--success) 12%, white)', color: 'var(--success)' }
                        : r.badgeTone === 'info'
                          ? { background: 'color-mix(in oklch, var(--brand) 12%, white)', color: 'var(--brand)' }
                          : { background: 'var(--warning-muted)', color: 'var(--warning)' }
                    }
                  >
                    {r.badge}
                  </span>
                )}
              </td>
              <td className="py-1.5 px-2 tabular-nums" style={{ color: 'var(--gray-500)' }}>{r.referencia || '—'}</td>
              <td className="py-1.5 px-2" style={{ color: 'var(--gray-700)' }}>{r.cia}</td>
              <td className="py-1.5 px-2 tabular-nums" style={{ color: 'var(--gray-700)' }}>{r.cuenta}</td>
              <td className="py-1.5 px-2 text-right tabular-nums font-medium"
                  style={{ color: r.importe >= 0 ? 'var(--success)' : 'var(--danger)' }}>
                {r.importe >= 0 ? '+' : ''}{fmtCurrency(r.importe)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
