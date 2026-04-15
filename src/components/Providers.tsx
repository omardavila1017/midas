import { useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import {
  Provider,
  ProviderRisk,
  ProviderPaymentPeriod,
} from '../domain/types';
import { importProvidersFromWorkbook } from '../domain/importProviders';
import { Plus, Trash2, Upload as UploadIcon, Search } from 'lucide-react';

/**
 * Proveedores tab.
 * Three fields per spec: Tipo · Riesgo · Periodo de pago.
 * Excel import and CRUD.
 */

const TYPE_SUGGESTIONS = [
  'Servicios', 'Filiales', 'DIESEL', 'Combustible', 'Refaccionario',
  'Seguros y fianzas', 'Bancario', 'Impuestos', 'Gubernamental', 'Automotriz', 'Otro',
];
const RISKS: ProviderRisk[] = ['Alto', 'Medio', 'Bajo'];
const PERIODS: ProviderPaymentPeriod[] = ['Contado', '15 días', '30 días', '45 días', '60 días', '90 días'];

const RISK_STYLES: Record<ProviderRisk, string> = {
  Alto: 'bg-red-50 text-red-700 border-red-200',
  Medio: 'bg-amber-50 text-amber-700 border-amber-200',
  Bajo: 'bg-emerald-50 text-emerald-700 border-emerald-200',
};

interface Props {
  providers: Provider[];
  onReplace: (providers: Provider[]) => void;
  onAdd: (p: Provider) => void;
  onUpdate: (p: Provider) => void;
  onDelete: (id: string) => void;
}

export default function Providers({ providers, onReplace, onAdd, onUpdate, onDelete }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<Omit<Provider, 'id'>>({
    name: '',
    type: 'Servicios',
    risk: 'Medio',
    paymentPeriod: '30 días',
  });

  const filtered = useMemo(() => {
    if (!query) return providers;
    const q = query.toLowerCase();
    return providers.filter(
      p => p.name.toLowerCase().includes(q) || p.type.toLowerCase().includes(q),
    );
  }, [providers, query]);

  const canAdd = draft.name.trim().length > 0;
  const addNow = () => {
    if (!canAdd) return;
    onAdd({ ...draft, name: draft.name.trim(), id: crypto.randomUUID() });
    setDraft({ name: '', type: draft.type, risk: draft.risk, paymentPeriod: draft.paymentPeriod });
  };

  const handleFile = async (file: File) => {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array', cellDates: true });
    const result = importProvidersFromWorkbook(wb);
    onReplace(result.providers);
  };

  return (
    <div className="space-y-5">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-[#1d1d1f] tracking-tight">Proveedores</h1>
          <p className="text-[13px] text-[#86868b] mt-1">
            {providers.length === 0
              ? 'Importa el catálogo o agrega proveedores uno a uno.'
              : `${providers.length} proveedores`}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => fileRef.current?.click()}
            className="flex items-center gap-1.5 px-4 h-9 rounded-lg bg-[#0071e3] text-white text-[13px] font-medium hover:bg-[#0077ed]"
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

      {/* Quick add row */}
      <div className="bg-white border border-[#d2d2d7]/60 rounded-xl p-4">
        <div className="text-[12px] text-[#86868b] mb-2">Agregar manualmente</div>
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
          >
            {RISKS.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
          <select
            value={draft.paymentPeriod}
            onChange={e => setDraft({ ...draft, paymentPeriod: e.target.value as ProviderPaymentPeriod })}
            className="input w-36"
          >
            {PERIODS.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
          <button
            onClick={addNow}
            disabled={!canAdd}
            className={`flex items-center gap-1.5 px-4 h-9 rounded-lg text-[13px] font-medium hover-press ${
              canAdd
                ? 'bg-[#0071e3] text-white hover:bg-[#0077ed]'
                : 'bg-[#f5f5f7] text-[#86868b] cursor-not-allowed'
            }`}
          >
            <Plus className="w-3.5 h-3.5" /> Agregar
          </button>
        </div>
        {!canAdd && draft.name.length === 0 && (
          <div className="text-[11px] text-[#86868b] mt-2">
            Escribe un nombre para habilitar el botón.
          </div>
        )}
      </div>

      {/* Search */}
      {providers.length > 0 && (
        <div className="relative max-w-sm">
          <Search className="w-4 h-4 text-[#86868b] absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Buscar por nombre o tipo…"
            className="input pl-9 w-full"
          />
        </div>
      )}

      {/* Table */}
      <div className="bg-white border border-[#d2d2d7]/60 rounded-xl overflow-hidden animate-card-in">
        <table className="w-full text-[13px]">
          <thead className="bg-[#fbfbfd] text-[#86868b] text-left text-[11px] uppercase tracking-wide">
            <tr>
              <Th>Proveedor</Th>
              <Th>Tipo</Th>
              <Th>Riesgo</Th>
              <Th>Periodo de pago</Th>
              <Th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={5} className="text-center text-[#86868b] py-10">
                {providers.length === 0
                  ? 'Sin proveedores. Importa un Excel o agrega uno arriba.'
                  : 'Sin coincidencias con el filtro.'}
              </td></tr>
            )}
            {filtered.map(p => (
              <tr key={p.id} className="border-t border-[#d2d2d7]/40 hover:bg-[#f5f5f7]/50 hover-row">
                <Td>
                  <input
                    value={p.name}
                    onChange={e => onUpdate({ ...p, name: e.target.value })}
                    className="w-full bg-transparent focus:outline-none"
                  />
                </Td>
                <Td>
                  <input
                    list="type-suggestions"
                    value={p.type}
                    onChange={e => onUpdate({ ...p, type: e.target.value })}
                    className="w-full bg-transparent focus:outline-none"
                  />
                </Td>
                <Td>
                  <div className={`inline-flex items-center px-2 py-0.5 rounded-full border text-[12px] ${RISK_STYLES[p.risk]}`}>
                    <select
                      value={p.risk}
                      onChange={e => onUpdate({ ...p, risk: e.target.value as ProviderRisk })}
                      className="bg-transparent outline-none"
                    >
                      {RISKS.map(r => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </div>
                </Td>
                <Td>
                  <select
                    value={p.paymentPeriod}
                    onChange={e => onUpdate({ ...p, paymentPeriod: e.target.value as ProviderPaymentPeriod })}
                    className="bg-transparent"
                  >
                    {PERIODS.map(pr => <option key={pr} value={pr}>{pr}</option>)}
                  </select>
                </Td>
                <Td>
                  <button onClick={() => onDelete(p.id)} className="text-[#86868b] hover:text-red-600 hover-press">
                    <Trash2 className="w-4 h-4" />
                  </button>
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Th({ children, className = '' }: { children?: React.ReactNode; className?: string }) {
  return <th className={`px-4 py-2.5 font-medium ${className}`}>{children}</th>;
}
function Td({ children }: { children?: React.ReactNode }) {
  return <td className="px-4 py-2.5 text-[#1d1d1f]">{children}</td>;
}
