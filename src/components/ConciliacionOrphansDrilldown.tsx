import { useMemo, useState } from 'react';
import { Modal } from './ui/Modal';
import { fmtCurrency, fmtDate, fmtInt } from '../formatters';
import type {
  AuxiliarMatchTier,
  AuxiliarReconLine,
  AuxiliarReconResult,
} from '../domain/auxiliarReconciliationEngine';

/**
 * Drilldown de líneas sin cruce — se abre al hacer click en las cajas de
 * "Ingresos / Egresos cruzados a banco" del dashboard de Conciliación.
 *
 * Muestra TODAS las líneas que no quedaron cruzadas para el flujo elegido,
 * agrupadas por razón (matchTier). Cada razón se renderiza como una sección
 * colapsable con conteo + monto y una tabla con detalle por línea (fecha,
 * cía, cuenta, contraparte, doc fuente, importe).
 *
 * Las razones que NO entran al panel: `caja`, `interno`, `asiento-interno`
 * (categorías semánticas excluidas del denominador del % cruce — no son
 * "sin movimiento bancario", son "no bancario por diseño").
 */

interface Props {
  reconciliation: AuxiliarReconResult;
  flujo: 'ingreso' | 'egreso' | null;
  /** Lookup cía → razón social. Permite mostrar el nombre en la tabla y en
   *  el filtro. Si está vacío, se muestra solo el código. */
  ciaNameByCode?: ReadonlyMap<string, string>;
  onClose: () => void;
}

type NonCrossedTier = Extract<
  AuxiliarMatchTier,
  | 'pendiente-revision'
  | 'asiento-contable'
  | 'cuenta-no-en-banco'
  | 'sin-cuenta-aux'
  | 'timing-pendiente'
>;

const NON_CROSSED_TIERS: readonly NonCrossedTier[] = [
  'pendiente-revision',
  'asiento-contable',
  'cuenta-no-en-banco',
  'sin-cuenta-aux',
  'timing-pendiente',
];

const TIER_META: Record<
  NonCrossedTier,
  { label: string; description: string; tone: 'danger' | 'warning' | 'neutral' }
> = {
  'pendiente-revision': {
    label: 'Pendiente de revisión',
    description:
      'Cheques, cobros y pagos que SÍ son movs bancarios pero el motor no encontró pareja automática (intercompañía marcado como traspaso, agregados N:1, importe difiere >10% por comisiones). Necesita revisión contable manual — marcar R en JDE o ajustar el asiento.',
    tone: 'danger',
  },
  'asiento-contable': {
    label: 'Asientos contables sin banco',
    description:
      'Líneas journal-style (JX revaluación FX, JG ajustes conciliación, T1 desembolso nómina, BA ajustes facturación, etc.) y finiquitos provisionales (batch G + tipoDocto PF). NO tienen contraparte bancaria por diseño — son registros de ajuste contable.',
    tone: 'neutral',
  },
  'cuenta-no-en-banco': {
    label: 'Cuenta sin estado de cuenta',
    description:
      'La cuenta del asiento no aparece en /bancos JDE (cuenta por_cancelar inactiva o cuenta no expuesta). Gap estructural — alta en catálogo o cierre contable.',
    tone: 'warning',
  },
  'sin-cuenta-aux': {
    label: 'Sin cuenta bancaria en aux',
    description:
      'La línea del aux contable no trae el campo cuentaBanco poblado — no hay clave para emparejar. Gap del API JDE.',
    tone: 'warning',
  },
  'timing-pendiente': {
    label: 'Posterior al cierre del extracto',
    description:
      'Asiento fechado después del último movimiento bancario cargado. Match imposible por timing — esperar al siguiente extracto.',
    tone: 'neutral',
  },
};

