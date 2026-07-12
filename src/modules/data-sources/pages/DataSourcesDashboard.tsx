/**
 * ⚠️ TEMPORAL (2026-07-10) — módulo "Fuentes y Datos".
 *
 * Vista de frescura por fuente (Bancos / JDE / TRESS / ROL) para usuarios NO
 * técnicos: cada sub-tab explica qué sistema es, cómo llega el dato a Midas
 * (API vs. carga manual) y la fecha del dato REAL más reciente, calculada
 * desde los records ya en memoria (nunca hardcodeada). Read-only.
 *
 * Para retirar: borrar `src/modules/data-sources/` + los puntos marcados
 * "TEMPORAL fuentes-datos" en AppCore.tsx / types.ts / NavigationContext.tsx
 * / appTabs.ts.
 */

import { useMemo, type ReactNode } from 'react';
import { CloudDownload, FileUp, Info } from 'lucide-react';
import PageHeader from '../../../components/ui/PageHeader';
import { fmtCurrency, fmtDate, fmtInt, todayISO } from '../../../formatters';
import type {
  AuxiliarContableRecord,
  BankAccountStatement,
  CobranzaRecord,
  Company,
  ComprasRecord,
  PagoProveedorRecord,
  RolRecord,
  ViajeEspecialRecord,
} from '../../../services/jde';
import type { CXPRecord } from '../../../domain/persistence';
import type { PayrollCostRecord } from '../../shared-finance/types';
import {
  buildBankFreshnessRows,
  buildJdeEntityRows,
  buildRolFreshnessRows,
  buildTressFreshnessRows,
  companyNameFor,
  daysSince,
  freshnessTone,
  maxIsoDay,
  summarizeViajesEspeciales,
  type FreshnessTone,
} from '../services/dataSourcesService';

export type DataSourceId = 'bancos' | 'jde' | 'tress' | 'rol';

interface DataSourcesDashboardProps {
  source: DataSourceId;
  companies?: Company[];
  /** Todos los estados de cuenta en memoria (JDE + cargas manuales). */
  bankStatements?: BankAccountStatement[];
  /** Solo los estados de cuenta que vinieron de JDE (para la entidad JDE). */
  bankJdeStatements?: BankAccountStatement[];
  cxpRecords?: CXPRecord[];
  cobranzaRecords?: CobranzaRecord[];
  comprasRecords?: ComprasRecord[];
  pagoProveedorRecords?: PagoProveedorRecord[];
  auxiliarRecords?: AuxiliarContableRecord[];
  nominaRecords?: PayrollCostRecord[];
  rolRecords?: RolRecord[];
  viajesEspecialesRecords?: ViajeEspecialRecord[];
}

// ── Copy visible por fuente (requisito: autoexplicativo, sin tooltips) ──────

const SOURCE_META: Record<DataSourceId, {
  title: string;
  sistema: string;
  queEs: string;
  comoLlega: 'manual' | 'api';
  comoLlegaDetalle: string;
}> = {
  bancos: {
    title: 'Bancos — estados de cuenta',
    sistema: 'Estados de cuenta bancarios (BanBajío, Santander y demás bancos del grupo)',
    queEs:
      'Son los movimientos y saldos reales de las cuentas bancarias del grupo. En Midas son la ' +
      '"verdad del efectivo": anclan la caja histórica, el Flujo Neto y el cuadre de Planeación.',
    comoLlega: 'manual',
    comoLlegaDetalle:
      'Tesorería sube los estados de cuenta mediante carga masiva de archivos (no hay conexión ' +
      'automática con los bancos). Eso significa que el dato es tan fresco como la última carga: ' +
      'si una cuenta lleva días sin cargarse, Midas sigue mostrando el último saldo que recibió ' +
      'aunque el banco ya tenga movimientos más recientes.',
  },
  jde: {
    title: 'JDE — sistema administrativo',
    sistema: 'JD Edwards (ERP contable-administrativo del grupo)',
    queEs:
      'Es el sistema donde vive la contabilidad y la administración: facturas por cobrar y por ' +
      'pagar, órdenes de compra, pagos a proveedores, estados de cuenta capturados y el libro ' +
      'mayor. Casi todos los módulos de Midas se alimentan de aquí.',
    comoLlega: 'api',
    comoLlegaDetalle:
      'Midas consulta JDE en línea (API) cada vez que se abre la aplicación, así que el dato es ' +
      'tan reciente como lo que ya está capturado en JDE. Ojo: si algo aún no se captura en JDE ' +
      '(p. ej. un estado de cuenta que tesorería sube con atraso), Midas tampoco lo puede ver.',
  },
  tress: {
    title: 'TRESS — nómina',
    sistema: 'TRESS (sistema de nómina del grupo)',
    queEs:
      'Es el sistema donde se calcula y paga la nómina. Midas usa sus totales (por empresa, ' +
      'concepto y periodo) para el módulo de Nómina y para proyectar el egreso de nómina en el ' +
      'flujo de efectivo.',
    comoLlega: 'api',
    comoLlegaDetalle:
      'Midas consulta TRESS en línea (API) al abrir la aplicación. El dato refleja los periodos ' +
      'de nómina ya cerrados/pagados en TRESS; un periodo que aún no se procesa en TRESS no ' +
      'aparece aquí.',
  },
  rol: {
    title: 'ROL (CITI) — viajes',
    sistema: 'CITI / ROL Diario (sistema operativo de viajes)',
    queEs:
      'Registra los viajes ejecutados (y los viajes especiales). Para Midas es la señal más ' +
      'temprana de ingreso: un viaje efectuado que aún no se factura ya se proyecta como cobro ' +
      'futuro en Ingresos y en la proyección.',
    comoLlega: 'api',
    comoLlegaDetalle:
      'Midas consulta CITI en línea (API) al abrir la aplicación, día por día. El dato es tan ' +
      'reciente como lo que operaciones ya registró en CITI.',
  },
};

