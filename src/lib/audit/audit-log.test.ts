import { describe, expect, it } from 'vitest';
import { AuditQueryError, decodeCursor, encodeCursor, parseAuditQuery, safeMetadata, safeResourceId } from './audit-log';

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