const TONE_COLORS: Record<'danger' | 'warning' | 'neutral', { text: string; bg: string; border: string }> = {
  danger: {
    text: 'var(--danger)',
    bg: 'color-mix(in oklch, var(--danger) 12%, transparent)',
    border: 'color-mix(in oklch, var(--danger) 25%, var(--gray-200))',
  },
  warning: {
    text: 'var(--warning)',
    bg: 'color-mix(in oklch, var(--warning) 14%, transparent)',
    border: 'color-mix(in oklch, var(--warning) 30%, var(--gray-200))',
  },
  neutral: {
    text: 'var(--gray-600)',
    bg: 'var(--gray-50)',
    border: 'var(--gray-200)',
  },
};

function sourceLabel(line: AuxiliarReconLine): string {
  const { source } = line;
  switch (source.kind) {
    case 'factura':
      return `Factura ${source.ref}`;
    case 'oc':
      return `OC ${source.ref}`;
    case 'pago':
      return `Pago ${source.ref}`;
    default:
      return source.ref || '—';
  }
}

interface TierGroup {
  tier: NonCrossedTier;
  lines: AuxiliarReconLine[];
  monto: number;
}

function groupByTier(
  lines: AuxiliarReconLine[],
  flujo: 'ingreso' | 'egreso',
  ciaFilter: string | null,
): TierGroup[] {
  const buckets = new Map<NonCrossedTier, { lines: AuxiliarReconLine[]; monto: number }>();
  for (const line of lines) {
    if (line.flujo !== flujo) continue;
    if (ciaFilter && line.cia !== ciaFilter) continue;
    if (!(NON_CROSSED_TIERS as readonly string[]).includes(line.matchTier)) continue;
    const tier = line.matchTier as NonCrossedTier;
    const bucket = buckets.get(tier) ?? { lines: [], monto: 0 };
    bucket.lines.push(line);
    bucket.monto += Math.abs(line.importe);
    buckets.set(tier, bucket);
  }
  // Orden fijo por accionabilidad: orphan primero (más urgente), gaps después.
  return NON_CROSSED_TIERS
    .filter((tier) => buckets.has(tier))
    .map((tier) => {
      const b = buckets.get(tier)!;
      // Cada bucket ordenado por fecha desc — los más recientes arriba.
      b.lines.sort((a, b2) => b2.fechaContable.localeCompare(a.fechaContable));
      return { tier, lines: b.lines, monto: b.monto };
    });
}

