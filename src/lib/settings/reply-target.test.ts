import { expect, it } from 'vitest';
import { parseReplyTarget } from './reply-target';
it('accepts only whole reply targets between 1 and 1440 minutes', () => {
  for (const input of ['1', '5', '1440']) expect(parseReplyTarget(input)).toBe(Number(input));
  for (const input of ['', '0', '-1', '1441', '1.5', 'Infinity', '5minutes']) expect(parseReplyTarget(input)).toBeNull();
});