// ── Piezas de UI ────────────────────────────────────────────────────────────

const TONE_STYLE: Record<FreshnessTone, { bg: string; fg: string; label: string }> = {
  fresh: { bg: 'rgba(16,185,129,0.12)', fg: 'var(--success)', label: 'Al día' },
  stale: { bg: 'rgba(217,119,6,0.12)', fg: '#d97706', label: 'Con atraso' },
  old: { bg: 'rgba(220,38,38,0.12)', fg: '#dc2626', label: 'Desactualizado' },
  none: { bg: 'var(--gray-100)', fg: 'var(--gray-500)', label: 'Sin datos' },
};

function agoLabel(days: number | null): string {
  if (days === null) return 'sin fecha';
  if (days < 0) return `fecha futura (+${Math.abs(days)} d)`;
  if (days === 0) return 'hoy';
  if (days === 1) return 'hace 1 día';
  return `hace ${days} días`;
}

function FreshnessChip({ date, today }: { date: string | null; today: string }) {
  const days = daysSince(date, today);
  const tone = TONE_STYLE[freshnessTone(days)];
  return (
    <span
      className="inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold"
      style={{ background: tone.bg, color: tone.fg }}
    >
      {agoLabel(days)}
    </span>
  );
}

function Card({ children }: { children: ReactNode }) {
  return (
    <div
      className="rounded-[var(--radius-lg)] p-4"
      style={{ background: 'var(--card)', border: '1px solid var(--gray-200)' }}
    >
      {children}
    </div>
  );
}

function CardLabel({ children }: { children: ReactNode }) {
  return (
    <p className="text-[11px] font-medium uppercase tracking-[0.06em]" style={{ color: 'var(--gray-500)' }}>
      {children}
    </p>
  );
}

/** Ficha autoexplicativa de la fuente: qué es, cómo llega y qué tan fresco está. */
function SourceExplainer({ source, latestDate, today }: { source: DataSourceId; latestDate: string | null; today: string }) {
  const meta = SOURCE_META[source];
  const manual = meta.comoLlega === 'manual';
  const days = daysSince(latestDate, today);
  const tone = TONE_STYLE[freshnessTone(days)];
  return (
    <div className="grid gap-3 md:grid-cols-3">
      <Card>
        <CardLabel>¿Qué sistema es?</CardLabel>
        <p className="mt-1.5 text-[13px] font-semibold" style={{ color: 'var(--gray-950)' }}>{meta.sistema}</p>
        <p className="mt-1 text-[12px] leading-snug" style={{ color: 'var(--gray-500)' }}>{meta.queEs}</p>
      </Card>
      <Card>
        <CardLabel>¿Cómo llega el dato a Midas?</CardLabel>
        <p className="mt-1.5">
          <span
            className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide"
            style={{
              background: manual ? 'rgba(217,119,6,0.12)' : 'rgba(16,185,129,0.12)',
              color: manual ? '#d97706' : 'var(--success)',
            }}
          >
            {manual ? <FileUp className="h-3.5 w-3.5" strokeWidth={2} /> : <CloudDownload className="h-3.5 w-3.5" strokeWidth={2} />}
            {manual ? 'Carga manual de archivos' : 'Consulta automática (API)'}
          </span>
        </p>
        <p className="mt-2 text-[12px] leading-snug" style={{ color: 'var(--gray-500)' }}>{meta.comoLlegaDetalle}</p>
      </Card>
      <Card>
        <CardLabel>Dato más reciente en Midas</CardLabel>
        <p className="mt-1.5 text-[20px] font-bold leading-tight" style={{ color: tone.fg }}>
          {latestDate ? fmtDate(latestDate) : 'Sin datos cargados'}
        </p>
        <p className="mt-1 text-[12px]" style={{ color: 'var(--gray-500)' }}>
          {agoLabel(days)} · {tone.label}. Es la fecha del dato real más reciente que Midas tiene
          registrado — no la fecha de hoy ni la fecha en que se consultó/cargó.
        </p>
      </Card>
    </div>
  );
}

