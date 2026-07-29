import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyToClipboard, csvDate, downloadFile, toCSV } from './export';

describe('csvDate — dd/mm/aaaa for CSV export (B3.8)', () => {
  it('formats a plain ISO date', () => {
    expect(csvDate('2026-03-10')).toBe('10/03/2026');
  });

  it('formats an ISO datetime by dropping the time', () => {
    expect(csvDate('2026-12-01T13:40:00')).toBe('01/12/2026');
  });

  it('is tolerant of empty / nullish values', () => {
    expect(csvDate('')).toBe('');
    expect(csvDate(null)).toBe('');
    expect(csvDate(undefined)).toBe('');
  });

  it('passes through non-ISO strings unchanged (already-formatted or garbage)', () => {
    expect(csvDate('10/03/2026')).toBe('10/03/2026');
    expect(csvDate('N/A')).toBe('N/A');
    expect(csvDate('Ene 2026')).toBe('Ene 2026');
  });

  it('coerces numeric input to string (passthrough — not an ISO date)', () => {
    expect(csvDate(20260310)).toBe('20260310');
  });
});

describe('toCSV', () => {
  it('escapes commas, quotes and newlines', () => {
    const csv = toCSV([{ a: 'x,y', b: 'he said "hi"' }]);
    const lines = csv.split('\n');
    expect(lines[0]).toBe('a,b');
    expect(lines[1]).toBe('"x,y","he said ""hi"""');
  });

  it('returns empty string for no rows', () => {
    expect(toCSV([])).toBe('');
  });

  it('escapes embedded newlines by quoting the cell', () => {
    const csv = toCSV([{ a: 'line1\nline2', b: 'plain' }]);
    const [header, ...rest] = csv.split('\n');
    expect(header).toBe('a,b');
    // The newline lives INSIDE the quoted cell, so joining the remaining
    // physical lines reconstructs the single logical row.
    expect(rest.join('\n')).toBe('"line1\nline2",plain');
  });

  it('honors an explicit headers list (column subset + order + missing keys)', () => {
    const rows: Record<string, string | number>[] = [
      { a: 'x', b: 1 },
      { a: 'y' }, // no `b` — must render as empty cell, not "undefined"
    ];
    const csv = toCSV(rows, ['b', 'a']);
    expect(csv.split('\n')).toEqual(['b,a', '1,x', ',y']);
  });

  it('renders numbers unquoted and derives headers from the first row', () => {
    const csv = toCSV([
      { a: 1.5, b: 'plain' },
      { a: 0, b: 'z', c: 'extra-key-ignored' },
    ]);
    expect(csv.split('\n')).toEqual(['a,b', '1.5,plain', '0,z']);
  });
});

describe('copyToClipboard', () => {
  const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

  afterEach(() => {
    if (originalClipboard) {
      Object.defineProperty(navigator, 'clipboard', originalClipboard);
    } else {
      delete (navigator as unknown as Record<string, unknown>).clipboard;
    }
    delete (document as unknown as Record<string, unknown>).execCommand;
    vi.restoreAllMocks();
  });

  it('uses navigator.clipboard.writeText when available', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    await expect(copyToClipboard('hola')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('hola');
  });

  it('falls back to a hidden textarea + execCommand when clipboard API rejects', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
      configurable: true,
    });
    const execCommand = vi.fn().mockReturnValue(true);
    (document as unknown as Record<string, unknown>).execCommand = execCommand;

    await expect(copyToClipboard('fallback-text')).resolves.toBe(true);
    expect(execCommand).toHaveBeenCalledWith('copy');
    // The temp textarea must be cleaned up.
    expect(document.querySelector('textarea')).toBeNull();
  });

  it('reports false when the execCommand fallback also fails', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
      configurable: true,
    });
    (document as unknown as Record<string, unknown>).execCommand = vi.fn().mockReturnValue(false);
    await expect(copyToClipboard('x')).resolves.toBe(false);
    expect(document.querySelector('textarea')).toBeNull();
  });
});

describe('downloadFile', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates a BOM-prefixed blob, clicks an anchor with the filename and revokes the URL', () => {
    let capturedBlob: Blob | null = null;
    const createObjectURL = vi.fn((blob: Blob) => {
      capturedBlob = blob;
      return 'blob:midas-test';
    });
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', Object.assign(Object.create(URL), { createObjectURL, revokeObjectURL }));

    let clickedAnchor: HTMLAnchorElement | null = null;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clickedAnchor = this;
    });

    downloadFile('a,b\n1,2', 'reporte.csv');

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(capturedBlob).not.toBeNull();
    expect(capturedBlob!.type).toBe('text/csv;charset=utf-8');
    // '﻿' (BOM) es 3 bytes UTF-8 + 7 bytes del contenido.
    expect(capturedBlob!.size).toBe(new TextEncoder().encode('﻿a,b\n1,2').length);
    expect(clickedAnchor).not.toBeNull();
    expect(clickedAnchor!.download).toBe('reporte.csv');
    expect(clickedAnchor!.href).toContain('blob:midas-test');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:midas-test');

    vi.unstubAllGlobals();
  });

  it('accepts a custom mime type', () => {
    let capturedBlob: Blob | null = null;
    const createObjectURL = vi.fn((blob: Blob) => {
      capturedBlob = blob;
      return 'blob:midas-test-2';
    });
    vi.stubGlobal('URL', Object.assign(Object.create(URL), { createObjectURL, revokeObjectURL: vi.fn() }));
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    downloadFile('{"a":1}', 'data.json', 'application/json');
    expect(capturedBlob!.type).toBe('application/json');

    vi.unstubAllGlobals();
  });
});
