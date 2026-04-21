import { useMemo, useState } from 'react';
import { Client, Frequency, PaymentDayPattern, DayOfWeek, NthOfMonth, WeekOfMonth, CashFlowAssumptions } from '../domain/types';
import { parsePaymentDay } from '../domain/parsePaymentDay';
import { projectClientMonth } from '../domain/collectionEngine';
import { MONTHS } from '../types';
import { Trash2, AlertTriangle, Plus, Search, Download } from 'lucide-react';
import { toCSV, downloadFile } from '../utils/export';

/**
 * Clientes tab.
 *
 * Full CRUD backed by the client catalog service.
 * Shows per-client seasonality, parsing status, and inline corrections.
 */

interface ImportIssue {
  clientName: string;
  kind: 'no-billing' | 'unparsed-day' | 'unknown-frequency' | 'invalid-row';
  detail?: string;
}

const FREQUENCIES: Frequency[] = ['Semanal', 'Quincenal', 'Mensual', 'Contado'];
const DOW_LABELS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];
const NTH_OPTIONS: Array<{ value: NthOfMonth; label: string }> = [
  { value: 1, label: 'Primer' },
  { value: 2, label: 'Segundo' },
  { value: 3, label: 'Tercer' },
  { value: 4, label: 'Cuarto' },
  { value: -1, label: 'Último' },
];
const WEEK_OPTIONS: Array<{ value: WeekOfMonth; label: string }> = [
  { value: 1, label: '1a' },
  { value: 2, label: '2da' },
  { value: 3, label: '3ra' },
  { value: 4, label: '4ta' },
  { value: -1, label: 'Última' },
];

interface Props {
  clients: Client[];
  onReplace: (clients: Client[]) => void;
  onAdd: (c: Client) => void;
  onUpdate: (c: Client) => void;
  onDelete: (id: string) => void;
}

