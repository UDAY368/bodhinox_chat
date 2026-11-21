// PDF rendering of an analytics report table (Phase 12 design §5.3).
//
// pdf-lib only: pure JavaScript, no native dependency and no headless
// browser. A4 landscape, a paginated table whose header repeats on every
// page, and a footer with the page number, the generation time in the
// workspace timezone and any notices.
//
// Fonts (src/lib/analytics/fonts, SIL OFL 1.1, licence texts alongside, source
// URLs in fonts/sources.txt): Noto Sans Regular/Bold for Latin, Greek and
// Cyrillic, Noto Sans Devanagari (Hindi, Marathi), Noto Sans Telugu and the
// monochrome Noto Emoji (PDF cannot use colour emoji fonts). Each string is
// split into runs by script and each run is drawn in its font; Devanagari and
// Telugu runs are shaped by HarfBuzz (reordering, conjuncts, vowel signs, mark
// positions), and only glyphs actually used are embedded (subset). Characters no embedded font covers (Korean, Arabic, ...) are drawn
// as "?" and counted; the footer then points to the CSV, which stays the
// lossless format. At most PDF_MAX_ROWS rows are drawn.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import fontkit, { type Font } from '@pdf-lib/fontkit';
import {
  PDFDocument, PDFHexString, beginText, endText, popGraphicsState, pushGraphicsState, rgb, setFillingColor, setFontAndSize,
  setTextMatrix, showText, type Color, type PDFFont, type PDFName, type PDFPage,
} from 'pdf-lib';

export const PDF_MAX_ROWS = 2000;

const PAGE: [number, number] = [841.89, 595.28]; // A4 landscape, points
const MARGIN = 36;
const ROW_HEIGHT = 13;
const FOOTER_HEIGHT = 30;
const CELL_PAD = 3;
const MIN_COLUMN = 36;

type Script = 'latin' | 'deva' | 'telu' | 'emoji';
const FALLBACK_ORDER: Script[] = ['latin', 'emoji', 'deva', 'telu'];

const FONT_FILES = {
  latin: 'NotoSans-Regular.ttf',
  latinBold: 'NotoSans-Bold.ttf',
  deva: 'NotoSansDevanagari-Regular.ttf',
  telu: 'NotoSansTelugu-Regular.ttf',
  emoji: 'NotoEmoji-Regular.ttf',
} as const;

// Resolved from the working directory: the app and the worker both run from
// the repository root (the standalone build must trace this folder in).
const FONT_DIR = path.join(process.cwd(), 'src', 'lib', 'analytics', 'fonts');

interface LoadedFonts {
  bytes: Record<keyof typeof FONT_FILES, Uint8Array>;
  faces: Record<Script, Font>;
}
let loaded: LoadedFonts | null = null;

/** Reads the font files once per process, on first use. */
function loadFonts(): LoadedFonts {
  if (loaded) return loaded;
  const read = (file: string) => new Uint8Array(readFileSync(path.join(FONT_DIR, file)));
  const bytes = {
    latin: read(FONT_FILES.latin),
    latinBold: read(FONT_FILES.latinBold),
    deva: read(FONT_FILES.deva),
    telu: read(FONT_FILES.telu),
    emoji: read(FONT_FILES.emoji),
  };
  const faces = {
    latin: fontkit.create(bytes.latin),
    deva: fontkit.create(bytes.deva),
    telu: fontkit.create(bytes.telu),
    emoji: fontkit.create(bytes.emoji),
  };
  loaded = { bytes, faces };
  return loaded;
}

const EXTENDED_PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const MARK = /\p{M}/u;

/** Script ranges with a dedicated font; everything else tries the fonts in FALLBACK_ORDER. */
function scriptOf(code: number, next: number | undefined): Script | null {
  if ((code >= 0x0900 && code <= 0x097f) || (code >= 0xa8e0 && code <= 0xa8ff)) return 'deva';
  if (code >= 0x0c00 && code <= 0x0c7f) return 'telu';
  if (code >= 0x1f1e6 && code <= 0x1f1ff) return 'emoji'; // regional indicators (flags)
  // Pictographs: always for the emoji planes; text-default symbols (©, ™, ↔) only with VS16.
  if (EXTENDED_PICTOGRAPHIC.test(String.fromCodePoint(code)) && (code >= 0x1f000 || next === 0xfe0f)) return 'emoji';
  return null;
}

