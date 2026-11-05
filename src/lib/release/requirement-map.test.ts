import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildRows, csvWithReleaseColumns, parseCsv, renderMarkdown, requirementsFromCsv, resultsFromPlaywright, resultsFromVitest,
  tagsFromSource, testKind, validateRows, type StatusEntry,
} from './requirement-map';
import { REQUIREMENT_STATUS } from './requirement-status';

const root = path.resolve(__dirname, '..', '..', '..');
const csvText = fs.readFileSync(path.join(root, 'docs/product/bodhinox-chat-requirements-v1.0.csv'), 'utf8');
const registry = JSON.parse(fs.readFileSync(path.join(root, 'docs/release/requirement-tests.json'), 'utf8')) as Record<string, string[]>;
delete (registry as Record<string, unknown>).$comment;

const CSV = 'requirement_id,requirement,release,priority,status\r\nAA-01,"One, quoted ""x""",A,P0,Planned\r\nBB-02,Two,B,P1,Planned\r\n';
const reqs = requirementsFromCsv(CSV);

describe('[OPS-03] requirement-to-test map', () => {
  it('parses quoted CSV fields and reads the requirement columns', () => {
    expect(parseCsv('a,"b,c","d""e"\n1,2,3\n')).toEqual([['a', 'b,c', 'd"e'], ['1', '2', '3']]);
    expect(reqs).toEqual([
      { id: 'AA-01', title: 'One, quoted "x"', release: 'A', priority: 'P0' },
      { id: 'BB-02', title: 'Two', release: 'B', priority: 'P1' },
    ]);
  });

  it('reads [REQ-ID] tags from describe titles only', () => {
    // Built at run time so this file's own source does not carry these tags.
    const d = ['desc', 'ribe'].join('');
    const src = `${d}('[XX-01][YY-02] routes', () => {});\n${d}.skipIf(x)(\`[ZZ-03] ops\`, () => {});\nit('[WW-04] not a describe', () => {});`;
    expect(tagsFromSource(src)).toEqual(['XX-01', 'YY-02', 'ZZ-03']);
    expect(testKind('e2e/a.spec.ts')).toBe('e2e');
    expect(testKind('src/a.integration.test.ts')).toBe('integration');
    expect(testKind('src/a.load.test.ts')).toBe('integration');
    expect(testKind('src/a.test.ts')).toBe('unit');
  });

  it('counts vitest and Playwright results per file, never a skip as a pass', () => {
    const vitest = resultsFromVitest({ testResults: [
      { name: 'C:\\repo\\src\\a.test.ts', assertionResults: [{ status: 'passed' }, { status: 'skipped' }, { status: 'pending' }] },
      { name: 'C:\\repo\\src\\b.integration.test.ts', status: 'failed', assertionResults: [] },
    ] }, 'C:\\repo');
    expect(vitest.get('src/a.test.ts')).toEqual({ passed: 1, failed: 0, skipped: 2 });
    expect(vitest.get('src/b.integration.test.ts')).toEqual({ passed: 0, failed: 1, skipped: 0 });
    const pw = resultsFromPlaywright({ config: { rootDir: '/repo/e2e' }, suites: [{ file: 'x.spec.ts', specs: [
      { file: 'x.spec.ts', tests: [{ status: 'expected' }, { status: 'skipped' }, { status: 'unexpected' }] }] }] }, '/repo');
    expect(pw.get('e2e/x.spec.ts')).toEqual({ passed: 1, failed: 1, skipped: 1 });
  });

  it('applies the release rules: status per id, evidence for live, a passing test for verified', () => {
    const statuses: Record<string, StatusEntry> = {
      'AA-01': { status: 'verified', reason: 'tests pass' },
      'BB-02': { status: 'live', reason: 'in production' },
    };
    const input = { requirements: reqs, registry: { 'AA-01': ['src/a.test.ts'] }, tags: {}, statuses, results: new Map([['src/a.test.ts', { passed: 0, failed: 0, skipped: 3 }]]) };
    const rows = buildRows(input);
    expect(validateRows(rows, input, { withResults: true })).toEqual([
      'AA-01: verified without a passing test in the last run',
      'BB-02: live without owner production evidence',
      'BB-02: live without any mapped test',
    ]);
    expect(validateRows(buildRows({ ...input, statuses: { 'AA-01': statuses['AA-01'] } }), { ...input, statuses: { 'AA-01': statuses['AA-01'] } }, { withResults: false }))
      .toEqual(['BB-02: no status row']);
    // A verified row whose blocker names production keys, a stub or an approval is refused.
    for (const blocker of ['Keys are needed in production.', 'Delivery is simulated.', 'Needs Meta approval.']) {
      const gated = { 'AA-01': { status: 'verified' as const, reason: 'tests pass', blocker }, 'BB-02': { status: 'partial' as const, reason: 'x' } };
      expect(validateRows(buildRows({ ...input, statuses: gated }), { ...input, statuses: gated }, { withResults: false }), blocker)
        .toEqual(['AA-01: verified with a provider-gated, simulated or approval blocker (use that status or partial)']);
    }
    const md = renderMarkdown(rows, { commit: 'abc', date: '2026-11-05', runs: ['unit'], notes: [] });
    expect(md).toContain('| AA-01 | One, quoted "x" | `verified` |');
    expect(md).toContain('0/0/3');
    const csv = csvWithReleaseColumns(CSV, rows);
    expect(csv.split('\r\n')[0]).toBe('requirement_id,requirement,release,priority,status,release_status,tests');
    expect(csv).toContain('AA-01,"One, quoted ""x""",A,P0,Planned,verified,src/a.test.ts');
    // Re-running replaces the appended columns instead of adding more.
    expect(csvWithReleaseColumns(csv, rows)).toBe(csv);
  });

  it('the real status table covers every CSV id, has no unevidenced live row, and maps only existing files', () => {
    const requirements = requirementsFromCsv(csvText);
    expect(requirements).toHaveLength(72);
    const input = { requirements, registry, tags: {}, statuses: REQUIREMENT_STATUS, results: new Map() };
    const errors = validateRows(buildRows(input), input, {
      withResults: false,
      fileExists: (f) => fs.existsSync(path.join(root, f)),
    });
    expect(errors).toEqual([]);
  });
});
