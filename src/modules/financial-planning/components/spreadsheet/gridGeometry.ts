import type { ProjectionGranularity } from '../../../shared-finance/types';

export const ROW_HEIGHT = 34;
export const HEADER_HEIGHT = 32;
export const GROUP_HEADER_HEIGHT = 28;
export const ADD_ROW_HEIGHT = 32;
export const FOOTER_ROW_HEIGHT = 36;

export const GROUP_COL_WIDTH = 130;
export const LABEL_COL_WIDTH = 200;

export function colWidthForGranularity(granularity: ProjectionGranularity): number {
  if (granularity === 'daily') return 64;
  if (granularity === 'weekly') return 92;
  return 116;
}

export function parseNumericInput(raw: string): number | null {
  if (!raw) return null;
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[, ]+/g, '');
  if (!cleaned) return null;
  const lastChar = cleaned[cleaned.length - 1];
  let multiplier = 1;
  let body = cleaned;
  if (lastChar === 'k') {
    multiplier = 1_000;
    body = cleaned.slice(0, -1);
  } else if (lastChar === 'm') {
    multiplier = 1_000_000;
    body = cleaned.slice(0, -1);
  } else if (lastChar === 'b') {
    multiplier = 1_000_000_000;
    body = cleaned.slice(0, -1);
  }
  const numeric = Number(body);
  if (!Number.isFinite(numeric)) return null;
  return numeric * multiplier;
}

export function isPastBucket(bucketKey: string, asOfDate: string): boolean {
  return bucketKey < asOfDate.slice(0, 10);
}

export interface BucketColumn {
  key: string;
  label: string;
  isPast: boolean;
  isCurrent: boolean;
}
