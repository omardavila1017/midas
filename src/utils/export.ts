/**
 * Export utilities for Midas.
 * Provides CSV generation and clipboard copy for all modules.
 */

/**
 * Format a date value for CSV export as `dd/mm/aaaa` (es-MX convention).
 *
 * Tolerant by design: `YYYY-MM-DD` (optionally carrying a `T…` time suffix)
 * → `dd/mm/aaaa`; empty / nullish → `''`; anything that is NOT a recognizable
 * ISO date is passed through unchanged, so legacy or already-formatted values
 * survive without being mangled. The finance team reads these CSVs in Excel
 * es-MX, where `2026-04-20` is ambiguous but `20/04/2026` is not.
 */
export function csvDate(value: string | number | null | undefined): string {
  if (value == null || value === '') return '';
  const s = String(value).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return s;
  const [, year, month, day] = m;
  return `${day}/${month}/${year}`;
}

/** Convert array of objects to CSV string */
export function toCSV(rows: Record<string, string | number>[], headers?: string[]): string {
  if (rows.length === 0) return '';
  const keys = headers ?? Object.keys(rows[0]);
  const lines = [keys.join(',')];
  for (const row of rows) {
    lines.push(keys.map(k => {
      const val = row[k];
      if (typeof val === 'string' && (val.includes(',') || val.includes('"') || val.includes('\n'))) {
        return `"${val.replace(/"/g, '""')}"`;
      }
      return String(val ?? '');
    }).join(','));
  }
  return lines.join('\n');
}

/** Copy text to clipboard with fallback */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for older browsers
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  }
}

/** Trigger browser download of a string as a file */
export function downloadFile(content: string, filename: string, mime = 'text/csv;charset=utf-8') {
  const blob = new Blob(['\ufeff' + content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
