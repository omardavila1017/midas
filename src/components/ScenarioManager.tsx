import React, { useState } from 'react';
import { Save, FolderOpen, Trash2, Check } from 'lucide-react';
import type { Proposal, Scenario } from '../types';

interface Props {
  proposals: Proposal[];
  scenarios: Scenario[];
  activeScenarioId: string | null;
  onSaveCurrent: (name: string, description?: string) => void;
  onLoad: (scenarioId: string) => void;
  onDelete: (scenarioId: string) => void;
}

function newId(): string {
  return `scen-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createScenarioFromCurrent(
  proposals: Proposal[],
  name: string,
  description?: string,
): Scenario {
  const now = new Date().toISOString();
  const states: Record<string, boolean> = {};
  for (const p of proposals) states[p.id] = p.enabled;
  return {
    id: newId(),
    name: name.trim(),
    description: description?.trim() || undefined,
    proposalStates: states,
    createdAt: now,
    updatedAt: now,
  };
}

const ScenarioManager: React.FC<Props> = ({ proposals, scenarios, activeScenarioId, onSaveCurrent, onLoad, onDelete }) => {
  const [name, setName] = useState('');
  const activeCount = proposals.filter((p) => p.enabled).length;

  const handleSave = () => {
    if (!name.trim()) return;
    onSaveCurrent(name.trim());
    setName('');
  };

  return (
    <div className="rounded-2xl border border-[var(--gray-200)] bg-white">
      <div className="px-4 py-3 border-b border-[var(--gray-100)]">
        <h3 className="text-[14px] font-semibold tracking-tight" style={{ color: 'var(--gray-950)' }}>
          Escenarios
        </h3>
        <p className="text-[11px]" style={{ color: 'var(--gray-400)' }}>
          Guarda combinaciones de propuestas como "hot switches".
        </p>
      </div>

      <div className="px-4 py-3 border-b border-[var(--gray-100)]">
        <div className="flex gap-2">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSave()}
            placeholder={`Guardar estado actual (${activeCount} activas)`}
            className="input flex-1 text-[12px]"
          />
          <button
            onClick={handleSave}
            disabled={!name.trim()}
            className="flex items-center gap-1.5 h-9 px-3 rounded-lg bg-[var(--primary)] text-white text-[12px] font-medium hover:bg-[var(--primary-hover)] disabled:opacity-40"
          >
            <Save className="w-3.5 h-3.5" />
            Guardar
          </button>
        </div>
      </div>

      {scenarios.length === 0 ? (
        <div className="px-4 py-8 text-center">
          <p className="text-[12px]" style={{ color: 'var(--gray-400)' }}>
            Aún no has guardado escenarios.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-[var(--gray-100)] max-h-[320px] overflow-y-auto">
          {scenarios.map((s) => {
            const enabledCount = Object.values(s.proposalStates).filter(Boolean).length;
            const isActive = activeScenarioId === s.id;
            return (
              <li key={s.id} className="px-4 py-3 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-[13px] font-medium truncate flex items-center gap-2" style={{ color: 'var(--gray-950)' }}>
                    {isActive && <Check className="w-3.5 h-3.5" style={{ color: 'var(--primary)' }} />}
                    {s.name}
                  </p>
                  <p className="text-[11px]" style={{ color: 'var(--gray-400)' }}>
                    {enabledCount} propuesta{enabledCount === 1 ? '' : 's'} activa{enabledCount === 1 ? '' : 's'}
                  </p>
                </div>
                <button
                  onClick={() => onLoad(s.id)}
                  title="Cargar escenario"
                  className="flex items-center gap-1 h-8 px-2.5 rounded-lg text-[12px] font-medium transition"
                  style={{
                    background: isActive ? 'var(--primary-muted)' : 'var(--gray-50)',
                    color: isActive ? 'var(--primary)' : 'var(--gray-700)',
                  }}
                >
                  <FolderOpen className="w-3.5 h-3.5" />
                  Cargar
                </button>
                <button
                  onClick={() => {
                    if (confirm(`¿Eliminar "${s.name}"?`)) onDelete(s.id);
                  }}
                  className="p-1.5 rounded hover:bg-[var(--danger)]/10 text-[var(--gray-400)] hover:text-[var(--danger)]"
                  aria-label="Eliminar escenario"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};

export default ScenarioManager;
