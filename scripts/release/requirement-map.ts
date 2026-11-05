// Generates docs/release/requirement-to-test.md (and, with --csv, appends the
// release_status/tests columns to the requirements CSV) from the CSV, the
// registry, [REQ-ID] tags, the status table and vitest/Playwright JSON reports.
// Exits 1 when a release rule fails (src/lib/release/requirement-map.ts).
//
// Usage: npx tsx scripts/release/requirement-map.ts [--vitest <report.json>]... [--playwright <report.json>]
//          [--run "<description>"]... [--note "<text>"]... [--csv] [--out <file>]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildRows, csvWithReleaseColumns, mergeResults, renderMarkdown, requirementsFromCsv, resultsFromPlaywright,
  resultsFromVitest, tagsFromSource, validateRows, type ResultMap,
} from '../../src/lib/release/requirement-map';
import { REQUIREMENT_STATUS } from '../../src/lib/release/requirement-status';

const root = path.resolve(__dirname, '..', '..');
const CSV = path.join(root, 'docs/product/bodhinox-chat-requirements-v1.0.csv');
const REGISTRY = path.join(root, 'docs/release/requirement-tests.json');

const args = process.argv.slice(2);
const many = (flag: string) => args.flatMap((a, i) => (a === flag && args[i + 1] ? [args[i + 1]] : []));
const out = many('--out')[0] ?? path.join(root, 'docs/release/requirement-to-test.md');

function walk(dir: string, pick: (f: string) => boolean, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, pick, acc);
    else if (pick(full)) acc.push(full);
  }
  return acc;
}

const rel = (f: string) => path.relative(root, f).replace(/\\/g, '/');
const tags: Record<string, string[]> = {};
for (const file of [...walk(path.join(root, 'src'), (f) => f.endsWith('.test.ts') || f.endsWith('.test.tsx')), ...walk(path.join(root, 'e2e'), (f) => f.endsWith('.spec.ts'))]) {
  const ids = tagsFromSource(fs.readFileSync(file, 'utf8'));
  if (ids.length) tags[rel(file)] = ids;
}

const reports: ResultMap[] = [
  ...many('--vitest').map((f) => resultsFromVitest(JSON.parse(fs.readFileSync(f, 'utf8')), root)),
  ...many('--playwright').map((f) => resultsFromPlaywright(JSON.parse(fs.readFileSync(f, 'utf8')), root)),
];
const csvText = fs.readFileSync(CSV, 'utf8');
const registry = JSON.parse(fs.readFileSync(REGISTRY, 'utf8')) as Record<string, string[]>;
delete (registry as Record<string, unknown>).$comment;
const input = { requirements: requirementsFromCsv(csvText), registry, tags, statuses: REQUIREMENT_STATUS, results: mergeResults(...reports) };
const rows = buildRows(input);
const errors = validateRows(rows, input, { withResults: reports.length > 0, fileExists: (f) => fs.existsSync(path.join(root, f)) });

let commit = 'unknown';
try { commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); } catch { /* not a checkout */ }
const dirty = (() => { try { return execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim() !== ''; } catch { return false; } })();
fs.writeFileSync(out, renderMarkdown(rows, {
  commit: dirty ? `${commit} + uncommitted Phase 15 changes` : commit,
  date: new Date().toISOString().slice(0, 10),
  runs: many('--run').length ? many('--run') : ['No run reports given: results show "not run".'],
  notes: [...many('--note'), ...errors.map((e) => `Release rule failed: ${e}`)],
}));
if (args.includes('--csv')) fs.writeFileSync(CSV, csvWithReleaseColumns(csvText, rows));
console.log(`requirement map: ${rows.length} requirements, ${errors.length} rule failure(s) -> ${rel(out)}`);
for (const e of errors) console.error(`  ${e}`);
process.exit(errors.length ? 1 : 0);
