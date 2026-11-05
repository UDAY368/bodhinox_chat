// Phase 15 release evidence: builds the requirement-to-test record from the
// requirements CSV, the curated test registry, [REQ-ID] tags in describe titles,
// the per-row status table and the JSON reports of the last local run. Pure
// functions only; scripts/release/requirement-map.ts does the file I/O.

export const RELEASE_STATUSES = ['live', 'verified', 'simulated', 'provider-gated', 'approval-blocked', 'partial', 'not built'] as const;
export type ReleaseStatus = (typeof RELEASE_STATUSES)[number];

export interface StatusEntry {
  status: ReleaseStatus;
  /** Why this status, from the evidence. */
  reason: string;
  /** What stops the next status (approval, keys, missing build); empty when nothing does. */
  blocker?: string;
  /** Owner-supplied production evidence (date and what was observed). Required for `live`. */
  ownerEvidence?: string;
}

export interface Requirement { id: string; title: string; release: string; priority: string }
export type TestKind = 'unit' | 'integration' | 'e2e';
export interface FileResult { passed: number; failed: number; skipped: number }
export type ResultMap = Map<string, FileResult>;

export interface RequirementRow extends Requirement {
  entry: StatusEntry | undefined;
  tests: Record<TestKind, string[]>;
  result: FileResult & { notRun: number };
}

const ID = /^[A-Z]{2,4}-\d{2}$/;

/** RFC 4180 CSV (quoted fields, doubled quotes, CRLF or LF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  return rows;
}

export function requirementsFromCsv(text: string): Requirement[] {
  const [header, ...rows] = parseCsv(text);
  const col = (name: string) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`requirements CSV has no ${name} column`);
    return i;
  };
  const [id, title, release, priority] = [col('requirement_id'), col('requirement'), col('release'), col('priority')];
  return rows.filter((r) => r[id]).map((r) => ({ id: r[id], title: r[title], release: r[release], priority: r[priority] }));
}

/** Requirement ids tagged as `[REQ-ID]` in describe titles of one test file. */
export function tagsFromSource(source: string): string[] {
  const ids = new Set<string>();
  const describe = /describe(?:\.[a-zA-Z]+(?:\([^)]*\))?)*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g;
  for (const m of source.matchAll(describe))
    for (const t of m[2].matchAll(/\[([A-Z]{2,4}-\d{2})\]/g)) ids.add(t[1]);
  return [...ids].sort();
}

