import { describe, expect, it } from 'vitest';
import { activeTab, buildSections, sectionFor } from './sections';

const both = buildSections(['whatsapp', 'instagram']);
const section = (path: string) => sectionFor(path, both)?.id ?? null;
const tab = (path: string) => { const s = sectionFor(path, both); return s ? activeTab(path, s)?.href ?? null : null; };

describe('sections', () => {
  it('has eight sections in order, Settings last', () => {
    expect(both.map((s) => s.id)).toEqual(['inbox', 'contacts', 'automation', 'campaigns', 'sales', 'ai', 'analytics', 'settings']);
  });

  it('leaves Campaigns out without WhatsApp, and Instagram tools out without Instagram', () => {
    expect(buildSections(['instagram']).map((s) => s.id)).not.toContain('campaigns');
    const waOnly = buildSections(['whatsapp']);
    // Rules list with flows and sequences under one Automation tab.
    expect(waOnly.find((s) => s.id === 'automation')!.tabs.map((t) => t.labelKey)).toEqual(['automation']);
    expect(both.find((s) => s.id === 'automation')!.tabs.map((t) => t.labelKey)).toEqual(['automation', 'instagramTools']);
    expect(waOnly.find((s) => s.id === 'inbox')!.href).toBe('/whatsapp/inbox');
  });

  it('places every existing page in its section', () => {
    expect(section('/inbox')).toBe('inbox');
    expect(section('/instagram/inbox')).toBe('inbox');
    expect(section('/contacts/123')).toBe('contacts');
    expect(section('/automation')).toBe('automation');
    expect(section('/whatsapp/flows/abc')).toBe('automation');
    expect(section('/flows/abc')).toBe('automation');
    expect(section('/instagram/comments')).toBe('automation');
    expect(section('/broadcasts/42')).toBe('campaigns');
    expect(section('/ads')).toBe('campaigns');
    expect(section('/commerce/orders')).toBe('sales');
    expect(section('/appointments')).toBe('sales');
    expect(section('/agents')).toBe('ai');
    expect(section('/dashboard')).toBe('analytics');
    expect(section('/reports')).toBe('analytics');
    expect(section('/settings')).toBe('settings');
    expect(section('/notifications')).toBeNull();
  });

  it('picks the most specific tab', () => {
    // A rule, a sequence and the Instagram automation rail open from the Automation list.
    expect(tab('/whatsapp/automations/new')).toBe('/automation');
    expect(tab('/instagram/automations')).toBe('/automation');
    expect(tab('/instagram/sequences/9')).toBe('/automation');
    expect(tab('/instagram/basics')).toBe('/automation');
    expect(tab('/instagram/ref-links')).toBe('/instagram/home');
    expect(tab('/whatsapp/flows/abc')).toBe('/automation');
    expect(tab('/commerce/products/9')).toBe('/commerce/products');
    expect(tab('/dashboard')).toBe('/dashboard');
  });
});
