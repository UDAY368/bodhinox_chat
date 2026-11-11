// Stage 5 (5E): inbox folders, the agent-visibility predicate and the CRM read scope.
import { describe, expect, it } from 'vitest';

import { compileSelect } from '@/lib/repositories/query';
import { labelFilter, labelOfFilter, matchesInboxFilter, parseInboxFilter } from './inbox-filters';
import { conversationIdVisibleSql, conversationVisibleSql, visibilityRestricted } from './inbox-scope';
import { isUuid, LabelError, parseLabelColor, parseLabelCreate, parseLabelName, parseLabelPatch } from './labels';
import { parseFavouriteInput } from './favourites';

const now = Date.parse('2026-11-11T12:00:00Z');
const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const LABEL = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
const base = { status: 'open' as const, unread_count: 0, last_customer_message_at: null, assigned_agent_id: undefined as string | undefined };

const code = (fn: () => unknown) => {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof LabelError ? `${error.status}:${error.code}` : 'other';
  }
};

describe('Stage 5 folder filters', () => {
  it('parses the folders and one filter per label, and nothing else', () => {
    expect(parseInboxFilter('mine')).toBe('mine');
    expect(parseInboxFilter('favourites')).toBe('favourites');
    expect(parseInboxFilter('reminders')).toBe('reminders');
    expect(parseInboxFilter(`label-${LABEL}`)).toBe(`label-${LABEL.toLowerCase()}`);
    expect(parseInboxFilter('label-not-a-uuid')).toBe('all');
    expect(parseInboxFilter("label-'; DROP TABLE x")).toBe('all');
    expect(labelOfFilter(labelFilter(LABEL))).toBe(LABEL.toLowerCase());
    expect(labelOfFilter('mine')).toBeNull();
  });

  it('Mine is the open conversations assigned to the signed-in member', () => {
    const folders = { userId: ME };
    expect(matchesInboxFilter({ ...base, assigned_agent_id: ME }, 'mine', now, undefined, folders)).toBe(true);
    expect(matchesInboxFilter({ ...base, assigned_agent_id: OTHER }, 'mine', now, undefined, folders)).toBe(false);
    expect(matchesInboxFilter({ ...base, assigned_agent_id: ME, status: 'closed' }, 'mine', now, undefined, folders)).toBe(false);
    // Without the member's identity the folder matches nothing.
    expect(matchesInboxFilter({ ...base, assigned_agent_id: ME }, 'mine', now)).toBe(false);
  });

  it('Favourites, Reminders and label folders read the loaded sets and match nothing without them', () => {
    const folders = {
      favouriteIds: new Set(['c1']),
      reminderIds: new Set(['c2']),
      labelsByConversation: new Map([['c3', new Set([LABEL.toLowerCase()])]]),
    };
    expect(matchesInboxFilter({ ...base, id: 'c1' }, 'favourites', now, undefined, folders)).toBe(true);
    expect(matchesInboxFilter({ ...base, id: 'c2' }, 'favourites', now, undefined, folders)).toBe(false);
    expect(matchesInboxFilter({ ...base, id: 'c2' }, 'reminders', now, undefined, folders)).toBe(true);
    expect(matchesInboxFilter({ ...base, id: 'c3' }, labelFilter(LABEL), now, undefined, folders)).toBe(true);
    expect(matchesInboxFilter({ ...base, id: 'c1' }, labelFilter(LABEL), now, undefined, folders)).toBe(false);
    expect(matchesInboxFilter({ ...base, id: 'c1' }, 'favourites', now)).toBe(false);
    expect(matchesInboxFilter(base, 'favourites', now, undefined, folders)).toBe(false);
  });
});

