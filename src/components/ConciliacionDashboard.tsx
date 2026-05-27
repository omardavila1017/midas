import { useMemo, useState } from 'react';
import { AlertTriangle, ArrowDownCircle, ArrowUpCircle, Banknote, FileWarning, Wallet } from 'lucide-react';
import PageHeader from './ui/PageHeader';
import { KpiCard, type KpiCardProps } from './ui/KpiCard';
import { fmtInt, fmtKpi, fmtPctInt } from '../formatters';
import type {
  AuxiliarInconsistency,
  AuxiliarInconsistencyKind,
  AuxiliarReconResult,
} from '../domain/auxiliarReconciliationEngine';
import type { Company } from '../services/jdeTypes';
import ConciliacionOrphansDrilldown from './ConciliacionOrphansDrilldown';

const INCONSISTENCY_LABELS: Record<AuxiliarInconsistencyKind, string> = {
  'non-bank-batch-in-1020': 'Tipo_Batch fuera de bancos en cuenta 1020',
};

function InconsistenciesSection({ list }: { list: AuxiliarInconsistency[] }) {
  if (list.length === 0) return null;
  const grouped = new Map<AuxiliarInconsistencyKind, AuxiliarInconsistency[]>();
  for (const inc of list) {
    const bucket = grouped.get(inc.kind);
    if (bucket) bucket.push(inc);
    else grouped.set(inc.kind, [inc]);
  }
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <AlertTriangle className="h-4 w-4" style={{ color: 'var(--danger)' }} aria-hidden />
        <h2 className={SECTION_TITLE} style={{ color: 'var(--gray-700)' }}>
          Inconsistencias críticas
        </h2>
        <span className="text-[12px]" style={{ color: 'var(--gray-500)' }}>
          {fmtInt(list.length)} eventos
        </span>
      </div>
      <div
        className="rounded-[var(--radius-lg)] border divide-y"
        style={{
          borderColor: 'color-mix(in oklch, var(--danger) 25%, var(--gray-200))',
          background: 'var(--card)',
        }}
      >
        {Array.from(grouped.entries()).map(([kind, items]) => (
          <div key={kind} className="p-3 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[13px] font-semibold" style={{ color: 'var(--gray-800)' }}>
                {INCONSISTENCY_LABELS[kind]}
              </span>
              <span
                className="rounded-full px-2 py-0.5 text-[12px] font-semibold"
                style={{
                  background: 'color-mix(in oklch, var(--danger) 14%, transparent)',
                  color: 'var(--danger)',
                }}
              >
                {fmtInt(items.length)}
              </span>
            </div>
            <ul className="space-y-1 text-[12px]" style={{ color: 'var(--gray-600)' }}>
              {items.slice(0, 5).map((inc, i) => (
                <li key={`${inc.ref}-${i}`}>
                  <span
                    className="font-mono text-[11px] mr-2"
                    style={{ color: 'var(--gray-500)' }}
                  >
                    {inc.cia}
                  </span>
                  {inc.detail}
                </li>
              ))}
              {items.length > 5 && (
                <li style={{ color: 'var(--gray-500)' }}>
                  …y {fmtInt(items.length - 5)} más
                </li>
              )}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * Conciliación — cruce del libro mayor JDE (AuxiliarContable, objeto
 * 1010-1020) contra el estado de cuenta bancario.
 *
 * Panel de diagnóstico de SOLO KPIs: muestra qué tan bien cruza cada lado
 * (ingresos y egresos), cuántas líneas conciló JDE por su cuenta, y los
 * puntos a revisar (líneas GL sin movimiento bancario, movimientos
 * bancarios sin asiento, y caja sin estado de cuenta).
 */
interface Props {
  reconciliation: AuxiliarReconResult;
  companies?: Company[];
}

/** Tono por porcentaje de cruce: <50 rojo, <80 ámbar, ≥80 verde. */
function toneForPct(pct: number): KpiCardProps['tone'] {
  if (pct < 50) return 'danger';
  if (pct < 80) return 'warning';
  return 'success';
}

const SECTION_TITLE = 'text-[13px] font-bold uppercase tracking-[0.08em]';

export default function ConciliacionDashboard({ reconciliation, companies }: Props) {
  const s = reconciliation.summary;
  const [drilldownFlujo, setDrilldownFlujo] = useState<'ingreso' | 'egreso' | null>(null);

  /** Lookup cía → razón social. La tabla de breakdown muestra el nombre como
   *  título primario y deja el código como subtítulo para deshacer ambigüedad
   *  (dos cías pueden compartir nombre comercial). Fallback al código si la
   *  cía no está en el catálogo cargado.
   *
   *  El API JDE entrega `nombre` ya combinado como "00001 - TRANSPORTES..."
   *  (código + separador + razón social). Para no duplicar el código en
   *  título y subtítulo, removemos el prefijo `${cia}[- |]` si existe. */
  const ciaNameByCode = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of companies ?? []) {
      if (!c.cia || !c.nombre) continue;
      const stripped = c.nombre.replace(new RegExp(`^${c.cia}\\s*[-|·]?\\s*`), '').trim();
      m.set(c.cia, stripped || c.nombre);
    }
    return m;
  }, [companies]);

  const vacio = useMemo(
    () => s.totalLineas === 0 && s.bankOrphanLineas === 0,
    [s],
  );

  return (
    <div className="space-y-8">
      <PageHeader
        title="Conciliación"
        meta="Diagnóstico"
        subtitle="Cruce del libro mayor JDE (AuxiliarContable) contra el estado de cuenta bancario. Solo KPIs."
      />

      {vacio && (
        <div
          className="rounded-[var(--radius-lg)] border p-4 text-[13px]"
          style={{
            borderColor: 'color-mix(in oklch, var(--warning) 30%, var(--gray-200))',
            background: 'var(--warning-muted)',
            color: 'var(--gray-700)',
          }}
        >
          La conciliación aún no ha corrido (0 líneas del auxiliar contable).
          Espera a que termine la carga de AuxiliarContable + bancos, o revisa
          que los datos estén sincronizados.
        </div>
      )}

      <InconsistenciesSection list={reconciliation.inconsistencies} />

      {/* ── INGRESOS ───────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <ArrowDownCircle className="h-4 w-4" style={{ color: 'var(--success)' }} aria-hidden />
          <h2 className={SECTION_TITLE} style={{ color: 'var(--gray-700)' }}>
            Ingresos · Libro mayor ↔ Banco
          </h2>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <KpiCard
            label="Ingresos cruzados a banco"
            value={fmtPctInt(s.pctIngresoCruzado)}
            tone={toneForPct(s.pctIngresoCruzado)}
            icon={<Banknote className="h-4 w-4" />}
            sublabel={`${fmtInt(s.ingresoCruzadas)} de ${fmtInt(s.ingresoLineas)} líneas de ingreso`}
            breakdown={[
              { label: 'Cruzadas', value: fmtInt(s.ingresoCruzadas), valueColor: 'var(--success)' },
              { label: 'Sin movimiento bancario', value: fmtInt(s.ingresoLineas - s.ingresoCruzadas), valueColor: 'var(--danger)' },
            ]}
            onClick={s.ingresoLineas > s.ingresoCruzadas ? () => setDrilldownFlujo('ingreso') : undefined}
            navHint="Ver líneas sin cruce"
          />
          <KpiCard
            label="Monto ingresos (libro mayor)"
            value={fmtKpi(s.ingresoMonto)}
            sublabel={`${fmtKpi(s.ingresoMontoCruzado)} validado en banco`}
          />
          <KpiCard
            label="Conciliadas por JDE"
            value={fmtInt(s.conciliadasJde)}
            tone="neutral"
            sublabel="líneas con estatus 'R' en el ERP"
          />
          <KpiCard
            label="Traspasos internos"
            value={fmtInt(s.internoLineas)}
            tone="neutral"
            sublabel={`${fmtKpi(s.internoMonto)} entre cuentas propias`}
          />
        </div>
      </section>

      {/* ── EGRESOS ────────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <ArrowUpCircle className="h-4 w-4" style={{ color: 'var(--danger)' }} aria-hidden />
          <h2 className={SECTION_TITLE} style={{ color: 'var(--gray-700)' }}>
            Egresos · Libro mayor ↔ Banco
          </h2>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <KpiCard
            label="Egresos cruzados a banco"
            value={fmtPctInt(s.pctEgresoCruzado)}
            tone={toneForPct(s.pctEgresoCruzado)}
            icon={<Banknote className="h-4 w-4" />}
            sublabel={`${fmtInt(s.egresoCruzadas)} de ${fmtInt(s.egresoLineas)} líneas de egreso`}
            breakdown={[
              { label: 'Cruzadas', value: fmtInt(s.egresoCruzadas), valueColor: 'var(--success)' },
              { label: 'Sin movimiento bancario', value: fmtInt(s.egresoLineas - s.egresoCruzadas), valueColor: 'var(--danger)' },
            ]}
            onClick={s.egresoLineas > s.egresoCruzadas ? () => setDrilldownFlujo('egreso') : undefined}
            navHint="Ver líneas sin cruce"
          />
          <KpiCard
            label="Monto egresos (libro mayor)"
            value={fmtKpi(s.egresoMonto)}
            sublabel={`${fmtKpi(s.egresoMontoCruzado)} validado en banco`}
          />
          <KpiCard
            label="Líneas GL sin banco"
            value={fmtInt(s.glOrphanLineas)}
            tone={s.glOrphanLineas > 0 ? 'warning' : 'success'}
            icon={<FileWarning className="h-4 w-4" />}
            sublabel={`${fmtKpi(s.glOrphanMonto)} · asiento sin movimiento bancario`}
          />
          <KpiCard
            label="Movimientos banco sin GL"
            value={fmtInt(s.bankOrphanLineas)}
            tone={s.bankOrphanLineas > 0 ? 'warning' : 'success'}
            icon={<FileWarning className="h-4 w-4" />}
            sublabel={`${fmtKpi(s.bankOrphanMonto)} · comisiones / no asentados`}
          />
        </div>
      </section>

      {/* ── CAJA ───────────────────────────────────────────────────────── */}
      {s.cajaLineas > 0 && (
        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <Wallet className="h-4 w-4" style={{ color: 'var(--gray-500)' }} aria-hidden />
            <h2 className={SECTION_TITLE} style={{ color: 'var(--gray-700)' }}>
              Caja · Sin contraparte de banco
            </h2>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <KpiCard
              label="Líneas de caja (objeto 1010)"
              value={fmtInt(s.cajaLineas)}
              tone="neutral"
              sublabel={`${fmtKpi(s.cajaMonto)} · no tienen estado de cuenta bancario`}
            />
          </div>
        </section>
      )}

      <ConciliacionOrphansDrilldown
        reconciliation={reconciliation}
        flujo={drilldownFlujo}
        ciaNameByCode={ciaNameByCode}
        onClose={() => setDrilldownFlujo(null)}
      />

      {/* Desglose por compañía — diagnóstico de cruce bajo.
         *
         * MULTICARGA (cía 00033) se excluye del desglose: está en la
         * allowlist de AuxiliarContable por requerimiento operativo, pero la
         * meta de cruce 100% no aplica para ella (volumen mínimo, esquema
         * contable distinto). Filtrarla evita ruido en el KPI por-empresa. */}
      {s.ciaBreakdown.filter((r) => r.cia !== '00033').length > 0 && (
        <div
          className="overflow-hidden rounded-[var(--radius-lg)] border"
          style={{ borderColor: 'var(--gray-200)', background: 'var(--surface)' }}
        >
          <table className="w-full text-[12px]">
            <thead>
              <tr style={{ background: 'var(--gray-50)', color: 'var(--gray-500)' }}>
                <th className="px-3 py-2 text-left font-medium uppercase tracking-[0.06em]">Compañía</th>
                <th className="px-3 py-2 text-right font-medium uppercase tracking-[0.06em]">Líneas</th>
                <th className="px-3 py-2 text-right font-medium uppercase tracking-[0.06em]">Cruzadas</th>
                <th className="px-3 py-2 text-right font-medium uppercase tracking-[0.06em]">% Cruce</th>
              </tr>
            </thead>
            <tbody>
              {s.ciaBreakdown.filter((r) => r.cia !== '00033').map((row) => {
                const nombre = ciaNameByCode.get(row.cia);
                return (
                <tr key={row.cia} className="border-t" style={{ borderColor: 'var(--gray-100)' }}>
                  <td className="px-3 py-1.5" style={{ color: 'var(--gray-950)' }}>
                    <div className="font-medium">{nombre ?? row.cia}</div>
                    {nombre && (
                      <div className="text-[10px] tabular-nums" style={{ color: 'var(--gray-500)' }}>{row.cia}</div>
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums" style={{ color: 'var(--gray-700)' }}>{fmtInt(row.lineas)}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums" style={{ color: 'var(--gray-700)' }}>{fmtInt(row.cruzadas)}</td>
                  <td
                    className="px-3 py-1.5 text-right font-semibold tabular-nums"
                    style={{ color: row.pct < 50 ? 'var(--danger)' : row.pct < 80 ? 'var(--warning)' : 'var(--success)' }}
                  >
                    {fmtPctInt(row.pct)}
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
