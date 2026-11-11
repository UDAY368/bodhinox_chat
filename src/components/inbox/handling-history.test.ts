// "Who handled which chat": the sentence each history event reads as, and the
// inbox's Agent filter (assigned to someone now, or handled by them at any time).
import { describe, expect, it } from 'vitest';

import type { HandlingEvent } from '@/lib/inbox/handling-history';
import { matchesAgentFilter } from '@/lib/inbox/inbox-filters';
import { handlingSentence } from './handling-history';

const t = (key: string, values?: Record<string, string>) =>
  `${key}${values ? `(${Object.entries(values).map(([k, v]) => `${k}=${v}`).join(',')})` : ''}`;
const priya = { id: 'p', name: 'Priya' }, ravi = { id: 'r', name: 'Ravi' }, gone = { id: 'g', name: null };
const event = (e: Partial<HandlingEvent>): HandlingEvent =>
  ({ id: 'e', kind: 'assigned', from: null, to: null, actor: null, at: '2026-11-12T10:00:00.000Z', ...e });

describe('handlingSentence', () => {
  it('says who assigned it, or that it was automatic, or that someone took it themselves', () => {
    expect(handlingSentence(event({ to: priya, actor: ravi }), t)).toBe('assignedBy(to=Priya,by=Ravi)');
    expect(handlingSentence(event({ to: priya }), t)).toBe('assignedAuto(to=Priya)');
    expect(handlingSentence(event({ to: priya, actor: priya }), t)).toBe('tookIt(to=Priya)');
  });

  it('covers unassigning, resolving and reopening, by a member or automatically', () => {
    expect(handlingSentence(event({ kind: 'unassigned', from: priya, actor: ravi }), t)).toBe('unassignedBy(from=Priya,by=Ravi)');
    expect(handlingSentence(event({ kind: 'unassigned', from: priya }), t)).toBe('unassignedAuto(from=Priya)');
    expect(handlingSentence(event({ kind: 'resolved', actor: ravi }), t)).toBe('resolvedBy(by=Ravi)');
    expect(handlingSentence(event({ kind: 'resolved' }), t)).toBe('resolvedAuto');
    expect(handlingSentence(event({ kind: 'reopened', actor: ravi }), t)).toBe('reopenedBy(by=Ravi)');
    expect(handlingSentence(event({ kind: 'reopened' }), t)).toBe('reopenedAuto');
  });

  it('names someone who has left the workspace as a former member', () => {
    expect(handlingSentence(event({ to: gone, actor: ravi }), t)).toBe('assignedBy(to=formerMember,by=Ravi)');
    expect(handlingSentence(event({ kind: 'resolved', actor: gone }), t)).toBe('resolvedBy(by=formerMember)');
  });
});

describe('matchesAgentFilter', () => {
  const chat = (id: string, assigned_agent_id: string | null) => ({ id, assigned_agent_id });

  it('shows everything without a chosen agent', () => {
    expect(matchesAgentFilter(chat('c', null), null)).toBe(true);
  });

  it('"Assigned to" matches the current assignee only, even when the chat was handled before', () => {
    const agent = { memberId: 'p', mode: 'assigned' as const };
    expect(matchesAgentFilter(chat('c1', 'p'), agent)).toBe(true);
    expect(matchesAgentFilter(chat('c2', 'r'), agent, new Set(['c2']))).toBe(false);
  });

  it('"Handled by" adds the chats the server listed, and keeps the current ones while that list loads', () => {
    const agent = { memberId: 'p', mode: 'handled' as const };
    expect(matchesAgentFilter(chat('c2', 'r'), agent, new Set(['c2']))).toBe(true);
    expect(matchesAgentFilter(chat('c3', null), agent, new Set(['c2']))).toBe(false);
    expect(matchesAgentFilter(chat('c1', 'p'), agent, null)).toBe(true);
    expect(matchesAgentFilter(chat('c2', 'r'), agent, null)).toBe(false);
  });
});
