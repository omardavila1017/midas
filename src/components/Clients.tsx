import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Client, Frequency, PaymentDayPattern, DayOfWeek, NthOfMonth, WeekOfMonth, CashFlowAssumptions, ConfirmedPayment } from '../domain/types';
import type { CobranzaRecord } from '../services/jdeTypes';
import { parsePaymentDay } from '../domain/parsePaymentDay';
import { projectClientMonth } from '../domain/collectionEngine';
import {
  buildClientHierarchy,
  commercialGroupId,
  type ClientAccountNode,
  type ClientGroupNode,
  type ClientGroupSource,
} from '../domain/clientGrouping';
import {
  buildCobranzaByAccount,
  computeMonthlyBilling,
  type CobranzaByAccount,
  type ClientMonthlyBilling,
} from '../domain/clientBillingHistory';
import { MONTHS } from '../types';
import {
  Trash2,
  AlertTriangle,
  Search,
  Download,
  ChevronDown,
  ChevronRight,
  FolderPlus,
  Pencil,
  Lock,
  TrendingUp,
  Info,
} from 'lucide-react';
import { toCSV, downloadFile } from '../utils/export';
import { fmtSmart, todayISO } from '../formatters';
import PageHeader from './ui/PageHeader';
import ClientMatchWizard from './ClientMatchWizard';

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
  assumptions: CashFlowAssumptions;
  confirmedPayments: ConfirmedPayment[];
  cobranzaRecords: CobranzaRecord[];
  matcherReview: import('../domain/clientCobranzaMatcher').MatcherOutput;
  onReplace: (clients: Client[]) => void;
  onAdd: (c: Client) => void;
  onUpdate: (c: Client) => void;
  onDelete: (id: string) => void;
  onConfirmMatch: (s: import('../domain/clientCobranzaMatcher').MatchSuggestion, targetClientId?: string) => void;
  onIgnoreOrphan: (cia: string, noCliente: string) => void;
  onCreateClientFromOrphan: (o: import('../domain/clientCobranzaMatcher').OrphanNoCliente) => void;
}

type SortKey = 'sales-desc' | 'sales-asc' | 'credit-desc' | 'credit-asc' | 'real-credit-desc' | 'real-credit-asc' | 'name-asc';

