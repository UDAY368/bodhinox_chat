import { describe, expect, it, vi } from 'vitest';
import type { TenantTransaction } from '@/lib/db/tenant';
import {
  latestAttributableReferralTx,
  parseReferral,
  recordReferralTx,
  toAdReferralSummary,
  type AdReferral,
} from './referrals';

/** The ad_referrals CHECKs from 20261104101000_ad_referrals, in JS (char_length counts code points). */
function satisfiesChecks(r: AdReferral): boolean {
  const len = (s: string | null) => (s === null ? 0 : [...s].length);
  const noNul = (s: string | null) => s === null || !s.includes('\u0000');
  return (r.sourceId === null || /^[0-9_]{1,64}$/.test(r.sourceId))
    && ['ad', 'post', 'unknown'].includes(r.sourceType)
    && (r.sourceType !== 'ad' || r.sourceId === null || /^\d{1,32}$/.test(r.sourceId))
    && len(r.sourceUrl) <= 2048 && len(r.headline) <= 1024 && len(r.body) <= 4096 && len(r.ctwaClid) <= 512
    && (r.mediaType === null || r.mediaType === 'image' || r.mediaType === 'video')
    && [r.sourceId, r.sourceUrl, r.headline, r.body, r.ctwaClid].every(noNul)
    && [r.sourceId, r.sourceUrl, r.headline, r.body, r.ctwaClid].every(wellFormed);
}

/** No unpaired surrogate: Postgres jsonb rejects one, and the job payload carries these values as JSON. */
function wellFormed(s: string | null): boolean {
  return s === null || !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
}

const sample = {
  source_url: 'https://fb.me/abc',
  source_id: '120211234567890',
  source_type: 'ad',
  headline: 'Summer sale',
  body: 'Up to 50% off',
  media_type: 'image',
  image_url: 'https://scontent.example/img.jpg',
  ctwa_clid: 'ARAkLkA8rmlFeiCktEJQ-QTwRiyYHAFDLMNDBH0CD3qpjd0HR4irJ6LEkR7JwFF4XvnO2E4Nx0-eM-GABDLOPaOdRMv-_zfUQ2a',
};

