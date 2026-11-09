/**
 * Quote a CSV cell and neutralise spreadsheet formulas (=, +, -, @, tab, CR).
 * A plain international number ('+' then digits only) cannot call a function,
 * so it is written as-is and other tools can read the phone column.
 * Client-safe (no server imports): the import modal's rejected-rows file uses it too.
 */
export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : value instanceof Date ? value.toISOString() : String(value);
  if (/^[=+\-@\t\r]/.test(text) && !/^\+\d+$/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
