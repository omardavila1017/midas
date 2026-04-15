import { useState } from 'react';
import {
  Provider,
  ProviderType,
  ProviderRisk,
  ProviderPaymentPeriod,
} from '../domain/types';
import { Plus, Trash2 } from 'lucide-react';

/**
 * Proveedores tab.
 *
 * Intentionally minimal per spec: only Tipo / Riesgo / Periodo de pago.
 * No invoices, no aging, no calendar here — that lives in the payment engine
 * (to be built on top of this catalog).
 */

const TYPES: ProviderType[] = ['Servicio', 'Insumo', 'Renta', 'Nómina externa', 'CAPEX', 'Otro'];
const RISKS: ProviderRisk[] = ['Alto', 'Medio', 'Bajo'];
const PERIODS: ProviderPaymentPeriod[] = ['Contado', '15 días', '30 días', '45 días', '60 días', '90 días'];

const RISK_STYLES: Record<ProviderRisk, string> = {
  Alto: 'bg-red-50 text-red-700 border-red-200',
  Medio: 'bg-amber-50 text-amber-700 border-amber-200',
  Bajo: 'bg-emerald-50 text-emerald-700 border-emerald-200',
};

interface Props {
  providers: Provider[];
  onAdd: (p: Provider) => void;
  onUpdate: (p: Provider) => void;
  onDelete: (id: string) => void;
}

export default function Providers({ providers, onAdd, onUpdate, onDelete }: Props) {
  const [draft, setDraft] = useState<Omit<Provider, 'id'>>({
    name: '',
    type: 'Servicio',
    risk: 'Medio',
    paymentPeriod: '30 días',
  });

  const add = () => {
    if (!draft.name.trim()) return;
    onAdd({ ...draft, id: crypto.randomUUID() });
    setDraft({ name: '', type: 'Servicio', risk: 'Medio', paymentPeriod: '30 días' });
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-[#1d1d1f] tracking-tight">Proveedores</h1>
        <p className="text-[13px] text-[#86868b] mt-1">
          Catálogo mínimo. Tipo · Riesgo · Periodo de pago. El calendario real de pagos se calcula
          en el motor de egresos a partir de este catálogo.
        </p>
      </div>

      {/* Form row */}
      <div className="bg-white border border-[#d2d2d7]/60 rounded-xl p-4 grid grid-cols-[1fr_160px_140px_160px_auto] gap-3 items-end">
        <Field label="Proveedor">
          <input
            value={draft.name}
            onChange={e => setDraft({ ...draft, name: e.target.value })}
            placeholder="Nombre comercial"
            className="input"
          />
        </Field>
        <Field label="Tipo">
          <select value={draft.type} onChange={e => setDraft({ ...draft, type: e.target.value as ProviderType })} className="input">
            {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </Field>
        <Field label="Riesgo">
          <select value={draft.risk} onChange={e => setDraft({ ...draft, risk: e.target.value as ProviderRisk })} className="input">
            {RISKS.map(r => <option key={r} value={r}>{r}</option>)}
          </select>
        </Field>
        <Field label="Periodo de pago">
          <select value={draft.paymentPeriod} onChange={e => setDraft({ ...draft, paymentPeriod: e.target.value as ProviderPaymentPeriod })} className="input">
            {PERIODS.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        </Field>
        <button
          onClick={add}
          className="flex items-center gap-1.5 px-4 h-9 rounded-lg bg-[#0071e3] text-white text-[13px] font-medium hover:bg-[#0077ed]"
        >
          <Plus className="w-3.5 h-3.5" /> Agregar
        </button>
      </div>

      {/* Table */}
      <div className="bg-white border border-[#d2d2d7]/60 rounded-xl overflow-hidden">
        <table className="w-full text-[13px]">
          <thead className="bg-[#f5f5f7] text-[#86868b] text-left">
            <tr>
              <Th>Proveedor</Th>
              <Th>Tipo</Th>
              <Th>Riesgo</Th>
              <Th>Periodo de pago</Th>
              <Th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {providers.length === 0 && (
              <tr><td colSpan={5} className="text-center text-[#86868b] py-10">Sin proveedores. Agrega uno arriba.</td></tr>
            )}
            {providers.map(p => (
              <tr key={p.id} className="border-t border-[#d2d2d7]/40 hover:bg-[#f5f5f7]/50">
                <Td>
                  <input
                    value={p.name}
                    onChange={e => onUpdate({ ...p, name: e.target.value })}
                    className="w-full bg-transparent focus:outline-none"
                  />
                </Td>
                <Td>
                  <select value={p.type} onChange={e => onUpdate({ ...p, type: e.target.value as ProviderType })} className="bg-transparent">
                    {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                </Td>
                <Td>
                  <span className={`inline-block px-2 py-0.5 text-[12px] rounded-full border ${RISK_STYLES[p.risk]}`}>
                    <select value={p.risk} onChange={e => onUpdate({ ...p, risk: e.target.value as ProviderRisk })} className="bg-transparent">
                      {RISKS.map(r => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </span>
                </Td>
                <Td>
                  <select value={p.paymentPeriod} onChange={e => onUpdate({ ...p, paymentPeriod: e.target.value as ProviderPaymentPeriod })} className="bg-transparent">
                    {PERIODS.map(pr => <option key={pr} value={pr}>{pr}</option>)}
                  </select>
                </Td>
                <Td>
                  <button onClick={() => onDelete(p.id)} className="text-[#86868b] hover:text-red-600">
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-[12px] text-[#86868b]">
      <span>{label}</span>
      {children}
    </label>
  );
}

function Th({ children, className = '' }: { children?: React.ReactNode; className?: string }) {
  return <th className={`px-4 py-2.5 font-medium text-[12px] uppercase tracking-wide ${className}`}>{children}</th>;
}
function Td({ children }: { children?: React.ReactNode }) {
  return <td className="px-4 py-2.5 text-[#1d1d1f]">{children}</td>;
}
