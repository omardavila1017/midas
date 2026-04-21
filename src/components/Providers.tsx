import { useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import {
  Provider,
  ProviderRisk,
  ProviderPaymentPeriod,
  ProviderFlexibility,
} from '../domain/types';
import { importProvidersFromWorkbook } from '../domain/importProviders';
import {
  Plus,
  Trash2,
  Upload as UploadIcon,
  Search,
  Lock,
  Unlock,
  AlertCircle,
  HelpCircle,
  X,
} from 'lucide-react';

/**
 * Proveedores tab.
 * Campos por proveedor: Tipo · Riesgo · Periodo de pago · Flexibilidad.
 * Importación desde Excel + CRUD inline.
 */

const TYPE_SUGGESTIONS = [
  'Servicios', 'Filiales', 'DIESEL', 'Combustible', 'Refaccionario',
  'Seguros y fianzas', 'Bancario', 'Impuestos', 'Gubernamental', 'Automotriz', 'Otro',
];
const RISKS: ProviderRisk[] = ['Alto', 'Medio', 'Bajo'];
const PERIODS: ProviderPaymentPeriod[] = ['Contado', '15 días', '30 días', '45 días', '60 días', '90 días'];
const FLEX_VALUES: ProviderFlexibility[] = ['inamovible', 'flexible', 'revisar', 'unknown'];

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
  const fileRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [riskFilter, setRiskFilter] = useState<RiskFilter>('all');
  const [flexFilter, setFlexFilter] = useState<FlexFilter>('all');
  const [draft, setDraft] = useState<Omit<Provider, 'id'>>({
    name: '',
    type: 'Servicios',
    risk: 'Medio',
    paymentPeriod: '30 días',
    flexibility: 'unknown',
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
      if (q && !p.name.toLowerCase().includes(q) && !p.type.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [providers, query, riskFilter, flexFilter]);

  const filtersActive = query.length > 0 || riskFilter !== 'all' || flexFilter !== 'all';
  const clearFilters = () => { setQuery(''); setRiskFilter('all'); setFlexFilter('all'); };

  const canAdd = draft.name.trim().length > 0;
  const addNow = () => {
    if (!canAdd) return;
    onAdd({ ...draft, name: draft.name.trim(), id: crypto.randomUUID() });
    setDraft({
      name: '',
      type: draft.type,
      risk: draft.risk,
      paymentPeriod: draft.paymentPeriod,
      flexibility: draft.flexibility,
    });
  };

  const handleFile = async (file: File) => {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array', cellDates: true });
    const result = importProvidersFromWorkbook(wb);
    onReplace(result.providers);
  };

  return (
    <div className="space-y-5">
      {/* ─── Header ─────────────────────────────────────────────────────── */}
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--gray-950)] tracking-tight">Proveedores</h1>
          <p className="text-[13px] text-[var(--gray-400)] mt-1">
            {providers.length === 0
              ? 'Importa el catálogo o agrega proveedores uno a uno.'
              : `${providers.length} ${providers.length === 1 ? 'proveedor' : 'proveedores'} en el catálogo`}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => fileRef.current?.click()}
            className="flex items-center gap-1.5 px-4 h-9 rounded-lg bg-[var(--primary)] text-white text-[13px] font-medium hover:bg-[var(--primary-hover)] hover-press"
          >
            <UploadIcon className="w-3.5 h-3.5" /> Importar Excel
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.xls"
            className="hidden"
            onChange={e => e.target.files?.[0] && handleFile(e.target.files[0])}
          />
        </div>
      </header>

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
          <table className="w-full text-[13px]">
            <thead className="bg-[var(--surface-alt)] text-[var(--gray-400)] text-left text-[11px] uppercase tracking-wide sticky top-0 z-10">
              <tr>
                <Th className="pl-5">Proveedor</Th>
                <Th>Tipo</Th>
                <Th>Riesgo</Th>
                <Th>Periodo de pago</Th>
                <Th>Flexibilidad</Th>
                <Th className="w-10 pr-3" />
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={6} className="text-center text-[var(--gray-400)] py-12">
                    {providers.length === 0 ? (
                      <div className="flex flex-col items-center gap-2">
                        <UploadIcon className="w-5 h-5 text-[var(--gray-300)]" />
                        <div>Sin proveedores. Importa un Excel o agrega uno arriba.</div>
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
                      onChange={e => onUpdate({ ...p, name: e.target.value })}
                      className="w-full bg-transparent focus:outline-none font-medium text-[var(--gray-950)]"
                    />
                  </Td>
                  <Td>
                    <input
                      list="type-suggestions"
                      value={p.type}
                      onChange={e => onUpdate({ ...p, type: e.target.value })}
                      className="w-full bg-transparent focus:outline-none text-[var(--gray-700)]"
                    />
                  </Td>
                  <Td>
                    <Chip style={RISK_STYLES[p.risk]} withDot>
                      <select
                        value={p.risk}
                        onChange={e => onUpdate({ ...p, risk: e.target.value as ProviderRisk })}
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
                      onChange={e => onUpdate({ ...p, paymentPeriod: e.target.value as ProviderPaymentPeriod })}
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
                            onChange={e => onUpdate({ ...p, flexibility: e.target.value as ProviderFlexibility })}
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
