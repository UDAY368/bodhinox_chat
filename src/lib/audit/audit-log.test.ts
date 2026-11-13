import { describe, expect, it } from 'vitest';
import {
  AUDIT_CATEGORIES, AuditQueryError, categoryOf, containsPattern, csvCell, decodeCursor, encodeCursor, parseAuditQuery, safeMetadata, safeResourceId,
} from './audit-log';

describe('audit log search, categories and export', () => {
  const parse = (s: string) => parseAuditQuery(new URLSearchParams(s));
  it('parses free text and a known category', () => {
    expect(parse('q=%20team.created%20&category=team')).toMatchObject({ q: 'team.created', category: 'team' });
    for (const bad of ['category=everything', `q=${'x'.repeat(81)}`, 'q=a%00b'])
      expect(() => parse(bad), bad).toThrow(AuditQueryError);
  });

  it('escapes LIKE wildcards in the search text', () => {
    expect(containsPattern('50%_off\\')).toBe('%50\\%\\_off\\\\%');
  });

  it('files actions under the prototype categories', () => {
    expect(categoryOf('team.created')).toBe('team');
    expect(categoryOf('whatsapp_number.disconnected')).toBe('channels');
    expect(categoryOf('settings.billing')).toBe('billing');
    expect(categoryOf('auth.google_linked')).toBe('security');
    expect(categoryOf('integrations.zoom_connect')).toBe('integrations');
    expect(categoryOf('settings.workspace')).toBe('settings');
    expect(categoryOf('contacts.export')).toBeNull();
    expect(Object.keys(AUDIT_CATEGORIES).sort()).toEqual(['billing', 'channels', 'integrations', 'security', 'settings', 'team']);
  });

  it('neutralises spreadsheet formulas and quotes every CSV cell', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+1')).toBe(`"'+1"`);
    expect(csvCell('-1')).toBe(`"'-1"`);
    expect(csvCell('@sum')).toBe(`"'@sum"`);
    expect(csvCell('team.created')).toBe('"team.created"');
    expect(csvCell(null)).toBe('""');
  });
});

const ID = '11111111-1111-4111-8111-111111111111';
const q = (s: string) => parseAuditQuery(new URLSearchParams(s));

describe('audit log query', () => {
  it('parses filters with defaults', () => {
    expect(q('')).toMatchObject({ limit: 50 });
    const parsed = q(`actor=${ID}&action=team.&from=2026-11-01&to=2026-11-02T10:00:00Z&limit=10`);
    expect(parsed).toMatchObject({ actor: ID, action: 'team.', limit: 10 });
    expect(parsed.from?.toISOString()).toBe('2026-11-01T00:00:00.000Z');
  });

  it('rejects malformed input', () => {
    for (const bad of ['actor=me', 'action=DROP TABLE', 'from=yesterday', 'limit=0', 'limit=101', 'limit=2.5',
      'from=2026-11-03&to=2026-11-01', 'cursor=abc'])
      expect(() => q(bad), bad).toThrow(AuditQueryError);
  });

  it('round-trips a microsecond cursor and refuses a forged one', () => {
    const cursor = encodeCursor('2026-11-02 10:11:12.123456+00', ID);
    expect(decodeCursor(cursor)).toEqual({ at: '2026-11-02 10:11:12.123456+00', id: ID });
    expect(() => decodeCursor(Buffer.from(`now()|${ID}`).toString('base64url'))).toThrow(AuditQueryError);
    expect(() => decodeCursor(Buffer.from(`2026-11-02 10:11:12+00|${ID}|x`).toString('base64url'))).toThrow(AuditQueryError);
  });
});

describe('audit log projection', () => {
  it('keeps identifiers, counts and flags only', () => {
    expect(safeMetadata({
      rows: 12, allowed: false, role: 'agent', status: 'paused', whatsapp_config_id: ID, missing: null,
      email: 'person@example.com', body: 'Hello, my card is 4111 1111', nested: { secret: 'x' }, list: [1],
      token: 'x'.repeat(65), 'Bad-Key': 1, infinite: Infinity,
    })).toEqual({ rows: 12, allowed: false, role: 'agent', status: 'paused', whatsapp_config_id: ID, missing: null });
    expect(safeMetadata('text')).toEqual({});
    expect(safeMetadata([1])).toEqual({});
  });

  it('drops resource ids that are not identifier-like', () => {
    expect(safeResourceId(ID)).toBe(ID);
    expect(safeResourceId('contacts.export')).toBe('contacts.export');
    expect(safeResourceId('a b')).toBeNull();
    expect(safeResourceId(null)).toBeNull();
  });
});
