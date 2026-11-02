import { describe, expect, it } from 'vitest';

import {
  canDeleteMedia,
  cleanFilename,
  decodeCursor,
  encodeCursor,
  mediaKindOf,
  MEDIA_LIBRARY_PAGE_SIZE,
  MediaLibraryError,
  parseListQuery,
} from './media-library';

const ID = '44444444-4444-4444-8444-444444444444';
const USER = '22222222-2222-4222-8222-222222222222';

describe('mediaKindOf', () => {
  it('derives the kind from the content type', () => {
    expect(mediaKindOf('image/png')).toBe('image');
    expect(mediaKindOf('VIDEO/MP4')).toBe('video');
    expect(mediaKindOf('audio/ogg; codecs=opus')).toBe('audio');
    expect(mediaKindOf('application/pdf')).toBe('document');
    expect(mediaKindOf('text/plain')).toBe('document');
  });
});

describe('cursor', () => {
  it('round-trips a microsecond timestamp and id', () => {
    const at = '2026-11-02T10:00:00.123456Z';
    expect(decodeCursor(encodeCursor(at, ID))).toEqual({ createdAt: at, id: ID });
  });

  it('rejects tampered cursors', () => {
    expect(decodeCursor(Buffer.from(`not-a-date|${ID}`).toString('base64url'))).toBeNull();
    expect(decodeCursor(Buffer.from('2026-11-02T10:00:00Z|nope').toString('base64url'))).toBeNull();
    expect(decodeCursor(Buffer.from(`2026-11-02T10:00:00Z|${ID}|x`).toString('base64url'))).toBeNull();
    expect(decodeCursor(Buffer.from(`2026-11-02T10:00:00Z');DROP|${ID}`).toString('base64url'))).toBeNull();
    expect(decodeCursor('x'.repeat(300))).toBeNull();
  });
});

describe('parseListQuery', () => {
  it('defaults to the first page of everything', () => {
    expect(parseListQuery(new URLSearchParams())).toEqual({ kind: null, q: null, cursor: null, limit: MEDIA_LIBRARY_PAGE_SIZE });
  });

  it('reads kind, search, cursor and limit', () => {
    const cursor = encodeCursor('2026-11-02T10:00:00.000001Z', ID);
    expect(parseListQuery(new URLSearchParams({ kind: 'image', q: '  menu ', cursor, limit: '10' }))).toEqual({
      kind: 'image', q: 'menu', cursor: { createdAt: '2026-11-02T10:00:00.000001Z', id: ID }, limit: 10,
    });
  });

  it.each([
    [{ kind: 'sticker' }, 'invalid_kind'],
    [{ cursor: 'garbage' }, 'invalid_cursor'],
    [{ limit: '0' }, 'invalid_limit'],
    [{ limit: '101' }, 'invalid_limit'],
    [{ limit: '2.5' }, 'invalid_limit'],
  ])('rejects %o', (params, code) => {
    try {
      parseListQuery(new URLSearchParams(params));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(MediaLibraryError);
      expect((error as MediaLibraryError).code).toBe(code);
    }
  });

  it('caps the search text', () => {
    expect(parseListQuery(new URLSearchParams({ q: 'a'.repeat(500) })).q).toHaveLength(100);
  });
});

describe('cleanFilename', () => {
  it('keeps only the last path segment without control characters', () => {
    expect(cleanFilename('C:\\Users\\me\\menu.pdf')).toBe('menu.pdf');
    expect(cleanFilename('../../etc/passwd')).toBe('passwd');
    expect(cleanFilename('bad\u0000\nname.png')).toBe('badname.png');
    expect(cleanFilename('')).toBe('file');
    expect(cleanFilename('x'.repeat(300))).toHaveLength(200);
  });
});

describe('canDeleteMedia', () => {
  it('allows admins and owners on any file', () => {
    expect(canDeleteMedia({ userId: USER, role: 'admin' }, null)).toBe(true);
    expect(canDeleteMedia({ userId: USER, role: 'owner' }, ID)).toBe(true);
  });

  it('allows an agent only on their own upload', () => {
    expect(canDeleteMedia({ userId: USER, role: 'agent' }, USER)).toBe(true);
    expect(canDeleteMedia({ userId: USER, role: 'agent' }, ID)).toBe(false);
    expect(canDeleteMedia({ userId: USER, role: 'agent' }, null)).toBe(false);
  });

  it('never allows viewers, even on their own upload', () => {
    expect(canDeleteMedia({ userId: USER, role: 'viewer' }, USER)).toBe(false);
    expect(canDeleteMedia({}, USER)).toBe(false);
  });
});
