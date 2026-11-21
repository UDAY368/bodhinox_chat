import { expect, it, vi } from 'vitest';

vi.mock('@/lib/auth/client', () => ({ authFetch: vi.fn() }));
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));

import { numberOptionLabel, pickableNumbers } from './number-select';

const live = { id: 'a', removed: false, display_name: 'Support', phone_number_id: '111' };
const gone = { id: 'b', removed: true, display_name: null, phone_number_id: '222' };
const t = (key: string, values: Record<string, string>) =>
  key === 'unnamedNumber' ? `Number ${values.phoneNumberId}` : `${values.name} (disconnected)`;

it('offers only connected numbers for a new choice', () => {
  expect(pickableNumbers([live, gone])).toEqual([live]);
  expect(pickableNumbers([live, gone], null)).toEqual([live]);
  expect(pickableNumbers([live, gone], 'a')).toEqual([live]);
});

it('keeps a disconnected number that an existing record still points at', () => {
  expect(pickableNumbers([live, gone], 'b')).toEqual([live, gone]);
});

it('marks a disconnected number in its label', () => {
  expect(numberOptionLabel(live, t)).toBe('Support');
  expect(numberOptionLabel(gone, t)).toBe('Number 222 (disconnected)');
});

it('the select hides disconnected numbers but still names the current one', async () => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { NumberSelect, numberSelectOptions, NO_NUMBER } = await import('./number-select');
  const dto = (over: Record<string, unknown>) => ({
    waba_id: null, status: 'connected', is_default: false, quality_rating: null, messaging_limit_tier: null,
    name_status: null, health_checked_at: null, connected_at: null, created_at: null, ...live, ...over,
  });
  const numbers = [dto({}), dto({ ...gone, status: 'disconnected' })] as Parameters<typeof numberSelectOptions>[0];
  const tKey = (key: string) => key;
  const values = (value: string | null) => numberSelectOptions(numbers, value, 'All', tKey).map((o) => o.value);

  expect(values(null)).toEqual([NO_NUMBER, 'a']);
  expect(values('b')).toEqual([NO_NUMBER, 'a', 'b']);
  // A stored id the list does not have at all still shows.
  expect(values('zzz')).toEqual([NO_NUMBER, 'a', 'zzz']);

  const render = (value: string | null) =>
    renderToStaticMarkup(createElement(NumberSelect, { numbers, value, onChange: () => {}, emptyLabel: 'All' }));
  // The closed menu shows the chosen number's label, never its raw id.
  expect(render(null)).toContain('All');
  expect(render('b')).toContain('picker.disconnectedSuffix');
});
