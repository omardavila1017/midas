import { fmtCurrency } from '../../../formatters';
import type {
  CellOverride,
  FinancialMovementType,
  PlanningCustomRow,
  ScenarioChangeKind,
  ScenarioChangeLogEntry,
} from '../../shared-finance/types';

export function newChangeLogEntry(args: {
  scenarioId: string;
  kind: ScenarioChangeKind;
  autoDescription: string;
  payload?: Record<string, unknown>;
  userNote?: string;
  createdBy?: string;
}): ScenarioChangeLogEntry {
  return {
    id: `cl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    scenarioId: args.scenarioId,
    kind: args.kind,
    payload: args.payload ?? {},
    autoDescription: args.autoDescription,
    userNote: args.userNote,
    createdBy: args.createdBy ?? 'tesoreria@senda.local',
    createdAt: new Date().toISOString(),
  };
}

export function describeAddRow(row: PlanningCustomRow): string {
  return `Agregaste fila "${row.label}" en ${typeLabel(row.type)}.`;
}

export function describeRemoveRow(row: { label: string; type: FinancialMovementType }): string {
  return `Eliminaste fila "${row.label}".`;
}

export function describeRenameRow(oldLabel: string, newLabel: string): string {
  return `Renombraste "${oldLabel}" → "${newLabel}".`;
}

export function describeEditCell(args: {
  rowLabel: string;
  bucketLabel: string;
  oldValue: number;
  newValue: number;
}): string {
  return `Cambiaste ${args.rowLabel} ${args.bucketLabel}: ${fmtCurrency(args.oldValue)} → ${fmtCurrency(args.newValue)}.`;
}

export function describeClearCell(args: {
  rowLabel: string;
  bucketLabel: string;
  baseValue: number;
}): string {
  return `Limpiaste override de ${args.rowLabel} ${args.bucketLabel} (volvió a ${fmtCurrency(args.baseValue)}).`;
}

export function describeCreateDraft(): string {
  return 'Propuesta creada desde Aprobado.';
}

export function describeDuplicateDraft(sourceName: string): string {
  return `Duplicada desde "${sourceName}".`;
}

export function describeMergeToApproved(args: {
  cellCount: number;
  rowCount: number;
  date: string;
}): string {
  const cells = `${args.cellCount} celda${args.cellCount === 1 ? '' : 's'}`;
  const rows = `${args.rowCount} fila${args.rowCount === 1 ? '' : 's'} custom`;
  return `Mergeada a Aprobado el ${args.date}. ${cells}, ${rows}.`;
}

export function describeOverridePayload(override: CellOverride): Record<string, unknown> {
  return {
    conceptKey: override.conceptKey,
    bucketKey: override.bucketKey,
    granularity: override.granularity,
    type: override.type,
    value: override.value,
    previousAggregatedValue: override.previousAggregatedValue,
  };
}

function typeLabel(type: FinancialMovementType): string {
  return type === 'INFLOW' ? 'Ingresos' : 'Egresos';
}
