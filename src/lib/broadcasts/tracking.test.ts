import { describe, expect, it } from 'vitest';
import type { TemplateButton } from '@/types';
import { CLICK_TOKEN, trackedButtonIndex, validTrackedUrl } from './tracking';

const origin = 'https://app.example.com';
const tpl = (buttons: TemplateButton[]) => ({ buttons });

describe('click tracking helpers', () => {
  it('finds only a URL button pointing exactly at this app\'s /r/{{1}}', () => {
    expect(trackedButtonIndex(tpl([{ type: 'QUICK_REPLY', text: 'Hi' }, { type: 'URL', text: 'Shop', url: `${origin}/r/{{1}}` }]), origin)).toBe(1);
    expect(trackedButtonIndex(tpl([{ type: 'URL', text: 'Shop', url: 'https://evil.example/r/{{1}}' }]), origin)).toBe(-1);
    expect(trackedButtonIndex(tpl([{ type: 'URL', text: 'Shop', url: `${origin}/r/{{1}}/x` }]), origin)).toBe(-1);
    expect(trackedButtonIndex(null, origin)).toBe(-1);
  });

  it('accepts only absolute https destinations without credentials', () => {
    expect(validTrackedUrl('https://shop.example.com/sale?utm=wa')).toBe(true);
    expect(validTrackedUrl('http://shop.example.com')).toBe(false);
    expect(validTrackedUrl('javascript:alert(1)')).toBe(false);
    expect(validTrackedUrl('https://user:pass@shop.example.com')).toBe(false);
    expect(validTrackedUrl('/relative')).toBe(false);
    expect(validTrackedUrl(`https://a.example/${'x'.repeat(2048)}`)).toBe(false);
  });

  it('accepts only 32-hex click tokens', () => {
    expect(CLICK_TOKEN.test('0123456789abcdef0123456789abcdef')).toBe(true);
    expect(CLICK_TOKEN.test("x' OR 1=1 --")).toBe(false);
    expect(CLICK_TOKEN.test('test')).toBe(false);
  });
});