describe('labels and favourites input', () => {
  it('trims and bounds names, and accepts only palette colours', () => {
    expect(parseLabelName('  VIP   buyers ')).toBe('VIP buyers');
    expect(parseLabelName('')).toBeNull();
    expect(parseLabelName('x'.repeat(41))).toBeNull();
    expect(parseLabelColor('teal')).toBe('teal');
    expect(parseLabelColor('#ff0000')).toBeNull();
    expect(parseLabelCreate({ name: 'Hot' })).toEqual({ name: 'Hot', color: 'gray' });
    expect(code(() => parseLabelCreate({ name: ' ' }))).toBe('400:invalid_name');
    expect(code(() => parseLabelCreate({ name: 'Hot', color: 'url(x)' }))).toBe('400:invalid_color');
    expect(parseLabelPatch({ color: 'red' })).toEqual({ color: 'red' });
    expect(code(() => parseLabelPatch({}))).toBe('400:invalid_name');
    expect(isUuid(LABEL)).toBe(true);
    expect(isUuid('1 OR 1=1')).toBe(false);
  });

  it('needs a conversation id and a boolean to change a favourite', () => {
    expect(parseFavouriteInput({ conversation_id: ME, favourite: true })).toEqual({ conversationId: ME, favourite: true });
    expect(code(() => parseFavouriteInput({ conversation_id: ME, favourite: 'yes' }))).toBe('400:invalid_body');
    expect(code(() => parseFavouriteInput(null))).toBe('400:invalid_body');
  });
});

describe('agent visibility predicate', () => {
  it('restricts only agents and viewers', () => {
    expect(visibilityRestricted('agent')).toBe(true);
    expect(visibilityRestricted('viewer')).toBe(true);
    expect(visibilityRestricted('admin')).toBe(false);
    expect(visibilityRestricted('owner')).toBe(false);
    expect(visibilityRestricted(undefined)).toBe(false);
  });

  it('reads the setting, the member and their teams from the tenant transaction, over a trusted alias only', () => {
    const sql = conversationVisibleSql('c');
    expect(sql).toContain("agent_visibility = 'assigned_or_team'");
    expect(sql).toContain('c.assigned_agent_id IS NULL');
    expect(sql).toContain('c.assigned_agent_id = app_user_id()');
    expect(sql).toContain('team_members');
    expect(() => conversationVisibleSql('c; DROP TABLE conversations')).toThrow('Invalid SQL alias');
    expect(conversationIdVisibleSql('m.conversation_id')).toContain('vis_c.id = m.conversation_id');
  });

  it('adds the predicate to conversation and message reads for agents, and nothing for admins', () => {
    const accountId = '00000000-0000-4000-8000-000000000001';
    const spec = (resource: string) => ({ resource, operation: 'select', filters: [] }) as never;
    const asAgent = { accountId, userId: ME, role: 'agent' } as never;
    const asAdmin = { accountId, userId: ME, role: 'admin' } as never;
    expect(compileSelect(spec('conversations'), asAgent, true).text).toContain('assigned_or_team');
    expect(compileSelect(spec('messages'), asAgent, true).text).toContain('vis_c.id = t.conversation_id');
    expect(compileSelect(spec('conversations'), asAdmin, true).text).not.toContain('assigned_or_team');
    expect(compileSelect(spec('messages'), asAdmin, true).text).not.toContain('assigned_or_team');
    // Other tables keep exactly their tenant condition.
    expect(compileSelect(spec('contacts'), asAgent, true).text).not.toContain('assigned_or_team');
  });
});

describe('agent visibility on the act-on-a-conversation lookups', () => {
  it('gives the server lookups the same role-gated predicate, over a trusted alias only', async () => {
    const { conversationVisible } = await import('./visibility-sql');
    const sql = conversationVisible('c').sql;
    expect(sql).toBe(conversationVisibleSql('c'));
    expect(sql).toContain("current_setting('app.account_role', true)");
    expect(sql).toContain("vis.agent_visibility = 'assigned_or_team'");
    expect(conversationVisible('conversations').values).toEqual([]);
    expect(() => conversationVisible('c; DROP TABLE x')).toThrow('Invalid SQL alias');
  });
});
