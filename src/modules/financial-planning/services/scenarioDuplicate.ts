import type {
  CellOverride,
  FinancialAdjustment,
  FinancialScenario,
  ManualPlanningEntry,
  PlanningCustomRow,
  ScenarioChangeLogEntry,
} from '../../shared-finance/types';
import { describeDuplicateDraft, newChangeLogEntry } from './changeLogTemplates';

export interface DuplicateDraftArgs {
  source: FinancialScenario;
  approvedScenarioId: string;
  allOverrides: CellOverride[];
  allCustomRows: PlanningCustomRow[];
  /**
   * Requeridos (no opcionales) a propósito: una copia que omite las propuestas
   * o las entradas manuales del origen CALCULA DISTINTO sin avisar — fue
   * exactamente el defecto que esto cierra.
   */
  allAdjustments: FinancialAdjustment[];
  allManualEntries: ManualPlanningEntry[];
  changeLog: ScenarioChangeLogEntry[];
  newName?: string;
  user?: string;
}

export interface DuplicateDraftResult {
  newScenario: FinancialScenario;
  cellOverrides: CellOverride[];
  customRows: PlanningCustomRow[];
  adjustments: FinancialAdjustment[];
  manualEntries: ManualPlanningEntry[];
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

  const sourceManualEntries = args.allManualEntries.filter((entry) => entry.scenarioIds.includes(args.source.id));
  const manualEntryIdRemap = new Map<string, string>();
  const clonedManualEntries: ManualPlanningEntry[] = sourceManualEntries.map((entry, index) => {
    const clonedId = `${entry.id}:dup:${Date.now()}:${index}`;
    manualEntryIdRemap.set(entry.id, clonedId);
    return {
      ...entry,
      id: clonedId,
      scenarioIds: [newId],
      createdAt: now,
      updatedAt: now,
    };
  });

  // Propuestas y entradas manuales se CLONAN (copia independiente, igual que
  // overrides y custom rows): compartir el registro haría que editar una copia
  // moviera la otra. El motor las selecciona por `scenarioIds`.
  const sourceAdjustments = args.allAdjustments.filter((adjustment) => adjustment.scenarioIds.includes(args.source.id));
  const clonedAdjustments: FinancialAdjustment[] = sourceAdjustments.map((adjustment, index) => ({
    ...adjustment,
    id: `${adjustment.id}:dup:${Date.now()}:${index}`,
    scenarioIds: [newId],
    // Una propuesta dirigida a un MOVIMIENTO apunta por id, y el id de una
    // ocurrencia manual lleva dentro el id de su entrada — que acaba de
    // clonarse. Sin re-apuntar, la copia deja de aplicar esa propuesta: el
    // defecto que duplicar-completo viene a cerrar, por la otra puerta.
    targetExpression: remapManualTarget(adjustment, manualEntryIdRemap),
    createdAt: now,
  }));

  const cellOverrides = [...args.allOverrides, ...clonedOverrides];
  const customRows = [...args.allCustomRows, ...clonedCustomRows];
  const adjustments = [...args.allAdjustments, ...clonedAdjustments];
  const manualEntries = [...args.allManualEntries, ...clonedManualEntries];

  const seedEntry = newChangeLogEntry({
    scenarioId: newId,
    kind: 'DUPLICATE_DRAFT',
    autoDescription: describeDuplicateDraft(args.source.name),
    payload: {
      sourceScenarioId: args.source.id,
      sourceName: args.source.name,
      cellCount: clonedOverrides.length,
      customRowCount: clonedCustomRows.length,
      adjustmentCount: clonedAdjustments.length,
      manualEntryCount: clonedManualEntries.length,
    },
    createdBy: user,
  });

  return {
    newScenario,
    cellOverrides,
    customRows,
    adjustments,
    manualEntries,
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

/**
 * Re-apunta una propuesta dirigida a una ocurrencia de entrada manual cuando esa
 * entrada se clonó. El id de la ocurrencia es `manual-entry:<entryId>:<fecha>`
 * y `sourceObjectId` es el `<entryId>` pelado — `matchesAdjustmentTarget` acepta
 * los dos, así que ambas formas se re-apuntan. Cualquier otro target (una
 * categoría, un rango de fechas, un movimiento del API) se devuelve intacto.
 */
function remapManualTarget(adjustment: FinancialAdjustment, remap: Map<string, string>): string {
  if (adjustment.targetType !== 'MOVEMENT' || remap.size === 0) return adjustment.targetExpression;
  const expression = adjustment.targetExpression;
  const direct = remap.get(expression);
  if (direct) return direct;
  const occurrence = /^manual-entry:(.+):(\d{4}-\d{2}-\d{2})$/.exec(expression);
  if (!occurrence) return expression;
  const clonedEntryId = remap.get(occurrence[1]);
  return clonedEntryId ? `manual-entry:${clonedEntryId}:${occurrence[2]}` : expression;
}
