import { describe, expect, it } from 'vitest';
import { activeMentionQuery, insertMention, matchMembers, mentionedIds, splitMentions } from './mentions';

const members = [
  { id: 'a', name: 'Asha Rao' },
  { id: 'b', name: 'Ravi Kumar' },
  { id: 'c', name: 'Kiran Asher' },
];

describe('activeMentionQuery', () => {
  it('finds the mention being typed at the caret', () => {
    expect(activeMentionQuery('hi @as', 6)).toEqual({ start: 3, query: 'as' });
    expect(activeMentionQuery('@', 1)).toEqual({ start: 0, query: '' });
    expect(activeMentionQuery('ping @Asha R', 12)).toEqual({ start: 5, query: 'Asha R' });
  });

  it('ignores emails, finished lines and text without @', () => {
    expect(activeMentionQuery('mail a@b.com', 12)).toBeNull();
    expect(activeMentionQuery('hello', 5)).toBeNull();
    expect(activeMentionQuery('@as\nnext', 8)).toBeNull();
    expect(activeMentionQuery('@ x', 3)).toBeNull();
  });
});

describe('matchMembers', () => {
  it('ranks name prefixes, then word prefixes, then substrings', () => {
    expect(matchMembers(members, 'as').map((m) => m.id)).toEqual(['a', 'c']);
    expect(matchMembers(members, 'ku').map((m) => m.id)).toEqual(['b']);
    expect(matchMembers(members, 'zz')).toEqual([]);
    expect(matchMembers(members, '', 2)).toHaveLength(2);
  });
});

describe('insertMention and mentionedIds', () => {
  it('replaces the query with the full name and tracks only names still present', () => {
    const { text, caret } = insertMention('call @as now', 5, 8, 'Asha Rao');
    expect(text).toBe('call @Asha Rao now');
    expect(caret).toBe('call @Asha Rao '.length);
    const picked = new Map([['a', 'Asha Rao'], ['b', 'Ravi Kumar']]);
    expect(mentionedIds(text, picked)).toEqual(['a']);
    expect(mentionedIds('nobody', picked)).toEqual([]);
  });
});

describe('splitMentions', () => {
  it('marks known @names, longest first', () => {
    expect(splitMentions('hi @Asha Rao and @Bob', ['Asha', 'Asha Rao'])).toEqual([
      { text: 'hi ', mention: false },
      { text: '@Asha Rao', mention: true },
      { text: ' and @Bob', mention: false },
    ]);
    expect(splitMentions('plain', [])).toEqual([{ text: 'plain', mention: false }]);
  });
});