describe('parseReferral', () => {
  it('maps a click-to-WhatsApp ad referral and drops unknown fields', () => {
    const parsed = parseReferral({ ...sample, extra: { nested: true } });
    expect(parsed).toEqual({
      sourceId: '120211234567890',
      sourceType: 'ad',
      sourceUrl: 'https://fb.me/abc',
      headline: 'Summer sale',
      body: 'Up to 50% off',
      mediaType: 'image',
      ctwaClid: sample.ctwa_clid,
    });
    expect(parsed && satisfiesChecks(parsed)).toBe(true);
  });

  it('keeps a post id like page_post, but not as an ad id', () => {
    expect(parseReferral({ source_type: 'post', source_id: '123_456' })?.sourceId).toBe('123_456');
    expect(parseReferral({ source_type: 'ad', source_id: '123_456', headline: 'x' })?.sourceId).toBeNull();
  });

  it('nulls bad ids and maps an unknown source type to unknown', () => {
    const parsed = parseReferral({ source_type: 'Story', source_id: '12;DROP', headline: 'h' });
    expect(parsed?.sourceType).toBe('unknown');
    expect(parsed?.sourceId).toBeNull();
    expect(parseReferral({ source_type: 'AD', source_id: 42 })?.sourceType).toBe('ad');
    expect(parseReferral({ source_type: 'ad', source_id: 42 })?.sourceId).toBe('42');
    expect(parseReferral({ source_type: 'ad', source_id: '1'.repeat(33), headline: 'h' })?.sourceId).toBeNull();
  });

  it('truncates free text to the column limits and drops oversize or non-http tokens', () => {
    const parsed = parseReferral({
      source_type: 'ad',
      source_id: '1',
      headline: 'h'.repeat(5000),
      body: 'b'.repeat(10_000),
      source_url: `https://x.example/${'a'.repeat(3000)}`,
      ctwa_clid: 'c'.repeat(600),
    });
    expect(parsed?.headline).toHaveLength(1024);
    expect(parsed?.body).toHaveLength(4096);
    expect(parsed?.sourceUrl).toBeNull();
    expect(parsed?.ctwaClid).toBeNull();
    expect(parseReferral({ source_id: '1', source_url: 'javascript:alert(1)' })?.sourceUrl).toBeNull();
  });

  it('removes NUL and control characters, which Postgres text would reject', () => {
    const parsed = parseReferral({ source_type: 'ad', source_id: '9', headline: 'a\u0000b\u0007c', ctwa_clid: 'id\u0000' });
    expect(parsed?.headline).toBe('abc');
    expect(parsed?.ctwaClid).toBe('id');
  });

  it('never cuts a surrogate pair in half and drops unpaired surrogates', () => {
    const emoji = '\u{1F600}';
    const atLimit = parseReferral({ source_type: 'ad', source_id: '9', headline: `${'h'.repeat(1023)}${emoji}`, body: `${'b'.repeat(4095)}${emoji}` })!;
    expect(atLimit.headline).toBe('h'.repeat(1023));
    expect(atLimit.body).toBe('b'.repeat(4095));
    const lone = parseReferral({ source_type: 'ad', source_id: '9', headline: `a\uD83Db\uDE00c${emoji}`, ctwa_clid: 'id\uDC00' })!;
    expect(lone.headline).toBe(`abc${emoji}`);
    expect(lone.ctwaClid).toBe('id');
  });

  it('returns null for non-objects and empty referrals', () => {
    for (const raw of [null, undefined, 'ad', 42, [], [sample], {}, { source_type: 'ad' }, { media_type: 'video' }])
      expect(parseReferral(raw)).toBeNull();
  });

  it('never throws and always satisfies the table CHECKs (property test)', () => {
    let seed = 20261104;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    const pick = <T,>(values: T[]) => values[Math.floor(rand() * values.length)];
    const randomString = () => {
      const alphabet = ['1', '0', '_', 'a', ' ', '\u0000', '\n', 'é', '😀', '\uD800', '\uDE00', ':', '/', 'https://'];
      return Array.from({ length: Math.floor(rand() * pick([5, 40, 600, 5000])) }, () => pick(alphabet)).join('');
    };
    const randomValue = () => pick<unknown>([undefined, null, 0, -1, 1.5, 1e40, true, {}, [], randomString(), randomString(), '123', '1_2', 'https://a.example/x']);
    const throwing = new Proxy({}, { get() { throw new Error('boom'); }, ownKeys() { throw new Error('boom'); } });
    expect(parseReferral(throwing)).toBeNull();
    for (let i = 0; i < 3000; i++) {
      const raw = Object.fromEntries(
        ['source_url', 'source_id', 'source_type', 'headline', 'body', 'media_type', 'ctwa_clid', 'other']
          .filter(() => rand() < 0.8)
          .map((key) => [key, key === 'source_type' ? pick(['ad', 'post', 'AD', 'x', randomValue()]) : randomValue()]),
      );
      const parsed = parseReferral(raw);
      if (parsed) expect(satisfiesChecks(parsed), JSON.stringify(raw).slice(0, 200)).toBe(true);
    }
  }, 30_000); // 3,000 cases with strings up to 5,000 units can pass 5s on a loaded parallel run
});

describe('toAdReferralSummary', () => {
  it('cuts the headline to 256 characters and never carries the click id', () => {
    const parsed = parseReferral({ ...sample, headline: 'h'.repeat(900) })!;
    const summary = toAdReferralSummary('6f1c2d3e-0000-4000-8000-000000000001', parsed);
    expect(summary.headline).toHaveLength(256);
    expect(JSON.stringify(summary)).not.toContain(sample.ctwa_clid);
    expect(Object.keys(summary).sort()).toEqual(['headline', 'id', 'sourceId', 'sourceType', 'sourceUrl']);
  });

  it('does not split an emoji at the 256-unit cut, so the job payload stays valid jsonb', () => {
    const parsed = parseReferral({ ...sample, headline: `${'h'.repeat(255)}\u{1F600} more` })!;
    const summary = toAdReferralSummary('6f1c2d3e-0000-4000-8000-000000000001', parsed);
    expect(summary.headline).toBe('h'.repeat(255));
    expect(JSON.stringify(summary)).not.toMatch(/\\ud[89a-f]/i);
    const kept = toAdReferralSummary('6f1c2d3e-0000-4000-8000-000000000001', { ...parsed, headline: `${'h'.repeat(254)}\u{1F600}x` });
    expect(kept.headline).toBe(`${'h'.repeat(254)}\u{1F600}`);
  });
});

