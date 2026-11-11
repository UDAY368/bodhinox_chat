// Stage 3A migration inventory: the Stage 3 migrations are additive (every
// NOT VALID check validated later, indexes built CONCURRENTLY on the existing
// comment table), the trigger check lists exactly the trigger types the code
// knows (also covered generically in phase1-schema.test.ts), and
// schema-inventory.json carries every new column (contracts.ts reads it). The
// database behaviour itself is covered by phase2-schema.integration.test.ts.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import inventory from '../../../prisma/schema-inventory.json';
import checksums from '../../../prisma/migration-checksums.json';
import { FLOW_TRIGGER_TYPES } from '@/lib/flows/types';
import { INSTAGRAM_AI_COMMENT_INTENTS, INSTAGRAM_AI_COMMENT_STATUSES, INSTAGRAM_AI_COMMENT_SENTIMENTS } from '@/types';
import { INSTAGRAM_LIMITS } from './graph-limits';

const MIGRATIONS = join(process.cwd(), 'prisma', 'migrations');
const migrations = readdirSync(MIGRATIONS).filter((name) => /^\d{14}_/.test(name)).sort();
const sql = (name: string) => readFileSync(join(MIGRATIONS, name, 'migration.sql'), 'utf8').replace(/--[^\n]*/g, '');
const stage3 = migrations.filter((name) => /^2026111713\d{4}_/.test(name));

const columns = (table: string): string[] => {
  const entry = (inventory.tables as Record<string, { name: string }[] | { columns: { name: string }[] }>)[table];
  return (Array.isArray(entry) ? entry : entry.columns).map((c) => c.name);
};
/** The quoted values in `<column> IN (...)` of a migration. */
const inList = (text: string, column: string): string[] => {
  const match = new RegExp(`${column}\\s+IN\\s*\\(([^)]*)\\)`).exec(text);
  return match ? [...match[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]) : [];
};

describe('Stage 3A migration inventory', () => {
  it('ships the planned migrations under the 3A prefix, each with a recorded checksum', () => {
    expect(stage3).toEqual([
      '20261117130000_flow_ig_phase2_triggers', '20261117130100_flow_ig_phase2_triggers_validate',
      '20261117130200_instagram_persistent_menu', '20261117130300_contact_ig_ref', '20261117130400_instagram_ai_comments',
      '20261117130500_instagram_comment_funnel', '20261117130600_instagram_comment_run_idx',
      '20261117130700_instagram_comment_received_idx', '20261117130800_instagram_phase2_validate',
    ]);
    for (const name of stage3) expect((checksums as Record<string, string>)[name], name).toMatch(/^[0-9a-f]{64}$/);
  });

  it('adds the Live comment and ref link triggers to the flow check', () => {
    const values = inList(sql('20261117130000_flow_ig_phase2_triggers'), 'trigger_type');
    expect(values.sort()).toEqual([...FLOW_TRIGGER_TYPES].sort());
    expect(values).toEqual(expect.arrayContaining(['ig_live_comment', 'ig_ref']));
  });

  it('validates every constraint it adds NOT VALID, in a later migration', () => {
    const added = stage3.flatMap((name) => [...sql(name).matchAll(/ADD CONSTRAINT (\w+)[\s\S]*?NOT VALID/g)].map((m) => m[1]));
    const validated = stage3.flatMap((name) => [...sql(name).matchAll(/VALIDATE CONSTRAINT (\w+)/g)].map((m) => m[1]));
    expect(added.sort()).toEqual(validated.sort());
    expect(added).toHaveLength(4);
  });

  it('builds the comment indexes concurrently, one statement per file', () => {
    for (const name of ['20261117130600_instagram_comment_run_idx', '20261117130700_instagram_comment_received_idx']) {
      const text = sql(name).trim();
      expect(text, name).toMatch(/^CREATE INDEX CONCURRENTLY \w+\s+ON instagram_comment_events/);
      expect(text.split(';').filter((s) => s.trim())).toHaveLength(1);
    }
  });

  it('keeps the AI comment queue values in step with the shared types and the comment reply cap', () => {
    const text = sql('20261117130400_instagram_ai_comments');
    expect(inList(text, 'sentiment')).toEqual([...INSTAGRAM_AI_COMMENT_SENTIMENTS]);
    expect(inList(text, 'intent')).toEqual([...INSTAGRAM_AI_COMMENT_INTENTS]);
    expect(inList(text, 'status')).toEqual([...INSTAGRAM_AI_COMMENT_STATUSES]);
    expect(text).toContain(`BETWEEN 1 AND ${INSTAGRAM_LIMITS.commentReplyChars}`);
    // Admins decide only pending rows, as themselves; they change only the decision columns.
    expect(text).toMatch(/GRANT UPDATE \(status, reply_text, decided_by, decided_at\) ON instagram_ai_comment_queue TO bodhinox_app;/);
    expect(text).not.toMatch(/GRANT (INSERT|DELETE|SELECT, INSERT)[^;]*instagram_ai_comment_queue TO bodhinox_app/);
    expect(text).toMatch(/ENABLE ROW LEVEL SECURITY[\s\S]*FORCE ROW LEVEL SECURITY/);
    // Owner decision 2: nothing posts automatically until an admin turns it on.
    expect(text).toMatch(/instagram_ai_comments_auto_approve boolean NOT NULL DEFAULT false/);
    expect(text).toMatch(/instagram_ai_comments_enabled boolean NOT NULL DEFAULT false/);
    // The guard holds for the worker too: forward-only status, a fixed approved text, and auto-approval only with both switches on.
    expect(text).toMatch(/CREATE TRIGGER instagram_ai_comment_queue_guard BEFORE INSERT OR UPDATE ON instagram_ai_comment_queue/);
    expect(text).toMatch(/OLD\.status = 'unknown' AND NEW\.status IN \('sent','failed'\)/);
    expect(text).toMatch(/instagram_ai_comments_enabled AND c\.instagram_ai_comments_auto_approve/);
  });

  it('caps the stored menu at the graph client limit and grants the app the non-secret columns', () => {
    const text = sql('20261117130200_instagram_persistent_menu');
    expect(text).toContain(`jsonb_array_length(persistent_menu) <= ${INSTAGRAM_LIMITS.persistentMenuItems}`);
    expect(text).toMatch(/GRANT SELECT \(persistent_menu, persistent_menu_synced_at\) ON instagram_accounts TO bodhinox_app/);
  });

  it('records every Stage 3 column and table in schema-inventory.json', () => {
    expect(columns('instagram_accounts')).toEqual(expect.arrayContaining(['persistent_menu', 'persistent_menu_synced_at']));
    expect(columns('contact_channel_identities')).toEqual(expect.arrayContaining(['last_ref', 'last_ref_at']));
    expect(columns('ai_configs')).toEqual(expect.arrayContaining(
      ['instagram_ai_comments_enabled', 'instagram_ai_comments_auto_approve', 'instagram_ai_comments_daily_cap']));
    expect(columns('instagram_comment_events')).toEqual(expect.arrayContaining(['link_clicked_at', 'lead_captured_at', 'followed_at']));
    expect(columns('instagram_ai_comment_queue')).toEqual(['id', 'account_id', 'instagram_account_id', 'comment_event_id', 'comment_id',
      'media_id', 'sentiment', 'intent', 'reply_text', 'status', 'auto_approved', 'decided_by', 'decided_at', 'public_reply_id',
      'error_code', 'created_at', 'updated_at']);
  });
});