export default function Clients({ clients, onReplace, onAdd, onUpdate, onDelete }: Props) {
  const [issues, setIssues] = useState<ImportIssue[]>([]);
  const [query, setQuery] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const totalAnnual = useMemo(
    () => clients.reduce((a, c) => a + c.monthlyBilling.reduce((s, v) => s + v, 0), 0),
    [clients],
  );

  const totalIva = useMemo(
    () => clients.reduce((a, c) => {
      const rate = (c.ivaRate ?? 16) / 100;
      return a + c.monthlyBilling.reduce((s, v) => s + v, 0) * rate;
    }, 0),
    [clients],
  );

  // Calculate avg lag per client (credit real vs nominal)
  const lagMap = useMemo(() => {
    const map = new Map<string, number>();
    const year = new Date().getFullYear();
    const assumptions: CashFlowAssumptions = { year, globalCompliance: 1, factorajeDays: 30 };
    for (const c of clients) {
      const events = projectClientMonth(c, year, 3, assumptions); // April sample
      if (events.length > 0) {
        const avgLag = events.reduce((s, e) => s + e.lagDays, 0) / events.length;
        map.set(c.id, avgLag);
      }
    }
    return map;
  }, [clients]);

  const filtered = useMemo(() => {
    if (!query) return clients;
    const q = query.toLowerCase();
    return clients.filter(c => c.name.toLowerCase().includes(q));
  }, [clients, query]);

  const addBlank = () => {
    onAdd({
      id: crypto.randomUUID(),
      name: 'Nuevo cliente',
      paymentDay: { kind: 'DOW', days: [5] },
      frequency: 'Mensual',
      creditDays: 30,
      monthlyBilling: new Array(12).fill(0),
      ivaRate: 16,
    });
  };

  const handleExport = () => {
    const rows = clients.map(c => ({
      Nombre: c.name,
      'Día de Pago': c.paymentDayRaw ?? '',
      Frecuencia: c.frequency,
      'Días Crédito': c.creditDays,
      'Venta Mensual': c.monthlyBilling[0],
      Factoraje: c.factoraje ? 'Sí' : 'No',
    }));
    downloadFile(toCSV(rows), 'clientes-flowsense.csv');
  };

  return (
    <div className="space-y-6">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-[var(--gray-950)] tracking-tight animate-fade-in">Clientes</h1>
          <p className="text-[13px] text-[var(--gray-400)] mt-1">
            {clients.length} clientes · facturación anual {fmt(totalAnnual)} · IVA {fmt(totalIva)}
            {issues.length > 0 && (
              <span className="ml-2 text-amber-600">· {issues.length} avisos de importación</span>
            )}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={handleExport}
            title="Exportar catálogo"
            className="p-2 h-9 rounded-lg hover:bg-[var(--gray-50)] text-[var(--gray-400)] hover:text-[var(--gray-950)] transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={addBlank}
            className="flex items-center gap-1.5 px-4 h-9 rounded-lg bg-[var(--primary)] text-white text-[13px] font-medium hover:bg-[var(--primary-hover)] hover-press"
          >
            <Plus className="w-3.5 h-3.5" /> Nuevo Cliente
          </button>
        </div>
      </header>

      {/* Issues panel */}
      {issues.length > 0 && <div className="animate-slide-down"><IssuesPanel issues={issues} onDismiss={() => setIssues([])} /></div>}

      {/* Search */}
      <div className="relative">
        <Search className="w-4 h-4 text-[var(--gray-400)] absolute left-3 top-1/2 -translate-y-1/2" />
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Buscar cliente…"
          className="input pl-9 w-full max-w-sm"
        />
      </div>

      {/* Table */}
      <div className="bg-white border border-[var(--gray-200)]/60 rounded-xl overflow-hidden">
        <table className="w-full text-[13px]">
          <thead className="bg-[var(--gray-50)] text-[var(--gray-400)] text-left text-[12px] uppercase tracking-wide">
            <tr>
              <Th>Cliente</Th>
              <Th>Día de pago</Th>
              <Th>Patrón</Th>
              <Th>Frecuencia</Th>
              <Th className="text-right">Crédito</Th>
              <Th className="text-right">Lag</Th>
              <Th className="text-right">Crédito Real</Th>
              <Th className="text-right">Anual</Th>
              <Th className="text-right">IVA</Th>
              <Th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={10} className="text-center text-[var(--gray-400)] py-10">
                {clients.length === 0
                  ? 'Sin clientes. Sincroniza el catálogo o agrega uno manual.'
                  : 'Sin coincidencias.'}
              </td></tr>
            )}
            {filtered.map((c, idx) => {
              const annual = c.monthlyBilling.reduce((s, v) => s + v, 0);
              const ivaRate = c.ivaRate ?? 16;
              const ivaAmount = annual * ivaRate / 100;
              const parsed = c.paymentDayRaw ? parsePaymentDay(c.paymentDayRaw) : c.paymentDay;
              const isOpen = expandedId === c.id;
              const avgLag = lagMap.get(c.id) ?? 0;
              const realCredit = c.creditDays + Math.round(avgLag);
              return (
                <>
                  <tr
                    key={c.id}
                    className={`border-t border-[var(--gray-200)]/40 hover:bg-[var(--gray-50)]/40 cursor-pointer hover-row stagger-${Math.min(idx + 1, 10)}`}
                    onClick={() => setExpandedId(isOpen ? null : c.id)}
                  >
                    <Td>
                      <div className="flex items-center gap-2">
                        {c.factoraje && <span className="text-[11px] bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded">Factoraje</span>}
                        <span className="font-medium">{c.name}</span>
                        <span className={`text-[11px] px-1.5 py-0.5 rounded ${ivaRate === 8 ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'}`}>
                          IVA {ivaRate}%
                        </span>
                      </div>
                    </Td>
                    <Td>
                      <span className="text-[var(--gray-400)]">{c.paymentDayRaw ?? '—'}</span>
                    </Td>
                    <Td>
                      {parsed
                        ? <span className="text-emerald-700 text-[12px]">{renderPattern(parsed)}</span>
                        : <span className="text-amber-600 text-[12px] flex items-center gap-1">
                            <AlertTriangle className="w-3 h-3" /> no interpretado
                          </span>}
                    </Td>
                    <Td>{c.frequency}</Td>
                    <Td className="text-right tabular-nums">{c.creditDays}d</Td>
                    <Td className="text-right tabular-nums">
                      {avgLag > 0
                        ? <span className="text-[var(--danger)] text-[12px] font-medium">+{avgLag.toFixed(0)}d</span>
                        : <span className="text-[var(--success)] text-[12px]">0d</span>}
                    </Td>
                    <Td className="text-right tabular-nums">
                      {realCredit > c.creditDays
                        ? <span className="font-semibold text-[var(--danger)]">{realCredit}d</span>
                        : <span className="text-[var(--success)]">{realCredit}d</span>}
                    </Td>
                    <Td className="text-right tabular-nums font-medium">{fmt(annual)}</Td>
                    <Td className="text-right tabular-nums text-[var(--gray-400)]">{fmt(ivaAmount)}</Td>
                    <Td>
                      <button
                        onClick={(e) => { e.stopPropagation(); onDelete(c.id); }}
                        className="text-[var(--gray-400)] hover:text-red-600"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </Td>
                  </tr>
                  {isOpen && (
                    <tr className="border-t border-[var(--gray-200)]/40 bg-[var(--surface-alt)]">
                      <td colSpan={9} className="px-4 py-4">
                        <ClientEditor client={c} onChange={onUpdate} />
                      </td>
                    </tr>
                  )}
                </>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline editor (expanded row)
// ---------------------------------------------------------------------------
function ClientEditor({ client, onChange }: { client: Client; onChange: (c: Client) => void }) {
  const update = (patch: Partial<Client>) => onChange({ ...client, ...patch });
  const ivaRate = (client.ivaRate ?? 16) / 100;

  return (
    <div className="grid grid-cols-[1fr_1fr] gap-6">
      {/* Left column — catalog fields */}
      <div className="space-y-3">
        <Field label="Nombre">
          <input value={client.name} onChange={e => update({ name: e.target.value })} className="input w-full" />
        </Field>
        <Field label="Patrón de pago">
          <PatternEditor pattern={client.paymentDay} onChange={p => update({ paymentDay: p })} />
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Frecuencia">
            <select
              value={client.frequency}
              onChange={e => update({ frequency: e.target.value as Frequency })}
              className="input w-full"
            >
              {FREQUENCIES.map(f => <option key={f} value={f}>{f}</option>)}
            </select>
          </Field>
          <Field label="Días crédito">
            <input
              type="number"
              value={client.creditDays}
              onChange={e => update({ creditDays: Number(e.target.value) })}
              className="input w-full"
            />
          </Field>
          <Field label="Tasa IVA">
            <select
              value={client.ivaRate ?? 16}
              onChange={e => update({ ivaRate: Number(e.target.value) as 8 | 16 })}
              className="input w-full"
            >
              <option value={16}>16% — General</option>
              <option value={8}>8% — Frontera Norte</option>
            </select>
          </Field>
        </div>
        <label className="flex items-center gap-2 text-[13px]">
          <input
            type="checkbox"
            checked={!!client.factoraje}
            onChange={e => update({ factoraje: e.target.checked })}
          />
          Factoraje (ignora patrón, paga a los pocos días)
        </label>
      </div>

      {/* Right column — seasonality + IVA */}
      <div className="space-y-3">
        <div>
          <div className="text-[12px] text-[var(--gray-400)] mb-1.5">Facturación mensual (sin IVA)</div>
          <div className="grid grid-cols-6 gap-1.5">
            {MONTHS.map((m, i) => (
              <label key={m} className="flex flex-col">
                <span className="text-[11px] text-[var(--gray-400)] text-center">{m}</span>
                <input
                  type="number"
                  value={client.monthlyBilling[i] ?? 0}
                  onChange={e => {
                    const next = [...client.monthlyBilling];
                    next[i] = Number(e.target.value);
                    update({ monthlyBilling: next });
                  }}
                  className="input text-right tabular-nums text-[12px] px-1.5"
                />
              </label>
            ))}
          </div>
        </div>
        <div className="bg-[var(--gray-50)] rounded-lg px-3 py-2 text-[12px] grid grid-cols-3 gap-x-4">
          <div>
            <div className="text-[var(--gray-400)]">Base gravable anual</div>
            <div className="font-semibold tabular-nums text-[var(--gray-950)]">
              {fmt(client.monthlyBilling.reduce((s, v) => s + v, 0))}
            </div>
          </div>
          <div>
            <div className="text-[var(--gray-400)]">IVA ({(client.ivaRate ?? 16)}%)</div>
            <div className="font-semibold tabular-nums text-[var(--primary)]">
              {fmt(client.monthlyBilling.reduce((s, v) => s + v, 0) * ivaRate)}
            </div>
          </div>
          <div>
            <div className="text-[var(--gray-400)]">Total con IVA</div>
            <div className="font-semibold tabular-nums text-[var(--gray-950)]">
              {fmt(client.monthlyBilling.reduce((s, v) => s + v, 0) * (1 + ivaRate))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pattern editor — toggles DOW / DOM / NTH_DOW / DOM_LIST
// ---------------------------------------------------------------------------
function PatternEditor({ pattern, onChange }: { pattern: PaymentDayPattern; onChange: (p: PaymentDayPattern) => void }) {
  return (
    <div className="space-y-2">
      <select
        value={pattern.kind}
        onChange={e => {
          const kind = e.target.value as PaymentDayPattern['kind'];
          if (kind === 'ANY') onChange({ kind });
          else if (kind === 'DOW') onChange({ kind, days: [5] });
          else if (kind === 'DOM') onChange({ kind, day: 15 });
          else if (kind === 'DOM_LIST') onChange({ kind, days: [10, 25] });
          else if (kind === 'NTH_DOW') onChange({ kind, nth: 1, day: 5 });
          else if (kind === 'NTH_DOW_SET') onChange({ kind, nths: [2, 4], day: 4 });
          else onChange({ kind: 'WOM', weeks: [1, 3] });
        }}
        className="input w-full"
      >
        <option value="ANY">Cualquier día</option>
        <option value="DOW">Día(s) de semana</option>
        <option value="DOM">Día del mes</option>
        <option value="DOM_LIST">Varios días del mes</option>
        <option value="NTH_DOW">N-ésimo día de semana del mes</option>
        <option value="NTH_DOW_SET">Varios cortes del mismo día</option>
        <option value="WOM">Semana(s) del mes</option>
      </select>
      {pattern.kind === 'ANY' && (
        <div className="text-[12px] text-[var(--gray-400)]">Sin restricción de fecha exacta; el pago cae en la fecha teórica.</div>
      )}
      {pattern.kind === 'DOW' && (
        <div className="flex gap-1">
          {DOW_LABELS.map((lbl, i) => (
            <button
              key={lbl}
              onClick={() => {
                const has = pattern.days.includes(i as DayOfWeek);
                const days = has ? pattern.days.filter(d => d !== i) : [...pattern.days, i as DayOfWeek];
                onChange({ kind: 'DOW', days: days.sort() as DayOfWeek[] });
              }}
              className={`px-2 py-1 text-[12px] rounded border ${
                pattern.days.includes(i as DayOfWeek)
                  ? 'bg-[var(--primary)] text-white border-[var(--primary)]'
                  : 'bg-white border-[var(--gray-200)] text-[var(--gray-400)]'
              }`}
            >{lbl}</button>
          ))}
        </div>
      )}
      {pattern.kind === 'DOM' && (
        <input
          type="number" min={1} max={31}
          value={pattern.day}
          onChange={e => onChange({ kind: 'DOM', day: Number(e.target.value) })}
          className="input w-24"
        />
      )}
      {pattern.kind === 'DOM_LIST' && (
        <input
          value={pattern.days.join(', ')}
          onChange={e => {
            const days = e.target.value.split(',').map(s => Number(s.trim())).filter(n => n >= 1 && n <= 31);
            onChange({ kind: 'DOM_LIST', days });
          }}
          placeholder="10, 25"
          className="input w-40"
        />
      )}
      {pattern.kind === 'NTH_DOW' && (
        <div className="flex gap-2">
          <select
            value={pattern.nth}
            onChange={e => onChange({ ...pattern, nth: Number(e.target.value) as NthOfMonth })}
            className="input"
          >
            {NTH_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          <select
            value={pattern.day}
            onChange={e => onChange({ ...pattern, day: Number(e.target.value) as DayOfWeek })}
            className="input"
          >
            {DOW_LABELS.map((l, i) => <option key={l} value={i}>{l}</option>)}
          </select>
          <span className="self-center text-[12px] text-[var(--gray-400)]">del mes</span>
        </div>
      )}
      {pattern.kind === 'NTH_DOW_SET' && (
        <div className="space-y-2">
          <div className="flex gap-1 flex-wrap">
            {NTH_OPTIONS.map(option => (
              <button
                key={option.value}
                onClick={() =>
                  onChange({
                    ...pattern,
                    nths: toggleOrdered(pattern.nths, option.value),
                  })
                }
                className={`px-2 py-1 text-[12px] rounded border ${
                  pattern.nths.includes(option.value)
                    ? 'bg-[var(--primary)] text-white border-[var(--primary)]'
                    : 'bg-white border-[var(--gray-200)] text-[var(--gray-400)]'
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <select
              value={pattern.day}
              onChange={e => onChange({ ...pattern, day: Number(e.target.value) as DayOfWeek })}
              className="input"
            >
              {DOW_LABELS.map((l, i) => <option key={l} value={i}>{l}</option>)}
            </select>
            <span className="text-[12px] text-[var(--gray-400)]">del mes</span>
          </div>
        </div>
      )}
      {pattern.kind === 'WOM' && (
        <div className="flex gap-1 flex-wrap">
          {WEEK_OPTIONS.map(option => (
            <button
              key={option.value}
              onClick={() =>
                onChange({
                  kind: 'WOM',
                  weeks: toggleOrdered(pattern.weeks, option.value),
                })
              }
              className={`px-2 py-1 text-[12px] rounded border ${
                pattern.weeks.includes(option.value)
                  ? 'bg-[var(--primary)] text-white border-[var(--primary)]'
                  : 'bg-white border-[var(--gray-200)] text-[var(--gray-400)]'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Issues panel
// ---------------------------------------------------------------------------
function IssuesPanel({ issues, onDismiss }: { issues: ImportIssue[]; onDismiss: () => void }) {
  return (
    <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 hover-lift">
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-2 text-amber-800 font-medium text-[13px]">
          <AlertTriangle className="w-4 h-4" /> {issues.length} avisos de importación
        </div>
        <button onClick={onDismiss} className="text-[12px] text-amber-700 hover:underline">Ocultar</button>
      </div>
      <div className="text-[12px] text-amber-800 max-h-40 overflow-y-auto space-y-0.5">
        {issues.slice(0, 50).map((i, k) => (
          <div key={k}>
            <span className="font-medium">{i.clientName}</span>
            {' — '}
            {i.kind === 'no-billing' && 'sin facturación disponible'}
            {i.kind === 'unparsed-day' && `día de pago no reconocido: "${i.detail}"`}
            {i.kind === 'unknown-frequency' && `frecuencia desconocida: "${i.detail}"`}
            {i.kind === 'invalid-row' && (i.detail ?? 'fila inválida')}
          </div>
        ))}
        {issues.length > 50 && <div>…y {issues.length - 50} más</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function renderPattern(p: PaymentDayPattern): string {
  switch (p.kind) {
    case 'ANY':
      return 'Cualquier día';
    case 'DOW':
      return p.days.map(d => DOW_LABELS[d]).join(', ');
    case 'DOM':
      return `Día ${p.day}`;
    case 'DOM_LIST':
      return `Días ${formatDayList(p.days)}`;
    case 'NTH_DOW': {
      const nthLbl = p.nth === -1 ? 'Último' : ['', 'Primer', 'Segundo', 'Tercer', 'Cuarto'][p.nth];
      return `${nthLbl} ${DOW_LABELS[p.day]}`;
    }
    case 'NTH_DOW_SET':
      return `${formatOrdinalList(p.nths)} ${DOW_LABELS[p.day]}`;
    case 'WOM':
      return `${formatWeekList(p.weeks)} semana`;
  }
}

function toggleOrdered<T extends number>(values: T[], next: T): T[] {
  const updated = values.includes(next) ? values.filter(v => v !== next) : [...values, next];
  return [...new Set(updated)].sort((a, b) => sortPatternNumber(a) - sortPatternNumber(b)) as T[];
}

function formatDayList(days: number[]): string {
  const sorted = [...days].sort((a, b) => a - b);
  const isContiguous = sorted.every((day, idx) => idx === 0 || day === sorted[idx - 1] + 1);
  if (sorted.length > 1 && isContiguous) return `${sorted[0]}-${sorted[sorted.length - 1]}`;
  return sorted.join(', ');
}

function formatOrdinalList(nths: NthOfMonth[]): string {
  return nths
    .map(nth => nth === -1 ? 'Último' : ['', 'Primer', 'Segundo', 'Tercer', 'Cuarto'][nth])
    .join(' y ');
}

function formatWeekList(weeks: WeekOfMonth[]): string {
  const labels = weeks.map(week => week === -1 ? 'Última' : `${week}a`);
  return labels.join(' y ');
}

function sortPatternNumber(value: number): number {
  return value === -1 ? 99 : value;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-[12px] text-[var(--gray-400)]">
      <span>{label}</span>
      {children}
    </label>
  );
}
function Th({ children, className = '' }: { children?: React.ReactNode; className?: string }) {
  return <th className={`px-4 py-2.5 font-medium ${className}`}>{children}</th>;
}
function Td({ children, className = '' }: { children?: React.ReactNode; className?: string }) {
  return <td className={`px-4 py-2.5 text-[var(--gray-950)] ${className}`}>{children}</td>;
}
function fmt(n: number): string {
  return n.toLocaleString('es-MX', { maximumFractionDigits: 0 });
}
