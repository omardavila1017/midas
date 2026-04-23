import { Fragment, useMemo, useState, type ElementType, type ReactNode } from 'react';
import { Client, Frequency, PaymentDayPattern, DayOfWeek, NthOfMonth, WeekOfMonth, CashFlowAssumptions, ConfirmedPayment } from '../domain/types';
import { parsePaymentDay } from '../domain/parsePaymentDay';
import { projectClientMonth } from '../domain/collectionEngine';
import {
  buildClientHierarchy,
  commercialGroupId,
  type ClientAccountNode,
  type ClientGroupNode,
  type ClientGroupSource,
} from '../domain/clientGrouping';
import { MONTHS } from '../types';
import {
  Trash2,
  AlertTriangle,
  Plus,
  Search,
  Download,
  ChevronDown,
  ChevronRight,
  FolderPlus,
  Link2,
  Unlink,
  Pencil,
  Users,
  Building2,
  Check,
} from 'lucide-react';
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
  assumptions: CashFlowAssumptions;
  confirmedPayments: ConfirmedPayment[];
  onReplace: (clients: Client[]) => void;
  onAdd: (c: Client) => void;
  onUpdate: (c: Client) => void;
  onDelete: (id: string) => void;
}

export default function Clients({ clients, assumptions, confirmedPayments, onReplace, onAdd, onUpdate, onDelete }: Props) {
  const [issues, setIssues] = useState<ImportIssue[]>([]);
  const [query, setQuery] = useState('');
  const [expandedAccountId, setExpandedAccountId] = useState<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [groupNameDraft, setGroupNameDraft] = useState('');
  const [renameDrafts, setRenameDrafts] = useState<Record<string, string>>({});
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);

  const hierarchy = useMemo(
    () => buildClientHierarchy(clients, { assumptions, confirmedPayments, today }),
    [clients, assumptions, confirmedPayments, today],
  );

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

  const totalReceivable = useMemo(
    () => hierarchy.reduce((sum, group) => sum + group.projectedReceivable, 0),
    [hierarchy],
  );

  const totalPendingInvoices = useMemo(
    () => hierarchy.reduce((sum, group) => sum + group.pendingInvoices, 0),
    [hierarchy],
  );

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

  const filteredGroups = useMemo(() => {
    if (!query) return hierarchy;
    const q = query.toLowerCase();
    return hierarchy
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
      .filter(Boolean) as ClientGroupNode[];
  }, [hierarchy, query]);

  const selectedClients = useMemo(
    () => clients.filter(client => selectedIds.has(client.id)),
    [clients, selectedIds],
  );

  const groupOptions = useMemo(
    () => hierarchy.map(group => ({ id: group.id, name: group.name })),
    [hierarchy],
  );

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

  const createGroupFromSelected = () => {
    const name = groupNameDraft.trim();
    if (!name || selectedIds.size === 0) return;
    const id = commercialGroupId(name);
    onReplace(clients.map(client => selectedIds.has(client.id)
      ? { ...client, commercialGroupName: name, commercialGroupId: id }
      : client
    ));
    setGroupNameDraft('');
    setSelectedIds(new Set());
    setExpandedGroups(prev => new Set(prev).add(id));
  };

  const moveSelectedToGroup = (groupId: string) => {
    const target = hierarchy.find(group => group.id === groupId);
    if (!target || selectedIds.size === 0) return;
    onReplace(clients.map(client => selectedIds.has(client.id)
      ? { ...client, commercialGroupName: target.name, commercialGroupId: target.id }
      : client
    ));
    setSelectedIds(new Set());
    setExpandedGroups(prev => new Set(prev).add(target.id));
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
      ? { ...client, commercialGroupName: target.name, commercialGroupId: target.id }
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
        }
      : client
    ));
    setExpandedAccountId(null);
  };

  const separateSelected = () => {
    if (selectedIds.size === 0) return;
    onReplace(clients.map(client => selectedIds.has(client.id)
      ? {
          ...client,
          commercialGroupName: client.name,
          commercialGroupId: `client-single-${client.id}`,
        }
      : client
    ));
    setSelectedIds(new Set());
  };

  const renameGroup = (group: ClientGroupNode) => {
    const name = (renameDrafts[group.id] ?? group.name).trim();
    if (!name) return;
    const id = commercialGroupId(name);
    const accountIds = new Set(group.accounts.map(account => account.client.id));
    onReplace(clients.map(client => accountIds.has(client.id)
      ? { ...client, commercialGroupName: name, commercialGroupId: id }
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
    });
  };

  return (
    <div className="space-y-5">
      <header className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-white tracking-tight animate-fade-in">Clientes</h1>
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
            <Plus className="w-3.5 h-3.5" /> Nuevo cliente
          </button>
        </div>
      </header>

      {/* Issues panel */}
      {issues.length > 0 && <div className="animate-slide-down"><IssuesPanel issues={issues} onDismiss={() => setIssues([])} /></div>}

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-4">
        <SummaryMetric icon={Users} label="Grupos comerciales" value={hierarchy.length} sub={`${clients.length} cuentas`} />
        <SummaryMetric icon={Building2} label="Ventas anuales" value={fmt(totalAnnual)} sub={`IVA estimado ${fmt(totalIva)}`} />
        <SummaryMetric icon={AlertTriangle} label="Por cobrar proyectado" value={fmt(totalReceivable)} sub={`${totalPendingInvoices} eventos pendientes`} />
        <SummaryMetric icon={Check} label="Correcciones manuales" value={clients.filter(c => c.commercialGroupName).length} sub="cuentas con grupo fijo" />
      </div>

      {/* Search + grouping actions */}
      <div className="rounded-xl border border-[var(--gray-200)] bg-white p-3 shadow-sm">
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
          <div className="flex items-center gap-2">
            <input
              value={groupNameDraft}
              onChange={e => setGroupNameDraft(e.target.value)}
              placeholder="Nuevo grupo"
              className="input h-9 w-64"
            />
            <button
              onClick={createGroupFromSelected}
              disabled={selectedIds.size === 0 || !groupNameDraft.trim()}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-[var(--primary)] px-3 text-[12px] font-medium text-white transition hover:bg-[var(--primary-hover)] disabled:cursor-not-allowed disabled:opacity-40"
              title="Crear un grupo con las cuentas seleccionadas"
            >
              <Link2 className="h-3.5 w-3.5" /> Crear grupo
            </button>
            <select
              value=""
              onChange={e => {
                if (e.target.value) moveSelectedToGroup(e.target.value);
              }}
              disabled={selectedIds.size === 0}
              className="input h-9 w-48 text-[12px] disabled:cursor-not-allowed disabled:opacity-40"
              title="Mover las cuentas seleccionadas a un grupo existente"
            >
              <option value="">Mover a...</option>
              {groupOptions.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}
            </select>
            <button
              onClick={separateSelected}
              disabled={selectedIds.size === 0}
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[var(--gray-200)] px-3 text-[12px] font-medium text-[var(--gray-500)] transition hover:text-[var(--danger)] disabled:cursor-not-allowed disabled:opacity-40"
              title="Separar las cuentas seleccionadas de su grupo actual"
            >
              <Unlink className="h-3.5 w-3.5" /> Separar
            </button>
          </div>
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
      <div className="bg-white border border-[var(--gray-200)]/60 rounded-xl overflow-hidden">
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
              <Th className="text-right">Crédito real</Th>
              <Th className="w-64">Acciones</Th>
            </tr>
          </thead>
          <tbody>
            {filteredGroups.length === 0 && (
              <tr><td colSpan={8} className="text-center text-[var(--gray-400)] py-10">
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
                            <span className="font-semibold text-[var(--gray-950)]">{group.name}</span>
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
                    <Td className="text-right tabular-nums">{group.realCreditDays}d</Td>
                    <Td>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleGroupSelection(group);
                        }}
                        className="rounded-lg border border-[var(--gray-200)] px-2.5 py-1 text-[11px] font-medium text-[var(--gray-500)] hover:bg-white"
                      >
                        Seleccionar cuentas
                      </button>
                    </Td>
                  </tr>
                  {isOpen && (
                    <>
                      <tr className="bg-[var(--surface-alt)] border-t border-[var(--gray-200)]/40">
                        <td colSpan={8} className="px-4 py-3">
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
                              className="h-8 rounded-lg bg-[var(--primary)] px-3 text-[12px] font-medium text-white hover:bg-[var(--primary-hover)]"
                            >
                              Renombrar
                            </button>
                          </div>
                        </td>
                      </tr>
                      {group.accounts.map(account => (
                        <AccountRows
                          key={account.client.id}
                          account={account}
                          isSelected={selectedIds.has(account.client.id)}
                          isOpen={expandedAccountId === account.client.id}
                          avgLag={lagMap.get(account.client.id) ?? account.avgLagDays}
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

function SummaryMetric({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: ElementType;
  label: string;
  value: string | number;
  sub: string;
}) {
  return (
    <div className="rounded-xl border border-[var(--gray-200)] bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] font-medium uppercase tracking-wide text-[var(--gray-400)]">{label}</p>
        <Icon className="h-4 w-4 text-[var(--gray-400)]" />
      </div>
      <p className="mt-2 font-mono text-[22px] font-semibold text-[var(--gray-950)]">{value}</p>
      <p className="mt-1 text-[11px] text-[var(--gray-400)]">{sub}</p>
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
        <Td className="text-right tabular-nums">
          {account.realCreditDays > c.creditDays
            ? <span className="font-semibold text-[var(--danger)]">{account.realCreditDays}d</span>
            : <span className="text-[var(--success)]">{account.realCreditDays}d</span>}
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
              className="rounded-lg border border-[var(--gray-200)] px-2 py-1 text-[11px] font-medium text-[var(--gray-500)] hover:bg-white hover:text-[var(--primary)]"
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
          <td colSpan={8} className="px-4 py-4">
            <div className="mb-3 grid grid-cols-2 gap-3 rounded-lg bg-white px-3 py-2 text-[12px] lg:grid-cols-4">
              <div>
                <div className="text-[var(--gray-400)]">Lag estimado</div>
                <div className="font-mono font-semibold text-[var(--gray-950)]">{avgLag.toFixed(0)}d</div>
              </div>
              <div>
                <div className="text-[var(--gray-400)]">IVA</div>
                <div className="font-mono font-semibold text-[var(--gray-950)]">{ivaRate}%</div>
              </div>
              <div>
                <div className="text-[var(--gray-400)]">Cobranza confirmada</div>
                <div className="font-mono font-semibold text-[var(--gray-950)]">{fmt(account.confirmedCollections)}</div>
              </div>
              <div>
                <div className="text-[var(--gray-400)]">Facturas confirmadas</div>
                <div className="font-mono font-semibold text-[var(--gray-950)]">{account.confirmedInvoices}</div>
              </div>
            </div>
            <ClientEditor client={c} onChange={onUpdate} />
          </td>
        </tr>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Inline editor (expanded row)
// ---------------------------------------------------------------------------
function ClientEditor({ client, onChange }: { client: Client; onChange: (c: Client) => void }) {
  const update = (patch: Partial<Client>) => onChange({ ...client, ...patch });
  const updateOptionalText = (key: 'legalName' | 'rfc' | 'emailDomain' | 'address', value: string) => {
    update({ [key]: value.trim() ? value : undefined });
  };
  const updateManualGroup = (value: string) => {
    const name = value.trim();
    update({
      commercialGroupName: name || undefined,
      commercialGroupId: name ? commercialGroupId(name) : undefined,
    });
  };
  const ivaRate = (client.ivaRate ?? 16) / 100;

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1fr_1fr]">
      {/* Left column — catalog fields */}
      <div className="space-y-3">
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
          <Field label="Grupo comercial fijo">
            <input
              value={client.commercialGroupName ?? ''}
              onChange={e => updateManualGroup(e.target.value)}
              className="input w-full"
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

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-[12px] text-[var(--gray-400)]">
      <span>{label}</span>
      {children}
    </label>
  );
}
function Th({ children, className = '' }: { children?: ReactNode; className?: string }) {
  return <th className={`px-4 py-2.5 font-medium ${className}`}>{children}</th>;
}
function Td({ children, className = '' }: { children?: ReactNode; className?: string }) {
  return <td className={`px-4 py-2.5 text-[var(--gray-950)] ${className}`}>{children}</td>;
}
function fmt(n: number): string {
  return n.toLocaleString('es-MX', { maximumFractionDigits: 0 });
}
