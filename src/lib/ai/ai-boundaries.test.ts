// Static boundaries for the AI business assistant (Phase 13, design sections
// 5 and 10): the assistant's modules can never send anything to a customer
// and have no write path to payments, orders, shipments, appointments or
// attendance. Checked on the import graph (transitively through every
// src/lib/ai module they reach) and on the SQL they contain, so a later
// refactor that wires one of them to a sender or a domain mutation fails here.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve(__dirname, '../..');

/** Assistant code: everything here is checked, plus every src/lib/ai module it imports. */
const ROOTS = [
  'lib/ai/assist', 'lib/ai/assess', 'lib/ai/insights', 'lib/ai/safety', 'lib/ai/context-providers', 'lib/ai/evals',
  'lib/ai/task.ts', 'lib/ai/retention.ts', 'lib/ai/settings.ts', 'lib/ai/budget.ts', 'lib/ai/gate.ts', 'lib/ai/log.ts',
  'lib/ai/feature-budgets.ts',
  'app/api/ai/assist', 'app/api/ai/assess', 'app/api/ai/insights', 'app/api/ai/quality', 'app/api/ai/settings',
  'components/inbox/ai-assist', 'components/inbox/ai-assessment', 'components/analytics/ai-insights',
  'components/settings/ai-assistant-settings.tsx', 'components/settings/ai-quality.tsx',
];

