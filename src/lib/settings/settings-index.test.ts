import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RELATED_SETTINGS, SETTINGS_INDEX, relatedSettings, searchSettings } from './settings-index';
import { SECTION_META, SETTINGS_SECTIONS } from '@/components/settings/settings-sections';
import { AGENT_TABS } from '@/components/agents/agent-tabs';
import { APPOINTMENT_SCREEN_TABS } from '@/components/appointments/shared';

/** Every page route under src/app, route groups removed (/settings, /commerce/settings, ...). */
function appRoutes(): Set<string> {
  const root = join(process.cwd(), 'src', 'app');
  const routes = new Set<string>();
  for (const file of readdirSync(root, { recursive: true }) as string[]) {
    const parts = file.split(sep);
    if (parts.at(-1) !== 'page.tsx') continue;
    const segments = parts.slice(0, -1).filter((part) => !/^\(.*\)$/.test(part));
    routes.add(`/${segments.join('/')}`);
  }
  return routes;
}

const ids = (list: { id: string }[]) => list.map((e) => e.id);

describe('settings index', () => {
  it('has one entry per settings section, unique ids, and links into Settings or the AI page', () => {
    const all = SETTINGS_INDEX.map((e) => e.id);
    expect(new Set(all).size).toBe(all.length);
    for (const section of [...SETTINGS_SECTIONS, 'ai', 'needs-review']) expect(all).toContain(section);
  });

  it('links every entry to a page that exists in src/app, with a tab that page knows', () => {
    const routes = appRoutes();
    expect(routes).toContain('/settings');
    const tabs: Record<string, readonly string[]> = {
      '/settings': [...SETTINGS_SECTIONS, 'ai', 'needs-review'],
      '/agents': AGENT_TABS,
      '/appointments': APPOINTMENT_SCREEN_TABS,
    };
    for (const entry of SETTINGS_INDEX) {
      const url = new URL(entry.href, 'https://app.test');
      expect(routes, `${entry.id} -> ${entry.href}`).toContain(url.pathname);
      const tab = url.searchParams.get('tab');
      if (tab) expect(tabs[url.pathname], `${entry.id} -> ${entry.href}`).toContain(tab);
    }
  });

  it('sends a section that moved to its own page (Templates) straight there', () => {
    for (const entry of SETTINGS_INDEX) {
      const moved = entry.kind === 'section' && entry.section && entry.section in SECTION_META
        ? SECTION_META[entry.section as keyof typeof SECTION_META].href : undefined;
      if (moved) expect(entry.href).toBe(moved);
    }
    expect(SETTINGS_INDEX.find((e) => e.id === 'templates')?.href).toBe('/templates');
  });

  it('scrolls only to anchors the settings page renders', () => {
    const page = readFileSync(join(process.cwd(), 'src', 'app', '(dashboard)', 'settings', 'page.tsx'), 'utf8');
    for (const entry of SETTINGS_INDEX) if (entry.anchor) expect(page, entry.anchor).toContain(`id="${entry.anchor}"`);
  });

  it('gives every settings screen shown on the page its Related links', () => {
    const shown = [...SETTINGS_SECTIONS.filter((s) => !SECTION_META[s].href), 'ai', 'needs-review'] as const;
    for (const section of shown) expect(relatedSettings(section).length, section).toBeGreaterThan(0);
  });

  it('lists admin screens only for the roles that may open them', () => {
    const byId = new Map(SETTINGS_INDEX.map((e) => [e.id, e]));
    for (const id of ['ai', 'ai-setup', 'ai-knowledge', 'ai-usage']) expect(byId.get(id)?.requires).toBe('edit-settings');
    for (const id of ['audit-log', 'needs-review']) expect(byId.get(id)?.requires).toBe('manage-members');
  });

  it('has an on-screen title for every entry in every language', async () => {
    for (const locale of ['en', 'es', 'ko', 'pt']) {
      const messages = JSON.parse(readFileSync(join(process.cwd(), 'messages', `${locale}.json`), 'utf8'));
      for (const entry of SETTINGS_INDEX) expect(messages.SettingsSearch.entries[entry.id], `${locale}: ${entry.id}`).toBeTruthy();
    }
  });

  it('points every related link at a real entry', () => {
    const all = new Set(SETTINGS_INDEX.map((e) => e.id));
    for (const list of Object.values(RELATED_SETTINGS)) for (const id of list ?? []) expect(all).toContain(id);
    expect(ids(relatedSettings('inbox')).slice(0, 3)).toEqual(['working-hours', 'away-message', 'routing']);
    expect(ids(relatedSettings('whatsapp'))).toEqual(expect.arrayContaining(['templates', 'whatsapp-numbers']));
    expect(ids(relatedSettings('ai'))).toEqual(expect.arrayContaining(['ai-knowledge', 'ai-usage']));
    expect(ids(relatedSettings('needs-review'))).toEqual(['audit-log', 'inbox']);
  });

  it('drops related links the viewer cannot open', () => {
    expect(ids(relatedSettings('members', (e) => e.id !== 'audit-log'))).not.toContain('audit-log');
  });
});

describe('searchSettings', () => {
  it('finds a section by its name, title matches first', () => {
    expect(ids(searchSettings('inbox'))[0]).toBe('inbox');
    expect(ids(searchSettings('templ'))[0]).toBe('templates');
  });

  it('finds individual settings by keyword', () => {
    expect(ids(searchSettings('out of office'))).toContain('away-message');
    expect(ids(searchSettings('2fa'))).toContain('two-factor');
    expect(ids(searchSettings('dark mode'))).toEqual(['appearance']);
    expect(searchSettings('working hours')[0]).toMatchObject({ id: 'working-hours', href: '/settings?tab=inbox#working-hours' });
  });

  it('needs every word to match, ignores case and accents, and is empty for blank or unknown text', () => {
    expect(ids(searchSettings('API KEY'))).toContain('api');
    expect(searchSettings('   ')).toEqual([]);
    expect(searchSettings('zzzz nothing')).toEqual([]);
    expect(ids(searchSettings('Idioma', { label: (e) => (e.id === 'language' ? 'Idioma' : e.title) }))).toEqual(['language']);
    expect(ids(searchSettings('idiomá', { label: (e) => (e.id === 'language' ? 'Idioma' : e.title) }))).toEqual(['language']);
  });

  it('caps the results', () => {
    expect(searchSettings('a', { limit: 3 })).toHaveLength(3);
  });
});
