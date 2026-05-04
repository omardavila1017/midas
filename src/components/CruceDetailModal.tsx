/**
 * Modal de drill-down del cruce Cobranza ↔ Bancos.
 *
 * Dos puntos de entrada — el modal es bidireccional:
 *
 *   1. Desde la pestaña Cobranza: el usuario hace click en una factura
 *      cobrada → abrimos el modal en modo "factura" mostrando el banco
 *      que la cubrió (ref, fecha, monto, concepto, tier de match).
 *
 *   2. Desde la pestaña Bancos: el usuario hace click en el pill
 *      "✓ Factura X" de un ABONO → modal en modo "banco" listando todas
 *      las facturas que cubrió ese movimiento (1 para match individual,
 *      2-4 para subset).
 *
 * Es un overlay simple (no usa portal) porque vive bajo el árbol React
 * normal y los z-indexes del app permiten que aparezca encima sin lío.
 * Cierra con Escape, click fuera o el botón X.
 */

import { useEffect, useRef } from 'react';
import { CheckCircle2, AlertTriangle, X, FileText, Landmark, Coins, Calendar, Hash, ExternalLink } from 'lucide-react';
import { fmtCurrency } from '../formatters';
import type { CobranzaRecord } from '../services/jdeTypes';
import type {
  RealReconciliationMatch,
  AbonoEnrichment,
  MatchTier,
} from '../domain/realReconciliationEngine';

const TIER_LABEL: Record<MatchTier, string> = {
  exact: 'Exacto al céntimo',
  tolerance: 'Con tolerancia ±0.5%',
  subset: 'Subset (varias facturas)',
};

const TIER_COLOR: Record<MatchTier, string> = {
  exact: 'var(--success)',
  tolerance: 'var(--warning, #d97706)',
  subset: 'var(--primary)',
};

export type CruceDetailMode =
  | { kind: 'factura'; factura: CobranzaRecord; match?: RealReconciliationMatch }
  | { kind: 'banco'; enrichment: AbonoEnrichment };