function fakeTx(queryRaw: (sql: string, values: unknown[]) => unknown) {
  const executed: string[] = [];
  const tx = {
    $executeRaw: vi.fn(async (strings: TemplateStringsArray) => { executed.push(strings.join('?')); return 0; }),
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => queryRaw(strings.join('?'), values)),
  };
  return { tx: tx as unknown as TenantTransaction, executed, mock: tx };
}

const input = {
  accountId: '6f1c2d3e-0000-4000-8000-0000000000aa',
  contactId: '6f1c2d3e-0000-4000-8000-0000000000bb',
  conversationId: null,
  messageId: '6f1c2d3e-0000-4000-8000-0000000000cc',
  waMessageId: 'wamid.HBgM',
  whatsappConfigId: null,
  referral: parseReferral(sample)!,
};

describe('recordReferralTx', () => {
  it('inserts idempotently under a savepoint and returns the new id', async () => {
    const { tx, executed } = fakeTx((sql) => {
      expect(sql).toContain('ON CONFLICT (account_id, wa_message_id) DO NOTHING');
      return [{ id: 'new-id' }];
    });
    await expect(recordReferralTx(tx, input)).resolves.toBe('new-id');
    expect(executed).toEqual(['SAVEPOINT ad_referral', 'RELEASE SAVEPOINT ad_referral']);
  });

  it('returns null on a redelivery', async () => {
    const { tx } = fakeTx(() => []);
    await expect(recordReferralTx(tx, input)).resolves.toBeNull();
  });

  it('rolls back to the savepoint instead of failing the message transaction, without logging the referral', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { tx, executed } = fakeTx(() => { throw new Error(`violates check ${sample.ctwa_clid}`); });
    await expect(recordReferralTx(tx, input)).resolves.toBeNull();
    expect(executed).toEqual(['SAVEPOINT ad_referral', 'ROLLBACK TO SAVEPOINT ad_referral']);
    expect(JSON.stringify(error.mock.calls)).not.toContain(sample.ctwa_clid);
    error.mockRestore();
  });

  it('skips a missing or oversize WhatsApp message id without touching the database', async () => {
    const { tx, mock } = fakeTx(() => []);
    await expect(recordReferralTx(tx, { ...input, waMessageId: '' })).resolves.toBeNull();
    await expect(recordReferralTx(tx, { ...input, waMessageId: 'w'.repeat(257) })).resolves.toBeNull();
    expect(mock.$executeRaw).not.toHaveBeenCalled();
  });
});

describe('latestAttributableReferralTx', () => {
  it('reads only app-visible columns (has_click_id, never ctwa_clid)', async () => {
    let seen = '';
    const { tx } = fakeTx((sql) => { seen = sql; return [{ id: 'r1', whatsapp_config_id: 'w1' }]; });
    await expect(latestAttributableReferralTx(tx, input.accountId, input.contactId)).resolves.toEqual({ id: 'r1', whatsapp_config_id: 'w1' });
    expect(seen).toContain('has_click_id');
    expect(seen).not.toContain('ctwa_clid');
  });

  it('returns null at once for an empty number list', async () => {
    const { tx, mock } = fakeTx(() => [{ id: 'r1', whatsapp_config_id: null }]);
    await expect(latestAttributableReferralTx(tx, input.accountId, input.contactId, 7, [])).resolves.toBeNull();
    expect(mock.$queryRaw).not.toHaveBeenCalled();
  });
});