/** Joiners and presentation modifiers that belong to the character before them. */
function isJoiner(code: number): boolean {
  return code === 0x200c || code === 0x200d || code === 0x20e3
    || (code >= 0xfe00 && code <= 0xfe0f)
    || (code >= 0x1f3fb && code <= 0x1f3ff) // skin tones
    || (code >= 0xe0020 && code <= 0xe007f); // tag sequences
}

interface Run {
  script: Script;
  text: string;
}

interface Shaped {
  runs: Run[];
  text: string;
  replaced: number;
}

/**
 * Splits text into font runs. Control characters become spaces; joiners,
 * variation selectors and skin-tone modifiers stay with the run before them
 * when its font has them and are dropped otherwise (not counted); anything
 * no embedded font covers becomes "?" and is counted.
 */
function segment(value: unknown): Shaped {
  const raw = value == null ? '' : String(value);
  const { faces } = loadFonts();
  const runs: Run[] = [];
  let replaced = 0;
  const push = (script: Script, char: string) => {
    const last = runs[runs.length - 1];
    if (last && last.script === script) last.text += char;
    else runs.push({ script, text: char });
  };
  const chars = Array.from(raw);
  chars.forEach((char, i) => {
    const code = char.codePointAt(0)!;
    if (code < 0x20 || (code >= 0x7f && code < 0xa0) || code === 0x2028 || code === 0x2029) {
      push('latin', ' ');
      return;
    }
    const last = runs[runs.length - 1];
    if (isJoiner(code)) {
      if (last && faces[last.script].hasGlyphForCodePoint(code)) push(last.script, char);
      return;
    }
    if (MARK.test(char) && last && faces[last.script].hasGlyphForCodePoint(code)) {
      push(last.script, char);
      return;
    }
    const preferred = scriptOf(code, chars[i + 1]?.codePointAt(0));
    const order = preferred ? [preferred, ...FALLBACK_ORDER.filter((s) => s !== preferred)] : FALLBACK_ORDER;
    const script = order.find((s) => faces[s].hasGlyphForCodePoint(code));
    if (script) push(script, char);
    else {
      push('latin', '?');
      replaced += 1;
    }
  });
  return { runs, text: runs.map((r) => r.text).join(''), replaced };
}

/**
 * Text the embedded fonts can draw: whitespace and control characters become
 * a space, anything no embedded font covers becomes "?" and is counted.
 */
export function sanitizePdfText(value: unknown): { text: string; replaced: number } {
  const { text, replaced } = segment(value);
  return { text, replaced };
}

/** One weight of the font set: the Latin face differs, the script faces are Regular only. */
type FontSet = Record<Script, PDFFont>;

// Devanagari and Telugu need complex shaping (reordered vowel signs, conjuncts,
// reph, mark positioning). pdf-lib draws through fontkit's layout, whose Indic
// shaper in @pdf-lib/fontkit 1.1.1 crashes (it needs a global
// regeneratorRuntime) and which ignores mark positioning anyway. So these runs
// are shaped with HarfBuzz (WebAssembly) and drawn glyph by glyph at the
// positions it returns; the glyphs are added to pdf-lib's font subset directly.
type HarfBuzz = typeof import('harfbuzzjs');
type IndicScript = 'deva' | 'telu';
const isIndic = (script: Script): script is IndicScript => script === 'deva' || script === 'telu';

interface HbState {
  hb: HarfBuzz;
  fonts: Record<IndicScript, { font: InstanceType<HarfBuzz['Font']>; upem: number }>;
}
let hbState: Promise<HbState> | null = null;
let hbReady: HbState | null = null;