function TierSection({
  group,
  defaultOpen,
  ciaNameByCode,
}: {
  group: TierGroup;
  defaultOpen: boolean;
  ciaNameByCode?: ReadonlyMap<string, string>;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const meta = TIER_META[group.tier];
  const colors = TONE_COLORS[meta.tone];
  return (
    <section
      className="overflow-hidden rounded-[var(--radius-lg)] border"
      style={{ borderColor: colors.border, background: 'var(--card)' }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left"
        style={{ background: colors.bg }}
        aria-expanded={open}
      >
        <div className="flex items-center gap-3">
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ background: colors.text }}
            aria-hidden
          />
          <div>
            <div className="text-[13px] font-semibold" style={{ color: 'var(--gray-900)' }}>
              {meta.label}
            </div>
            <div className="text-[11px]" style={{ color: 'var(--gray-600)' }}>
              {meta.description}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-baseline gap-3 tabular-nums">
          <span className="text-[18px] font-bold" style={{ color: colors.text }}>
            {fmtInt(group.lines.length)}
          </span>
          <span className="text-[12px]" style={{ color: 'var(--gray-600)' }}>
            {fmtCurrency(group.monto)}
          </span>
          <span className="text-[14px]" style={{ color: 'var(--gray-500)' }} aria-hidden>
            {open ? '▾' : '▸'}
          </span>
        </div>
      </button>
      {open && (
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr style={{ background: 'var(--gray-50)', color: 'var(--gray-500)' }}>
                <th className="px-3 py-2 text-left font-medium uppercase tracking-[0.06em]">Fecha</th>
                <th className="px-3 py-2 text-left font-medium uppercase tracking-[0.06em]">Cía</th>
                <th className="px-3 py-2 text-left font-medium uppercase tracking-[0.06em]">Cuenta</th>
                <th className="px-3 py-2 text-left font-medium uppercase tracking-[0.06em]">Contraparte</th>
                <th className="px-3 py-2 text-left font-medium uppercase tracking-[0.06em]">Doc fuente</th>
                <th className="px-3 py-2 text-left font-medium uppercase tracking-[0.06em]">Tipo</th>
                <th className="px-3 py-2 text-right font-medium uppercase tracking-[0.06em]">Importe</th>
              </tr>
            </thead>
            <tbody>
              {group.lines.map((line) => (
                <tr
                  key={line.glKey}
                  className="border-t"
                  style={{ borderColor: 'var(--gray-100)' }}
                >
                  <td className="px-3 py-1.5 tabular-nums" style={{ color: 'var(--gray-700)' }}>
                    {fmtDate(line.fechaContable)}
                  </td>
                  <td className="px-3 py-1.5" style={{ color: 'var(--gray-900)' }}>
                    {(() => {
                      const nombre = ciaNameByCode?.get(line.cia);
                      return nombre ? (
                        <>
                          <div>{nombre}</div>
                          <div className="text-[10px] tabular-nums" style={{ color: 'var(--gray-500)' }}>{line.cia}</div>
                        </>
                      ) : (
                        <span className="tabular-nums">{line.cia}</span>
                      );
                    })()}
                  </td>
                  <td className="px-3 py-1.5" style={{ color: 'var(--gray-700)' }}>
                    <div className="tabular-nums">{line.cuentaBanco || '—'}</div>
                    {line.nombreCuenta && (
                      <div className="text-[10px]" style={{ color: 'var(--gray-500)' }}>
                        {line.nombreCuenta}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-1.5" style={{ color: 'var(--gray-700)' }}>
                    {line.source.contraparte || '—'}
                  </td>
                  <td className="px-3 py-1.5" style={{ color: 'var(--gray-700)' }}>
                    {sourceLabel(line)}
                  </td>
                  <td className="px-3 py-1.5" style={{ color: 'var(--gray-600)' }}>
                    {line.tipoDoctoDesc}
                  </td>
                  <td
                    className="px-3 py-1.5 text-right font-medium tabular-nums"
                    style={{ color: 'var(--gray-900)' }}
                  >
                    {fmtCurrency(Math.abs(line.importe))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** Genera CSV (UTF-8 con BOM para Excel-es) de todas las líneas de los
 *  grupos. Una fila por línea, columnas en español para que contabilidad
 *  pueda abrirlo directo. */
function buildCsv(groups: TierGroup[], ciaNameByCode?: ReadonlyMap<string, string>): string {
  const header = ['Razón', 'Fecha', 'Cía código', 'Cía nombre', 'Cuenta', 'Nombre cuenta', 'Contraparte', 'Doc fuente', 'Tipo doc', 'Importe', 'Moneda'];
  const esc = (v: string | number | undefined | null): string => {
    const s = v == null ? '' : String(v);
    return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows: string[] = [header.map(esc).join(',')];
  for (const g of groups) {
    const razon = TIER_META[g.tier].label;
    for (const line of g.lines) {
      rows.push([
        razon,
        line.fechaContable,
        line.cia,
        ciaNameByCode?.get(line.cia) ?? '',
        line.cuentaBanco,
        line.nombreCuenta,
        line.source.contraparte ?? '',
        sourceLabel(line),
        line.tipoDoctoDesc,
        Math.abs(line.importe).toFixed(2),
        line.moneda,
      ].map(esc).join(','));
    }
  }
  return '﻿' + rows.join('\r\n');
}

function downloadCsv(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function ConciliacionOrphansDrilldown({ reconciliation, flujo, ciaNameByCode, onClose }: Props) {
  const open = flujo !== null;
  const [ciaFilter, setCiaFilter] = useState<string | null>(null);

  /** Cías presentes en las líneas no-cruzadas del flujo elegido. Se calcula
   *  sin aplicar `ciaFilter` para que el dropdown no se auto-vacíe. */
  const ciaOptions = useMemo(() => {
    if (!flujo) return [] as string[];
    const set = new Set<string>();
    for (const line of reconciliation.lines) {
      if (line.flujo !== flujo) continue;
      if (!(NON_CROSSED_TIERS as readonly string[]).includes(line.matchTier)) continue;
      set.add(line.cia);
    }
    return Array.from(set).sort();
  }, [reconciliation, flujo]);

  const groups = useMemo(
    () => (flujo ? groupByTier(reconciliation.lines, flujo, ciaFilter) : []),
    [reconciliation, flujo, ciaFilter],
  );
  const totalLineas = useMemo(() => groups.reduce((acc, g) => acc + g.lines.length, 0), [groups]);
  const totalMonto = useMemo(() => groups.reduce((acc, g) => acc + g.monto, 0), [groups]);

  const direction = flujo === 'egreso' ? 'egreso' : 'ingreso';
  const title = `Líneas de ${direction} sin cruce a banco`;
  const description = totalLineas > 0
    ? `${fmtInt(totalLineas)} líneas · ${fmtCurrency(totalMonto)} total. Agrupadas por razón — el grupo "Sin movimiento bancario" es el accionable; los otros son gaps estructurales.`
    : 'No hay líneas pendientes — todo cruzó correctamente.';

  const handleExport = () => {
    if (!flujo || groups.length === 0) return;
    const fecha = new Date().toISOString().slice(0, 10);
    const ciaTag = ciaFilter ? `-${ciaFilter}` : '';
    downloadCsv(`conciliacion-${direction}-sin-cruce${ciaTag}-${fecha}.csv`, buildCsv(groups, ciaNameByCode));
  };

  return (
    <Modal open={open} onClose={onClose} title={title} description={description} size="xl">
      {ciaOptions.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-md)] border px-3 py-2"
          style={{ borderColor: 'var(--gray-200)', background: 'var(--gray-50)' }}>
          <label className="flex items-center gap-2 text-[12px]" style={{ color: 'var(--gray-700)' }}>
            <span className="font-medium uppercase tracking-[0.06em]" style={{ color: 'var(--gray-500)' }}>Empresa</span>
            <select
              value={ciaFilter ?? ''}
              onChange={(e) => setCiaFilter(e.target.value || null)}
              className="rounded border px-2 py-1 text-[12px]"
              style={{ borderColor: 'var(--gray-300)', background: 'var(--card)', color: 'var(--gray-900)' }}
            >
              <option value="">Todas ({ciaOptions.length})</option>
              {ciaOptions.map((cia) => {
                const nombre = ciaNameByCode?.get(cia);
                return (
                  <option key={cia} value={cia}>
                    {nombre ? `${nombre} (${cia})` : cia}
                  </option>
                );
              })}
            </select>
          </label>
          <button
            type="button"
            onClick={handleExport}
            disabled={groups.length === 0}
            className="rounded px-3 py-1.5 text-[12px] font-semibold disabled:opacity-50"
            style={{ background: 'var(--accent-blue)', color: 'white' }}
          >
            Exportar CSV ({fmtInt(totalLineas)})
          </button>
        </div>
      )}
      {groups.length === 0 ? (
        <div
          className="rounded-[var(--radius-lg)] border p-6 text-center text-[13px]"
          style={{
            borderColor: 'color-mix(in oklch, var(--success) 25%, var(--gray-200))',
            background: 'var(--success-muted)',
            color: 'var(--gray-700)',
          }}
        >
          Sin pendientes {ciaFilter ? `para ${ciaNameByCode?.get(ciaFilter) ?? ciaFilter}` : 'para este flujo'}.
        </div>
      ) : (
        <div className="space-y-4">
          {groups.map((group, i) => (
            <TierSection key={group.tier} group={group} defaultOpen={i === 0} ciaNameByCode={ciaNameByCode} />
          ))}
        </div>
      )}
    </Modal>
  );
}

export default ConciliacionOrphansDrilldown;