function EmptyNote({ children }: { children: ReactNode }) {
  return (
    <p className="py-8 text-center text-[13px]" style={{ color: 'var(--gray-500)' }}>{children}</p>
  );
}

const TH_CLASS = 'px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.05em]';
const TD_CLASS = 'px-3 py-2 text-[13px]';

function FreshTable({ head, children, empty }: { head: string[]; children: ReactNode; empty?: string }) {
  return (
    <div className="overflow-x-auto rounded-[var(--radius-lg)]" style={{ background: 'var(--card)', border: '1px solid var(--gray-200)' }}>
      <table className="w-full min-w-[720px] border-collapse">
        <thead>
          <tr style={{ borderBottom: '1px solid var(--gray-200)', color: 'var(--gray-500)' }}>
            {head.map((h) => <th key={h} className={TH_CLASS}>{h}</th>)}
          </tr>
        </thead>
        <tbody style={{ color: 'var(--gray-950)' }}>
          {children ?? null}
        </tbody>
      </table>
      {empty ? <EmptyNote>{empty}</EmptyNote> : null}
    </div>
  );
}

// ── Sub-vistas por fuente ───────────────────────────────────────────────────

function BancosView({ statements, companies, today }: { statements: BankAccountStatement[]; companies: Company[]; today: string }) {
  const rows = useMemo(() => buildBankFreshnessRows(statements), [statements]);
  const latest = useMemo(() => maxIsoDay(rows.map((r) => r.latestMovementDate)), [rows]);
  return (
    <div className="space-y-4">
      <SourceExplainer source="bancos" latestDate={latest} today={today} />
      <div
        className="flex items-start gap-2 rounded-[var(--radius-lg)] p-3 text-[12px] leading-snug"
        style={{ background: 'rgba(217,119,6,0.08)', border: '1px solid rgba(217,119,6,0.35)', color: 'var(--gray-950)' }}
      >
        <Info className="mt-0.5 h-4 w-4 shrink-0" style={{ color: '#d97706' }} strokeWidth={2} />
        <span>
          <strong>Para qué sirve esta tabla:</strong> la columna «Último movimiento» es la fecha del
          movimiento bancario más reciente que Midas tiene para cada cuenta. Si esa fecha es vieja, el
          saldo que Midas muestra para esa cuenta puede estar desactualizado aunque la pantalla se vea
          "al día" (caso real del 8-jul-2026: Bajío mostraba $528,400 cuando el saldo real era
          $281,636 — faltaban días de movimientos por cargar).
        </span>
      </div>
      <FreshTable
        head={['Banco', 'Cuenta', 'Empresa', 'Último movimiento', 'Frescura', 'Últ. estado de cuenta', 'Movs.', 'Saldo final reportado']}
        empty={rows.length === 0 ? 'Sin estados de cuenta cargados en esta sesión.' : undefined}
      >
        {rows.map((r) => (
          <tr key={r.key} style={{ borderTop: '1px solid var(--gray-100)' }}>
            <td className={TD_CLASS}>{r.nombreBanco || r.banco}</td>
            <td className={`${TD_CLASS} font-mono text-[12px]`}>{r.cuenta} · {r.moneda}</td>
            <td className={TD_CLASS}>{companyNameFor(companies, r.cia)}</td>
            <td className={`${TD_CLASS} font-semibold`}>{r.latestMovementDate ? fmtDate(r.latestMovementDate) : '—'}</td>
            <td className={TD_CLASS}><FreshnessChip date={r.latestMovementDate} today={today} /></td>
            <td className={TD_CLASS}>{r.latestStatementDate ? fmtDate(r.latestStatementDate) : '—'}</td>
            <td className={`${TD_CLASS} text-right tabular-nums`}>{fmtInt(r.movimientos)}</td>
            <td className={`${TD_CLASS} text-right tabular-nums`}>{r.saldoFinal !== null ? fmtCurrency(r.saldoFinal) : '—'}</td>
          </tr>
        ))}
      </FreshTable>
    </div>
  );
}

