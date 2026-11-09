import { expect, it } from 'vitest';
import { compileSelect } from '@/lib/repositories/query';
import { contactSearchFilter } from './search-term';

const context = { accountId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222', role: 'agent' as const };
const compile = (term: string) =>
  compileSelect({ resource: 'contacts', operation: 'select', filters: [], or: [contactSearchFilter(term)] }, context, true);

it.each(['Sharma, Raj', 'Acme (Pune', 'Acme) x', '(044) 2345', 'a,b(c)d'])('compiles the search %j without a query error', (term) => {
  const query = compile(term);
  expect(query.text).toContain('ILIKE');
  // Each of the three columns gets one bound pattern; the term is never spliced into SQL.
  expect(query.text).not.toContain(term);
});

it('keeps commas and brackets matchable as single-character wildcards', () => {
  expect(contactSearchFilter('  Sharma, Raj ')).toBe('name.ilike.%Sharma_ Raj%,phone.ilike.%Sharma_ Raj%,email.ilike.%Sharma_ Raj%');
  const values = compile('Acme (Pune').values;
  expect(values).toContain('%Acme _Pune%');
});
