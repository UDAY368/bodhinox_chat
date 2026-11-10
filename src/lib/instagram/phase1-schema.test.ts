// Stage 2A migration inventory: the latest flow trigger and step checks list
// exactly what the code knows, and schema-inventory.json carries every new
// column (contracts.ts reads it). The database behaviour itself is covered by
// phase1-schema.integration.test.ts.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import inventory from '../../../prisma/schema-inventory.json';
import { FLOW_TRIGGER_TYPES } from '@/lib/flows/types';
import { IMPLEMENTED_NODE_TYPES } from '@/lib/flows/node-registry';

const MIGRATIONS = join(process.cwd(), 'prisma', 'migrations');
const migrations = readdirSync(MIGRATIONS).filter((name) => /^\d{14}_/.test(name)).sort();
/** A migration's SQL without `--` comments. */
const sql = (name: string) => readFileSync(join(MIGRATIONS, name, 'migration.sql'), 'utf8').replace(/--[^\n]*/g, '');

/** The values in the last `ADD CONSTRAINT <name> CHECK (... IN (...))` across all migrations. */
function latestCheckValues(constraint: string): string[] {
  let latest: string | null = null;
  for (const name of migrations) {
    const match = new RegExp(`ADD CONSTRAINT ${constraint}\\s+CHECK\\s*\\(\\s*\\w+\\s+IN\\s*\\(([^)]*)\\)`, 'i').exec(sql(name));
    if (match) latest = match[1];
  }
  if (!latest) throw new Error(`no ${constraint}`);
  return [...latest.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

const columns = (table: string): string[] => {
  const entry = (inventory.tables as Record<string, { name: string }[] | { columns: { name: string }[] }>)[table];
  return (Array.isArray(entry) ? entry : entry.columns).map((c) => c.name);
};

describe('Stage 2A migration inventory', () => {
  it('the flow trigger check lists every trigger type the code knows, and only those', () => {
    expect(latestCheckValues('flows_trigger_type_check').sort()).toEqual([...FLOW_TRIGGER_TYPES].sort());
  });

  it('the flow node check allows every implemented node type (plus the retired http_fetch)', () => {
    const allowed = latestCheckValues('flow_nodes_node_type_check');
    for (const node of IMPLEMENTED_NODE_TYPES) expect(allowed, node).toContain(node);
    expect(allowed.filter((node) => !(IMPLEMENTED_NODE_TYPES as string[]).includes(node))).toEqual(['http_fetch']);
  });

  it('records every Stage 2 column in schema-inventory.json', () => {
    expect(columns('instagram_comment_events')).toEqual(expect.arrayContaining(['flow_run_id', 'public_reply_id', 'opted_in_at']));
    expect(columns('contact_channel_identities')).toEqual(expect.arrayContaining(
      ['follows_business', 'business_follows', 'is_verified', 'ig_follower_count', 'profile_checked_at']));
    expect(columns('instagram_accounts')).toEqual(expect.arrayContaining(['ice_breakers', 'profile_synced_at']));
    expect(columns('ai_configs')).toContain('instagram_auto_reply_enabled');
    expect(columns('workspace_inbox_settings')).toContain('instagram_away_message_enabled');
    expect(columns('webhook_endpoints')).toContain('channels');
  });

  it('keeps the Stage 2 migrations additive: constant defaults, NOT VALID checks validated later', () => {
    const stage2 = migrations.filter((name) => /^2026111707\d{4}_/.test(name));
    expect(stage2).toEqual([
      '20261117070000_flow_ig_triggers', '20261117070100_flow_ig_triggers_validate', '20261117070200_instagram_comment_flow_links',
      '20261117070300_contact_ig_profile_facts', '20261117070400_instagram_account_profile', '20261117070500_channel_reply_switches',
      '20261117070600_webhook_endpoint_channels', '20261117070700_instagram_phase1_validate',
    ]);
    const added = stage2.flatMap((name) => [...sql(name).matchAll(/ADD CONSTRAINT (\w+)/g)].map((m) => m[1]));
    const validated = stage2.flatMap((name) => [...sql(name).matchAll(/VALIDATE CONSTRAINT (\w+)/g)].map((m) => m[1]));
    expect(added.sort()).toEqual(validated.sort());
    // The app role can read the new non-secret instagram_accounts columns through its column grant.
    expect(sql('20261117070400_instagram_account_profile')).toMatch(/GRANT SELECT \(ice_breakers, profile_synced_at\) ON instagram_accounts TO bodhinox_app/);
  });
});
