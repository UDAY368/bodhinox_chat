import { expect, it } from 'vitest';
import { shouldSendOnEnter } from './composer-keyboard';
it('keeps Enter for touch, IME composition, modifiers and line breaks', () => {
  const enter = {
    key: 'Enter',
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    isComposing: false,
    keyCode: 13,
  };
  expect(shouldSendOnEnter(enter, false)).toBe(true);
  for (const patch of [
    { shiftKey: true },
    { isComposing: true },
    { keyCode: 229 },
    { ctrlKey: true },
    { key: 'a' },
  ])
    expect(shouldSendOnEnter({ ...enter, ...patch }, false)).toBe(false);
  expect(shouldSendOnEnter(enter, true)).toBe(false);
});
