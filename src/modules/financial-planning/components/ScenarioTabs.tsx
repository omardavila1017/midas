import { useEffect, useRef, useState } from 'react';
import { Copy, GitBranch, Lock, MoreHorizontal, Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { fmtCompact } from '../../../formatters';
import type { FinancialScenario } from '../../shared-finance/types';

export interface ScenarioTabsProps {
  scenarios: FinancialScenario[];
  activeScenarioId: string;
  approvedFinalCash: number;
  finalCashFor: (scenarioId: string) => number;
  onSelect: (scenarioId: string) => void;
  onCreateDraft: () => void;
  onDuplicateDraft: (scenarioId: string) => void;
  onRenameDraft: (scenarioId: string, name: string) => void;
  onDiscardDraft: (scenarioId: string) => void;
}

export function ScenarioTabs(props: ScenarioTabsProps) {
  const {
    scenarios,
    activeScenarioId,
    approvedFinalCash,
    finalCashFor,
    onSelect,
    onCreateDraft,
    onDuplicateDraft,
    onRenameDraft,
    onDiscardDraft,
  } = props;

  const baseScenario = scenarios.find((s) => s.kind === 'BASE');
  const approvedScenario = scenarios.find((s) => s.kind === 'APPROVED' && !s.archivedAt);
  const drafts = scenarios.filter((s) => s.kind === 'DRAFT' && !s.archivedAt);

  return (
    <section className="rounded-[var(--radius-lg)] border border-[var(--gray-200)] bg-white px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-2 text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--gray-500)]">
          Escenarios
        </span>
        {baseScenario && (
          <CoreTab
            scenario={baseScenario}
            active={activeScenarioId === baseScenario.id}
            onClick={() => onSelect(baseScenario.id)}
            tone="base"
            delta={null}
          />
        )}
        {approvedScenario && (
          <CoreTab
            scenario={approvedScenario}
            active={activeScenarioId === approvedScenario.id}
            onClick={() => onSelect(approvedScenario.id)}
            tone="approved"
            delta={null}
          />
        )}
        <span className="mx-2 h-6 w-px bg-[var(--gray-200)]" aria-hidden="true" />
        {drafts.map((draft) => {
          const finalCash = finalCashFor(draft.id);
          const delta = finalCash - approvedFinalCash;
          return (
            <DraftTab
              key={draft.id}
              draft={draft}
              active={activeScenarioId === draft.id}
              delta={delta}
              onSelect={() => onSelect(draft.id)}
              onDuplicate={() => onDuplicateDraft(draft.id)}
              onRename={(name) => onRenameDraft(draft.id, name)}
              onDiscard={() => onDiscardDraft(draft.id)}
            />
          );
        })}
        <button
          type="button"
          onClick={onCreateDraft}
          className="inline-flex h-9 items-center gap-1.5 rounded-[var(--radius)] border border-dashed border-[var(--gray-300)] bg-white px-3 text-[12px] font-medium text-[var(--gray-500)] transition-colors duration-150 hover:border-[var(--primary)] hover:text-[var(--primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]/30"
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={1.5} />
          Nueva propuesta
        </button>
      </div>
    </section>
  );
}

function CoreTab({
  scenario,
  active,
  onClick,
  tone,
  delta,
}: {
  scenario: FinancialScenario;
  active: boolean;
  onClick: () => void;
  tone: 'base' | 'approved';
  delta: number | null;
}) {
  const Icon = tone === 'base' ? Lock : ShieldCheck;
  const badge = tone === 'base' ? 'base' : 'main';
  const bg = active ? 'var(--gray-950)' : 'white';
  const color = active ? 'white' : 'var(--gray-700)';
  const tooltip = tone === 'base'
    ? 'Solo lectura · proyección original'
    : 'Solo lectura · cambia mediante merge de un draft';
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={tooltip}
      className="inline-flex h-9 items-center gap-2 rounded-[var(--radius)] border px-3 text-[12px] font-medium transition-colors"
      style={{ background: bg, color, borderColor: active ? 'var(--gray-950)' : 'var(--gray-200)' }}
    >
      <Icon className="h-3.5 w-3.5" strokeWidth={1.5} />
      <span className="truncate max-w-[160px]">{scenario.name}</span>
      <span
        className="rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.08em]"
        style={{
          background: active ? 'rgba(255,255,255,0.15)' : 'var(--gray-100)',
          color: active ? 'white' : 'var(--gray-500)',
        }}
      >
        {badge}
      </span>
      {delta !== null && delta !== 0 && (
        <span
          className="text-[11px] tabular-nums font-bold"
          style={{ color: active ? 'rgba(255,255,255,0.85)' : delta > 0 ? 'var(--success)' : 'var(--danger)' }}
        >
          {`${delta > 0 ? '+' : ''}${fmtCompact(delta)}`}
        </span>
      )}
    </button>
  );
}