/** Loads HarfBuzz and the two Indic faces once per process. */
function loadHarfBuzz(): Promise<HbState> {
  hbState ??= (async () => {
    const hb = await import('harfbuzzjs');
    const { bytes } = loadFonts();
    const open = (data: Uint8Array) => {
      const face = new hb.Face(new hb.Blob(data));
      return { font: new hb.Font(face), upem: face.upem };
    };
    hbReady = { hb, fonts: { deva: open(bytes.deva), telu: open(bytes.telu) } };
    return hbReady;
  })().catch((error: unknown) => {
    hbState = null;
    throw error;
  });
  return hbState;
}

interface ShapedGlyph {
  gid: number;
  /** Index of the first code point of the cluster this glyph belongs to. */
  cluster: number;
  /** In font units. */
  xAdvance: number;
  xOffset: number;
  yOffset: number;
}

function shapeIndic(script: IndicScript, codePoints: number[]): { glyphs: ShapedGlyph[]; upem: number } {
  if (!hbReady) throw new Error('HarfBuzz is not loaded');
  const { hb, fonts } = hbReady;
  const buffer = new hb.Buffer();
  codePoints.forEach((code, i) => buffer.add(code, i));
  buffer.guessSegmentProperties();
  hb.shape(fonts[script].font, buffer);
  const infos = buffer.getGlyphInfos();
  const positions = buffer.getGlyphPositions();
  const glyphs = infos.map((info, i) => ({
    gid: info.codepoint,
    cluster: info.cluster,
    xAdvance: positions[i].xAdvance,
    xOffset: positions[i].xOffset,
    yOffset: positions[i].yOffset,
  }));
  return { glyphs, upem: fonts[script].upem };
}

function runWidth(run: Run, font: PDFFont, size: number): number {
  if (!isIndic(run.script)) return font.widthOfTextAtSize(run.text, size);
  const { glyphs, upem } = shapeIndic(run.script, Array.from(run.text, (c) => c.codePointAt(0)!));
  return (glyphs.reduce((sum, g) => sum + g.xAdvance, 0) * size) / upem;
}

function widthOf(text: string, fonts: FontSet, size: number): number {
  return segment(text).runs.reduce((sum, run) => sum + runWidth(run, fonts[run.script], size), 0);
}

// pdf-lib 1.17.1 (pinned) keeps its subsetting embedder private; these are the
// fields its own encodeText uses. Checked at runtime so an upgrade fails loudly.
interface SubsetEmbedder {
  font: Font;
  subset: { includeGlyph(glyph: unknown): number };
  glyphs: unknown[];
  glyphIdMap: Map<number, number>;
  glyphCache: { invalidate(): void };
}

function subsetEmbedder(font: PDFFont): SubsetEmbedder {
  const embedder = (font as unknown as { embedder?: Partial<SubsetEmbedder> }).embedder;
  if (!embedder?.font || !embedder.subset || !Array.isArray(embedder.glyphs) || !(embedder.glyphIdMap instanceof Map) || !embedder.glyphCache)
    throw new Error('pdf-lib font embedder is not the expected subsetting embedder');
  return embedder as SubsetEmbedder;
}

/** Adds a glyph to the font's subset (with the text it stands for, for copy/search) and returns its id there. */
function subsetGlyphId(embedder: SubsetEmbedder, gid: number, codePoints: number[]): number {
  const known = embedder.glyphIdMap.get(gid);
  if (known !== undefined) return known;
  const glyph = embedder.font.getGlyph(gid, codePoints.length > 0 ? codePoints : [0x200b]);
  const id = embedder.subset.includeGlyph(glyph);
  embedder.glyphs[id - 1] = glyph;
  embedder.glyphIdMap.set(gid, id);
  embedder.glyphCache.invalidate();
  return id;
}

const pageFontKeys = new WeakMap<PDFPage, Map<PDFFont, PDFName>>();

function fontKeyFor(page: PDFPage, font: PDFFont): PDFName {
  let keys = pageFontKeys.get(page);
  if (!keys) pageFontKeys.set(page, (keys = new Map()));
  let key = keys.get(font);
  if (!key) keys.set(font, (key = page.node.newFontDictionary(font.name, font.ref)));
  return key;
}

