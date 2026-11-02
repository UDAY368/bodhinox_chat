import { expect, it } from 'vitest';
import { conversationNumberId, inboxFilterNumbers, matchesNumberFilter, NO_NUMBER } from './conversation-number';

it('filters conversations by the number they are on', () => {
  const onA = { id: 'c1', whatsapp_config_id: 'a' };
  const onB = { id: 'c2', whatsapp_config_id: 'b' };
  const none = { id: 'c3', whatsapp_config_id: null };
  const legacy = { id: 'c4' };
  const all = [onA, onB, none, legacy];
  expect(all.filter((c) => matchesNumberFilter(c, null))).toEqual(all);
  expect(all.filter((c) => matchesNumberFilter(c, 'a'))).toEqual([onA]);
  expect(all.filter((c) => matchesNumberFilter(c, NO_NUMBER))).toEqual([none, legacy]);
  expect(conversationNumberId(legacy)).toBeNull();
});

it('offers a disconnected number as an inbox filter only while conversations are on it', () => {
  const live = { id: 'a', removed: false };
  const gone = { id: 'b', removed: true };
  const goneQuiet = { id: 'c', removed: true };
  const numbers = [live, gone, goneQuiet];
  expect(inboxFilterNumbers(numbers, [], null)).toEqual([live]);
  expect(inboxFilterNumbers(numbers, [{ whatsapp_config_id: 'b' }, { whatsapp_config_id: null }], null)).toEqual([live, gone]);
  // The current filter stays listed even once its conversations scroll away.
  expect(inboxFilterNumbers(numbers, [], 'c')).toEqual([live, goneQuiet]);
});
