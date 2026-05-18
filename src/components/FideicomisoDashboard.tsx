import { useMemo } from 'react';
import {
  ShieldCheck, RefreshCw, AlertTriangle, CheckCircle2, ArrowDownLeft,
  Calendar, Banknote, Info, Loader2,
} from 'lucide-react';
import type { BankAccountStatement } from '../services/jde';
import { bankStatementBalance, isBajioStatement, isCorningAbono } from '../domain/bankStatements';
import { fmtCurrency, fmtCompact, fmtDate } from '../formatters';
import PageHeader from './ui/PageHeader';
import KpiCard from './ui/KpiCard';
import { DINA_MONTHLY_OBLIGATION, DINA_PAYMENT_DAY } from '../config/fideicomiso.config';

/**
 * Fideicomiso Dina — termómetro mensual.
 *
 * Regla de negocio: CORNING deposita en la cuenta BanBajío de la operadora.
 * El día 15 el fideicomiso le paga el arrendamiento a DINA (Transportes
 * Logística Jalisco). Este módulo responde SOLO tres cosas para el tesorero:
 *   1. ¿Cuánto depositó Corning en Bajío este mes?
 *   2. ¿Cuánto hay en caja hoy?
 *   3. ¿Alcanza para pagarle a DINA, o Romo tiene que fondear de otras
 *      cuentas con movimientos internos?
 *
 * Consume sólo /bancos (cuenta Bajío). No usa cobranza JDE ni movimientos
 * detallados — el termómetro es el dinero REAL que cae en el banco.
 */

