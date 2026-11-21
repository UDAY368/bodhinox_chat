import { PDFDict, PDFDocument, PDFName } from 'pdf-lib';
import { describe, expect, it } from 'vitest';

import { PDF_MAX_ROWS, sanitizePdfText, toPdf } from './report-pdf';

/** The /BaseFont names of the document's fonts and how many embedded TrueType programs (FontFile2) it carries. */
function embeddedFonts(doc: PDFDocument): { names: string[]; programs: number } {
  const names: string[] = [];
  let programs = 0;
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFDict)) continue;
    const base = object.get(PDFName.of('BaseFont'));
    if (base && object.get(PDFName.of('Type'))?.toString() === '/Font') names.push(base.toString());
    if (object.get(PDFName.of('FontFile2'))) programs += 1;
  }
  return { names, programs };
}

const table = (rows: number, cell = 'Campaign') => ({
  title: 'Campaign summary',
  rangeLabel: '2026-10-01 to 2026-10-07 (Asia/Kolkata)',
  columns: ['campaign', 'sent', 'delivered'],
  rows: Array.from({ length: rows }, (_, i) => [`${cell} ${i}`, i, i * 2]),
  timezone: 'Asia/Kolkata',
  generatedAt: new Date('2026-11-04T06:30:00Z'),
});

describe('PDF text sanitizer', () => {
  it('keeps Latin, Hindi, Telugu and emoji, and counts only what no embedded font can draw', () => {
    expect(sanitizePdfText('Café – “Ayurveda” €5')).toEqual({ text: 'Café – “Ayurveda” €5', replaced: 0 });
    expect(sanitizePdfText('नमस्ते హలో 🙂👍🏽')).toEqual({ text: 'नमस्ते హలో 🙂👍🏽', replaced: 0 });
    // One unsupported character is one "?" (Korean has no embedded font), never two UTF-16 halves.
    expect(sanitizePdfText('안녕 Seoul')).toEqual({ text: '?? Seoul', replaced: 2 });
  });

  it('turns control characters and line breaks into spaces and renders null as empty', () => {
    expect(sanitizePdfText('a\nb\tc\u0000d')).toEqual({ text: 'a b c d', replaced: 0 });
    expect(sanitizePdfText(null)).toEqual({ text: '', replaced: 0 });
    expect(sanitizePdfText(42)).toEqual({ text: '42', replaced: 0 });
  });
});

describe('PDF rendering (pdf-lib, no browser)', { timeout: 60_000 }, () => {
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

  it('prints Hindi, Telugu and emoji with embedded, subset Noto fonts', async () => {
    const built = await toPdf({ ...table(0), title: 'दिवाली ऑफ़र', rows: [['दिवाली ऑफ़र 🎉', 'తెలుగు ప్రచారం', '✅ 3']] });
    expect(built).toMatchObject({ rowCount: 1, replacedCharacters: 0, pages: 1 });
    const doc = await PDFDocument.load(built.bytes);
    const fonts = embeddedFonts(doc);
    // Each script font is embedded (pdf-lib names a subset font <name>-<n>) with its own font program.
    for (const name of ['NotoSans-Regular', 'NotoSansDevanagari-Regular', 'NotoSansTelugu-Regular', 'NotoEmoji-Regular'])
      expect(fonts.names.some((n) => new RegExp(`^/${name}-\\d+$`).test(n)), name).toBe(true);
    expect(fonts.programs).toBeGreaterThanOrEqual(4);
    // Subsetting keeps the file far below the ~2 MB of the full font files.
    expect(built.bytes.length).toBeLessThan(250_000);
    expect(doc.getTitle()).toBe('दिवाली ऑफ़र');
  });

  it('a Latin-only report embeds no script fonts', async () => {
    const fonts = embeddedFonts(await PDFDocument.load((await toPdf(table(2))).bytes));
    expect(fonts.names.some((n) => n.includes('NotoSansDevanagari') || n.includes('NotoSansTelugu') || n.includes('NotoEmoji'))).toBe(false);
    expect(fonts.names.some((n) => /^\/NotoSans-Regular-\d+$/.test(n))).toBe(true);
  });

  it('renders an empty table', async () => {
    const built = await toPdf(table(0));
    expect(built).toMatchObject({ rowCount: 0, pages: 1, truncated: false });
  });
});
