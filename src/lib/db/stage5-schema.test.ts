// Stage 5A migration inventory: the Stage 5 migrations are additive (every NOT
// VALID check and foreign key validated later), the new tables carry the rules
// the application relies on (FORCE RLS, tenant policies, app and worker grants
// only, the token column hidden from the app role), and the values in SQL stay
// in step with the shared types. schema-inventory.json and schema.prisma carry
// every new column and table (contracts.ts reads the inventory). The database
// behaviour itself is covered by stage5-schema.integration.test.ts.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import inventory from '../../../prisma/schema-inventory.json';
import checksums from '../../../prisma/migration-checksums.json';
import { NODE_REGISTRY } from '@/lib/flows/node-registry';
import { CANVAS_NOTE_LIMITS, FLOW_TRIGGER_LIMITS } from '@/lib/flows/types';
import {
  AGENT_REPLY_PAUSE_LIMITS, AGENT_VISIBILITY_MODES, AUTO_ASSIGN_MODES, GOOGLE_SHEETS_STATUSES, LABEL_COLORS, SEQUENCE_DELAY_UNITS,
  SEQUENCE_STATUSES, SEQUENCE_SUBSCRIPTION_STATUSES, STAGE5_LIMITS,
} from '@/types';

const MIGRATIONS = join(process.cwd(), 'prisma', 'migrations');
const migrations = readdirSync(MIGRATIONS).filter((name) => /^\d{14}_/.test(name)).sort();
const sql = (name: string) => readFileSync(join(MIGRATIONS, name, 'migration.sql'), 'utf8').replace(/\r\n/g, '\n').replace(/--[^\n]*/g, '');
const stage5 = migrations.filter((name) => name.startsWith('20261118'));
const all = stage5.map(sql).join('\n');

const columns = (table: string): string[] => {
  const entry = (inventory.tables as Record<string, { name: string }[] | { columns: { name: string }[] }>)[table];
  if (!entry) return [];
  return (Array.isArray(entry) ? entry : entry.columns).map((c) => c.name);
};
/** The quoted values of the first `<column> IN (...)` in a text. */
const inList = (text: string, column: string): string[] => {
  const match = new RegExp(`${column}\\s+IN\\s*\\(([^)]*)\\)`).exec(text);
  return match ? [...match[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]) : [];
};

const NEW_TABLES = ['flow_folders', 'flow_tracked_links', 'instagram_consent_settings', 'conversation_labels', 'conversation_label_links',
  'conversation_favourites', 'conversion_event_types', 'conversion_event_log', 'google_sheets_connections', 'sequences',
  'sequence_messages', 'sequence_subscriptions'];

