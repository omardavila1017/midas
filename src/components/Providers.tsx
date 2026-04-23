import { useMemo, useState } from 'react';
import {
  Provider,
  ProviderRisk,
  ProviderPaymentPeriod,
  ProviderFlexibility,
} from '../domain/types';
import { fetchProviderCatalog } from '../services/catalog.service';
import {
  Plus,
  Trash2,
  RefreshCw,
  Search,
  Lock,
  Unlock,
  AlertCircle,
  HelpCircle,
  X,
} from 'lucide-react';
import PageHeader from './ui/PageHeader';

/**
 * Proveedores tab.
 * Campos por proveedor: Tipo · Riesgo · Periodo de pago · Flexibilidad.
 * Provider catalog tab with service sync and inline CRUD.
 */

const TYPE_SUGGESTIONS = [
  'Servicios', 'Filiales', 'DIESEL', 'Combustible', 'Refaccionario',
  'Seguros y fianzas', 'Bancario', 'Impuestos', 'Gubernamental', 'Automotriz', 'Otro',
];
const RISKS: ProviderRisk[] = ['Alto', 'Medio', 'Bajo'];
const PERIODS: ProviderPaymentPeriod[] = ['Contado', '15 días', '30 días', '45 días', '60 días', '90 días'];
const FLEX_VALUES: ProviderFlexibility[] = ['inamovible', 'flexible', 'revisar', 'unknown'];
const DAY_MS = 24 * 60 * 60 * 1000;

type ChipStyle = { bg: string; text: string; border: string; dot: string };

const RISK_STYLES: Record<ProviderRisk, ChipStyle> = {
  Alto:  { bg: 'var(--danger-muted)',  text: 'var(--danger)',  border: 'oklch(88% 0.08 25)',  dot: 'var(--danger)'  },
  Medio: { bg: 'var(--warning-muted)', text: 'var(--warning)', border: 'oklch(88% 0.08 70)',  dot: 'var(--warning)' },
  Bajo:  { bg: 'var(--success-muted)', text: 'var(--success)', border: 'oklch(88% 0.08 145)', dot: 'var(--success)' },
};

const FLEX_STYLES: Record<
  ProviderFlexibility,
  { label: string; short: string; bg: string; text: string; border: string; Icon: typeof Lock }
> = {
  inamovible: {
    label: 'Inamovible', short: 'Inamovible',
    bg: 'var(--danger-muted)',  text: 'var(--danger)',  border: 'oklch(88% 0.08 25)',  Icon: Lock,
  },
  flexible: {
    label: 'Flexible', short: 'Flexible',
    bg: 'var(--success-muted)', text: 'var(--success)', border: 'oklch(88% 0.08 145)', Icon: Unlock,
  },
  revisar: {
    label: 'Revisar', short: 'Revisar',
    bg: 'var(--warning-muted)', text: 'var(--warning)', border: 'oklch(88% 0.08 70)',  Icon: AlertCircle,
  },
  unknown: {
    label: 'Sin clasificar', short: 'S/C',
    bg: 'var(--gray-100)',      text: 'var(--gray-500)', border: 'var(--gray-200)',    Icon: HelpCircle,
  },
};

interface Props {
  providers: Provider[];
  onReplace: (providers: Provider[]) => void;
  onAdd: (p: Provider) => void;
  onUpdate: (p: Provider) => void;
  onDelete: (id: string) => void;
}

type RiskFilter = 'all' | ProviderRisk;
type FlexFilter = 'all' | ProviderFlexibility;

