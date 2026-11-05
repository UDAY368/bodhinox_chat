// Customer commerce payments and the platform's SaaS billing never cross
// (Phase 14, design section 3). Static half: the import graph between the two.
// The database and webhook half is separation.integration.test.ts; the
// commerce settings guard (platform key reuse) is tested beside its route.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const rel = (p: string) => path.relative(ROOT, p).split(path.sep).join('/');

function files(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(path.join(ROOT, dir))) {
    const full = path.join(ROOT, dir, name);
    if (statSync(full).isDirectory()) out.push(...files(rel(full)));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(rel(full));
  }
  return out;
}

/** Every module a file imports (static, dynamic and type-only), resolved to a repo path without extension. */
function imports(file: string): { target: string; statement: string }[] {
  const source = readFileSync(path.join(ROOT, file), 'utf8');
  const found: { target: string; statement: string }[] = [];
  const pattern = /(import\s[^;]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|export\s[^;]*?from\s*['"]([^'"]+)['"])/g;
  for (const match of source.matchAll(pattern)) {
    const spec = match[2] ?? match[3] ?? match[4];
    let target: string;
    if (spec.startsWith('@/')) target = `src/${spec.slice(2)}`;
    else if (spec.startsWith('.')) target = rel(path.resolve(path.dirname(path.join(ROOT, file)), spec));
    else continue;
    found.push({ target: target.replace(/\.(ts|tsx)$/, '').replace(/\/index$/, ''), statement: match[0] });
  }
  return found;
}

const BILLING = [...files('src/lib/billing'), ...files('src/app/api/billing')];
const COMMERCE = [...files('src/lib/payments'), ...files('src/lib/commerce'), ...files('src/app/api/payments')];
const isCommerce = (t: string) => /^src\/(lib\/payments|lib\/commerce|app\/api\/payments)(\/|$)/.test(t);
const isBilling = (t: string) => /^src\/(lib\/billing|app\/api\/billing)(\/|$)/.test(t);

/**
 * Billing modules commerce code may use, captured from the import graph when
 * Phase 14 started: workspace suspension (no sends while suspended), plan
 * entitlements (feature gates) and GST helpers (state codes for the
 * storefront). None carries keys, webhooks or SaaS billing rows.
 */
const COMMERCE_MAY_USE = new Set(['src/lib/billing/suspension', 'src/lib/billing/entitlements', 'src/lib/billing/gst', 'src/lib/billing/limits']);

describe('commerce payments and SaaS billing stay apart', () => {
  it('scans real files', () => {
    expect(BILLING.length).toBeGreaterThan(10);
    expect(COMMERCE.length).toBeGreaterThan(10);
  });

  it('SaaS billing imports nothing from commerce except the pure Razorpay signature check', () => {
    const crossing = BILLING.flatMap((file) => imports(file).filter((i) => isCommerce(i.target)).map((i) => ({ file, ...i })));
    // The one allowed crossing: an HMAC helper that takes the secret as an argument (no keys, tables or webhooks shared).
    const allowed = crossing.filter((c) => c.file === 'src/lib/billing/razorpay-billing.ts' && c.target === 'src/lib/payments/razorpay'
      && /^import\s*\{\s*verifyWebhookSignature\s*\}\s*from/.test(c.statement));
    expect(crossing.filter((c) => !allowed.includes(c)).map((c) => `${c.file} -> ${c.target}`)).toEqual([]);
  });

  it('commerce imports from SaaS billing only suspension, entitlements and GST helpers', () => {
    const crossing = COMMERCE.flatMap((file) => imports(file).filter((i) => isBilling(i.target) && !COMMERCE_MAY_USE.has(i.target))
      .map((i) => `${file} -> ${i.target}`));
    expect(crossing).toEqual([]);
  });

  it('the commerce Razorpay settings route compares against the platform key without importing billing config', () => {
    const route = readFileSync(path.join(ROOT, 'src/app/api/payments/razorpay/settings/route.ts'), 'utf8');
    expect(route).toContain('BILLING_RAZORPAY_KEY_ID');
    expect(route).toContain("'platform_key_reuse'");
    expect(imports('src/app/api/payments/razorpay/settings/route.ts').some((i) => isBilling(i.target))).toBe(false);
  });
});