describe('Stage 5A migration inventory', () => {
  it('ships the planned migrations under the 5A prefix, each with a recorded checksum', () => {
    expect(stage5).toEqual([
      '20261118000000_flow_extra_triggers', '20261118000100_flow_folders', '20261118000200_flow_tracked_links',
      '20261118000300_conversation_pause_until', '20261118000400_instagram_consent', '20261118000500_conversation_labels',
      '20261118000600_inbox_assignment', '20261118000700_conversion_events', '20261118000800_ai_instagram_goals',
      '20261118000900_google_sheets_connections', '20261118001000_sequences', '20261118001100_stage5_type_checks',
      '20261118001200_stage5_validate',
    ]);
    for (const name of stage5) expect((checksums as Record<string, string>)[name], name).toMatch(/^[0-9a-f]{64}$/);
  });

  it('validates every constraint it adds NOT VALID, in a later migration', () => {
    const added = stage5.flatMap((name) => [...sql(name).matchAll(/ADD CONSTRAINT (\w+)[^;]*?NOT VALID/g)].map((m) => m[1]));
    const validated = stage5.flatMap((name) => [...sql(name).matchAll(/VALIDATE CONSTRAINT (\w+)/g)].map((m) => m[1]));
    expect(added.sort()).toEqual(validated.sort());
    expect(added).toHaveLength(11);
    for (const check of added) {
      const addedIn = stage5.findIndex((name) => new RegExp(`ADD CONSTRAINT ${check}\\b`).test(sql(name)));
      const validatedIn = stage5.findIndex((name) => new RegExp(`VALIDATE CONSTRAINT ${check}\\b`).test(sql(name)));
      expect(validatedIn, check).toBeGreaterThan(addedIn);
    }
  });

  it('has no destructive statement beyond the re-added step type check', () => {
    for (const name of stage5) {
      const text = sql(name);
      expect(text, name).not.toMatch(/\b(DROP TABLE|DROP COLUMN|TRUNCATE|DELETE FROM|ALTER COLUMN|RENAME)\b/i);
      for (const drop of text.match(/\bDROP\s+\w+[^;]*/gi) ?? [])
        expect(drop, name).toMatch(/DROP CONSTRAINT IF EXISTS flow_nodes_node_type_check/);
    }
  });

  it('widens the step type check to exactly the registered steps (plus the legacy http_fetch)', () => {
    const values = inList(sql('20261118001100_stage5_type_checks'), 'node_type');
    expect(values.sort()).toEqual([...Object.keys(NODE_REGISTRY), 'http_fetch'].sort());
  });

  it('forces RLS with a tenant read policy on every new table and grants only the app and worker roles', () => {
    for (const table of NEW_TABLES) {
      expect(all, table).toMatch(new RegExp(`CREATE TABLE ${table} \\(`));
      const forced = new RegExp(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`).test(all)
        || (/FOREACH t IN ARRAY ARRAY\['sequences','sequence_messages','sequence_subscriptions'\]/.test(all) && table.startsWith('sequence'));
      expect(forced, table).toBe(true);
      expect(all, table).toMatch(new RegExp(`account_id uuid (NOT NULL|PRIMARY KEY) DEFAULT NULLIF\\(current_setting\\('app\\.account_id', true\\),''\\)::uuid[\\s\\S]{0,80}REFERENCES accounts\\(id\\) ON DELETE CASCADE`));
    }
    // Grants name only the constrained runtime roles.
    for (const grant of all.match(/^GRANT [^;]+;/gm) ?? [])
      expect(grant).toMatch(/TO (bodhinox_app|bodhinox_worker)(, ?bodhinox_(app|worker))?;$/);
  });

  it('keeps tokens away from the app role', () => {
    const sheets = sql('20261118000900_google_sheets_connections');
    const appSelect = /GRANT SELECT \(([^)]*)\) ON google_sheets_connections TO bodhinox_app;/.exec(sheets)?.[1] ?? '';
    expect(appSelect).not.toContain('refresh_token_encrypted');
    expect(sheets).not.toMatch(/GRANT SELECT ON google_sheets_connections TO bodhinox_app/);
    const links = sql('20261118000200_flow_tracked_links');
    const linkSelect = /GRANT SELECT \(([^)]*)\) ON flow_tracked_links TO bodhinox_app;/.exec(links)?.[1] ?? '';
    expect(linkSelect).toContain('click_count');
    expect(linkSelect).not.toMatch(/\btoken\b/);
    expect(links).toMatch(/GRANT EXECUTE ON FUNCTION resolve_flow_link_token\(text\) TO bodhinox_worker;/);
    expect(sql('20261118001000_sequences')).toMatch(/GRANT EXECUTE ON FUNCTION crm_due_sequence_accounts\(\) TO bodhinox_worker;/);
    expect(all).not.toMatch(/ON FUNCTION \w+\([^)]*\) TO (bodhinox_app|PUBLIC)/);
  });

  it('keeps favourites per member and the label cap at the shared limit', () => {
    const labels = sql('20261118000500_conversation_labels');
    expect(labels).toMatch(/CREATE POLICY own_read ON conversation_favourites FOR SELECT TO bodhinox_app\s+USING \(account_id = app_account_id\(\) AND user_id = app_user_id\(\)\)/);
    expect(labels).toContain(`>= ${STAGE5_LIMITS.labelsPerWorkspace} THEN`);
    expect(inList(labels, 'color')).toEqual([...LABEL_COLORS]);
  });

  it('keeps the SQL values in step with the shared types', () => {
    const assignment = sql('20261118000600_inbox_assignment');
    expect(inList(assignment, 'auto_assign_mode')).toEqual([...AUTO_ASSIGN_MODES]);
    expect(inList(assignment, 'agent_visibility')).toEqual([...AGENT_VISIBILITY_MODES]);
    expect(assignment).toMatch(/auto_assign_mode text NOT NULL DEFAULT 'rules'/);
    expect(assignment).toMatch(/agent_visibility text NOT NULL DEFAULT 'all'/);
    expect(sql('20261118000300_conversation_pause_until'))
      .toContain(`BETWEEN ${AGENT_REPLY_PAUSE_LIMITS.minMinutes} AND ${AGENT_REPLY_PAUSE_LIMITS.maxMinutes}`);
    expect(inList(sql('20261118000900_google_sheets_connections'), 'status')).toEqual([...GOOGLE_SHEETS_STATUSES]);
    const sequences = sql('20261118001000_sequences');
    expect(inList(sequences, 'status')).toEqual([...SEQUENCE_STATUSES]);
    expect(inList(sequences, 'delay_unit')).toEqual([...SEQUENCE_DELAY_UNITS]);
    expect(inList(sequences.slice(sequences.indexOf('CREATE TABLE sequence_subscriptions')), 'status')).toEqual([...SEQUENCE_SUBSCRIPTION_STATUSES]);
    const flows = sql('20261118000000_flow_extra_triggers');
    expect(flows).toContain(`jsonb_array_length(extra_triggers) <= ${FLOW_TRIGGER_LIMITS.extraTriggers}`);
    expect(flows).toContain(`cardinality(test_usernames) <= ${FLOW_TRIGGER_LIMITS.testUsernames}`);
    expect(flows).toContain(`jsonb_array_length(canvas_notes) <= ${CANVAS_NOTE_LIMITS.notes}`);
    expect(sql('20261118000400_instagram_consent')).toContain(`keyword_list_ok(opt_out_keywords, ${STAGE5_LIMITS.consentKeywords}, ${STAGE5_LIMITS.consentKeywordChars})`);
  });

  it('records every Stage 5 column and table in schema-inventory.json and schema.prisma', () => {
    expect(columns('flows')).toEqual(expect.arrayContaining(['extra_triggers', 'test_usernames', 'canvas_notes', 'folder_id']));
    expect(columns('flow_versions')).toContain('extra_triggers');
    expect(columns('conversations')).toEqual(expect.arrayContaining(['bot_paused_until', 'bot_paused_by']));
    expect(columns('contacts')).toEqual(expect.arrayContaining(['instagram_opted_out_at', 'instagram_opted_in_at']));
    expect(columns('workspace_inbox_settings')).toEqual(expect.arrayContaining(['agent_reply_pause_minutes', 'auto_assign_mode', 'agent_visibility']));
    expect(columns('account_memberships')).toContain('max_open_conversations');
    expect(columns('ai_workspace_settings')).toContain('instagram_goals');
    const prisma = readFileSync(join(process.cwd(), 'prisma', 'schema.prisma'), 'utf8');
    for (const table of NEW_TABLES) {
      expect(columns(table).length, table).toBeGreaterThan(2);
      expect(columns(table), table).toContain('account_id');
      expect(prisma, table).toMatch(new RegExp(`^model ${table} \\{`, 'm'));
      // Every column in the inventory is created by the migration.
      for (const column of columns(table)) expect(all, `${table}.${column}`).toMatch(new RegExp(`\\b${column}\\b`));
    }
  });
});