function DraftTab({
  draft,
  active,
  delta,
  onSelect,
  onDuplicate,
  onRename,
  onDiscard,
}: {
  draft: FinancialScenario;
  active: boolean;
  delta: number;
  onSelect: () => void;
  onDuplicate: () => void;
  onRename: (name: string) => void;
  onDiscard: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState(draft.name);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => setDraftName(draft.name), [draft.name]);

  useEffect(() => {
    if (!menuOpen) return;
    const handler = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  const submitRename = () => {
    const trimmed = draftName.trim();
    if (trimmed && trimmed !== draft.name) onRename(trimmed);
    setRenaming(false);
  };

  return (
    <div className="relative inline-flex items-center">
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={active}
        className="inline-flex h-9 items-center gap-2 rounded-l-[var(--radius)] border-l border-y px-3 text-[12px] font-medium transition-colors"
        style={{
          background: active ? 'var(--primary)' : 'white',
          color: active ? 'white' : 'var(--gray-700)',
          borderColor: active ? 'var(--primary)' : 'var(--gray-200)',
        }}
      >
        <GitBranch className="h-3.5 w-3.5" strokeWidth={1.5} />
        {renaming ? (
          <input
            value={draftName}
            autoFocus
            onChange={(event) => setDraftName(event.target.value)}
            onBlur={submitRename}
            onKeyDown={(event) => {
              if (event.key === 'Enter') submitRename();
              else if (event.key === 'Escape') {
                setDraftName(draft.name);
                setRenaming(false);
              }
            }}
            className="w-[140px] bg-transparent text-[12px] font-medium outline-none"
            style={{ color: active ? 'white' : 'var(--gray-950)' }}
          />
        ) : (
          <span className="truncate max-w-[160px]" onDoubleClick={() => setRenaming(true)}>
            {draft.name}
          </span>
        )}
        {delta !== 0 && (
          <span
            className="text-[11px] tabular-nums font-bold"
            style={{ color: active ? 'rgba(255,255,255,0.85)' : delta > 0 ? 'var(--success)' : 'var(--danger)' }}
          >
            {`${delta > 0 ? '+' : ''}${fmtCompact(delta)}`}
          </span>
        )}
      </button>
      <button
        type="button"
        onClick={() => setMenuOpen((open) => !open)}
        aria-label="Acciones del borrador"
        className="inline-flex h-9 w-7 items-center justify-center rounded-r-[var(--radius)] border-r border-y transition-colors"
        style={{
          background: active ? 'var(--primary)' : 'white',
          color: active ? 'white' : 'var(--gray-500)',
          borderColor: active ? 'var(--primary)' : 'var(--gray-200)',
        }}
      >
        <MoreHorizontal className="h-3.5 w-3.5" strokeWidth={1.5} />
      </button>
      {menuOpen && (
        <div
          ref={menuRef}
          className="absolute right-0 top-10 z-40 w-44 rounded-[var(--radius)] border border-[var(--gray-200)] bg-white p-1 shadow-lg"
        >
          <MenuItem
            label="Duplicar"
            icon={<Copy className="h-3.5 w-3.5" strokeWidth={1.5} />}
            onClick={() => { setMenuOpen(false); onDuplicate(); }}
          />
          <MenuItem
            label="Renombrar"
            icon={<Pencil className="h-3.5 w-3.5" strokeWidth={1.5} />}
            onClick={() => { setMenuOpen(false); setRenaming(true); }}
          />
          <div className="my-1 h-px bg-[var(--gray-100)]" />
          <MenuItem
            label="Descartar"
            icon={<Trash2 className="h-3.5 w-3.5" strokeWidth={1.5} />}
            danger
            onClick={() => { setMenuOpen(false); onDiscard(); }}
          />
        </div>
      )}
    </div>
  );
}

function MenuItem({
  label,
  icon,
  onClick,
  danger = false,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-[var(--radius-md)] px-2.5 py-1.5 text-left text-[12px] font-medium transition-colors ${
        danger ? 'text-[var(--danger)] hover:bg-[var(--danger)]/8' : 'text-[var(--gray-700)] hover:bg-[var(--gray-50)]'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}
