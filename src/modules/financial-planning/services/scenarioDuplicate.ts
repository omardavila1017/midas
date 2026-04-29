import type {
  CellOverride,
  FinancialScenario,
  PlanningCustomRow,
  ScenarioChangeLogEntry,
} from '../../shared-finance/types';
import { describeDuplicateDraft, newChangeLogEntry } from './changeLogTemplates';

export interface DuplicateDraftArgs {
  source: FinancialScenario;
  approvedScenarioId: string;
  allOverrides: CellOverride[];
  allCustomRows: PlanningCustomRow[];
  changeLog: ScenarioChangeLogEntry[];
  newName?: string;
  user?: string;
}

export interface DuplicateDraftResult {
  newScenario: FinancialScenario;
  cellOverrides: CellOverride[];
  customRows: PlanningCustomRow[];
  changeLog: ScenarioChangeLogEntry[];
}

export function duplicateDraft(args: DuplicateDraftArgs): DuplicateDraftResult {
  const user = args.user ?? 'tesoreria@senda.local';
  const now = new Date().toISOString();
  const newId = `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  const newScenario: FinancialScenario = {
    ...args.source,
    id: newId,
    name: args.newName?.trim() || `${args.source.name} (copia)`,
    kind: 'DRAFT',
    isBase: false,
    parentScenarioId: args.approvedScenarioId,
    status: 'DRAFT',
    archivedAt: undefined,
    promotedFromScenarioId: undefined,
    promotedAt: undefined,
    adjustmentIds: [],
    createdAt: now,
    updatedAt: now,
    createdBy: user,
  };

  const sourceOverrides = args.allOverrides.filter((override) => override.scenarioId === args.source.id);
  const clonedOverrides: CellOverride[] = sourceOverrides.map((override, index) => ({
    ...override,
    id: `${override.id}:dup:${Date.now()}:${index}`,
    scenarioId: newId,
    createdAt: now,
    updatedAt: now,
  }));

  const sourceCustomRows = args.allCustomRows.filter((row) => row.scenarioId === args.source.id);
  const clonedCustomRows: PlanningCustomRow[] = sourceCustomRows.map((row, index) => ({
    ...row,
    id: `${row.id}:dup:${Date.now()}:${index}`,
    scenarioId: newId,
    createdAt: now,
    updatedAt: now,
  }));

  const cellOverrides = [...args.allOverrides, ...clonedOverrides];
  const customRows = [...args.allCustomRows, ...clonedCustomRows];

  const seedEntry = newChangeLogEntry({
    scenarioId: newId,
    kind: 'DUPLICATE_DRAFT',
    autoDescription: describeDuplicateDraft(args.source.name),
    payload: {
      sourceScenarioId: args.source.id,
      sourceName: args.source.name,
      cellCount: clonedOverrides.length,
      customRowCount: clonedCustomRows.length,
    },
    createdBy: user,
  });

  return {
    newScenario,
    cellOverrides,
    customRows,
    changeLog: [seedEntry, ...args.changeLog],
  };
}

export function createNewDraft(args: {
  approved: FinancialScenario;
  user?: string;
  name?: string;
}): { newScenario: FinancialScenario; seedEntry: ScenarioChangeLogEntry } {
  const user = args.user ?? 'tesoreria@senda.local';
  const now = new Date().toISOString();
  const newId = `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const name = args.name?.trim() || `Propuesta ${new Date().toLocaleDateString('es-MX')}`;

  const newScenario: FinancialScenario = {
    id: newId,
    name,
    kind: 'DRAFT',
    description: 'Propuesta editable creada desde Aprobado.',
    adjustmentIds: [],
    status: 'DRAFT',
    parentScenarioId: args.approved.id,
    createdBy: user,
    createdAt: now,
    updatedAt: now,
  };

  const seedEntry = newChangeLogEntry({
    scenarioId: newId,
    kind: 'CREATE_DRAFT',
    autoDescription: 'Propuesta creada desde Aprobado.',
    payload: { approvedScenarioId: args.approved.id },
    createdBy: user,
  });

  return { newScenario, seedEntry };
}
