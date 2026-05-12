import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Check, SkipForward, UserPlus, Search } from 'lucide-react';
import type { Client } from '../domain/types';
import type { MatchSuggestion, OrphanNoCliente, MatcherOutput } from '../domain/clientCobranzaMatcher';
import { suggestionToLink, rankClientsForAccount } from '../domain/clientCobranzaMatcher';
import { fmtSmart } from '../formatters';

interface Props {
  open: boolean;
  onClose: () => void;
  clients: Client[];
  matcherReview: MatcherOutput;
  onConfirmSuggestion: (s: MatchSuggestion, targetClientId?: string) => void;
  onIgnoreOrphan: (cia: string, noCliente: string) => void;
  onCreateClientFromOrphan: (o: OrphanNoCliente) => void;
}

type TabKey = 'suggestions' | 'orphans';

export default function ClientMatchWizard({
  open,
  onClose,
  clients,
  matcherReview,
  onConfirmSuggestion,
  onIgnoreOrphan,
  onCreateClientFromOrphan,
}: Props) {
  const [tab, setTab] = useState<TabKey>(
    matcherReview.needsReview.length > 0 ? 'suggestions' : 'orphans',
  );
  const [skipped, setSkipped] = useState<Set<string>>(new Set());

  const visibleSuggestions = useMemo(
    () => matcherReview.needsReview.filter(s => !skipped.has(`${s.cia}::${s.noCliente}`)),
    [matcherReview.needsReview, skipped],
  );
  const visibleOrphans = useMemo(
    () => matcherReview.orphanNoClientes.filter(o => !skipped.has(`${o.cia}::${o.noCliente}`)),
    [matcherReview.orphanNoClientes, skipped],
  );

  // Bloquea scroll del body mientras el modal está abierto.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [open]);

  if (!open) return null;

  const total = visibleSuggestions.length + visibleOrphans.length;

  // Portal a <body> para evitar ancestros con `transform`/`filter` que rompen
  // `position: fixed` (centrado contra el viewport real, no contra la página).
  return createPortal(
    <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[88vh] w-full max-w-4xl flex-col rounded-[var(--radius)] bg-white shadow-2xl">
        <header className="flex items-center justify-between border-b border-[var(--gray-200)] px-5 py-3">
          <div>
            <h2 className="text-[15px] font-semibold text-[var(--gray-950)]">Revisar matches cobranza ↔ catálogo</h2>
            <p className="mt-0.5 text-[12px] text-[var(--gray-400)]">
              {total > 0
                ? `${total} pendiente${total !== 1 ? 's' : ''} de decisión`
                : 'Todo conectado.'}
            </p>
          </div>
          <button onClick={onClose} className="rounded p-1 text-[var(--gray-400)] hover:bg-[var(--gray-50)] hover:text-[var(--gray-950)]">
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex gap-1 border-b border-[var(--gray-200)] px-5">
          <TabBtn active={tab === 'suggestions'} onClick={() => setTab('suggestions')}>
            Sugerencias dudosas ({visibleSuggestions.length})
          </TabBtn>
          <TabBtn active={tab === 'orphans'} onClick={() => setTab('orphans')}>
            Cuentas JDE sin asignar ({visibleOrphans.length})
          </TabBtn>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-3">
          {tab === 'suggestions' && (
            <SuggestionsList
              suggestions={visibleSuggestions}
              clients={clients}
              onConfirm={(s, targetId) => onConfirmSuggestion(s, targetId)}
              onSkip={s => setSkipped(prev => new Set(prev).add(`${s.cia}::${s.noCliente}`))}
            />
          )}
          {tab === 'orphans' && (
            <OrphansList
              orphans={visibleOrphans}
              clients={clients}
              onAssign={(o, targetClientId) => {
                onConfirmSuggestion(
                  o.bestGuess
                    ? { ...o.bestGuess, clientId: targetClientId }
                    : {
                        clientId: targetClientId,
                        cia: o.cia,
                        noCliente: o.noCliente,
                        nombreCliente: o.nombreCliente,
                        rfc: o.rfc,
                        tier: 'token-overlap',
                        confidence: 0.5,
                        invoiceCount: o.invoiceCount,
                      },
                  targetClientId,
                );
              }}
              onCreateNew={o => {
                onCreateClientFromOrphan(o);
                setSkipped(prev => new Set(prev).add(`${o.cia}::${o.noCliente}`));
              }}
              onIgnore={o => {
                onIgnoreOrphan(o.cia, o.noCliente);
                setSkipped(prev => new Set(prev).add(`${o.cia}::${o.noCliente}`));
              }}
            />
          )}
        </div>

        <footer className="flex justify-end border-t border-[var(--gray-200)] px-5 py-3">
          <button
            onClick={onClose}
            className="rounded-[var(--radius-md)] bg-[var(--gray-950)] px-3 py-1.5 text-[12px] font-medium text-white hover:opacity-90"
          >
            Cerrar
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-2 text-[12px] font-medium border-b-2 -mb-px transition-colors ${
        active
          ? 'border-[var(--gray-950)] text-[var(--gray-950)]'
          : 'border-transparent text-[var(--gray-400)] hover:text-[var(--gray-700)]'
      }`}
    >
      {children}
    </button>
  );
}

function SuggestionsList({
  suggestions,
  clients,
  onConfirm,
  onSkip,
}: {
  suggestions: MatchSuggestion[];
  clients: Client[];
  onConfirm: (s: MatchSuggestion, targetClientId?: string) => void;
  onSkip: (s: MatchSuggestion) => void;
}) {
  if (suggestions.length === 0) {
    return <EmptyState text="No hay sugerencias para revisar." />;
  }
  return (
    <ul className="space-y-2">
      {suggestions.map(s => {
        const client = clients.find(c => c.id === s.clientId);
        return (
          <li
            key={`${s.cia}::${s.noCliente}`}
            className="rounded-[var(--radius-md)] border border-[var(--gray-200)] bg-white p-3"
          >
            <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_auto_1fr_auto]">
              <Side label="Catálogo" name={client?.name ?? '(desconocido)'} sub={client?.rfc ?? client?.legalName ?? ''} />
              <div className="self-center text-[11px] text-[var(--gray-400)]">↔</div>
              <Side
                label="Cobranza"
                name={s.nombreCliente}
                sub={`${s.cia} · noCliente ${s.noCliente} · ${s.invoiceCount} fac.`}
              />
              <div className="flex flex-col items-end justify-center gap-1">
                <Badge tier={s.tier} confidence={s.confidence} />
                <div className="flex gap-1">
                  <button
                    onClick={() => onConfirm(s)}
                    className="inline-flex items-center gap-1 rounded bg-[var(--gray-950)] px-2 py-1 text-[11px] font-medium text-white hover:opacity-90"
                  >
                    <Check className="h-3 w-3" /> Confirmar
                  </button>
                  <button
                    onClick={() => onSkip(s)}
                    className="inline-flex items-center gap-1 rounded border border-[var(--gray-200)] px-2 py-1 text-[11px] font-medium text-[var(--gray-500)] hover:bg-[var(--gray-50)]"
                  >
                    <SkipForward className="h-3 w-3" /> Saltar
                  </button>
                </div>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function OrphansList({
  orphans,
  clients,
  onAssign,
  onCreateNew,
  onIgnore,
}: {
  orphans: OrphanNoCliente[];
  clients: Client[];
  onAssign: (o: OrphanNoCliente, targetClientId: string) => void;
  onCreateNew: (o: OrphanNoCliente) => void;
  onIgnore: (o: OrphanNoCliente) => void;
}) {
  if (orphans.length === 0) {
    return <EmptyState text="No hay cuentas JDE sin asignar." />;
  }
  return (
    <ul className="space-y-2">
      {orphans.map(o => (
        <OrphanCard
          key={`${o.cia}::${o.noCliente}`}
          orphan={o}
          clients={clients}
          onAssign={onAssign}
          onCreateNew={onCreateNew}
          onIgnore={onIgnore}
        />
      ))}
    </ul>
  );
}

function OrphanCard({
  orphan,
  clients,
  onAssign,
  onCreateNew,
  onIgnore,
}: {
  orphan: OrphanNoCliente;
  clients: Client[];
  onAssign: (o: OrphanNoCliente, targetClientId: string) => void;
  onCreateNew: (o: OrphanNoCliente) => void;
  onIgnore: (o: OrphanNoCliente) => void;
}) {
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);

  const nameSuggestions = useMemo(() => {
    const top = rankClientsForAccount(
      { cia: orphan.cia, noCliente: orphan.noCliente, nombreCliente: orphan.nombreCliente, rfc: orphan.rfc, invoiceCount: orphan.invoiceCount },
      clients,
      5,
    );
    const guessId = orphan.bestGuess?.clientId;
    return top.filter(s => s.clientId !== guessId);
  }, [orphan, clients]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [] as Client[];
    const scored: Array<{ c: Client; score: number }> = [];
    for (const c of clients) {
      const hay = `${c.name} ${c.legalName ?? ''} ${c.rfc ?? ''} ${c.commercialGroupName ?? ''}`.toLowerCase();
      const idx = hay.indexOf(q);
      if (idx >= 0) scored.push({ c, score: idx });
    }
    scored.sort((a, b) => a.score - b.score || a.c.name.localeCompare(b.c.name));
    return scored.slice(0, 30).map(s => s.c);
  }, [clients, query]);

  const showDropdown = focused && query.trim().length > 0;

  return (
    <li className="rounded-[var(--radius-md)] border border-[var(--gray-200)] bg-white p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <Side
          label="Cobranza sin cliente"
          name={orphan.nombreCliente}
          sub={`${orphan.cia} · noCliente ${orphan.noCliente} · ${orphan.invoiceCount} fac.${orphan.rfc ? ` · RFC ${orphan.rfc}` : ''}`}
        />
        {orphan.bestGuess && (
          <span className="rounded bg-[var(--gray-50)] px-2 py-1 text-[10.5px] text-[var(--gray-500)]">
            Mejor adivinación: {fmtSmart(orphan.bestGuess.confidence * 100)}%
          </span>
        )}
      </div>

      <div className="relative mt-2">
        <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--gray-400)]" />
        <input
          value={query}
          onChange={e => setQuery(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 150)}
          placeholder="Buscar cliente del catálogo por nombre, RFC o grupo comercial…"
          className="input h-8 w-full pl-8 text-[12px]"
        />
        {showDropdown && (
          <div className="absolute left-0 right-0 top-full z-10 mt-1 max-h-64 overflow-y-auto rounded-[var(--radius-md)] border border-[var(--gray-200)] bg-white shadow-lg">
            {results.length === 0 ? (
              <div className="px-3 py-2 text-[11px] text-[var(--gray-400)]">Sin coincidencias en el catálogo.</div>
            ) : (
              results.map(c => (
                <button
                  key={c.id}
                  onMouseDown={e => {
                    e.preventDefault();
                    onAssign(orphan, c.id);
                  }}
                  className="flex w-full flex-col items-start gap-0.5 px-3 py-1.5 text-left text-[12px] hover:bg-[var(--gray-50)]"
                >
                  <span className="font-medium text-[var(--gray-950)]">{c.name}</span>
                  <span className="text-[10.5px] text-[var(--gray-400)]">
                    {[c.commercialGroupName, c.rfc, c.legalName].filter(Boolean).join(' · ') || '—'}
                  </span>
                </button>
              ))
            )}
          </div>
        )}
      </div>

      {(orphan.bestGuess || nameSuggestions.length > 0) && (
        <div className="mt-2 flex flex-wrap gap-1">
          <span className="text-[10.5px] text-[var(--gray-400)] self-center">Sugerencias:</span>
          {orphan.bestGuess && (() => {
            const guess = clients.find(c => c.id === orphan.bestGuess!.clientId);
            if (!guess) return null;
            return (
              <button
                key={`best-${guess.id}`}
                onClick={() => onAssign(orphan, guess.id)}
                className="inline-flex items-center gap-1 rounded border border-[var(--gray-950)] bg-[var(--gray-50)] px-2 py-1 text-[11px] font-medium text-[var(--gray-950)] hover:bg-[var(--gray-100)]"
                title={`Mejor: ${guess.name} · ${Math.round(orphan.bestGuess!.confidence * 100)}%`}
              >
                <UserPlus className="h-3 w-3" /> {guess.name}
                <span className="text-[9.5px] text-[var(--gray-400)]">{Math.round(orphan.bestGuess!.confidence * 100)}%</span>
              </button>
            );
          })()}
          {nameSuggestions.map(s => {
            const c = clients.find(cl => cl.id === s.clientId);
            if (!c) return null;
            return (
              <button
                key={s.clientId}
                onClick={() => onAssign(orphan, c.id)}
                className="inline-flex items-center gap-1 rounded border border-[var(--gray-200)] px-2 py-1 text-[11px] text-[var(--gray-700)] hover:border-[var(--gray-950)] hover:bg-[var(--gray-50)]"
                title={`${c.name} · similitud ${Math.round(s.confidence * 100)}%`}
              >
                <UserPlus className="h-3 w-3" /> {c.name}
                <span className="text-[9.5px] text-[var(--gray-400)]">{Math.round(s.confidence * 100)}%</span>
              </button>
            );
          })}
        </div>
      )}

      <div className="mt-2 flex flex-wrap justify-end gap-1">
        <button
          onClick={() => onCreateNew(orphan)}
          className="inline-flex items-center gap-1 rounded border border-[var(--primary)] bg-[var(--primary-muted)] px-2 py-1 text-[11px] font-medium text-[var(--primary)] hover:bg-[var(--primary)] hover:text-white"
          title="Crear este cliente como nuevo en el catálogo"
        >
          <UserPlus className="h-3 w-3" /> Crear cliente nuevo
        </button>
        <button
          onClick={() => onIgnore(orphan)}
          className="inline-flex items-center gap-1 rounded border border-[var(--gray-200)] px-2 py-1 text-[11px] text-[var(--gray-400)] hover:text-[var(--gray-700)]"
        >
          Ignorar
        </button>
      </div>
    </li>
  );
}

function Side({ label, name, sub }: { label: string; name: string; sub: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] uppercase tracking-wide text-[var(--gray-400)]">{label}</div>
      <div className="truncate text-[13px] font-medium text-[var(--gray-950)]">{name}</div>
      {sub && <div className="truncate text-[11px] text-[var(--gray-400)]">{sub}</div>}
    </div>
  );
}

function Badge({ tier, confidence }: { tier: MatchSuggestion['tier']; confidence: number }) {
  const label =
    tier === 'rfc-exact' ? 'RFC' :
    tier === 'name-exact' ? 'Nombre' :
    tier === 'substring' ? 'Substring' :
    'Tokens';
  return (
    <span
      className="rounded px-1.5 py-0.5 text-[10px] font-medium"
      style={{ backgroundColor: 'var(--gray-50)', color: 'var(--gray-700)' }}
    >
      {label} · {Math.round(confidence * 100)}%
    </span>
  );
}

function EmptyState({ text }: { text: string }) {
  return <div className="py-10 text-center text-[12px] text-[var(--gray-400)]">{text}</div>;
}

// Helper opcional para callers que tengan un MatchSuggestion ya listo y quieran
// la conversión a JdeAccountLink directamente (re-exporta el helper del dominio).
export { suggestionToLink };
