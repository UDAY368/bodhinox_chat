// Stage 4A migration inventory: the Stage 4 migrations are additive (every NOT
// VALID check validated later), the tables carry the rules the application
// relies on (RLS, forward-only status, no double send), and the status and
// limit values in SQL stay in step with the shared types. schema-inventory.json
// carries every new column (contracts.ts reads it). The database behaviour
// itself is covered by phase3-schema.integration.test.ts.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import inventory from '../../../prisma/schema-inventory.json';
import checksums from '../../../prisma/migration-checksums.json';
import { FLOW_TRIGGER_TYPES } from '@/lib/flows/types';
import {
  CONVERSATION_REMINDER_KINDS, CONVERSATION_REMINDER_LIMITS, CONVERSATION_REMINDER_STATUSES, INSTAGRAM_CONNECTION_KINDS,
  SCHEDULED_REPLY_LIMITS, SCHEDULED_REPLY_REASONS, SCHEDULED_REPLY_STATUSES,
} from '@/types';

const MIGRATIONS = join(process.cwd(), 'prisma', 'migrations');
const migrations = readdirSync(MIGRATIONS).filter((name) => /^\d{14}_/.test(name)).sort();
const sql = (name: string) => readFileSync(join(MIGRATIONS, name, 'migration.sql'), 'utf8').replace(/--[^\n]*/g, '');
const stage4 = migrations.filter((name) => /^2026111719\d{4}_/.test(name));

const columns = (table: string): string[] => {
  const entry = (inventory.tables as Record<string, { name: string }[] | { columns: { name: string }[] }>)[table];
  return (Array.isArray(entry) ? entry : entry.columns).map((c) => c.name);
};
/** The quoted values in `<column> IN (...)` of a migration, first occurrence. */
const inList = (text: string, column: string): string[] => {
  const match = new RegExp(`${column}\\s+IN\\s*\\(([^)]*)\\)`).exec(text);
  return match ? [...match[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]) : [];
};