function JdeView(props: Required<Pick<DataSourcesDashboardProps,
  'companies' | 'cxpRecords' | 'cobranzaRecords' | 'comprasRecords' | 'pagoProveedorRecords' | 'bankJdeStatements' | 'auxiliarRecords'>> & { today: string }) {
  const { companies, cxpRecords, cobranzaRecords, comprasRecords, pagoProveedorRecords, bankJdeStatements, auxiliarRecords } = props;
  // Deps individuales: JdeView se instancia con props inline, así que el
  // objeto `props` es nuevo en cada render y un memo keyeado por él nunca
  // cachea (recorrería ~100k records por re-render de AppCore).
  const rows = useMemo(
    () => buildJdeEntityRows({ companies, cxpRecords, cobranzaRecords, comprasRecords, pagoProveedorRecords, bankJdeStatements, auxiliarRecords }),
    [companies, cxpRecords, cobranzaRecords, comprasRecords, pagoProveedorRecords, bankJdeStatements, auxiliarRecords],
  );
  const latest = useMemo(() => maxIsoDay(rows.map((r) => r.latestDate)), [rows]);
  return (
    <div className="space-y-4">
      <SourceExplainer source="jde" latestDate={latest} today={props.today} />
      <FreshTable head={['Entidad', 'Para qué la usa Midas', 'Qué fecha se mide', 'Dato más reciente', 'Frescura', 'Registros']}>
        {rows.map((r) => (
          <tr key={r.id} style={{ borderTop: '1px solid var(--gray-100)' }}>
            <td className={`${TD_CLASS} font-semibold`}>{r.entidad}</td>
            <td className={`${TD_CLASS} max-w-[320px]`} style={{ color: 'var(--gray-500)' }}>{r.uso}</td>
            <td className={TD_CLASS} style={{ color: 'var(--gray-500)' }}>{r.fechaMedida}</td>
            <td className={`${TD_CLASS} font-semibold`}>{r.latestDate ? fmtDate(r.latestDate) : '—'}</td>
            <td className={TD_CLASS}>
              {r.id === 'empresas'
                ? <span className="text-[12px]" style={{ color: 'var(--gray-500)' }}>n/a (catálogo)</span>
                : <FreshnessChip date={r.latestDate} today={props.today} />}
            </td>
            <td className={`${TD_CLASS} text-right tabular-nums`}>{fmtInt(r.registros)}</td>
          </tr>
        ))}
      </FreshTable>
    </div>
  );
}

function TressView({ nominaRecords, companies, today }: { nominaRecords: PayrollCostRecord[]; companies: Company[]; today: string }) {
  const rows = useMemo(() => buildTressFreshnessRows(nominaRecords), [nominaRecords]);
  const latest = useMemo(() => maxIsoDay(rows.map((r) => r.latestPaymentDate)), [rows]);
  return (
    <div className="space-y-4">
      <SourceExplainer source="tress" latestDate={latest} today={today} />
      <FreshTable
        head={['Empresa de nómina', 'Compañía JDE', 'Último pago de nómina', 'Frescura', 'Periodo más reciente', 'Registros']}
        empty={rows.length === 0 ? 'Sin datos de nómina cargados en esta sesión.' : undefined}
      >
        {rows.map((r) => (
          <tr key={r.key} style={{ borderTop: '1px solid var(--gray-100)' }}>
            <td className={`${TD_CLASS} font-semibold`}>{r.empresaNomina || '—'}</td>
            <td className={TD_CLASS}>{companyNameFor(companies, r.cia)}</td>
            <td className={`${TD_CLASS} font-semibold`}>{r.latestPaymentDate ? fmtDate(r.latestPaymentDate) : '—'}</td>
            <td className={TD_CLASS}><FreshnessChip date={r.latestPaymentDate} today={today} /></td>
            <td className={TD_CLASS}>{r.latestPeriod ?? '—'}</td>
            <td className={`${TD_CLASS} text-right tabular-nums`}>{fmtInt(r.registros)}</td>
          </tr>
        ))}
      </FreshTable>
      <p className="text-[12px]" style={{ color: 'var(--gray-500)' }}>
        La nómina llega de TRESS agregada por empresa, concepto y periodo. «Último pago de nómina» es
        la fecha de pago del periodo más reciente que TRESS ya tiene procesado — la nómina se paga por
        periodos (semanal/quincenal), así que unos días de diferencia contra hoy son normales.
      </p>
    </div>
  );
}

