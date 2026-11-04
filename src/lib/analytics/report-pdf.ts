// PDF rendering of an analytics report table (Phase 12 design §5.3).
//
// pdf-lib only: pure JavaScript, no native dependency and no headless
// browser. A4 landscape, the standard Helvetica font, a paginated table whose
// header repeats on every page, and a footer with the page number, the
// generation time in the workspace timezone and any notices.
//
// Helvetica is a WinAnsi (Windows-1252) font, so text it cannot encode
// (Korean, emoji, most non-Latin scripts) is drawn as "?" and counted; the
// footer then says how many characters could not be shown and points to the
// CSV, which stays the lossless format. At most PDF_MAX_ROWS rows are drawn.

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';

export const PDF_MAX_ROWS = 2000;

const PAGE: [number, number] = [841.89, 595.28]; // A4 landscape, points
const MARGIN = 36;
const ROW_HEIGHT = 13;
const FOOTER_HEIGHT = 30;
const CELL_PAD = 3;
const MIN_COLUMN = 36;

// Windows-1252 code points above 0x7E that Helvetica (WinAnsiEncoding) can draw.
const WIN_ANSI_EXTRA = new Set(
  '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ'.split('').map((c) => c.codePointAt(0)!),
);

function encodable(code: number): boolean {
  return (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff) || WIN_ANSI_EXTRA.has(code);
}

/**
 * Text the standard font can draw: whitespace and control characters become
 * a space, anything else WinAnsi cannot encode becomes "?" and is counted.
 */
export function sanitizePdfText(value: unknown): { text: string; replaced: number } {
  const raw = value == null ? '' : String(value);
  let text = '';
  let replaced = 0;
  for (const char of raw) {
    const code = char.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code < 0xa0 && !WIN_ANSI_EXTRA.has(code))) text += ' ';
    else if (encodable(code)) text += char;
    else {
      text += '?';
      replaced += 1;
    }
  }
  return { text, replaced };
}

/** Shortens text to a width, ending with "..." when cut. */
function fit(text: string, font: PDFFont, size: number, width: number): string {
  if (font.widthOfTextAtSize(text, size) <= width) return text;
  const ellipsis = '...';
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (font.widthOfTextAtSize(text.slice(0, mid) + ellipsis, size) <= width) low = mid;
    else high = mid - 1;
  }
  return low > 0 ? text.slice(0, low) + ellipsis : '';
}

export interface PdfTable {
  title: string;
  /** e.g. "2026-10-01 to 2026-10-07 (Asia/Kolkata)". */
  rangeLabel: string;
  columns: string[];
  rows: unknown[][];
  timezone: string;
  generatedAt?: Date;
  /** The table was already cut before rendering (more rows than the report keeps). */
  truncated?: boolean;
}

export interface BuiltPdf {
  bytes: Uint8Array;
  /** Rows drawn (at most PDF_MAX_ROWS). */
  rowCount: number;
  truncated: boolean;
  /** Characters drawn as "?" because the standard font cannot encode them. */
  replacedCharacters: number;
  pages: number;
}

function generatedLabel(at: Date, timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(at);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
    return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')} (${timezone})`;
  } catch {
    return `${at.toISOString().slice(0, 16).replace('T', ' ')} (UTC)`;
  }
}