export default function Clients({ clients, assumptions, confirmedPayments, cobranzaRecords, matcherReview, onReplace, onAdd, onUpdate, onDelete, onConfirmMatch, onIgnoreOrphan, onCreateClientFromOrphan }: Props) {
  void onAdd; // reservado para alta manual; el wizard delega en onConfirmMatch
  const [sortKey, setSortKey] = useState<SortKey>('sales-desc');
  const [wizardOpen, setWizardOpen] = useState(false);
  const [issues, setIssues] = useState<ImportIssue[]>([]);
  const [query, setQuery] = useState('');
  const [expandedAccountId, setExpandedAccountId] = useState<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [renameDrafts, setRenameDrafts] = useState<Record<string, string>>({});
  const today = useMemo(() => todayISO(), []);

  const hierarchy = useMemo(
    () => buildClientHierarchy(clients, { assumptions, confirmedPayments, today, cobranzaRecords }),
    [clients, assumptions, confirmedPayments, today, cobranzaRecords],
  );

  const cobranzaByAccount = useMemo<CobranzaByAccount>(
    () => buildCobranzaByAccount(cobranzaRecords),
    [cobranzaRecords],
  );

  const referenceMonth = useMemo(() => {
    const d = new Date(`${today}T12:00:00`);
    return d.getFullYear() * 12 + d.getMonth();
  }, [today]);

  const billingMap = useMemo(() => {
    const map = new Map<string, ClientMonthlyBilling>();
    for (const c of clients) {
      map.set(c.id, computeMonthlyBilling(c, cobranzaByAccount, assumptions.year, referenceMonth));
    }
    return map;
  }, [clients, cobranzaByAccount, assumptions.year, referenceMonth]);

  // Persist derived monthlyBilling back to the client record so downstream
  // engines (collection, forecast, projection) consume the regression output
  // — not stale Excel seed values. Only fires when the derived array differs
  // and the client actually has cobranza data to learn from.
  useEffect(() => {
    if (cobranzaRecords.length === 0) return;
    const next: Client[] = [];
    let changed = false;
    for (const c of clients) {
      const derived = billingMap.get(c.id);
      if (!derived || derived.historicalMonths === 0) { next.push(c); continue; }
      const same = c.monthlyBilling.length === 12 && derived.values.every((v, i) =>
        Math.abs((c.monthlyBilling[i] ?? 0) - v) < 0.5
      );
      if (same) { next.push(c); continue; }
      changed = true;
      next.push({ ...c, monthlyBilling: derived.values.slice() });
    }
    if (changed) onReplace(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [billingMap, cobranzaRecords.length]);

  // Calculate avg lag per client (credit real vs nominal)
  const lagMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const c of clients) {
      const events = projectClientMonth(c, assumptions.year, new Date(`${today}T12:00:00`).getMonth(), assumptions);
      if (events.length > 0) {
        const avgLag = events.reduce((s, e) => s + e.lagDays, 0) / events.length;
        map.set(c.id, avgLag);
      }
    }
    return map;
  }, [clients, assumptions, today]);

  const groupNominalCredit = (g: ClientGroupNode): number => g.creditDaysApi;

  const filteredGroups = useMemo(() => {
    const q = query.toLowerCase();
    const base = !query ? hierarchy : (hierarchy
      .map(group => {
        const groupMatches = group.name.toLowerCase().includes(q);
        const accounts = groupMatches
          ? group.accounts
          : group.accounts.filter(account =>
              [
                account.client.name,
                account.client.legalName,
                account.client.rfc,
                account.client.emailDomain,
                account.client.address,
              ].filter(Boolean).join(' ').toLowerCase().includes(q)
            );
        return accounts.length ? { ...group, accounts } : null;
      })
      .filter(Boolean) as ClientGroupNode[]);

    const sorted = [...base];
    sorted.sort((a, b) => {
      switch (sortKey) {
        case 'sales-asc': return a.annualSales - b.annualSales;
        case 'sales-desc': return b.annualSales - a.annualSales;
        case 'credit-asc': return groupNominalCredit(a) - groupNominalCredit(b);
        case 'credit-desc': return groupNominalCredit(b) - groupNominalCredit(a);
        case 'real-credit-asc': return a.realCreditDays - b.realCreditDays;
        case 'real-credit-desc': return b.realCreditDays - a.realCreditDays;
        case 'name-asc': return a.name.localeCompare(b.name, 'es');
      }
    });
    return sorted;
  }, [hierarchy, query, sortKey]);

  const selectedClients = useMemo(
    () => clients.filter(client => selectedIds.has(client.id)),
    [clients, selectedIds],
  );

  const groupOptions = useMemo(
    () => hierarchy.map(group => ({ id: group.id, name: group.name })),
    [hierarchy],
  );

  const handleExport = () => {
    const groupByClientId = new Map<string, ClientGroupNode>();
    hierarchy.forEach(group => group.accounts.forEach(account => groupByClientId.set(account.client.id, group)));
    const rows = clients.map(c => {
      const group = groupByClientId.get(c.id);
      return {
        'Grupo comercial': group?.name ?? '',
        'Fuente agrupación': group ? sourceLabel(group.source) : '',
        Nombre: c.name,
        'Razón social': c.legalName ?? '',
        RFC: c.rfc ?? '',
        Dominio: c.emailDomain ?? '',
        Dirección: c.address ?? '',
        'Día de pago': c.paymentDayRaw ?? '',
        Frecuencia: c.frequency,
        'Días crédito': c.creditDays,
        'Venta mensual': c.monthlyBilling[0],
        Factoraje: c.factoraje ? 'Sí' : 'No',
      };
    });
    downloadFile(toCSV(rows), 'clientes-midas.csv');
  };

  const toggleGroup = (groupId: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  const toggleSelected = (clientId: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(clientId)) next.delete(clientId);
      else next.add(clientId);
      return next;
    });
  };

  const toggleGroupSelection = (group: ClientGroupNode) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      const allSelected = group.accounts.every(account => next.has(account.client.id));
      group.accounts.forEach(account => {
        if (allSelected) next.delete(account.client.id);
        else next.add(account.client.id);
      });
      return next;
    });
  };

  const moveAccountToGroup = (clientId: string, groupId: string) => {
    if (groupId === '__auto__') {
      const client = clients.find(c => c.id === clientId);
      if (client) clearManualGroup(client);
      return;
    }

    const target = hierarchy.find(group => group.id === groupId);
    if (!target) return;
    onReplace(clients.map(client => client.id === clientId
      ? { ...client, commercialGroupName: target.name, commercialGroupId: target.id, manualGroupOverride: true }
      : client
    ));
    setExpandedGroups(prev => new Set(prev).add(target.id));
  };

  const separateAccount = (clientId: string) => {
    onReplace(clients.map(client => client.id === clientId
      ? {
          ...client,
          commercialGroupName: client.name,
          commercialGroupId: `client-single-${client.id}`,
          manualGroupOverride: true,
        }
      : client
    ));
    setExpandedAccountId(null);
  };

  const renameGroup = (group: ClientGroupNode) => {
    const name = (renameDrafts[group.id] ?? group.name).trim();
    if (!name) return;
    const id = commercialGroupId(name);
    const accountIds = new Set(group.accounts.map(account => account.client.id));
    onReplace(clients.map(client => accountIds.has(client.id)
      ? { ...client, commercialGroupName: name, commercialGroupId: id, manualGroupOverride: true }
      : client
    ));
    setRenameDrafts(prev => {
      const next = { ...prev };
      delete next[group.id];
      return next;
    });
    setExpandedGroups(prev => {
      const next = new Set(prev);
      next.delete(group.id);
      next.add(id);
      return next;
    });
  };

  const clearManualGroup = (client: Client) => {
    onUpdate({
      ...client,
      commercialGroupName: undefined,
      commercialGroupId: undefined,
      manualGroupOverride: false,
    });
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Clientes"
        actions={
          <div className="flex items-center gap-2">
            {(matcherReview.needsReview.length + matcherReview.orphanNoClientes.length) > 0 && (
              <button
                onClick={() => setWizardOpen(true)}
                className="h-9 inline-flex items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--gray-200)] bg-white px-3 text-[12px] font-medium text-[var(--gray-700)] hover:bg-[var(--gray-50)]"
                title="Revisar matches cobranza ↔ catálogo"
              >
                <Info className="h-3.5 w-3.5" />
                Revisar matches ({matcherReview.needsReview.length + matcherReview.orphanNoClientes.length})
              </button>
            )}
            <button
              onClick={handleExport}
              title="Exportar catálogo"
              className="p-2 h-9 rounded-[var(--radius-md)] bg-white border border-[var(--gray-200)] hover:bg-[var(--gray-50)] text-[var(--gray-500)] hover:text-[var(--gray-950)] transition-colors"
            >
              <Download className="w-4 h-4" strokeWidth={1.5} />
            </button>
          </div>
        }
      />

      <ClientMatchWizard
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        clients={clients}
        matcherReview={matcherReview}
        onConfirmSuggestion={(s, targetClientId) => onConfirmMatch(s, targetClientId)}
        onIgnoreOrphan={onIgnoreOrphan}
        onCreateClientFromOrphan={onCreateClientFromOrphan}
      />

      {/* Issues panel */}
      {issues.length > 0 && <div className="animate-slide-down"><IssuesPanel issues={issues} onDismiss={() => setIssues([])} /></div>}

      {/* Search + grouping actions */}
      <div className="rounded-[var(--radius)] border border-[var(--gray-200)] bg-white p-3 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[260px] flex-1">
            <Search className="w-4 h-4 text-[var(--gray-400)] absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Buscar grupo, cuenta, RFC o dominio"
              className="input pl-9 w-full"
            />
          </div>
          <select
            value={sortKey}
            onChange={e => setSortKey(e.target.value as SortKey)}
            className="input h-9 text-[12px] w-56"
            title="Ordenar grupos"
          >
            <option value="sales-desc">Ingresos: mayor a menor</option>
            <option value="sales-asc">Ingresos: menor a mayor</option>
            <option value="credit-desc">Días crédito: mayor a menor</option>
            <option value="credit-asc">Días crédito: menor a mayor</option>
            <option value="real-credit-desc">Crédito real: mayor a menor</option>
            <option value="real-credit-asc">Crédito real: menor a mayor</option>
            <option value="name-asc">Nombre A–Z</option>
          </select>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-[var(--gray-400)]">
          <FolderPlus className="h-3.5 w-3.5" />
          {selectedIds.size > 0
            ? `${selectedIds.size} cuenta${selectedIds.size !== 1 ? 's' : ''} seleccionada${selectedIds.size !== 1 ? 's' : ''}`
            : '0 cuentas seleccionadas'}
          {selectedClients.length > 0 && (
            <span className="truncate text-[var(--gray-500)]">
              {selectedClients.slice(0, 3).map(c => c.name).join(' · ')}
              {selectedClients.length > 3 ? ` · +${selectedClients.length - 3}` : ''}
            </span>
          )}
        </div>
      </div>

      {/* Hierarchy table */}
      <div className="bg-white border border-[var(--gray-200)]/60 rounded-[var(--radius)] overflow-hidden">
        <div className="overflow-x-auto">
        <table className="min-w-[980px] w-full text-[13px]">
          <thead className="bg-[var(--gray-50)] text-[var(--gray-400)] text-left text-[12px] uppercase tracking-wide">
            <tr>
              <Th className="w-9" />
              <Th>Grupo / cuenta</Th>
              <Th className="text-right">Cuentas / frecuencia</Th>
              <Th className="text-right">Ventas</Th>
              <Th className="text-right">Por cobrar</Th>
              <Th className="text-right">Facturas</Th>
              <Th className="text-right" title="Días de crédito según JDE (Dias_Credito)">Días crédito</Th>
              <Th className="text-right" title="Días reales hasta cobro = crédito API + lag observado">Crédito real</Th>
              <Th className="w-64">Acciones</Th>
            </tr>
          </thead>
          <tbody>
            {filteredGroups.length === 0 && (
              <tr><td colSpan={9} className="text-center text-[var(--gray-400)] py-10">
                {clients.length === 0
                  ? 'Sin clientes. Sincroniza el catálogo o agrega uno manual.'
                  : 'Sin coincidencias.'}
              </td></tr>
            )}
            {filteredGroups.map((group, idx) => {
              const isOpen = expandedGroups.has(group.id);
              const groupSelected = group.accounts.every(account => selectedIds.has(account.client.id));
              const groupPartial = !groupSelected && group.accounts.some(account => selectedIds.has(account.client.id));
              const renameValue = renameDrafts[group.id] ?? group.name;
              return (
                <Fragment key={group.id}>
                  <tr
                    className={`border-t border-[var(--gray-200)]/40 hover:bg-[var(--gray-50)]/70 cursor-pointer hover-row stagger-${Math.min(idx + 1, 10)}`}
                    onClick={() => toggleGroup(group.id)}
                  >
                    <Td>
                      <input
                        type="checkbox"
                        checked={groupSelected}
                        ref={el => { if (el) el.indeterminate = groupPartial; }}
                        onClick={e => e.stopPropagation()}
                        onChange={() => toggleGroupSelection(group)}
                      />
                    </Td>
                    <Td>
                      <div className="flex items-center gap-2">
                        {isOpen ? <ChevronDown className="h-4 w-4 text-[var(--gray-400)]" /> : <ChevronRight className="h-4 w-4 text-[var(--gray-400)]" />}
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-[var(--gray-950)]">{group.name}</span>
                            {group.source === 'jde-padre' && <span className="rounded bg-[var(--gray-950)] px-1.5 py-0.5 text-[10px] font-medium text-white" title="Grupo derivado de Nombre_Cliente_Padre JDE">JDE</span>}
                            {group.source === 'manual' && <span className="rounded bg-[var(--primary-muted)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--primary)]">Manual</span>}
                          </div>
                          <p className="text-[11px] text-[var(--gray-400)] truncate">{group.accounts.length} cuenta{group.accounts.length !== 1 ? 's' : ''}</p>
                        </div>
                      </div>
                    </Td>
                    <Td className="text-right tabular-nums">{group.accounts.length}</Td>
                    <Td className="text-right tabular-nums font-medium">{fmt(group.annualSales)}</Td>
                    <Td className="text-right tabular-nums">{fmt(group.projectedReceivable)}</Td>
                    <Td className="text-right tabular-nums">{group.pendingInvoices}</Td>
                    <Td className="text-right tabular-nums" title={group.source === 'jde-padre' ? 'Días de crédito según JDE' : 'Días de crédito catálogo manual'}>
                      {group.creditDaysApi}d
                    </Td>
                    <Td className="text-right tabular-nums" title={`Crédito API ${group.creditDaysApi}d + lag observado ${group.lagDaysExtra}d`}>
                      <span className={group.lagDaysExtra > 0 ? 'font-bold text-[var(--danger)]' : 'text-[var(--success)]'}>
                        {group.realCreditDays}d
                      </span>
                      {group.lagDaysExtra > 0 && (
                        <span className="ml-1 text-[10px] text-[var(--gray-400)]">(+{group.lagDaysExtra})</span>
                      )}
                    </Td>
                    <Td>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleGroupSelection(group);
                        }}
                        className="rounded-[var(--radius-md)] border border-[var(--gray-200)] px-2.5 py-1 text-[11px] font-medium text-[var(--gray-500)] hover:bg-white"
                      >
                        Seleccionar cuentas
                      </button>
                    </Td>
                  </tr>
                  {isOpen && (
                    <>
                      <tr className="bg-[var(--surface-alt)] border-t border-[var(--gray-200)]/40">
                        <td colSpan={9} className="px-4 py-3">
                          {group.source === 'jde-padre' ? (
                            <div className="flex flex-wrap items-center gap-2">
                              <Lock className="h-3.5 w-3.5 text-[var(--gray-400)]" />
                              <span className="text-[12px] text-[var(--gray-400)]">Nombre del grupo</span>
                              <span className="rounded bg-white border border-[var(--gray-200)] px-2 py-1 text-[12px] font-medium text-[var(--gray-950)]">
                                {group.name}
                              </span>
                              <span className="rounded bg-[var(--gray-950)] px-1.5 py-0.5 text-[10px] font-medium text-white" title={group.signal}>
                                JDE
                              </span>
                              <span className="text-[11px] text-[var(--gray-400)]">No editable — autoridad JDE (Nombre_Cliente_Padre)</span>
                            </div>
                          ) : (
                            <div className="flex flex-wrap items-center gap-2">
                              <Pencil className="h-3.5 w-3.5 text-[var(--gray-400)]" />
                              <span className="text-[12px] text-[var(--gray-400)]">Nombre del grupo</span>
                              <input
                                value={renameValue}
                                onChange={e => setRenameDrafts(prev => ({ ...prev, [group.id]: e.target.value }))}
                                className="input h-8 w-72"
                              />
                              <button
                                onClick={() => renameGroup(group)}
                                className="h-8 rounded-[var(--radius-md)] bg-[var(--primary)] px-3 text-[12px] font-medium text-white hover:bg-[var(--primary-hover)]"
                              >
                                Renombrar
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                      <GroupBillingRow
                        group={group}
                        billingMap={billingMap}
                      />
                      {group.accounts.map(account => (
                        <AccountRows
                          key={account.client.id}
                          account={account}
                          isSelected={selectedIds.has(account.client.id)}
                          isOpen={expandedAccountId === account.client.id}
                          avgLag={lagMap.get(account.client.id) ?? account.avgLagDays}
                          billing={billingMap.get(account.client.id) ?? null}
                          onToggleSelected={() => toggleSelected(account.client.id)}
                          onToggleOpen={() => setExpandedAccountId(expandedAccountId === account.client.id ? null : account.client.id)}
                          groupOptions={groupOptions}
                          currentGroupId={group.id}
                          onMoveToGroup={(targetGroupId) => moveAccountToGroup(account.client.id, targetGroupId)}
                          onSeparate={() => separateAccount(account.client.id)}
                          onUpdate={onUpdate}
                          onDelete={onDelete}
                        />
                      ))}
                    </>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        </div>
      </div>
    </div>
  );
}

function sourceLabel(source: ClientGroupSource): string {
  switch (source) {
    case 'manual': return 'Manual';
    case 'rfc': return 'RFC';
    case 'domain': return 'Dominio';
    case 'address': return 'Dirección';
    case 'name': return 'Nombre';
    default: return 'Individual';
  }
}

function AccountRows({
  account,
  isSelected,
  isOpen,
  avgLag,
  billing,
  onToggleSelected,
  onToggleOpen,
  groupOptions,
  currentGroupId,
  onMoveToGroup,
  onSeparate,
  onUpdate,
  onDelete,
}: {
  account: ClientAccountNode;
  isSelected: boolean;
  isOpen: boolean;
  avgLag: number;
  billing: ClientMonthlyBilling | null;
  onToggleSelected: () => void;
  onToggleOpen: () => void;
  groupOptions: Array<{ id: string; name: string }>;
  currentGroupId: string;
  onMoveToGroup: (groupId: string) => void;
  onSeparate: () => void;
  onUpdate: (client: Client) => void;
  onDelete: (id: string) => void;
}) {
  const c = account.client;
  const annual = c.monthlyBilling.reduce((s, v) => s + v, 0);
  const ivaRate = c.ivaRate ?? 16;
  const parsed = c.paymentDayRaw ? parsePaymentDay(c.paymentDayRaw) : c.paymentDay;

  return (
    <>
      <tr className="border-t border-[var(--gray-200)]/30 bg-[var(--surface-alt)] hover:bg-[var(--gray-50)]/80">
        <Td>
          <input
            type="checkbox"
            checked={isSelected}
            onChange={onToggleSelected}
            onClick={e => e.stopPropagation()}
          />
        </Td>
        <Td>
          <button onClick={onToggleOpen} className="flex min-w-0 items-center gap-2 text-left">
            {isOpen ? <ChevronDown className="h-3.5 w-3.5 text-[var(--gray-400)]" /> : <ChevronRight className="h-3.5 w-3.5 text-[var(--gray-400)]" />}
            <span className="min-w-0">
              <span className="block truncate font-medium text-[var(--gray-950)]">{c.name}</span>
              <span className="block truncate text-[11px] text-[var(--gray-400)]">
                {c.rfc ? `RFC ${c.rfc}` : c.emailDomain ? `Dominio ${c.emailDomain}` : c.legalName ?? 'Cuenta individual'}
                {parsed ? ` · ${renderPattern(parsed)}` : ' · pago no interpretado'}
              </span>
            </span>
          </button>
        </Td>
        <Td className="text-right">{c.frequency}</Td>
        <Td className="text-right tabular-nums font-medium">{fmt(annual)}</Td>
        <Td className="text-right tabular-nums">{fmt(account.projectedReceivable)}</Td>
        <Td className="text-right tabular-nums">{account.pendingInvoices}</Td>
        <Td className="text-right tabular-nums" title={c.creditDaysFromApi ? 'Días de crédito según JDE (Dias_Credito)' : 'Días de crédito catálogo manual'}>
          {account.creditDaysApi}d
          {c.creditDaysFromApi && <Lock className="ml-1 inline h-2.5 w-2.5 text-[var(--gray-400)]" />}
        </Td>
        <Td className="text-right tabular-nums" title={`Crédito API ${account.creditDaysApi}d + lag ${account.lagDaysExtra}d${account.paymentDayName ? ` · día pago ${account.paymentDayName}` : ''}`}>
          {account.lagDaysExtra > 0
            ? <span className="font-bold text-[var(--danger)]">{account.realCreditDays}d</span>
            : <span className="text-[var(--success)]">{account.realCreditDays}d</span>}
          {account.lagDaysExtra > 0 && (
            <span className="ml-1 text-[10px] text-[var(--gray-400)]">(+{account.lagDaysExtra})</span>
          )}
        </Td>
        <Td>
          <div className="flex items-center justify-end gap-1.5">
            <select
              value={currentGroupId}
              onClick={e => e.stopPropagation()}
              onChange={e => onMoveToGroup(e.target.value)}
              className="input h-8 w-40 text-[12px]"
              title="Mover esta cuenta a otro grupo"
            >
              <option value="__auto__">Automático</option>
              {groupOptions.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}
            </select>
            <button
              onClick={(e) => { e.stopPropagation(); onSeparate(); }}
              className="rounded-[var(--radius-md)] border border-[var(--gray-200)] px-2 py-1 text-[11px] font-medium text-[var(--gray-500)] hover:bg-white hover:text-[var(--primary)]"
              title="Separar esta cuenta en su propio grupo"
            >
              Separar
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); onDelete(c.id); }}
              className="rounded p-1 text-[var(--gray-400)] hover:bg-white hover:text-[var(--danger)]"
              title="Eliminar cuenta"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        </Td>
      </tr>
      {isOpen && (
        <tr className="border-t border-[var(--gray-200)]/30 bg-[var(--surface-alt)]">
          <td colSpan={9} className="px-4 py-4">
            <div className="mb-3 grid grid-cols-2 gap-3 rounded-[var(--radius-md)] bg-white px-3 py-2 text-[12px] lg:grid-cols-4">
              <div>
                <div className="text-[var(--gray-400)]">Lag estimado</div>
                <div className="font-mono font-bold text-[var(--gray-950)]">{avgLag.toFixed(0)}d</div>
              </div>
              <div>
                <div className="text-[var(--gray-400)]">IVA</div>
                <div className="font-mono font-bold text-[var(--gray-950)]">{ivaRate}%</div>
              </div>
              <div>
                <div className="text-[var(--gray-400)]">Cobranza confirmada</div>
                <div className="font-mono font-bold text-[var(--gray-950)]">{fmt(account.confirmedCollections)}</div>
              </div>
              <div>
                <div className="text-[var(--gray-400)]">Facturas confirmadas</div>
                <div className="font-mono font-bold text-[var(--gray-950)]">{account.confirmedInvoices}</div>
              </div>
            </div>
            <ClientEditor client={c} billing={billing} onChange={onUpdate} />
          </td>
        </tr>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Aggregated billing row (rendered between "Renombrar" and accounts)
// ---------------------------------------------------------------------------
function GroupBillingRow({
  group,
  billingMap,
}: {
  group: ClientGroupNode;
  billingMap: Map<string, ClientMonthlyBilling>;
}) {
  // Solo histórico — la proyección no se muestra en el catálogo.
  const sum = new Array<number>(12).fill(0);
  const histMonth = new Array<boolean>(12).fill(false);
  let anyHist = false;
  let totalInvoices = 0;
  for (const acc of group.accounts) {
    const b = billingMap.get(acc.client.id);
    if (!b) continue;
    totalInvoices += b.invoiceCount;
    for (let i = 0; i < 12; i++) {
      if (b.isHistorical[i]) {
        sum[i] += b.values[i] ?? 0;
        histMonth[i] = true;
        anyHist = true;
      }
    }
  }
  if (group.accounts.length <= 1) return null;
  const maxVal = Math.max(1, ...sum);
  const annualHist = sum.reduce((s, v) => s + v, 0);
  return (
    <tr className="bg-[var(--surface-alt)] border-t border-[var(--gray-200)]/20">
      <td colSpan={9} className="px-4 py-2">
        <div className="flex items-center gap-3">
          <span className="text-[11px] uppercase tracking-wide text-[var(--gray-400)] whitespace-nowrap">
            Facturación grupo (sin IVA)
          </span>
          <div className="flex flex-1 items-end gap-0.5">
            {sum.map((v, i) => {
              const hist = histMonth[i];
              const h = hist ? Math.max(2, Math.round((v / maxVal) * 100)) : 0;
              return (
                <div
                  key={i}
                  className="flex-1 rounded-sm"
                  style={{
                    height: hist ? `${Math.max(4, h * 0.24)}px` : '4px',
                    backgroundColor: hist ? 'var(--gray-950)' : 'var(--gray-100)',
                  }}
                  title={hist ? `${MONTHS[i]}: ${fmt(v)} (histórico)` : `${MONTHS[i]}: sin histórico`}
                />
              );
            })}
          </div>
          <span className="text-[11px] tabular-nums text-[var(--gray-500)] whitespace-nowrap">
            {anyHist ? `${totalInvoices} fac. · ${fmt(annualHist)} anual` : 'Sin histórico'}
          </span>
        </div>
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Inline editor (expanded row)
// ---------------------------------------------------------------------------
function ClientEditor({
  client,
  billing,
  onChange,
}: {
  client: Client;
  billing: ClientMonthlyBilling | null;
  onChange: (c: Client) => void;
}) {
  const removeJdeLink = (cia: string, noCliente: string) => {
    if (!client.jdeAccounts) return;
    onChange({
      ...client,
      jdeAccounts: client.jdeAccounts.filter(a => !(a.cia === cia && a.noCliente === noCliente)),
    });
  };
  const update = (patch: Partial<Client>) => onChange({ ...client, ...patch });
  const updateOptionalText = (key: 'legalName' | 'rfc' | 'emailDomain' | 'address', value: string) => {
    update({ [key]: value.trim() ? value : undefined });
  };
  const updateManualGroup = (value: string) => {
    const name = value.trim();
    update({
      commercialGroupName: name || undefined,
      commercialGroupId: name ? commercialGroupId(name) : undefined,
      manualGroupOverride: name ? true : false,
    });
  };
  const ivaRate = (client.ivaRate ?? 16) / 100;

  // Facturación derivada: histórico real (meses pasados, cobranza sin
  // cancelados) + pronóstico (regresión sobre el histórico) para el resto del
  // año. B2.7: ambos se muestran, el pronóstico con estilo distinto — es el
  // "pronóstico por cliente".
  const rawValues = billing?.values ?? client.monthlyBilling;
  const isHistorical = billing?.isHistorical ?? new Array(12).fill(false);
  const histValues = rawValues.map((v, i) => (isHistorical[i] ? v : 0));
  const forecastValues = rawValues.map((v, i) => (isHistorical[i] ? 0 : v));
  const total = histValues.reduce((s, v) => s + v, 0); // base gravable = histórico
  const forecastTotal = forecastValues.reduce((s, v) => s + v, 0);
  const hasData = billing != null && billing.historicalMonths > 0;
  const hasForecast = hasData && forecastTotal > 0;
  const maxVal = Math.max(1, ...rawValues);

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
      {/* Left column — catalog fields */}
      <div className="space-y-4">
        <section className="rounded-[var(--radius-md)] border border-[var(--gray-200)]/60 bg-white p-3">
          <SectionTitle>Identificación</SectionTitle>
          <div className="mt-2 space-y-3">
            <Field label="Nombre">
              <input value={client.name} onChange={e => update({ name: e.target.value })} className="input w-full" />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Razón social">
                <input
                  value={client.legalName ?? ''}
                  onChange={e => updateOptionalText('legalName', e.target.value)}
                  className="input w-full"
                />
              </Field>
              <Field label="RFC">
                <input
                  value={client.rfc ?? ''}
                  onChange={e => updateOptionalText('rfc', e.target.value.toUpperCase())}
                  className="input w-full"
                />
              </Field>
              <Field label="Dominio">
                <input
                  value={client.emailDomain ?? ''}
                  onChange={e => updateOptionalText('emailDomain', e.target.value.toLowerCase())}
                  className="input w-full"
                />
              </Field>
              <Field label={client.jdeAccounts && client.jdeAccounts.length > 0 ? 'Grupo JDE (no editable)' : 'Grupo comercial fijo'}>
                <input
                  value={client.commercialGroupName ?? ''}
                  onChange={e => updateManualGroup(e.target.value)}
                  className="input w-full disabled:cursor-not-allowed disabled:bg-[var(--gray-50)]"
                  disabled={(client.jdeAccounts?.length ?? 0) > 0}
                  title={(client.jdeAccounts?.length ?? 0) > 0 ? 'El grupo viene de Nombre_Cliente_Padre JDE' : ''}
                />
              </Field>
            </div>
            <Field label="Dirección fiscal">
              <input
                value={client.address ?? ''}
                onChange={e => updateOptionalText('address', e.target.value)}
                className="input w-full"
              />
            </Field>
          </div>
        </section>

        <section className="rounded-[var(--radius-md)] border border-[var(--gray-200)]/60 bg-white p-3">
          <SectionTitle>Cuentas JDE</SectionTitle>
          <div className="mt-2 space-y-2">
            {client.jdeAccounts === undefined && (
              <div className="rounded bg-[var(--gray-50)] px-2 py-1.5 text-[11.5px] text-[var(--gray-500)]">
                Esperando matcher…
              </div>
            )}
            {client.jdeAccounts && client.jdeAccounts.length === 0 && (
              <div className="rounded bg-[var(--gray-50)] px-2 py-1.5 text-[11.5px] text-[var(--gray-500)]">
                Sin cuentas JDE asignadas. Asigna desde "Revisar matches".
              </div>
            )}
            {client.jdeAccounts && client.jdeAccounts.length > 0 && (
              <ul className="space-y-1">
                {client.jdeAccounts.map(a => (
                  <li key={`${a.cia}::${a.noCliente}`} className="flex items-center justify-between gap-2 rounded border border-[var(--gray-200)] bg-white px-2 py-1.5 text-[12px]">
                    <div className="min-w-0">
                      <span className="font-mono text-[var(--gray-950)]">{a.cia} · {a.noCliente}</span>
                      <span className="ml-2 truncate text-[var(--gray-500)]">{a.nombreCliente}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span
                        className="rounded px-1.5 py-0.5 text-[10px] font-medium"
                        style={{
                          backgroundColor: a.matchedBy === 'user' ? 'var(--gray-950)' : 'var(--gray-50)',
                          color: a.matchedBy === 'user' ? 'white' : 'var(--gray-500)',
                        }}
                        title={a.matchedBy === 'user' ? 'Confirmado por el usuario' : `Auto · ${a.tier ?? ''} · ${Math.round((a.confidence ?? 0) * 100)}%`}
                      >
                        {a.matchedBy === 'user' ? 'user' : `auto ${Math.round((a.confidence ?? 0) * 100)}%`}
                      </span>
                      <button
                        onClick={() => removeJdeLink(a.cia, a.noCliente)}
                        className="rounded p-1 text-[var(--gray-400)] hover:bg-[var(--gray-50)] hover:text-[var(--danger)]"
                        title="Quitar enlace"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        <section className="rounded-[var(--radius-md)] border border-[var(--gray-200)]/60 bg-white p-3">
          <SectionTitle>Cobranza</SectionTitle>
          <div className="mt-2 space-y-3">
            <Field label="Patrón de pago">
              <PatternEditor pattern={client.paymentDay} onChange={p => update({ paymentDay: p })} />
            </Field>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <Field label="Frecuencia">
                <select
                  value={client.frequency}
                  onChange={e => update({ frequency: e.target.value as Frequency })}
                  className="input w-full"
                >
                  {FREQUENCIES.map(f => <option key={f} value={f}>{f}</option>)}
                </select>
              </Field>
              <Field label={client.creditDaysFromApi ? 'Días crédito (JDE)' : 'Días crédito'}>
                <input
                  type="number"
                  value={client.creditDays}
                  onChange={e => update({ creditDays: Number(e.target.value) })}
                  className="input w-full disabled:cursor-not-allowed disabled:bg-[var(--gray-50)]"
                  disabled={client.creditDaysFromApi === true}
                  title={client.creditDaysFromApi ? 'Días de crédito viene de JDE (Dias_Credito)' : ''}
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
        </section>
      </div>

      {/* Right column — facturación mensual (read-only, derived) */}
      <section className="rounded-[var(--radius-md)] border border-[var(--gray-200)]/60 bg-white p-3">
        <div className="flex items-center justify-between gap-2">
          <SectionTitle>
            <span className="inline-flex items-center gap-1.5">
              Facturación mensual (sin IVA)
              <Lock className="h-3 w-3 text-[var(--gray-400)]" />
            </span>
          </SectionTitle>
          <div className="flex items-center gap-3 text-[10.5px] text-[var(--gray-400)]">
            <span className="inline-flex items-center gap-1">
              <span
                className="inline-block h-2 w-2 rounded-sm"
                style={{ backgroundColor: 'var(--gray-950)' }}
              />
              Histórico
            </span>
            {hasForecast && (
              <span className="inline-flex items-center gap-1">
                <span
                  className="inline-block h-2 w-2 rounded-sm"
                  style={{ backgroundColor: 'var(--accent-blue, #3b82f6)' }}
                />
                Pronóstico
              </span>
            )}
          </div>
        </div>

        {/* Chip de estado del enlace JDE */}
        <div className="mt-2">
          {(() => {
            const jde = client.jdeAccounts ?? [];
            const linked = jde.length;
            if (linked === 0) {
              return (
                <div className="flex items-start gap-2 rounded bg-[var(--gray-50)] px-2 py-1.5 text-[11.5px] text-[var(--gray-500)]">
                  <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--gray-400)]" />
                  <span>Sin conectar a JDE. La facturación mostrada viene del catálogo. Asigna cuentas JDE desde "Revisar matches".</span>
                </div>
              );
            }
            const invoiceCount = billing?.invoiceCount ?? 0;
            return (
              <div className="flex items-center gap-2 rounded bg-[var(--gray-50)] px-2 py-1.5 text-[11.5px] text-[var(--gray-700)]">
                <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ backgroundColor: 'var(--success, #22c55e)' }} />
                Conectado a {linked} cuenta{linked !== 1 ? 's' : ''} JDE · {invoiceCount} factura{invoiceCount !== 1 ? 's' : ''} contabilizada{invoiceCount !== 1 ? 's' : ''}
              </div>
            );
          })()}
        </div>
        {/* Aviso adicional cuando el cliente está conectado pero aún no hay
            facturas históricas en el año activo (cobranza muy reciente o no sincronizada). */}
        {(client.jdeAccounts?.length ?? 0) > 0 && !hasData && (
          <div className="mt-2 flex items-start gap-2 rounded bg-[var(--gray-50)] px-2 py-1.5 text-[11.5px] text-[var(--gray-500)]">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--gray-400)]" />
            <span>Conectado a JDE pero sin facturas del año en curso; la proyección se construirá cuando llegue cobranza.</span>
          </div>
        )}

        <div className="mt-3 grid grid-cols-12 gap-1">
          {MONTHS.map((m, i) => {
            const hist = isHistorical[i];
            const v = rawValues[i] ?? 0;
            const showBar = v > 0;
            const heightPct = showBar ? Math.max(2, Math.round((v / maxVal) * 100)) : 0;
            return (
              <div key={m} className="flex flex-col items-center">
                <div
                  className="relative h-14 w-full overflow-hidden rounded-sm"
                  style={{ backgroundColor: 'var(--gray-100, #f1f5f9)' }}
                >
                  {showBar && (
                    <div
                      className="absolute bottom-0 left-0 right-0"
                      style={{
                        height: `${heightPct}%`,
                        backgroundColor: hist ? 'var(--gray-950)' : 'var(--accent-blue, #3b82f6)',
                        opacity: hist ? 1 : 0.72,
                      }}
                      title={hist ? 'Histórico (cobranza)' : 'Pronóstico (regresión)'}
                    />
                  )}
                </div>
                <span className="mt-1 text-[10px] text-[var(--gray-400)]">{m}</span>
                <span
                  className="tabular-nums text-[10.5px]"
                  style={{
                    color: hist ? 'var(--gray-950)' : 'var(--accent-blue, #3b82f6)',
                    fontWeight: hist ? 600 : 400,
                  }}
                  title={hist ? 'Facturado histórico' : 'Pronóstico'}
                >
                  {showBar ? fmt(v) : '—'}
                </span>
              </div>
            );
          })}
        </div>

        <div className="mt-3 grid grid-cols-3 gap-x-4 rounded-[var(--radius-md)] bg-[var(--gray-50)] px-3 py-2 text-[12px]">
          <div>
            <div className="text-[var(--gray-400)]">Base gravable anual</div>
            <div className="font-bold tabular-nums text-[var(--gray-950)]">{fmt(total)}</div>
          </div>
          <div>
            <div className="text-[var(--gray-400)]">IVA ({(client.ivaRate ?? 16)}%)</div>
            <div className="font-bold tabular-nums text-[var(--primary)]">{fmt(total * ivaRate)}</div>
          </div>
          <div>
            <div className="text-[var(--gray-400)]">Total con IVA</div>
            <div className="font-bold tabular-nums text-[var(--gray-950)]">{fmt(total * (1 + ivaRate))}</div>
          </div>
        </div>

        {hasForecast && (
          <div className="mt-2 flex items-center justify-between rounded-[var(--radius-md)] bg-[var(--gray-50)] px-3 py-2 text-[12px]">
            <span className="inline-flex items-center gap-1.5 text-[var(--gray-400)]">
              <TrendingUp className="h-3 w-3" />
              Pronóstico resto del año (sin IVA)
            </span>
            <span
              className="font-bold tabular-nums"
              style={{ color: 'var(--accent-blue, #3b82f6)' }}
              title="Suma de los meses proyectados por regresión sobre el histórico"
            >
              {fmt(forecastTotal)}
            </span>
          </div>
        )}

        {hasData && (
          <div className="mt-2 flex items-center gap-1.5 text-[11px] text-[var(--gray-400)]">
            <TrendingUp className="h-3 w-3" />
            {billing!.historicalMonths} mes{billing!.historicalMonths === 1 ? '' : 'es'} de histórico
          </div>
        )}
      </section>
    </div>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <div className="text-[11px] font-medium uppercase tracking-wide text-[var(--gray-400)]">{children}</div>
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
    <div className="bg-amber-50 border border-amber-200 rounded-[var(--radius)] p-4 hover-lift">
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

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-[12px] text-[var(--gray-400)]">
      <span>{label}</span>
      {children}
    </label>
  );
}
function Th({ children, className = '', title }: { children?: ReactNode; className?: string; title?: string }) {
  return <th className={`px-4 py-2.5 font-medium ${className}`} title={title}>{children}</th>;
}
function Td({ children, className = '', title }: { children?: ReactNode; className?: string; title?: string }) {
  return <td className={`px-4 py-2.5 text-[var(--gray-950)] ${className}`} title={title}>{children}</td>;
}
function fmt(n: number): string {
  return fmtSmart(n);
}
