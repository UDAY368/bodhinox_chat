import React from 'react';
import { existsSync, readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/client')>()),
  authFetch: vi.fn(() => new Promise(() => {})),
}));

import { AI_TOGGLES, AiAssistantSettings, aiStatus, blankGoal, moveGoal, parseCapInput, unusedGoalTypes } from './ai-assistant-settings';
import { goalsProblem } from '@/lib/ai/goal-rules';
import { AI_GOAL_TYPES, AI_LEAD_FIELDS } from '@/lib/flows/types';
import { AiQuality, editShare, flagLabelKey, KNOWN_FLAGS, pct } from './ai-quality';

// AiSettings is in messages/en.json; AiAssistantSettings and AiQuality stay in
// the task's scratch i18n (AI_T5_I18N) until the fold-in merges them.
type Catalogue = Record<string, Record<string, unknown>>;
const catalogue = (): Catalogue => {
  const en = JSON.parse(readFileSync(`${process.cwd()}/messages/en.json`, 'utf8')) as Catalogue;
  const scratch = process.env.AI_T5_I18N;
  const extra = !en.AiQuality && scratch && existsSync(scratch) ? (JSON.parse(readFileSync(scratch, 'utf8')).en as Catalogue) : {};
  return { AiSettings: en.AiSettings, AiAssistantSettings: en.AiAssistantSettings ?? extra.AiAssistantSettings, AiQuality: en.AiQuality ?? extra.AiQuality };
};
const messages = catalogue();
const render = (node: React.ReactNode) =>
  renderToStaticMarkup(<NextIntlClientProvider locale="en" timeZone="UTC" messages={messages} onError={() => {}}>{node}</NextIntlClientProvider>);

const lookup = (ns: string, key: string): unknown =>
  key.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), messages[ns]);

describe('parseCapInput', () => {
  it('accepts empty (no cap) and positive whole numbers with separators', () => {
    expect(parseCapInput('')).toBeNull();
    expect(parseCapInput('  ')).toBeNull();
    expect(parseCapInput('50000')).toBe(50000);
    expect(parseCapInput('1,000,000')).toBe(1_000_000);
  });
  it.each(['0', '-5', '1.5', 'abc', '1e6', '10000000000000'])('rejects %s', (raw) => {
    expect(parseCapInput(raw)).toBe('invalid');
  });
});

describe('aiStatus', () => {
  it('explains the deployment switch before the key', () => {
    expect(aiStatus({ deployment_enabled: false, configured: true })).toBe('deploymentOff');
    expect(aiStatus({ deployment_enabled: true, configured: false })).toBe('notConfigured');
    expect(aiStatus({ deployment_enabled: true, configured: true })).toBe('ready');
  });
});

describe('Instagram goals editor helpers (5G)', () => {
  it('adds each goal type once, in order, and a blank goal is not saveable until filled in', () => {
    expect(unusedGoalTypes([])).toEqual([...AI_GOAL_TYPES]);
    expect(unusedGoalTypes([{ type: 'grow_followers' }])).toEqual(['share_link', 'capture_lead']);
    expect(goalsProblem([blankGoal('share_link')])).toBe('url');
    expect(goalsProblem([blankGoal('grow_followers'), blankGoal('capture_lead')])).toBeNull();
  });
  it('moves goals within bounds only', () => {
    const goals = [blankGoal('grow_followers'), blankGoal('capture_lead')];
    expect(moveGoal(goals, 1, -1).map((g) => g.type)).toEqual(['capture_lead', 'grow_followers']);
    expect(moveGoal(goals, 0, -1).map((g) => g.type)).toEqual(['grow_followers', 'capture_lead']);
    expect(moveGoal(goals, 1, 1).map((g) => g.type)).toEqual(['grow_followers', 'capture_lead']);
  });
  it('has every editor string in all four locales', () => {
    const keys = ['title', 'description', 'onlyInstagram', 'empty', 'add', 'save', 'goalLabel', 'type', 'url', 'linkLabel', 'fields',
      'onRefusal', 'refusalHandoff', 'refusalContinue', 'moveUp', 'moveDown', 'remove', 'invalid', 'saved', 'saveFailed',
      ...AI_GOAL_TYPES.flatMap((type) => [`types.${type}`, `typeHelp.${type}`]), ...AI_LEAD_FIELDS.map((f) => `fieldNames.${f}`)];
    for (const locale of ['en', 'es', 'pt', 'ko']) {
      const ns = (JSON.parse(readFileSync(`${process.cwd()}/messages/${locale}.json`, 'utf8')) as Catalogue).AiSettings.instagramGoals;
      const missing = keys.filter((key) => typeof key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], ns) !== 'string');
      expect(missing, locale).toEqual([]);
    }
  });
});

describe('quality helpers', () => {
  it('formats rates and edit shares', () => {
    expect(pct(null)).toBe('—');
    expect(pct(0.4)).toBe('40%');
    expect(editShare(125)).toBe('13%');
    expect(editShare(null)).toBe('—');
  });
  it('labels known flags and families, and leaves others as codes', () => {
    expect(flagLabelKey('pii_redacted')).toBe('flags.pii_redacted');
    expect(flagLabelKey('claim_payment_confirmed')).toBe('flags.claim');
    expect(flagLabelKey('fallback_timeout')).toBe('flags.fallback');
    expect(flagLabelKey('something_new')).toBeNull();
  });
});

describe('components', () => {
  it('render a loading state first (they fetch after mount)', () => {
    expect(render(<AiAssistantSettings />)).toContain('animate-spin');
    expect(render(<AiQuality />)).toContain('animate-spin');
  });

  it.skipIf(!messages.AiAssistantSettings || !messages.AiQuality)('every string they use exists in the catalogue', () => {
    const used = (file: string, fn: string, ns: string) => {
      const source = readFileSync(`${process.cwd()}/src/components/settings/${file}`, 'utf8');
      return [...source.matchAll(new RegExp(`\\b${fn}\\('([^'\`]+)'`, 'g'))].map((m) => [ns, m[1]] as const);
    };
    const keys = [
      ...used('ai-assistant-settings.tsx', 't', 'AiAssistantSettings'),
      ...used('ai-assistant-settings.tsx', 'ts', 'AiSettings'),
      ...used('ai-quality.tsx', 't', 'AiQuality'),
      ...['deploymentOff', 'notConfigured'].map((k) => ['AiAssistantSettings', `badge.${k}`] as const),
      ...AI_TOGGLES.flatMap(({ feature }) => [['AiAssistantSettings', `help.${feature}`] as const, ['AiSettings', `features.${feature}`] as const]),
      ...[...KNOWN_FLAGS, 'claim', 'fallback'].map((f) => ['AiQuality', `flags.${f}`] as const),
    ];
    expect(keys.length).toBeGreaterThan(30);
    expect(keys.filter(([ns, key]) => typeof lookup(ns, key) !== 'string')).toEqual([]);
  });
});