/** Draws one shaped Devanagari or Telugu run; returns its width. */
function drawIndic(page: PDFPage, run: Run & { script: IndicScript }, font: PDFFont, x: number, y: number, size: number, color: Color): number {
  const codePoints = Array.from(run.text, (c) => c.codePointAt(0)!);
  const { glyphs, upem } = shapeIndic(run.script, codePoints);
  const embedder = subsetEmbedder(font);
  const clusters = [...new Set(glyphs.map((g) => g.cluster))].sort((a, b) => a - b);
  const clusterEnd = (start: number) => clusters.find((c) => c > start) ?? codePoints.length;
  const seen = new Set<number>();
  const scale = size / upem;
  const ops = [pushGraphicsState(), setFillingColor(color), beginText(), setFontAndSize(fontKeyFor(page, font), size)];
  let pen = 0;
  for (const g of glyphs) {
    // The first glyph of a cluster carries the cluster's text in the ToUnicode map.
    const text = seen.has(g.cluster) ? [] : codePoints.slice(g.cluster, clusterEnd(g.cluster));
    seen.add(g.cluster);
    const id = subsetGlyphId(embedder, g.gid, text);
    ops.push(setTextMatrix(1, 0, 0, 1, x + (pen + g.xOffset) * scale, y + g.yOffset * scale));
    ops.push(showText(PDFHexString.of(id.toString(16).padStart(4, '0'))));
    pen += g.xAdvance;
  }
  ops.push(endText(), popGraphicsState());
  page.pushOperators(...ops);
  return pen * scale;
}

const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });

/** Shortens text to a width, ending with "..." when cut. Cuts between grapheme clusters, never inside a conjunct. */
function fit(text: string, fonts: FontSet, size: number, width: number): string {
  if (widthOf(text, fonts, size) <= width) return text;
  const parts = Array.from(graphemes.segment(text), (s) => s.segment);
  const ellipsis = '...';
  let low = 0;
  let high = parts.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (widthOf(parts.slice(0, mid).join('') + ellipsis, fonts, size) <= width) low = mid;
    else high = mid - 1;
  }
  return low > 0 ? parts.slice(0, low).join('') + ellipsis : '';
}