/** Renders a table as a paginated A4 landscape PDF. Headers are the report's English column labels. */
export async function toPdf(table: PdfTable): Promise<BuiltPdf> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const generatedAt = table.generatedAt ?? new Date();
  doc.setCreator('Bodhinox');
  doc.setProducer('Bodhinox');
  doc.setCreationDate(generatedAt);
  doc.setModificationDate(generatedAt);

  let replaced = 0;
  const clean = (value: unknown) => {
    const s = sanitizePdfText(value);
    replaced += s.replaced;
    return s.text;
  };
  const title = clean(table.title);
  doc.setTitle(title);
  const truncated = table.truncated === true || table.rows.length > PDF_MAX_ROWS;
  const rows = table.rows.slice(0, PDF_MAX_ROWS).map((row) => table.columns.map((_, i) => clean(row[i])));
  const headers = table.columns.map((c) => clean(c));
  const size = headers.length > 12 ? 6.5 : headers.length > 8 ? 7.5 : 8.5;

  // Column widths: each column's widest header or sample cell, scaled to the page.
  const usable = PAGE[0] - 2 * MARGIN;
  const sample = rows.slice(0, 200);
  const natural = headers.map((h, i) => Math.max(
    MIN_COLUMN,
    bold.widthOfTextAtSize(h, size) + 2 * CELL_PAD,
    ...sample.map((r) => Math.min(font.widthOfTextAtSize(r[i], size), 220) + 2 * CELL_PAD),
  ));
  const total = natural.reduce((a, b) => a + b, 0);
  const widths = natural.map((w) => (w / total) * usable);

  const pages: PDFPage[] = [];
  let page!: PDFPage;
  let y = 0;
  const newPage = (first: boolean) => {
    page = doc.addPage(PAGE);
    pages.push(page);
    y = PAGE[1] - MARGIN;
    if (first) {
      page.drawText(fit(title, bold, 14, usable), { x: MARGIN, y: y - 14, size: 14, font: bold });
      y -= 20;
      page.drawText(fit(clean(table.rangeLabel), font, 9, usable), { x: MARGIN, y: y - 9, size: 9, font, color: rgb(0.3, 0.3, 0.3) });
      y -= 18;
    }
    // Repeated header row.
    page.drawRectangle({ x: MARGIN, y: y - ROW_HEIGHT, width: usable, height: ROW_HEIGHT, color: rgb(0.92, 0.92, 0.92) });
    let x = MARGIN;
    headers.forEach((h, i) => {
      page.drawText(fit(h, bold, size, widths[i] - 2 * CELL_PAD), { x: x + CELL_PAD, y: y - ROW_HEIGHT + 4, size, font: bold });
      x += widths[i];
    });
    y -= ROW_HEIGHT;
  };

  newPage(true);
  if (rows.length === 0) page.drawText('No rows for this period.', { x: MARGIN, y: y - ROW_HEIGHT, size, font });
  rows.forEach((row, index) => {
    if (y - ROW_HEIGHT < MARGIN + FOOTER_HEIGHT) newPage(false);
    if (index % 2 === 1)
      page.drawRectangle({ x: MARGIN, y: y - ROW_HEIGHT, width: usable, height: ROW_HEIGHT, color: rgb(0.97, 0.97, 0.97) });
    let x = MARGIN;
    row.forEach((cell, i) => {
      const text = fit(cell, font, size, widths[i] - 2 * CELL_PAD);
      if (text) page.drawText(text, { x: x + CELL_PAD, y: y - ROW_HEIGHT + 4, size, font });
      x += widths[i];
    });
    y -= ROW_HEIGHT;
  });

  // Footers last, once the page count and the replaced-character count are known.
  const notices = [`Generated ${generatedLabel(generatedAt, table.timezone)}`];
  if (truncated) notices.push(`Truncated: the first ${rows.length.toLocaleString('en-US')} rows only; use CSV for the full report.`);
  if (replaced > 0) notices.push(`${replaced.toLocaleString('en-US')} characters could not be shown in this PDF and appear as "?"; use CSV.`);
  pages.forEach((p, i) => {
    p.drawText(fit(notices.join('  |  '), font, 7, usable - 60), { x: MARGIN, y: MARGIN - 4, size: 7, font, color: rgb(0.35, 0.35, 0.35) });
    const label = `Page ${i + 1} of ${pages.length}`;
    p.drawText(label, { x: PAGE[0] - MARGIN - font.widthOfTextAtSize(label, 7), y: MARGIN - 4, size: 7, font, color: rgb(0.35, 0.35, 0.35) });
  });

  const bytes = await doc.save({ useObjectStreams: true });
  return { bytes, rowCount: rows.length, truncated, replacedCharacters: replaced, pages: pages.length };
}
