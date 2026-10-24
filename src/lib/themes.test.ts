import { describe, it, expect } from 'vitest';
import { DEFAULT_MODE, DEFAULT_THEME, isThemeId, THEMES } from './themes';
describe('studio appearance defaults', () => {
 it('starts new devices with cream and copper', () => {
  expect(DEFAULT_MODE).toBe('light');
  expect(DEFAULT_THEME).toBe('copper');
  expect(THEMES.find(theme => theme.id === 'copper')?.swatch).toBe('#a65328');
 });
 it('continues accepting every previously saved accent', () => {
  for (const theme of ['violet', 'emerald', 'cobalt', 'amber', 'rose']) expect(isThemeId(theme)).toBe(true);
  expect(isThemeId('copper')).toBe(true);
  expect(isThemeId('unknown')).toBe(false);
 });
});
