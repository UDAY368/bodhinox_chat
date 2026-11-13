import { describe, expect, it } from 'vitest';
import { broadcastIntentKey } from '@/lib/whatsapp/broadcast-core';
import { personalizeInstagramText } from './instagram';

describe('personalizeInstagramText', () => {
  it('greets each recipient by first name', () => {
    expect(personalizeInstagramText('Hi {first name}! Sale is on, {first name}.', 'Priya')).toBe('Hi Priya! Sale is on, Priya.');
  });

  it('drops the token and its spacing when the name is unknown', () => {
    expect(personalizeInstagramText('Hi {first name}! Sale is on.', null)).toBe('Hi! Sale is on.');
    expect(personalizeInstagramText('{first name}, your order shipped', '  ')).toBe('your order shipped');
  });

  it('leaves text without the token unchanged', () => {
    expect(personalizeInstagramText('Weekend flash sale', 'Priya')).toBe('Weekend flash sale');
  });
});

describe('Instagram broadcast intent keys', () => {
  it('share the recipient prefix that staff reconciliation matches on', () => {
    expect(broadcastIntentKey('b', 'r', 'ig')).toBe('broadcast:b:r:ig');
    expect(broadcastIntentKey('b', 'r', 'ig', 2)).toBe('broadcast:b:r:ig:retry2');
  });
});
