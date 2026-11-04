import { describe, expect, it } from 'vitest';
import { cursorOf, parseRunListFilter, publicRun, type RunRow } from './run-inspection';

const UUID = '11111111-1111-4111-8111-111111111111';
const parse = (q: string) => parseRunListFilter(new URLSearchParams(q));

describe('parseRunListFilter', () => {
  it('accepts status, version (id or none) and a microsecond keyset cursor', () => {
    expect(parse('')).toEqual({});
    expect(parse(`status=failed&version=${UUID}&before=2026-11-04T10:00:00.123456Z,${UUID}`)).toEqual({
      status: 'failed', version: UUID, before: { startedAt: '2026-11-04T10:00:00.123456Z', id: UUID },
    });
    expect(parse('version=none')).toEqual({ version: 'none' });
  });

  it('refuses anything else', () => {
    for (const q of ['status=deleted', 'version=v1', 'before=yesterday', `before=2026-11-04T10:00:00Z`, `before=2026-11-04T10:00:00Z,${UUID},x`,
      `before=2026-11-04 10:00:00,${UUID}`]) expect(parse(q)).toBeNull();
  });

  it('round-trips the cursor and strips it from the public row', () => {
    const row = { id: UUID, cursor_at: '2026-11-04T10:00:00.000001Z', status: 'failed' } as RunRow;
    expect(parse(`before=${cursorOf(row)}`)?.before).toEqual({ startedAt: '2026-11-04T10:00:00.000001Z', id: UUID });
    expect(publicRun(row)).not.toHaveProperty('cursor_at');
  });
});