/** Draws text run by run, each in its script's font. */
function draw(page: PDFPage, text: string, fonts: FontSet, options: { x: number; y: number; size: number; color?: Color }) {
  let x = options.x;
  for (const run of segment(text).runs) {
    const font = fonts[run.script];
    if (isIndic(run.script)) {
      x += drawIndic(page, { script: run.script, text: run.text }, font, x, options.y, options.size, options.color ?? rgb(0, 0, 0));
      continue;
    }
    page.drawText(run.text, { ...options, x, font });
    x += font.widthOfTextAtSize(run.text, options.size);
  }
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
  /** Characters drawn as "?" because no embedded font has a glyph for them. */
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
  const { bytes: fontBytes } = loadFonts();
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const generatedAt = table.generatedAt ?? new Date();
  doc.setCreator('Bodhinox');
  doc.setProducer('Bodhinox');
  doc.setCreationDate(generatedAt);
  doc.setModificationDate(generatedAt);

  let replaced = 0;
  const used = new Set<Script>();
  const clean = (value: unknown) => {
    const s = segment(value);
    replaced += s.replaced;
    s.runs.forEach((r) => used.add(r.script));
    return s.text;
  };
  const title = clean(table.title);
  doc.setTitle(title);
  const rangeLabel = clean(table.rangeLabel);
  const truncated = table.truncated === true || table.rows.length > PDF_MAX_ROWS;
  const rows = table.rows.slice(0, PDF_MAX_ROWS).map((row) => table.columns.map((_, i) => clean(row[i])));
  const headers = table.columns.map((c) => clean(c));
  const size = headers.length > 12 ? 6.5 : headers.length > 8 ? 7.5 : 8.5;

  // Embed only the script fonts this document uses, subset to the glyphs drawn.
  const latin = await doc.embedFont(fontBytes.latin, { subset: true });
  const latinBold = await doc.embedFont(fontBytes.latinBold, { subset: true });
  const embed = async (script: Exclude<Script, 'latin'>) =>
    used.has(script) ? doc.embedFont(fontBytes[script], { subset: true }) : latin;
  const [deva, telu, emoji] = [await embed('deva'), await embed('telu'), await embed('emoji')];
  if (used.has('deva') || used.has('telu')) await loadHarfBuzz();
  const font: FontSet = { latin, deva, telu, emoji };
  const bold: FontSet = { latin: latinBold, deva, telu, emoji };

  // Column widths: each column's widest header or sample cell, scaled to the page.
  const usable = PAGE[0] - 2 * MARGIN;
  const sample = rows.slice(0, 200);
  const natural = headers.map((h, i) => Math.max(
    MIN_COLUMN,
    widthOf(h, bold, size) + 2 * CELL_PAD,
    ...sample.map((r) => Math.min(widthOf(r[i], font, size), 220) + 2 * CELL_PAD),
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
      draw(page, fit(title, bold, 14, usable), bold, { x: MARGIN, y: y - 14, size: 14 });
      y -= 20;
      draw(page, fit(rangeLabel, font, 9, usable), font, { x: MARGIN, y: y - 9, size: 9, color: rgb(0.3, 0.3, 0.3) });
      y -= 18;
    }
    // Repeated header row.
    page.drawRectangle({ x: MARGIN, y: y - ROW_HEIGHT, width: usable, height: ROW_HEIGHT, color: rgb(0.92, 0.92, 0.92) });
    let x = MARGIN;
    headers.forEach((h, i) => {
      draw(page, fit(h, bold, size, widths[i] - 2 * CELL_PAD), bold, { x: x + CELL_PAD, y: y - ROW_HEIGHT + 4, size });
      x += widths[i];
    });
    y -= ROW_HEIGHT;
  };

  newPage(true);
  if (rows.length === 0) draw(page, 'No rows for this period.', font, { x: MARGIN, y: y - ROW_HEIGHT, size });
  rows.forEach((row, index) => {
    if (y - ROW_HEIGHT < MARGIN + FOOTER_HEIGHT) newPage(false);
    if (index % 2 === 1)
      page.drawRectangle({ x: MARGIN, y: y - ROW_HEIGHT, width: usable, height: ROW_HEIGHT, color: rgb(0.97, 0.97, 0.97) });
    let x = MARGIN;
    row.forEach((cell, i) => {
      const text = fit(cell, font, size, widths[i] - 2 * CELL_PAD);
      if (text) draw(page, text, font, { x: x + CELL_PAD, y: y - ROW_HEIGHT + 4, size });
      x += widths[i];
    });
    y -= ROW_HEIGHT;
  });

  // Footers last, once the page count and the replaced-character count are known.
  const grey = rgb(0.35, 0.35, 0.35);
  const notices = [`Generated ${clean(generatedLabel(generatedAt, table.timezone))}`];
  if (truncated) notices.push(`Truncated: the first ${rows.length.toLocaleString('en-US')} rows only; use CSV for the full report.`);
  if (replaced > 0) notices.push(`${replaced.toLocaleString('en-US')} characters could not be shown in this PDF and appear as "?"; use CSV.`);
  pages.forEach((p, i) => {
    draw(p, fit(notices.join('  |  '), font, 7, usable - 60), font, { x: MARGIN, y: MARGIN - 4, size: 7, color: grey });
    const label = `Page ${i + 1} of ${pages.length}`;
    draw(p, label, font, { x: PAGE[0] - MARGIN - widthOf(label, font, 7), y: MARGIN - 4, size: 7, color: grey });
  });

  const bytes = await doc.save({ useObjectStreams: true });
  return { bytes, rowCount: rows.length, truncated, replacedCharacters: replaced, pages: pages.length };
}