export default function Providers({ providers, onReplace, onAdd, onUpdate, onDelete }: Props) {
  const [query, setQuery] = useState('');
  const [riskFilter, setRiskFilter] = useState<RiskFilter>('all');
  const [flexFilter, setFlexFilter] = useState<FlexFilter>('all');
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Omit<Provider, 'id'>>({
    name: '',
    type: 'Servicios',
    risk: 'Medio',
    riskComment: '',
    paymentPeriod: '30 días',
    flexibility: 'unknown',
    flexibilityComment: '',
    creditLimit: undefined,
    lastUpdatedAt: new Date().toISOString(),
  });

  // ─── Aggregates for header chips ────────────────────────────────────────
  const riskCounts = useMemo(() => {
    const out: Record<ProviderRisk, number> = { Alto: 0, Medio: 0, Bajo: 0 };
    for (const p of providers) out[p.risk]++;
    return out;
  }, [providers]);

  const flexCounts = useMemo(() => {
    const out: Record<ProviderFlexibility, number> = {
      inamovible: 0, flexible: 0, revisar: 0, unknown: 0,
    };
    for (const p of providers) out[p.flexibility ?? 'unknown']++;
    return out;
  }, [providers]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return providers.filter(p => {
      if (riskFilter !== 'all' && p.risk !== riskFilter) return false;
      if (flexFilter !== 'all' && (p.flexibility ?? 'unknown') !== flexFilter) return false;
      if (q) {
        const haystack = [
          p.name,
          p.type,
          p.riskComment,
          p.flexibilityComment,
          p.paymentPeriod,
        ].filter(Boolean).join(' ').toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [providers, query, riskFilter, flexFilter]);

  const filtersActive = query.length > 0 || riskFilter !== 'all' || flexFilter !== 'all';
  const clearFilters = () => { setQuery(''); setRiskFilter('all'); setFlexFilter('all'); };

  const canAdd = draft.name.trim().length > 0;
  const addNow = () => {
    if (!canAdd) return;
    onAdd({ ...draft, name: draft.name.trim(), lastUpdatedAt: new Date().toISOString(), id: crypto.randomUUID() });
    setDraft({
      name: '',
      type: draft.type,
      risk: draft.risk,
      riskComment: '',
      paymentPeriod: draft.paymentPeriod,
      flexibility: draft.flexibility,
      flexibilityComment: '',
      creditLimit: undefined,
      lastUpdatedAt: new Date().toISOString(),
    });
  };

  const updateProvider = (provider: Provider) => {
    onUpdate({ ...provider, lastUpdatedAt: new Date().toISOString() });
  };

  const handleSyncCatalog = async () => {
    setSyncing(true);
    setSyncError(null);
    try {
      const nextProviders = await fetchProviderCatalog();
      onReplace(nextProviders);
    } catch (error) {
      setSyncError(error instanceof Error ? error.message : 'No se pudo sincronizar el catálogo.');
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Proveedores"
        actions={
          <button
            onClick={handleSyncCatalog}
            disabled={syncing}
            className="flex items-center gap-1.5 px-4 h-9 rounded-lg bg-[var(--primary)] text-white text-[13px] font-medium hover:bg-[var(--primary-hover)] hover-press"
          >
            <RefreshCw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} strokeWidth={1.5} /> Sincronizar
          </button>
        }
      />
      {syncError && (
        <p className="text-[13px] text-white/80 bg-[var(--danger)]/25 border border-[var(--danger)]/40 rounded-lg px-3 py-2">
          {syncError}
        </p>
      )}

      {/* ─── Summary strip ──────────────────────────────────────────────── */}
      {providers.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {RISKS.map(r => (
            <StatChip
              key={r}
              label={`Riesgo ${r.toLowerCase()}`}
              count={riskCounts[r]}
              style={RISK_STYLES[r]}
              active={riskFilter === r}
              onClick={() => setRiskFilter(riskFilter === r ? 'all' : r)}
            />
          ))}
          <div className="w-px self-stretch bg-[var(--gray-200)]/60 mx-1" />
          {FLEX_VALUES.map(f => {
            const s = FLEX_STYLES[f];
            return (
              <StatChip
                key={f}
                icon={<s.Icon className="w-3 h-3" />}
                label={s.label}
                count={flexCounts[f]}
                style={{ bg: s.bg, text: s.text, border: s.border, dot: s.text }}
                active={flexFilter === f}
                onClick={() => setFlexFilter(flexFilter === f ? 'all' : f)}
              />
            );
          })}
        </div>
      )}

      {/* ─── Quick add row ──────────────────────────────────────────────── */}
      <div className="bg-white border border-[var(--gray-200)]/60 rounded-xl p-4">
        <div className="text-[12px] text-[var(--gray-400)] mb-2">Agregar manualmente</div>
        <div className="flex flex-wrap gap-2 items-end">
          <div className="flex-1 min-w-[220px]">
            <input
              value={draft.name}
              onChange={e => setDraft({ ...draft, name: e.target.value })}
              onKeyDown={e => e.key === 'Enter' && addNow()}
              placeholder="Nombre del proveedor"
              className="input w-full"
            />
          </div>
          <input
            list="type-suggestions"
            value={draft.type}
            onChange={e => setDraft({ ...draft, type: e.target.value })}
            placeholder="Tipo"
            className="input w-40"
          />
          <datalist id="type-suggestions">
            {TYPE_SUGGESTIONS.map(t => <option key={t} value={t} />)}
          </datalist>
          <select
            value={draft.risk}
            onChange={e => setDraft({ ...draft, risk: e.target.value as ProviderRisk })}
            className="input w-32"
            title="Riesgo"
          >
            {RISKS.map(r => <option key={r} value={r}>Riesgo {r}</option>)}
          </select>
          <select
            value={draft.paymentPeriod}
            onChange={e => setDraft({ ...draft, paymentPeriod: e.target.value as ProviderPaymentPeriod })}
            className="input w-36"
            title="Periodo de pago"
          >
            {PERIODS.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
          <select
            value={draft.flexibility ?? 'unknown'}
            onChange={e => setDraft({ ...draft, flexibility: e.target.value as ProviderFlexibility })}
            className="input w-40"
            title="Flexibilidad"
          >
            {FLEX_VALUES.map(f => (
              <option key={f} value={f}>{FLEX_STYLES[f].label}</option>
            ))}
          </select>
          <input
            type="number"
            min={0}
            step={1000}
            value={draft.creditLimit ?? ''}
            onChange={e => setDraft({ ...draft, creditLimit: e.target.value === '' ? undefined : Number(e.target.value) })}
            placeholder="Limite credito"
            className="input w-36"
          />
          <button
            onClick={addNow}
            disabled={!canAdd}
            className={`flex items-center gap-1.5 px-4 h-9 rounded-lg text-[13px] font-medium hover-press ${
              canAdd
                ? 'bg-[var(--primary)] text-white hover:bg-[var(--primary-hover)]'
                : 'bg-[var(--gray-50)] text-[var(--gray-400)] cursor-not-allowed'
            }`}
          >
            <Plus className="w-3.5 h-3.5" /> Agregar
          </button>
        </div>
        {!canAdd && draft.name.length === 0 && (
          <div className="text-[11px] text-[var(--gray-400)] mt-2">
            Escribe un nombre para habilitar el botón.
          </div>
        )}
        <div className="grid gap-2 md:grid-cols-2 mt-3">
          <input
            value={draft.riskComment ?? ''}
            onChange={e => setDraft({ ...draft, riskComment: e.target.value })}
            placeholder="Comentario de riesgo"
            className="input w-full"
          />
          <input
            value={draft.flexibilityComment ?? ''}
            onChange={e => setDraft({ ...draft, flexibilityComment: e.target.value })}
            placeholder="Comentario de flexibilidad"
            className="input w-full"
          />
        </div>
      </div>

      {/* ─── Toolbar: search + active filters ───────────────────────────── */}
      {providers.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[240px] max-w-md">
            <Search className="w-4 h-4 text-[var(--gray-400)] absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Buscar por nombre o tipo…"
              className="input pl-9 w-full"
            />
          </div>
          {filtersActive && (
            <button
              onClick={clearFilters}
              className="flex items-center gap-1 px-3 h-9 rounded-lg text-[12px] font-medium text-[var(--gray-500)] hover:text-[var(--gray-950)] hover:bg-[var(--gray-50)] hover-press"
            >
              <X className="w-3.5 h-3.5" /> Limpiar filtros
            </button>
          )}
          <div className="ml-auto text-[12px] text-[var(--gray-400)] tabular-nums">
            {filtered.length === providers.length
              ? `${providers.length} total`
              : `${filtered.length} de ${providers.length}`}
          </div>
        </div>
      )}

      {/* ─── Table ──────────────────────────────────────────────────────── */}
      <div className="bg-white border border-[var(--gray-200)]/60 rounded-xl overflow-hidden animate-card-in">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1180px] text-[13px]">
            <thead className="bg-[var(--surface-alt)] text-[var(--gray-400)] text-left text-[11px] uppercase tracking-wide sticky top-0 z-10">
              <tr>
                <Th className="pl-5">Proveedor</Th>
                <Th>Tipo</Th>
                <Th>Riesgo</Th>
                <Th>Periodo de pago</Th>
                <Th>Flexibilidad</Th>
                <Th>Limite credito</Th>
                <Th>Ultima actualizacion</Th>
                <Th>Comentarios</Th>
                <Th className="w-10 pr-3" />
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={9} className="text-center text-[var(--gray-400)] py-12">
                    {providers.length === 0 ? (
                      <div className="flex flex-col items-center gap-2">
                        <RefreshCw className="w-5 h-5 text-[var(--gray-300)]" />
                        <div>Sin proveedores. Sincroniza el catálogo o agrega uno arriba.</div>
                      </div>
                    ) : (
                      <div className="flex flex-col items-center gap-2">
                        <Search className="w-5 h-5 text-[var(--gray-300)]" />
                        <div>Sin coincidencias con el filtro.</div>
                        {filtersActive && (
                          <button
                            onClick={clearFilters}
                            className="text-[12px] text-[var(--primary)] hover:underline"
                          >
                            Limpiar filtros
                          </button>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              )}
              {filtered.map((p, idx) => (
                <tr
                  key={p.id}
                  className={`group border-t border-[var(--gray-200)]/40 hover-row ${
                    idx % 2 === 1 ? 'bg-[var(--gray-50)]' : ''
                  }`}
                >
                  <Td className="pl-5">
                    <input
                      value={p.name}
                      onChange={e => updateProvider({ ...p, name: e.target.value })}
                      className="w-full bg-transparent focus:outline-none font-medium text-[var(--gray-950)]"
                    />
                  </Td>
                  <Td>
                    <input
                      list="type-suggestions"
                      value={p.type}
                      onChange={e => updateProvider({ ...p, type: e.target.value })}
                      className="w-full bg-transparent focus:outline-none text-[var(--gray-700)]"
                    />
                  </Td>
                  <Td>
                    <Chip style={RISK_STYLES[p.risk]} withDot>
                      <select
                        value={p.risk}
                        onChange={e => updateProvider({ ...p, risk: e.target.value as ProviderRisk })}
                        className="bg-transparent outline-none font-medium cursor-pointer"
                        style={{ color: RISK_STYLES[p.risk].text }}
                      >
                        {RISKS.map(r => <option key={r} value={r}>{r}</option>)}
                      </select>
                    </Chip>
                  </Td>
                  <Td>
                    <select
                      value={p.paymentPeriod}
                      onChange={e => updateProvider({ ...p, paymentPeriod: e.target.value as ProviderPaymentPeriod })}
                      className="bg-transparent tabular-nums text-[var(--gray-700)] cursor-pointer focus:outline-none"
                    >
                      {PERIODS.map(pr => <option key={pr} value={pr}>{pr}</option>)}
                    </select>
                  </Td>
                  <Td>
                    {(() => {
                      const fv = p.flexibility ?? 'unknown';
                      const fs = FLEX_STYLES[fv];
                      return (
                        <Chip style={{ bg: fs.bg, text: fs.text, border: fs.border, dot: fs.text }}>
                          <fs.Icon className="w-3 h-3" style={{ color: fs.text }} />
                          <select
                            value={fv}
                            onChange={e => updateProvider({ ...p, flexibility: e.target.value as ProviderFlexibility })}
                            className="bg-transparent outline-none font-medium cursor-pointer ml-1"
                            style={{ color: fs.text }}
                          >
                            {FLEX_VALUES.map(f => (
                              <option key={f} value={f}>{FLEX_STYLES[f].label}</option>
                            ))}
                          </select>
                        </Chip>
                      );
                    })()}
                  </Td>
                  <Td>
                    <input
                      type="number"
                      min={0}
                      step={1000}
                      value={p.creditLimit ?? ''}
                      onChange={e => updateProvider({ ...p, creditLimit: e.target.value === '' ? undefined : Number(e.target.value) })}
                      className="w-28 bg-transparent tabular-nums text-right focus:outline-none text-[var(--gray-700)]"
                      placeholder="Capturar"
                      title="Limite de credito capturado para este proveedor"
                    />
                  </Td>
                  <Td>
                    <div className="space-y-1">
                      <input
                        type="date"
                        value={(p.lastUpdatedAt ?? '').slice(0, 10)}
                        onChange={e => onUpdate({ ...p, lastUpdatedAt: e.target.value ? `${e.target.value}T00:00:00.000Z` : undefined })}
                        className="w-32 bg-transparent text-[12px] text-[var(--gray-700)] focus:outline-none"
                        title="Fecha de ultima actualizacion del registro de proveedor"
                      />
                      <span className={`block text-[10px] ${staleTone(p.lastUpdatedAt)}`}>
                        {daysWithoutUpdateLabel(p.lastUpdatedAt)}
                      </span>
                    </div>
                  </Td>
                  <Td>
                    <div className="space-y-1 min-w-[240px]">
                      <input
                        value={p.riskComment ?? ''}
                        onChange={e => updateProvider({ ...p, riskComment: e.target.value })}
                        placeholder="Justificacion de riesgo"
                        className="w-full bg-transparent focus:outline-none text-[11px] text-[var(--gray-500)]"
                      />
                      <input
                        value={p.flexibilityComment ?? ''}
                        onChange={e => updateProvider({ ...p, flexibilityComment: e.target.value })}
                        placeholder="Justificacion de flexibilidad"
                        className="w-full bg-transparent focus:outline-none text-[11px] text-[var(--gray-400)]"
                      />
                    </div>
                  </Td>
                  <Td className="pr-3">
                    <button
                      onClick={() => onDelete(p.id)}
                      title="Eliminar proveedor"
                      className="text-[var(--gray-300)] hover:text-[var(--danger)] hover-press opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function Th({ children, className = '' }: { children?: React.ReactNode; className?: string }) {
  return <th className={`px-4 py-2.5 font-medium ${className}`}>{children}</th>;
}

function Td({ children, className = '' }: { children?: React.ReactNode; className?: string }) {
  return <td className={`px-4 py-2.5 text-[var(--gray-950)] align-middle ${className}`}>{children}</td>;
}

function daysWithoutUpdate(value: string | undefined): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return null;
  return Math.max(0, Math.floor((Date.now() - time) / DAY_MS));
}

function daysWithoutUpdateLabel(value: string | undefined): string {
  const days = daysWithoutUpdate(value);
  if (days === null) return 'Sin fecha';
  if (days === 0) return 'Actualizado hoy';
  return `${days}d sin actualizar`;
}

function staleTone(value: string | undefined): string {
  const days = daysWithoutUpdate(value);
  if (days === null || days > 90) return 'text-[var(--danger)]';
  if (days > 30) return 'text-[var(--warning)]';
  return 'text-[var(--success)]';
}

function Chip({
  children,
  style,
  withDot = false,
}: {
  children: React.ReactNode;
  style: ChipStyle;
  withDot?: boolean;
}) {
  return (
    <div
      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-[12px]"
      style={{ backgroundColor: style.bg, borderColor: style.border }}
    >
      {withDot && (
        <span
          className="inline-block w-1.5 h-1.5 rounded-full"
          style={{ backgroundColor: style.dot }}
        />
      )}
      {children}
    </div>
  );
}

function StatChip({
  label,
  count,
  style,
  active,
  onClick,
  icon,
}: {
  label: string;
  count: number;
  style: ChipStyle;
  active: boolean;
  onClick: () => void;
  icon?: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 px-2.5 h-7 rounded-full border text-[12px] font-medium hover-press transition-shadow ${
        active ? 'shadow-sm ring-1' : ''
      }`}
      style={{
        backgroundColor: style.bg,
        borderColor: active ? style.text : style.border,
        color: style.text,
        ['--tw-ring-color' as string]: style.text,
      } as React.CSSProperties}
      title={active ? 'Quitar filtro' : `Filtrar por ${label.toLowerCase()}`}
    >
      {icon ?? (
        <span
          className="inline-block w-1.5 h-1.5 rounded-full"
          style={{ backgroundColor: style.dot }}
        />
      )}
      <span>{label}</span>
      <span className="tabular-nums opacity-70">{count}</span>
    </button>
  );
}