describe('Stage 4A migration inventory', () => {
  it('ships the planned migrations under the 4A prefix, each with a recorded checksum', () => {
    expect(stage4).toEqual([
      '20261117190000_conversation_reminders', '20261117190100_scheduled_replies', '20261117190200_instagram_connection_kind',
      '20261117190300_flow_ig_share_trigger', '20261117190400_flow_ig_share_trigger_validate', '20261117190500_instagram_phase3_validate',
    ]);
    for (const name of stage4) expect((checksums as Record<string, string>)[name], name).toMatch(/^[0-9a-f]{64}$/);
  });

  it('adds the Share-to-Story trigger to the flow check, on top of every existing trigger', () => {
    const values = inList(sql('20261117190300_flow_ig_share_trigger'), 'trigger_type');
    expect(values.sort()).toEqual([...FLOW_TRIGGER_TYPES].sort());
    expect(values).toContain('ig_share_to_story');
    expect(columnsDefinition('flows', 'trigger_type')).toContain("'ig_share_to_story'");
  });

  it('validates every constraint it adds NOT VALID, in a later migration', () => {
    const added = stage4.flatMap((name) => [...sql(name).matchAll(/ADD CONSTRAINT (\w+)[\s\S]*?NOT VALID/g)].map((m) => m[1]));
    const validated = stage4.flatMap((name) => [...sql(name).matchAll(/VALIDATE CONSTRAINT (\w+)/g)].map((m) => m[1]));
    expect(added.sort()).toEqual(validated.sort());
    expect(added).toEqual(expect.arrayContaining(['flows_trigger_type_check', 'instagram_accounts_connection_kind_check']));
    // A validate runs in a later file than the one that added the check.
    for (const check of added) {
      const addedIn = stage4.findIndex((name) => new RegExp(`ADD CONSTRAINT ${check}\\b`).test(sql(name)));
      const validatedIn = stage4.findIndex((name) => new RegExp(`VALIDATE CONSTRAINT ${check}\\b`).test(sql(name)));
      expect(validatedIn, check).toBeGreaterThan(addedIn);
    }
  });

  it('has no destructive statement beyond the re-added trigger check', () => {
    for (const name of stage4) {
      const text = sql(name);
      expect(text, name).not.toMatch(/\b(DROP TABLE|DROP COLUMN|TRUNCATE|DELETE FROM|ALTER COLUMN)\b/i);
      for (const drop of text.match(/\bDROP\s+\w+[^;]*/gi) ?? [])
        expect(drop, name).toMatch(/DROP CONSTRAINT IF EXISTS flows_trigger_type_check/);
    }
  });

  it('keeps the reminder values in step with the shared types and enforces tenancy', () => {
    const text = sql('20261117190000_conversation_reminders');
    expect(inList(text, 'kind')).toEqual([...CONVERSATION_REMINDER_KINDS]);
    expect(inList(text, 'status')).toEqual([...CONVERSATION_REMINDER_STATUSES]);
    expect(text).toContain(`char_length(note) <= ${CONVERSATION_REMINDER_LIMITS.noteChars}`);
    expect(text).toContain(`interval '${CONVERSATION_REMINDER_LIMITS.maxDaysAhead} days'`);
    expect(text).toMatch(/ENABLE ROW LEVEL SECURITY[\s\S]*FORCE ROW LEVEL SECURITY/);
    expect(text).toMatch(/FOREIGN KEY \(account_id, conversation_id\) REFERENCES conversations\(account_id, id\)/);
    // The app role writes only its own rows and only three columns; it never deletes.
    expect(text).toMatch(/GRANT UPDATE \(remind_at, note, status\) ON conversation_reminders TO bodhinox_app;/);
    expect(text).not.toMatch(/GRANT[^;]*DELETE[^;]*conversation_reminders TO bodhinox_app/);
    // Inserts are column grants: created_at (the year cap's anchor), fired_at and updated_at are never the app's.
    expect(text).toMatch(/GRANT INSERT \(account_id, conversation_id, user_id, kind, remind_at, note\) ON conversation_reminders TO bodhinox_app;/);
    expect(text).not.toMatch(/GRANT[^;]*INSERT ON conversation_reminders/);
    expect(text).toMatch(/user_id = app_user_id\(\)/);
    expect(text).toMatch(/CREATE UNIQUE INDEX conversation_reminders_one_snooze[\s\S]*WHERE kind = 'snooze' AND status = 'pending'/);
    expect(text).toMatch(/GRANT EXECUTE ON FUNCTION crm_due_conversation_reminder_accounts\(\) TO bodhinox_worker/);
    expect(text).not.toMatch(/crm_due_conversation_reminder_accounts\(\) TO (bodhinox_app|PUBLIC)/);
  });

  it('keeps the scheduled reply values in step with the shared types and holds the no-double-send rules', () => {
    const text = sql('20261117190100_scheduled_replies');
    expect(inList(text, 'status')).toEqual([...SCHEDULED_REPLY_STATUSES]);
    expect(text).toContain(`BETWEEN 1 AND ${SCHEDULED_REPLY_LIMITS.contentChars}`);
    expect(text).toContain(`interval '${SCHEDULED_REPLY_LIMITS.maxDaysAhead.whatsapp} days'`);
    expect(text).toContain(`channel <> 'instagram' OR send_at <= created_at + interval '${SCHEDULED_REPLY_LIMITS.maxDaysAhead.instagram} days'`);
    expect(text).toMatch(/ENABLE ROW LEVEL SECURITY[\s\S]*FORCE ROW LEVEL SECURITY/);
    expect(text).toMatch(/GRANT UPDATE \(content, send_at, status\) ON scheduled_replies TO bodhinox_app;/);
    expect(text).not.toMatch(/GRANT[^;]*DELETE[^;]*scheduled_replies TO bodhinox_app/);
    // Inserts are column grants (created_at anchors the 7 and 30 day caps) and the channel is the conversation's.
    expect(text).toMatch(/GRANT INSERT \(account_id, conversation_id, channel, created_by_user_id, content, send_at\) ON scheduled_replies TO bodhinox_app;/);
    expect(text).not.toMatch(/GRANT[^;]*INSERT ON scheduled_replies/);
    expect(text).toMatch(/CREATE TRIGGER scheduled_replies_channel_guard BEFORE INSERT ON scheduled_replies/);
    // Forward-only status for every role: the worker cannot move a sent or unknown row back to pending.
    expect(text).toMatch(/CREATE TRIGGER scheduled_replies_guard BEFORE UPDATE ON scheduled_replies/);
    expect(text).toMatch(/OLD\.status = 'unknown' AND NEW\.status IN \('sent','failed'\)/);
    expect(text).toMatch(/OLD\.status = 'sending' AND NEW\.status IN \('sent','failed','unknown'\)/);
    // An ambiguous send needs its claim time; a sent row needs its message.
    expect(text).toMatch(/status <> 'sent' OR \(message_id IS NOT NULL AND sent_at IS NOT NULL\)/);
    expect(text).toMatch(/GRANT EXECUTE ON FUNCTION crm_due_scheduled_reply_accounts\(\) TO bodhinox_worker/);
    // Reasons are machine codes, never message text.
    expect(text).toContain("reason_code ~ '^[a-z0-9_]{1,64}$'");
    for (const reason of SCHEDULED_REPLY_REASONS) expect(reason).toMatch(/^[a-z0-9_]{1,64}$/);
  });

  it('adds the connection kind with a safe default and grants the app the non-secret columns only', () => {
    const text = sql('20261117190200_instagram_connection_kind');
    expect(inList(text, 'connection_kind')).toEqual([...INSTAGRAM_CONNECTION_KINDS]);
    expect(text).toMatch(/ADD COLUMN connection_kind text NOT NULL DEFAULT 'instagram_login'/);
    expect(text).toMatch(/GRANT SELECT \(connection_kind, facebook_page_id\) ON instagram_accounts TO bodhinox_app;/);
    expect(text).not.toMatch(/access_token/);
  });

  it('records every Stage 4 column and table in schema-inventory.json', () => {
    expect(columns('conversation_reminders')).toEqual(['id', 'account_id', 'conversation_id', 'user_id', 'kind', 'remind_at', 'note',
      'status', 'fired_at', 'created_at', 'updated_at']);
    expect(columns('scheduled_replies')).toEqual(['id', 'account_id', 'conversation_id', 'channel', 'created_by_user_id', 'content',
      'send_at', 'status', 'claimed_at', 'attempts', 'message_id', 'sent_at', 'reason_code', 'created_at', 'updated_at']);
    expect(columns('instagram_accounts')).toEqual(expect.arrayContaining(['connection_kind', 'facebook_page_id']));
  });
});

function columnsDefinition(table: string, column: string): string {
  const entry = (inventory.tables as Record<string, { name: string; definition: string }[]>)[table];
  return entry.find((c) => c.name === column)?.definition ?? '';
}
