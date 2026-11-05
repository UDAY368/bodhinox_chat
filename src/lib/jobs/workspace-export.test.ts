// Unit tests for the workspace export archive: the streaming zip is a valid zip
// (every entry inflates and matches its CRC), it reaches the sink in pieces as it
// is built (never as one buffer), credentials are stripped from rows, and the
// exported tables are a fixed allowlist with no secret-bearing table.
import { crc32, inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import type { ExportSink } from '@/lib/account/export';
import { EXCLUDED_COLUMN, EXPORT_DOMAINS, StreamingZip, sanitizeRow } from './workspace-export';

function memorySink() {
  const chunks: Buffer[] = [];
  const sink: ExportSink & { chunks: Buffer[] } = {
    chunks,
    async write(chunk) {
      chunks.push(Buffer.from(chunk));
    },
    async finish() {
      return chunks.reduce((n, c) => n + c.byteLength, 0);
    },
    async abort() {
      chunks.length = 0;
    },
  };
  return sink;
}

/** A minimal zip reader: walks the central directory and inflates each entry. */
function readZip(zip: Buffer): Map<string, string> {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(eocd).toBeGreaterThan(0);
  const count = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);
  const out = new Map<string, string>();
  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(at)).toBe(0x02014b50);
    const crc = zip.readUInt32LE(at + 16);
    const compressed = zip.readUInt32LE(at + 20);
    const size = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const offset = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    expect(zip.readUInt32LE(offset)).toBe(0x04034b50);
    const localName = zip.readUInt16LE(offset + 26);
    const dataStart = offset + 30 + localName + zip.readUInt16LE(offset + 28);
    const data = inflateRawSync(zip.subarray(dataStart, dataStart + compressed));
    expect(data.byteLength).toBe(size);
    expect(crc32(data) >>> 0).toBe(crc);
    out.set(name, data.toString('utf8'));
    at += 46 + nameLength;
  }
  return out;
}

describe('StreamingZip', () => {
  it('writes a valid zip of several entries, streamed in pieces', async () => {
    const sink = memorySink();
    const zip = new StreamingZip(sink, new Date('2026-11-05T10:20:30Z'));
    await zip.begin('contacts.jsonl');
    const pages: string[] = [];
    for (let page = 0; page < 5; page++) {
      const text = Array.from({ length: 200 }, (_, i) => `${JSON.stringify({ id: `${page}-${i}`, name: 'Asha Rao ✓' })}\n`).join('');
      pages.push(text);
      await zip.write(text);
    }
    await zip.begin('empty.jsonl');
    await zip.begin('manifest.json');
    await zip.write('{"ok":true}');
    await zip.close();
    expect(sink.chunks.length).toBeGreaterThan(5);
    const files = readZip(Buffer.concat(sink.chunks));
    expect([...files.keys()]).toEqual(['contacts.jsonl', 'empty.jsonl', 'manifest.json']);
    expect(files.get('contacts.jsonl')).toBe(pages.join(''));
    expect(files.get('empty.jsonl')).toBe('');
    expect(files.get('manifest.json')).toBe('{"ok":true}');
  });

  it('refuses writes outside an entry', async () => {
    const zip = new StreamingZip(memorySink());
    await expect(zip.write('x')).rejects.toThrow('No open zip entry');
  });
});

describe('export rows and domains', () => {
  it('removes credentials, hashes, tokens, encrypted values and internal object keys', () => {
    const row = sanitizeRow({
      id: 'a', name: 'Asha', phone: '+919900000000', email: 'asha@example.invalid',
      manage_token_hash: 'h', hold_client_hash: 'h', hold_code: '1234', token_epoch: 2, access_token_enc: 'x',
      webhook_secret: 's', password_hash: 'p', pdf_object_key: 'k', refresh_token: 't',
      content_text: 'Hello', last_message_text: 'Hi',
    });
    expect(Object.keys(row).sort()).toEqual(['content_text', 'email', 'id', 'last_message_text', 'name', 'phone']);
  });

  it('keeps ordinary customer fields', () => {
    for (const column of ['name', 'phone', 'email', 'content_text', 'status', 'total_minor', 'opted_out_at', 'wa_user_id'])
      expect(EXCLUDED_COLUMN.test(column)).toBe(false);
  });

  it('exports a fixed allowlist of tenant tables and never a secret-bearing one', () => {
    const tables = EXPORT_DOMAINS.map((d) => d.table);
    expect(new Set(tables).size).toBe(tables.length);
    expect(new Set(EXPORT_DOMAINS.map((d) => d.file)).size).toBe(tables.length);
    for (const forbidden of ['whatsapp_config', 'payment_providers', 'api_keys', 'webhook_endpoints', 'auth_users', 'auth_sessions',
      'auth_mfa_factors', 'ai_configs', 'shopify_stores', 'woocommerce_stores', 'meeting_connections', 'courier_connections',
      'meta_ad_connections', 'instagram_accounts', 'account_memberships'])
      expect(tables).not.toContain(forbidden);
    for (const domain of EXPORT_DOMAINS) {
      expect(domain.table).toMatch(/^[a-z_]+$/);
      for (const key of domain.key) expect(key).toMatch(/^[a-z_]+$/);
    }
  });
});