export function CruceDetailModal({
  data,
  onClose,
}: {
  data: CruceDetailMode | null;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Cierre con Escape.
  useEffect(() => {
    if (!data) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [data, onClose]);

  if (!data) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/30 backdrop-blur-[2px] flex items-center justify-center p-4 animate-fade-in"
      onClick={(e) => {
        // Click fuera del card cierra; click adentro lo deja abierto.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className="bg-white rounded-xl shadow-2xl border border-[var(--gray-200)] w-full max-w-2xl max-h-[80vh] overflow-y-auto"
      >
        {data.kind === 'factura'
          ? <FacturaDetail factura={data.factura} match={data.match} onClose={onClose} />
          : <BancoDetail enrichment={data.enrichment} onClose={onClose} />}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Modo "factura": mostrar la factura y su ABONO matching (si lo hay).
// ─────────────────────────────────────────────────────────────────────────
function FacturaDetail({
  factura,
  match,
  onClose,
}: {
  factura: CobranzaRecord;
  match?: RealReconciliationMatch;
  onClose: () => void;
}) {
  const matched = match?.status === 'cobrada-banco';
  return (
    <>
      <Header
        icon={<FileText className="w-4 h-4" />}
        title={`Factura ${factura.noFactura}`}
        subtitle={factura.nombreCliente}
        onClose={onClose}
      />

      <div className="p-5 space-y-4">
        <Grid>
          <Field label="Compañía">{factura.cia}</Field>
          <Field label="Número de cliente">#{factura.noCliente}</Field>
          <Field label="Fecha emisión">{factura.fechaFactura?.slice(0, 10) || '—'}</Field>
          <Field label="Fecha vencimiento">
            <span className={factura.diasVencida > 0 ? 'text-[var(--danger)] font-medium' : ''}>
              {factura.fechaVence?.slice(0, 10) || '—'}
              {factura.diasVencida > 0 && ` · ${factura.diasVencida}d vencida`}
            </span>
          </Field>
          <Field label="Importe bruto">{fmtCurrency(factura.importeBrutoPesos)}</Field>
          <Field label="Saldo pendiente">
            <span className="font-semibold">{fmtCurrency(factura.importePendientePesos)}</span>
          </Field>
          <Field label="Moneda">{factura.moneda || 'MXN'}</Field>
          <Field label="Condición de pago">{factura.condPago || '—'}</Field>
          <Field label="Estatus JDE">{factura.estatus || '—'}</Field>
          {factura.fechaCobro && (
            <Field label="Fecha cobro JDE">{factura.fechaCobro.slice(0, 10)}</Field>
          )}
        </Grid>

        {/* Sección banco: aparece solo cuando hay match real. */}
        <Divider label="Cruce con bancos" />
        {matched && match ? (
          <div className="rounded-lg border-2 p-4" style={{
            borderColor: TIER_COLOR[match.matchTier ?? 'exact'],
            backgroundColor: 'var(--success-muted)',
          }}>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-5 h-5 text-[var(--success)]" />
                <span className="font-semibold text-[var(--gray-950)]">Cobrada</span>
                <span
                  className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded font-medium"
                  style={{
                    backgroundColor: 'white',
                    color: TIER_COLOR[match.matchTier ?? 'exact'],
                    border: `1px solid ${TIER_COLOR[match.matchTier ?? 'exact']}`,
                  }}
                >
                  {TIER_LABEL[match.matchTier ?? 'exact']}
                </span>
                {match.subsetSize && match.subsetSize > 1 && (
                  <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-[var(--primary-muted)] text-[var(--primary)] font-medium">
                    Subset ×{match.subsetSize}
                  </span>
                )}
              </div>
              <span className="text-[11px] text-[var(--gray-500)]">
                Confianza: {match.confidence ? `${(match.confidence * 100).toFixed(0)}%` : '—'}
              </span>
            </div>
            <Grid>
              <Field label="Fecha del abono" icon={<Calendar className="w-3 h-3" />}>{match.bankDate || '—'}</Field>
              <Field label="Monto del abono" icon={<Coins className="w-3 h-3" />}>
                {match.bankAmount !== undefined ? fmtCurrency(match.bankAmount) : '—'}
              </Field>
              <Field label="Cuenta bancaria" icon={<Landmark className="w-3 h-3" />}>{match.bankAccount || '—'}</Field>
              <Field label="Referencia" icon={<Hash className="w-3 h-3" />}>
                <code className="font-mono text-[11px]">{match.bankRef || '—'}</code>
              </Field>
              {match.bankConcept && (
                <div className="col-span-2">
                  <Field label="Concepto">{match.bankConcept}</Field>
                </div>
              )}
            </Grid>
          </div>
        ) : match?.status === 'cobrada-jde-sin-banco' ? (
          <NoMatchPanel
            icon={<CheckCircle2 className="w-5 h-5 text-[var(--gray-400)]" />}
            title="Cobrada en JDE, sin abono asociado"
            body="JDE marca esta factura como cobrada (saldo cero) pero el ABONO bancario no aparece en el rango de estados de cuenta cargado. Posiblemente cae fuera del último año o está en una cuenta no cargada."
          />
        ) : (
          <NoMatchPanel
            icon={<AlertTriangle className="w-5 h-5 text-[var(--warning, #d97706)]" />}
            title="Pendiente de cobro"
            body="No se encontró un ABONO bancario que cruce con esta factura. Si la cobranza ya entró, revisa: (1) que el ABONO esté en el rango de fechas cargado, (2) que la cuenta del banco esté entre los estados de cuenta sincronizados, (3) que el monto no difiera más de ±0.5% del bruto/pendiente."
          />
        )}
      </div>
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Modo "banco": mostrar el ABONO y las facturas que cubre.
// ─────────────────────────────────────────────────────────────────────────
function BancoDetail({
  enrichment,
  onClose,
}: {
  enrichment: AbonoEnrichment;
  onClose: () => void;
}) {
  return (
    <>
      <Header
        icon={<Landmark className="w-4 h-4" />}
        title={`Abono · ${fmtCurrency(enrichment.importe)}`}
        subtitle={`${enrichment.fechaOperacion} · Cuenta ${enrichment.cuenta}`}
        onClose={onClose}
      />

      <div className="p-5 space-y-4">
        <Grid>
          <Field label="Compañía">{enrichment.cia || '—'}</Field>
          <Field label="Cuenta bancaria">{enrichment.cuenta}</Field>
          <Field label="Fecha operación">{enrichment.fechaOperacion}</Field>
          <Field label="Importe">{fmtCurrency(enrichment.importe)}</Field>
          <Field label="Referencia">
            <code className="font-mono text-[11px]">{enrichment.referencia || '—'}</code>
          </Field>
          {enrichment.concepto && (
            <div className="col-span-2">
              <Field label="Concepto">{enrichment.concepto}</Field>
            </div>
          )}
        </Grid>

        <Divider label="Facturas cubiertas" />
        {enrichment.status === 'factura-cobrada' && enrichment.facturas && enrichment.facturas.length > 0 ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-[12px] text-[var(--gray-500)]">
              <CheckCircle2 className="w-4 h-4 text-[var(--success)]" />
              {enrichment.facturas.length === 1
                ? '1 factura cobrada por este abono.'
                : `${enrichment.facturas.length} facturas cobradas por este abono (subset).`}
              {enrichment.matchTier && (
                <span
                  className="ml-auto text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded font-medium"
                  style={{
                    backgroundColor: 'white',
                    color: TIER_COLOR[enrichment.matchTier],
                    border: `1px solid ${TIER_COLOR[enrichment.matchTier]}`,
                  }}
                >
                  {TIER_LABEL[enrichment.matchTier]}
                </span>
              )}
            </div>
            <div className="border border-[var(--gray-200)] rounded-lg overflow-hidden">
              <table className="w-full text-[12px]">
                <thead className="bg-[var(--surface-alt)] text-[var(--gray-500)] text-[11px] uppercase">
                  <tr>
                    <th className="text-left px-3 py-2">Factura</th>
                    <th className="text-left px-3 py-2">Cliente</th>
                    <th className="text-right px-3 py-2">Bruto</th>
                  </tr>
                </thead>
                <tbody>
                  {enrichment.facturas.map((f, i) => (
                    <tr key={`${f.cia}-${f.noFactura}-${i}`} className="border-t border-[var(--gray-100)]">
                      <td className="px-3 py-2 tabular-nums font-medium">{f.noFactura}</td>
                      <td className="px-3 py-2">
                        <div className="text-[var(--gray-950)]">{f.nombreCliente}</div>
                        <div className="text-[10px] text-[var(--gray-400)] tabular-nums">{f.cia} · #{f.noCliente}</div>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{fmtCurrency(f.importeBruto)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {enrichment.facturas.length > 1 && (() => {
              const sumBruto = enrichment.facturas!.reduce((s, f) => s + f.importeBruto, 0);
              const delta = enrichment.importe - sumBruto;
              return (
                <div className="text-[11px] text-[var(--gray-500)] flex items-center justify-between px-3 py-2 bg-[var(--surface-alt)] rounded-md border border-[var(--gray-100)]">
                  <span>Suma de facturas: {fmtCurrency(sumBruto)}</span>
                  <span>Δ vs abono: {delta >= 0 ? '+' : ''}{fmtCurrency(delta)}</span>
                </div>
              );
            })()}
          </div>
        ) : (
          <NoMatchPanel
            icon={<AlertTriangle className="w-5 h-5 text-[var(--warning, #d97706)]" />}
            title="Este abono no cruzó con ninguna factura JDE"
            body="Posibles causas: (1) anticipo o depósito en garantía sin factura emitida; (2) factura fuera del rango cargado (>365 días); (3) monto difiere >0.5% del bruto/pendiente; (4) el cliente no aparece en cobranza JDE de la cía del abono."
          />
        )}
      </div>
    </>
  );
}

// ── Helpers visuales ───────────────────────────────────────────────────────

function Header({
  icon,
  title,
  subtitle,
  onClose,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  onClose: () => void;
}) {
  return (
    <div className="px-5 py-4 border-b border-[var(--gray-200)] bg-[var(--surface-alt)] flex items-start gap-3">
      <div className="w-8 h-8 rounded-lg bg-white border border-[var(--gray-200)] flex items-center justify-center text-[var(--gray-500)] flex-shrink-0">
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <h3 className="text-[15px] font-semibold text-[var(--gray-950)] truncate">{title}</h3>
        <p className="text-[12px] text-[var(--gray-500)] truncate">{subtitle}</p>
      </div>
      <button
        onClick={onClose}
        aria-label="Cerrar"
        className="w-7 h-7 rounded-md hover:bg-[var(--gray-100)] flex items-center justify-center text-[var(--gray-400)] hover:text-[var(--gray-950)]"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-2 gap-x-6 gap-y-3">{children}</div>;
}

function Field({
  label,
  children,
  icon,
}: {
  label: string;
  children: React.ReactNode;
  icon?: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-[var(--gray-400)] flex items-center gap-1">
        {icon}
        {label}
      </div>
      <div className="text-[13px] text-[var(--gray-950)] mt-0.5">{children}</div>
    </div>
  );
}

function Divider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 mt-2">
      <div className="flex-1 h-px bg-[var(--gray-200)]" />
      <span className="text-[10px] uppercase tracking-wider text-[var(--gray-400)] font-medium">{label}</span>
      <div className="flex-1 h-px bg-[var(--gray-200)]" />
    </div>
  );
}

function NoMatchPanel({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  // ExternalLink importado pero sin uso en esta versión — reservado para
  // un futuro link "Buscar en bancos" que abra la pestaña Bancos pre-filtrada.
  void ExternalLink;
  return (
    <div className="rounded-lg border border-[var(--gray-200)] bg-[var(--surface-alt)] p-4 flex gap-3">
      <div className="flex-shrink-0">{icon}</div>
      <div>
        <div className="text-[13px] font-semibold text-[var(--gray-950)]">{title}</div>
        <p className="text-[12px] text-[var(--gray-500)] mt-1 leading-relaxed">{body}</p>
      </div>
    </div>
  );
}
