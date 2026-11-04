import { PDFDocument } from 'pdf-lib';
import { describe, expect, it } from 'vitest';

import { PDF_MAX_ROWS, sanitizePdfText, toPdf } from './report-pdf';

const table = (rows: number, cell = 'Campaign') => ({
  title: 'Campaign summary',
  rangeLabel: '2026-10-01 to 2026-10-07 (Asia/Kolkata)',
  columns: ['campaign', 'sent', 'delivered'],
  rows: Array.from({ length: rows }, (_, i) => [`${cell} ${i}`, i, i * 2]),
  timezone: 'Asia/Kolkata',
  generatedAt: new Date('2026-11-04T06:30:00Z'),
});

describe('PDF text sanitizer', () => {
  it('keeps Latin-1 and the Windows-1252 extras, and counts what the standard font cannot draw', () => {
    expect(sanitizePdfText('Café – “Ayurveda” €5')).toEqual({ text: 'Café – “Ayurveda” €5', replaced: 0 });
    expect(sanitizePdfText('안녕 Seoul')).toEqual({ text: '?? Seoul', replaced: 2 });
    // One emoji is one character (one "?"), not two UTF-16 halves.
    expect(sanitizePdfText('ok 🙂')).toEqual({ text: 'ok ?', replaced: 1 });
  });

  it('turns control characters and line breaks into spaces and renders null as empty', () => {
    expect(sanitizePdfText('a\nb\tc\u0000d')).toEqual({ text: 'a b c d', replaced: 0 });
    expect(sanitizePdfText(null)).toEqual({ text: '', replaced: 0 });
    expect(sanitizePdfText(42)).toEqual({ text: '42', replaced: 0 });
  });
});

describe('PDF rendering (pdf-lib, no browser)', () => {
  it('renders a readable A4 landscape document', async () => {
    const built = await toPdf(table(3));
    expect(new TextDecoder().decode(built.bytes.slice(0, 5))).toBe('%PDF-');
    const doc = await PDFDocument.load(built.bytes);
    expect(doc.getPageCount()).toBe(1);
    const { width, height } = doc.getPage(0).getSize();
    expect(width).toBeGreaterThan(height);
    expect(doc.getTitle()).toBe('Campaign summary');
    expect(built).toMatchObject({ rowCount: 3, truncated: false, replacedCharacters: 0, pages: 1 });
  });

  it('paginates long tables', async () => {
    const built = await toPdf(table(200));
    expect(built.pages).toBeGreaterThan(3);
    expect((await PDFDocument.load(built.bytes)).getPageCount()).toBe(built.pages);
  });

  it('truncates at PDF_MAX_ROWS and flags it', async () => {
    const built = await toPdf(table(PDF_MAX_ROWS + 5));
    expect(built).toMatchObject({ rowCount: PDF_MAX_ROWS, truncated: true });
    const marked = await toPdf({ ...table(2), truncated: true });
    expect(marked.truncated).toBe(true);
  });

  it('counts characters it could not draw (Korean names) for the CSV notice', async () => {
    const built = await toPdf(table(2, '캠페인'));
    expect(built.replacedCharacters).toBe(6);
  });

  it('renders an empty table', async () => {
    const built = await toPdf(table(0));
    expect(built).toMatchObject({ rowCount: 0, pages: 1, truncated: false });
  });
});