function RolView({ rolRecords, viajesEspecialesRecords, today }: { rolRecords: RolRecord[]; viajesEspecialesRecords: ViajeEspecialRecord[]; today: string }) {
  const rows = useMemo(() => buildRolFreshnessRows(rolRecords), [rolRecords]);
  const especiales = useMemo(() => summarizeViajesEspeciales(viajesEspecialesRecords), [viajesEspecialesRecords]);
  const latest = useMemo(
    () => maxIsoDay([...rows.map((r) => r.latestFechaViaje), especiales.latestDate]),
    [rows, especiales],
  );
  return (
    <div className="space-y-4">
      <SourceExplainer source="rol" latestDate={latest} today={today} />
      <FreshTable
        head={['Empresa', 'Último viaje registrado', 'Frescura', 'Registros de viaje']}
        empty={rows.length === 0 ? 'Sin viajes ROL cargados en esta sesión.' : undefined}
      >
        {rows.map((r) => (
          <tr key={r.empresa} style={{ borderTop: '1px solid var(--gray-100)' }}>
            <td className={`${TD_CLASS} font-semibold`}>{r.empresa}</td>
            <td className={`${TD_CLASS} font-semibold`}>{r.latestFechaViaje ? fmtDate(r.latestFechaViaje) : '—'}</td>
            <td className={TD_CLASS}><FreshnessChip date={r.latestFechaViaje} today={today} /></td>
            <td className={`${TD_CLASS} text-right tabular-nums`}>{fmtInt(r.registros)}</td>
          </tr>
        ))}
      </FreshTable>
      <Card>
        <CardLabel>Viajes especiales</CardLabel>
        <p className="mt-1.5 text-[13px]" style={{ color: 'var(--gray-950)' }}>
          {especiales.registros > 0 ? (
            <>
              <strong>{fmtInt(especiales.registros)}</strong> viajes especiales cargados · viaje más
              reciente: <strong>{especiales.latestDate ? fmtDate(especiales.latestDate) : '—'}</strong>{' '}
              <FreshnessChip date={especiales.latestDate} today={today} />
            </>
          ) : 'Sin viajes especiales cargados en esta sesión.'}
        </p>
        <p className="mt-1 text-[12px] leading-snug" style={{ color: 'var(--gray-500)' }}>
          Los viajes especiales (rentas) llegan de un servicio aparte del mismo sistema y también se
          proyectan como ingreso de corto plazo.
        </p>
      </Card>
    </div>
  );
}

// ── Página ──────────────────────────────────────────────────────────────────

export default function DataSourcesDashboard({
  source,
  companies = [],
  bankStatements = [],
  bankJdeStatements = [],
  cxpRecords = [],
  cobranzaRecords = [],
  comprasRecords = [],
  pagoProveedorRecords = [],
  auxiliarRecords = [],
  nominaRecords = [],
  rolRecords = [],
  viajesEspecialesRecords = [],
}: DataSourcesDashboardProps) {
  const today = todayISO();
  const meta = SOURCE_META[source];
  return (
    <div className="space-y-5">
      <PageHeader
        meta="Fuentes y Datos · vista temporal de diagnóstico"
        title={meta.title}
        subtitle="Qué tan actualizada está la información que Midas tiene de esta fuente. Las fechas se calculan del dato real en memoria; si una fecha se ve vieja, el número que dependa de ella también lo está."
      />
      {source === 'bancos' && <BancosView statements={bankStatements} companies={companies} today={today} />}
      {source === 'jde' && (
        <JdeView
          companies={companies}
          cxpRecords={cxpRecords}
          cobranzaRecords={cobranzaRecords}
          comprasRecords={comprasRecords}
          pagoProveedorRecords={pagoProveedorRecords}
          bankJdeStatements={bankJdeStatements}
          auxiliarRecords={auxiliarRecords}
          today={today}
        />
      )}
      {source === 'tress' && <TressView nominaRecords={nominaRecords} companies={companies} today={today} />}
      {source === 'rol' && <RolView rolRecords={rolRecords} viajesEspecialesRecords={viajesEspecialesRecords} today={today} />}
    </div>
  );
}