interface Props {
  bankStatements: BankAccountStatement[];
  companies: { cia: string; nombre: string }[];
  selectedCia: string;
  onRefreshBanks?: () => void;
  bankFetchStatus?: 'idle' | 'priming' | 'ranging';
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

export default function FideicomisoDashboard({
  bankStatements,
  companies,
  selectedCia,
  onRefreshBanks,
  bankFetchStatus = 'idle',
}: Props) {
  const bajioStatements = useMemo(
    () => bankStatements.filter(isBajioStatement),
    [bankStatements],
  );

  const ciaNameByCode = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of companies) map.set(c.cia, c.nombre);
    return map;
  }, [companies]);

  // Saldo actual en caja + lo que Corning depositó ESTE mes en Bajío.
  const summary = useMemo(() => {
    let saldoActual = 0;
    let corningMes = 0;
    let corningMesCount = 0;
    let latestFecha = '';
    const today = new Date();
    for (const s of bajioStatements) {
      // No usar `s.saldoFinal ?? 0`: el centinela BANBAJIO suele traer
      // Saldo_Final 0/null (sub-cuentas que se cancelan). bankStatementBalance
      // recupera el saldo real (saldoInicial + Σmov) igual que la pestaña
      // Bancos — si no, el termómetro muestra $0 con 6M reales en caja.
      saldoActual += bankStatementBalance(s);
      if (s.fechaEstadoCuenta > latestFecha) latestFecha = s.fechaEstadoCuenta;
      for (const m of s.movimientos) {
        if (isCorningAbono(m) && sameYearMonth(m.fechaOperacion, today)) {
          corningMes += Math.abs(m.importe ?? 0);
          corningMesCount += 1;
        }
      }
    }
    return { saldoActual, corningMes, corningMesCount, latestFecha };
  }, [bajioStatements]);

  // ¿Alcanza el saldo para la obligación del mes a DINA?
  const obligation = useMemo(() => {
    const next = nextPaymentDate();
    const todayDt = new Date();
    const dias = Math.max(0, Math.ceil((next.getTime() - todayDt.getTime()) / 86_400_000));
    const monto = DINA_MONTHLY_OBLIGATION;
    const saldo = summary.saldoActual;
    const cubierto = saldo >= monto;
    return {
      fechaProxima: next,
      diasRestantes: dias,
      monto,
      saldo,
      faltante: Math.max(0, monto - saldo),
      sobrante: Math.max(0, saldo - monto),
      cubierto,
      cobertura: monto > 0 ? Math.min(1, Math.max(0, saldo / monto)) : 1,
    };
  }, [summary.saldoActual]);

  const refreshing = bankFetchStatus !== 'idle';
  const hasBajio = bajioStatements.length > 0;

  return (
    <div className="space-y-5 animate-page-in">
      <PageHeader
        meta="Operación"
        title="Fideicomiso Dina"
        subtitle="Termómetro del mes: lo que Corning deposita en la cuenta BanBajío vs. la obligación a DINA. Saldo actual en caja y si alcanza para el pago del día 15."
        actions={
          <button
            onClick={() => onRefreshBanks?.()}
            disabled={refreshing}
            className="inline-flex items-center gap-1.5 rounded-[var(--radius)] border border-white/30 bg-white/10 px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-white/20 disabled:opacity-50"
          >
            {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Actualizar datos
          </button>
        }
      />

      {/* El termómetro en 4 números */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard
          label="Obligación DINA (mes)"
          value={fmtCompact(obligation.monto)}
          icon={<Calendar className="h-4 w-4" />}
          sublabel={`Pago día ${DINA_PAYMENT_DAY} · ${fmtDate(obligation.fechaProxima)} · en ${obligation.diasRestantes}d`}
        />
        <KpiCard
          label="Corning recibido este mes"
          value={fmtCompact(summary.corningMes)}
          icon={<ArrowDownLeft className="h-4 w-4" />}
          color="var(--success)"
          sublabel={
            summary.corningMesCount > 0
              ? `${summary.corningMesCount} depósito(s) Corning en Bajío`
              : 'Sin depósitos Corning este mes'
          }
        />
        <KpiCard
          label="Saldo actual en caja (Bajío)"
          value={fmtCompact(summary.saldoActual)}
          icon={<Banknote className="h-4 w-4" />}
          sublabel={
            hasBajio
              ? summary.latestFecha
                ? `Al ${fmtDate(summary.latestFecha)}`
                : `${bajioStatements.length} cuenta(s)`
              : 'Sin estado de cuenta Bajío'
          }
        />
        <KpiCard
          label={obligation.cubierto ? 'Alcanza para el pago' : 'Falta para el pago'}
          value={fmtCompact(obligation.cubierto ? obligation.sobrante : obligation.faltante)}
          icon={obligation.cubierto ? <CheckCircle2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
          color={obligation.cubierto ? 'var(--success)' : 'var(--danger)'}
          tone={obligation.cubierto ? 'neutral' : 'warning'}
          sublabel={obligation.cubierto ? 'Sobrante tras pagar DINA' : 'Romo debe fondear de otras cuentas'}
        />
      </div>

      {/* Termómetro visual + cierre */}
      <section
        className="rounded-[var(--radius-lg)] border p-5 skeuo-brackets skeuo-brackets-deep"
        data-skeuo-card="fideicomiso"
        style={{ borderColor: 'var(--gray-200)' }}
      >
        <div className="flex items-start justify-between gap-4 flex-wrap mb-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <ShieldCheck className="h-4 w-4" style={{ color: 'var(--brand)' }} />
              <h2 className="text-[14px] font-semibold" style={{ color: 'var(--gray-950)' }}>
                ¿Alcanza para pagarle a DINA?
              </h2>
            </div>
            <p className="text-[12px] leading-snug" style={{ color: 'var(--gray-500)' }}>
              Saldo actual en la cuenta Bajío contra la obligación mensual del fideicomiso.
              Si no alcanza, hay que fondear de otras cuentas antes del día {DINA_PAYMENT_DAY}.
            </p>
          </div>
          <div
            className="text-right rounded-[var(--radius)] border px-3 py-2"
            style={{ borderColor: 'var(--gray-200)', background: 'var(--gray-50)' }}
          >
            <p className="text-[10px] uppercase tracking-[0.06em] font-medium" style={{ color: 'var(--gray-500)' }}>Próximo pago</p>
            <p className="text-[14px] font-semibold tabular-nums" style={{ color: 'var(--gray-950)' }}>
              {fmtDate(obligation.fechaProxima)}
            </p>
            <p className="text-[11px]" style={{ color: 'var(--gray-500)' }}>en {obligation.diasRestantes} días</p>
          </div>
        </div>

        {/* Barra termómetro: saldo vs obligación */}
        <div className="mb-4">
          <div className="h-3 w-full rounded-full overflow-hidden" style={{ background: 'var(--gray-100)' }}>
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: `${(obligation.cobertura * 100).toFixed(1)}%`,
                background: obligation.cubierto ? 'var(--success)' : 'var(--danger)',
              }}
            />
          </div>
          <div className="mt-1 flex justify-between text-[11px]" style={{ color: 'var(--gray-500)' }}>
            <span>{(obligation.cobertura * 100).toFixed(0)}% cubierto</span>
            <span>Meta: {fmtCurrency(obligation.monto)}</span>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <ObligationStat label="Obligación DINA" value={fmtCurrency(obligation.monto)} />
          <ObligationStat
            label="Saldo en caja hoy"
            value={fmtCurrency(obligation.saldo)}
            color={obligation.cubierto ? 'var(--success)' : 'var(--danger)'}
          />
          <ObligationStat
            label={obligation.cubierto ? 'Sobrante' : 'Faltante por fondear'}
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

      <p className="text-[11px]" style={{ color: 'var(--gray-500)' }}>
        Fuente: JDE Orchestrator · /bancos (cuenta Bajío).
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
