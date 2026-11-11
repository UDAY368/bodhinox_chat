// Stage 3A ref links: what an author may create, what an inbound ref may be
// stored as (the same pattern as contact_channel_identities_last_ref_check),
// and the ig.me link. The inbound referral payload itself needs a live capture.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IG_REF_STORED, isRefKey, normalizeInboundRef, refKeyMatches, refLinkUrl, toRefKey } from './ref-links';

describe('ref keys', () => {
  it('accepts short link-safe keys only', () => {
    for (const key of ['summer-sale', 'bio', 'Promo_2026', 'x'.repeat(64)]) expect(isRefKey(key), key).toBe(true);
    for (const key of ['', 'has space', 'a/b', 'x'.repeat(65), 'naïve', 'a:b', 12, null]) expect(isRefKey(key), String(key)).toBe(false);
  });

  it('turns typed text into a key', () => {
    expect(toRefKey('  Summer sale 2026 ')).toBe('Summer-sale-2026');
    expect(toRefKey('bio/link?')).toBe('biolink');
    expect(toRefKey('!!!')).toBe('');
    expect(toRefKey('y'.repeat(100))).toHaveLength(64);
  });

  it('matches a trigger’s keys without case, ignoring invalid keys', () => {
    expect(refKeyMatches(['summer-sale', 'bio'], 'SUMMER-SALE')).toBe(true);
    expect(refKeyMatches(['summer-sale'], 'summer')).toBe(false);
    expect(refKeyMatches(['has space'], 'has space')).toBe(false);
    expect(refKeyMatches([], 'bio')).toBe(false);
  });
});

describe('inbound refs', () => {
  it('keeps what Meta allows, trimmed, and drops anything else', () => {
    expect(normalizeInboundRef(' summer-sale ')).toBe('summer-sale');
    expect(normalizeInboundRef('utm=ad/1.2:3+x_y')).toBe('utm=ad/1.2:3+x_y');
    for (const value of ['', '   ', 'a b', 'x'.repeat(251), '<script>', 'ref\n2', 42, undefined, null])
      expect(normalizeInboundRef(value), String(value)).toBeNull();
  });

  it('uses the same pattern as the database check', () => {
    const sql = readFileSync(join(process.cwd(), 'prisma', 'migrations', '20261117130300_contact_ig_ref', 'migration.sql'), 'utf8');
    expect(sql).toContain(`CHECK (last_ref ~ '${IG_REF_STORED.source}')`);
  });
});

describe('ref link URL', () => {
  it('builds the ig.me link for a username and key', () => {
    expect(refLinkUrl('bodhinox.shop', 'summer-sale')).toBe('https://ig.me/m/bodhinox.shop?ref=summer-sale');
    expect(refLinkUrl('@brand_1', 'bio')).toBe('https://ig.me/m/brand_1?ref=bio');
  });

  it('refuses a bad username or key', () => {
    expect(refLinkUrl('', 'bio')).toBeNull();
    expect(refLinkUrl('bad name', 'bio')).toBeNull();
    expect(refLinkUrl('x'.repeat(31), 'bio')).toBeNull();
    expect(refLinkUrl('brand', 'bad key')).toBeNull();
    expect(refLinkUrl('brand/../x', 'bio')).toBeNull();
  });
});
