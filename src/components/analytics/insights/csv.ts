// Client-side CSV export of a table already on screen (counts and names only).
// Cells that a spreadsheet would read as a formula are prefixed with an
// apostrophe, and the file starts with a UTF-8 BOM so Excel reads it as UTF-8.

/** One CSV cell: formula-safe and quoted when needed. */
export function csvCell(value: unknown): string {
  let s = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsvText(columns: string[], rows: unknown[][]): string {
  return `﻿${[columns, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

/** A file-name stem: lowercase letters, digits and dashes. */
export function slug(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'export';
}

/** Saves a CSV in the browser. */
export function downloadCsv(name: string, columns: string[], rows: unknown[][]): string {
  const file = `${slug(name)}.csv`;
  saveBlob(new Blob([toCsvText(columns, rows)], { type: 'text/csv;charset=utf-8' }), file);
  return file;
}

export function saveBlob(blob: Blob, file: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = file;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