/** Modules that send to customers, dispatch outbound work or mutate payments, orders, shipments, appointments or attendance. */
const FORBIDDEN: Array<{ id: RegExp; why: string }> = [
  { id: /^@\/lib\/whatsapp\/(?:send-message|broadcast-core|template-send-builder|forms\/send)$/, why: 'customer send' },
  { id: /^@\/lib\/channels\/sender$/, why: 'customer send' },
  { id: /^@\/lib\/instagram\/send/, why: 'customer send' },
  { id: /^@\/lib\/flows\/(?:engine|channel-send|meta-send|replay)$/, why: 'flow execution / send' },
  { id: /^@\/lib\/jobs\/dispatch$/, why: 'outbound dispatch' },
  { id: /^@\/lib\/automations\/engine$/, why: 'automation execution' },
  { id: /^@\/lib\/payments\//, why: 'payments' },
  { id: /^@\/lib\/commerce\/(?!money$)/, why: 'orders and commerce mutations' },
  { id: /^@\/lib\/appointments\/(?!types$)/, why: 'appointments' },
  { id: /^@\/lib\/meetings\//, why: 'meetings and attendance' },
  { id: /^@\/lib\/fulfilment\//, why: 'shipments' },
  { id: /^@\/lib\/ai\/(?:auto-reply|flow-reply|handoff)$/, why: 'autonomous customer replies' },
];

/** Tables the assistant may write. Everything else is read-only to it. */
const WRITABLE_TABLES = new Set([
  'ai_suggestions', 'ai_assessments', 'ai_insight_runs', 'ai_usage_log', 'ai_workspace_settings', 'audit_logs', 'jobs',
  // Retention deletes the auto-reply activity log (written by the auto-reply agent, not the assistant).
  'ai_reply_events',
]);

const isTest = (file: string) => /\.test\.tsx?$/.test(file);

function walk(path: string, out: string[] = []): string[] {
  if (!existsSync(path)) return out;
  if (statSync(path).isFile()) {
    if (/\.tsx?$/.test(path) && !isTest(path)) out.push(path);
    return out;
  }
  for (const name of readdirSync(path)) walk(join(path, name), out);
  return out;
}

function resolveFile(base: string): string | null {
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')])
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  return null;
}

/** '@/lib/x/y' for a file under src (no extension, no /index). */
const moduleId = (file: string) => '@/' + relative(SRC, file).replace(/\\/g, '/').replace(/\.tsx?$/, '').replace(/\/index$/, '');

function importsOf(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const specs = new Set<string>();
  for (const re of [/\bfrom\s+['"]([^'"]+)['"]/g, /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, /^\s*import\s+['"]([^'"]+)['"]/gm, /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g])
    for (const m of text.matchAll(re)) specs.add(m[1]);
  return [...specs];
}

/** Every module id the roots reach: their own imports, followed through src/lib/ai. */
function importGraph(): { reached: Map<string, string>; files: string[] } {
  const files = ROOTS.flatMap((r) => walk(join(SRC, r)));
  const reached = new Map<string, string>(); // module id -> first importer
  const queue = [...files];
  const seen = new Set(queue);
  while (queue.length) {
    const file = queue.shift()!;
    for (const spec of importsOf(file)) {
      let target: string | null = null;
      if (spec.startsWith('@/')) target = resolveFile(join(SRC, spec.slice(2)));
      else if (spec.startsWith('.')) target = resolveFile(resolve(dirname(file), spec));
      const id = target ? moduleId(target) : spec;
      if (!reached.has(id)) reached.set(id, moduleId(file));
      if (target && id.startsWith('@/lib/ai/') && !isTest(target) && !seen.has(target)) {
        seen.add(target);
        queue.push(target);
        files.push(target);
      }
    }
  }
  return { reached, files };
}

describe('AI assistant boundaries', () => {
  const { reached, files } = importGraph();

  it('scans the assistant code', () => {
    const ids = new Set(files.map(moduleId));
    for (const expected of ['@/lib/ai/task', '@/lib/ai/assist/assist', '@/lib/ai/assess/job', '@/lib/ai/insights/job',
      '@/lib/ai/retention', '@/app/api/ai/assist/replies/route', '@/app/api/ai/quality/route'])
      expect(ids.has(expected), expected).toBe(true);
  });

  it('the detector sees a real sender import (auto-reply sends through flows/meta-send)', () => {
    const autoReply = join(SRC, 'lib/ai/auto-reply.ts');
    const ids = importsOf(autoReply).map((s) => (s.startsWith('@/') ? s : moduleId(resolveFile(resolve(dirname(autoReply), s)) ?? s)));
    expect(ids.some((id) => FORBIDDEN.some((f) => f.id.test(id)))).toBe(true);
  });

  it('never imports a sender, dispatcher or payment/order/shipment/appointment/attendance module', () => {
    const violations = [...reached.entries()]
      .flatMap(([id, from]) => FORBIDDEN.filter((f) => f.id.test(id)).map((f) => `${from} -> ${id} (${f.why})`));
    expect(violations).toEqual([]);
  });

  it('reaches providers only through generateReply / embedTexts (no adapter imports, no raw fetch)', () => {
    const adapters = [...reached.entries()].filter(([id]) => /^@\/lib\/ai\/providers\/(?!fake$)/.test(id))
      .filter(([, from]) => !/^@\/lib\/ai\/(?:generate|embeddings)$/.test(from));
    expect(adapters).toEqual([]);
    const fetching = files.filter((f) => !/[\\/](?:generate|embeddings|openrouter|crawler|validate)\.ts$/.test(f)
      && !/[\\/]components[\\/]/.test(f) && !/[\\/]providers[\\/]/.test(f))
      .filter((f) => /(?<![\w.])fetch\s*\(/.test(readFileSync(f, 'utf8')))
      .map(moduleId);
    expect(fetching).toEqual([]);
  });

  it('writes only its own tables in SQL', () => {
    const roots = ROOTS.flatMap((r) => walk(join(SRC, r)));
    const code = (f: string) => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(?:\/\/|\*).*$/gm, '');
    const writes = roots.flatMap((f) => [...code(f).matchAll(/\b(?:UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+([a-z_][a-z0-9_]*)/g)]
      .map((m) => ({ file: moduleId(f), table: m[1] })))
      .filter((w) => !WRITABLE_TABLES.has(w.table));
    expect(writes).toEqual([]);
  });

  it('gives the model no tools or function calling', () => {
    const tools = files.filter((f) => /\b(?:tools|tool_choice|functions|function_call)\s*:/.test(readFileSync(f, 'utf8'))).map(moduleId);
    expect(tools).toEqual([]);
  });
});