export function testKind(file: string): TestKind {
  if (/^e2e\//.test(file) || file.endsWith('.spec.ts')) return 'e2e';
  if (/\.(integration|load)\.test\.ts$/.test(file)) return 'integration';
  return 'unit';
}

const posix = (file: string) => file.replace(/\\/g, '/');

/** Repository-relative path of a report entry (reports hold absolute paths). */
export function relativeTo(root: string, file: string): string {
  const r = posix(root).replace(/\/+$/, '') + '/';
  const f = posix(file);
  return f.toLowerCase().startsWith(r.toLowerCase()) ? f.slice(r.length) : f;
}

/** Per-file counts from a vitest `--reporter=json` report. */
export function resultsFromVitest(report: unknown, root: string): ResultMap {
  const out: ResultMap = new Map();
  const files = (report as { testResults?: { name: string; assertionResults?: { status: string }[] }[] })?.testResults ?? [];
  for (const file of files) {
    const r: FileResult = { passed: 0, failed: 0, skipped: 0 };
    for (const a of file.assertionResults ?? []) {
      if (a.status === 'passed') r.passed++;
      else if (a.status === 'failed') r.failed++;
      else r.skipped++;
    }
    // A file that failed to load has no assertions: count it as one failure.
    if (!file.assertionResults?.length && (file as { status?: string }).status === 'failed') r.failed++;
    out.set(relativeTo(root, file.name), r);
  }
  return out;
}

/** Per-file counts from a Playwright `--reporter=json` report. */
export function resultsFromPlaywright(report: unknown, root: string): ResultMap {
  const out: ResultMap = new Map();
  type Suite = { file?: string; specs?: { file?: string; tests?: { status?: string }[] }[]; suites?: Suite[] };
  const base = posix((report as { config?: { rootDir?: string } })?.config?.rootDir ?? root);
  const walk = (suite: Suite) => {
    for (const spec of suite.specs ?? []) {
      const file = relativeTo(root, `${base}/${spec.file ?? suite.file ?? ''}`);
      const key = file.startsWith('e2e/') ? file : `e2e/${file}`;
      const r = out.get(key) ?? { passed: 0, failed: 0, skipped: 0 };
      for (const t of spec.tests ?? []) {
        if (t.status === 'expected' || t.status === 'flaky') r.passed++;
        else if (t.status === 'skipped') r.skipped++;
        else r.failed++;
      }
      out.set(key, r);
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of (report as { suites?: Suite[] })?.suites ?? []) walk(suite);
  return out;
}

export function mergeResults(...maps: ResultMap[]): ResultMap {
  const out: ResultMap = new Map();
  for (const map of maps) for (const [k, v] of map) out.set(k, v);
  return out;
}

export interface BuildInput {
  requirements: Requirement[];
  /** Curated registry: id → test files (docs/release/requirement-tests.json). */
  registry: Record<string, string[]>;
  /** Tags found in test sources: file → ids. */
  tags: Record<string, string[]>;
  statuses: Record<string, StatusEntry>;
  results: ResultMap;
}

export function buildRows(input: BuildInput): RequirementRow[] {
  const filesFor = new Map<string, Set<string>>();
  const add = (id: string, file: string) => {
    if (!filesFor.has(id)) filesFor.set(id, new Set());
    filesFor.get(id)!.add(posix(file));
  };
  for (const [id, files] of Object.entries(input.registry)) if (ID.test(id)) for (const f of files) add(id, f);
  for (const [file, ids] of Object.entries(input.tags)) for (const id of ids) add(id, file);
  return input.requirements.map((req) => {
    const files = [...(filesFor.get(req.id) ?? [])].sort();
    const tests: Record<TestKind, string[]> = { unit: [], integration: [], e2e: [] };
    for (const f of files) tests[testKind(f)].push(f);
    const result = { passed: 0, failed: 0, skipped: 0, notRun: 0 };
    for (const f of files) {
      const r = input.results.get(f);
      if (!r) { result.notRun++; continue; }
      result.passed += r.passed; result.failed += r.failed; result.skipped += r.skipped;
    }
    return { ...req, entry: input.statuses[req.id], tests, result };
  });
}

/**
 * Release rules: every CSV id has a status row with a reason; a `verified` or
 * `live` row has at least one passing mapped test and no failing one (when
 * results are given); a `live` row carries owner production evidence; registry
 * and status ids exist in the CSV; mapped files exist.
 */
const GATED_BLOCKER = /production|simulated|approval/i;

export function validateRows(rows: RequirementRow[], input: Pick<BuildInput, 'registry' | 'statuses'>,
  opts: { withResults: boolean; fileExists?: (file: string) => boolean }): string[] {
  const errors: string[] = [];
  const ids = new Set(rows.map((r) => r.id));
  for (const id of Object.keys(input.statuses)) if (!ids.has(id)) errors.push(`status table names unknown id ${id}`);
  for (const id of Object.keys(input.registry)) if (ID.test(id) && !ids.has(id)) errors.push(`registry names unknown id ${id}`);
  if (opts.fileExists)
    for (const files of Object.values(input.registry)) if (Array.isArray(files))
      for (const f of files) if (!opts.fileExists(f)) errors.push(`registry file missing: ${f}`);
  for (const row of rows) {
    const e = row.entry;
    if (!e) { errors.push(`${row.id}: no status row`); continue; }
    if (!RELEASE_STATUSES.includes(e.status)) errors.push(`${row.id}: unknown status ${e.status}`);
    if (!e.reason?.trim()) errors.push(`${row.id}: status without a reason`);
    if (e.status === 'live' && !e.ownerEvidence?.trim()) errors.push(`${row.id}: live without owner production evidence`);
    if (e.status === 'verified' || e.status === 'live') {
      const mapped = row.tests.unit.length + row.tests.integration.length + row.tests.e2e.length;
      if (!mapped) errors.push(`${row.id}: ${e.status} without any mapped test`);
      else if (opts.withResults && row.result.passed === 0) errors.push(`${row.id}: ${e.status} without a passing test in the last run`);
      if (opts.withResults && row.result.failed > 0) errors.push(`${row.id}: ${e.status} with ${row.result.failed} failing test(s)`);
      // A blocker naming missing production keys, a stub or an approval means the row is not verified.
      if (GATED_BLOCKER.test(e.blocker ?? '')) errors.push(`${row.id}: ${e.status} with a provider-gated, simulated or approval blocker (use that status or partial)`);
    }
  }
  return errors;
}

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
const list = (files: string[]) => (files.length ? files.map((f) => `\`${f}\``).join('<br>') : '—');

export interface RenderMeta { commit: string; date: string; runs: string[]; notes: string[] }

export function renderMarkdown(rows: RequirementRow[], meta: RenderMeta): string {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.entry?.status ?? 'missing', (counts.get(r.entry?.status ?? 'missing') ?? 0) + 1);
  const lines = [
    '# Requirement-to-test record',
    '',
    `Generated by \`scripts/release/requirement-map.ts\` on ${meta.date} at commit \`${meta.commit}\`. Do not edit by hand: change the status table (\`src/lib/release/requirement-status.ts\`), the registry (\`docs/release/requirement-tests.json\`) or \`[REQ-ID]\` tags, then regenerate.`,
    '',
    '## Status vocabulary',
    '',
    '- `live`: in production with owner-supplied production evidence. No row is `live` without it.',
    '- `verified`: built; automated tests pass on the local Docker database; not yet evidenced in production.',
    '- `simulated`: exercised only with a stubbed provider (docs-derived contracts, signed fixture webhooks).',
    '- `provider-gated`: needs provider keys not configured in production (named in the blocker column).',
    '- `approval-blocked`: needs an external approval (named in the blocker column).',
    '- `partial`, `not built`: as named.',
    '',
    `Totals: ${RELEASE_STATUSES.map((s) => `${s} ${counts.get(s) ?? 0}`).join(', ')}.`,
    '',
    '## Runs used',
    '',
    ...meta.runs.map((r) => `- ${r}`),
    '',
    'Result column: passed / failed / skipped tests in the mapped files from those runs; "not run" counts mapped files absent from the reports (e2e specs and opt-in suites). Skipped tests are never counted as passes.',
    '',
    ...(meta.notes.length ? ['## Notes', '', ...meta.notes.map((n) => `- ${n}`), ''] : []),
    '## Requirements',
    '',
    '| Id | Title | Release status | Reason | Blocker | Unit tests | Integration tests | E2E specs | Last run (pass/fail/skip, not run) |',
    '|---|---|---|---|---|---|---|---|---|',
  ];
  for (const r of rows) {
    const e = r.entry;
    lines.push(`| ${r.id} | ${cell(r.title)} | ${e ? `\`${e.status}\`` : '**missing**'} | ${cell(e?.reason ?? '')}${e?.ownerEvidence ? ` Evidence: ${cell(e.ownerEvidence)}` : ''} | ${cell(e?.blocker ?? '') || '—'} | ${list(r.tests.unit)} | ${list(r.tests.integration)} | ${list(r.tests.e2e)} | ${r.result.passed}/${r.result.failed}/${r.result.skipped}${r.result.notRun ? `, ${r.result.notRun} not run` : ''} |`);
  }
  return lines.join('\n') + '\n';
}

/** Appends `release_status` and `tests` columns (append-only; existing columns untouched). */
export function csvWithReleaseColumns(text: string, rows: RequirementRow[]): string {
  const parsed = parseCsv(text).filter((r) => r.length > 1 || r[0]);
  const header = parsed[0];
  const keep = header.indexOf('release_status') >= 0 ? header.indexOf('release_status') : header.length;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const quote = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const out = [[...header.slice(0, keep), 'release_status', 'tests']];
  for (const r of parsed.slice(1)) {
    const row = byId.get(r[0]);
    const files = row ? [...row.tests.unit, ...row.tests.integration, ...row.tests.e2e] : [];
    out.push([...r.slice(0, keep), row?.entry?.status ?? '', files.join(';')]);
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  return out.map((r) => r.map(quote).join(',')).join(eol) + eol;
}
