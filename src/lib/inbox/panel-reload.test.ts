import { describe, expect, it } from 'vitest';
import { panelReloadFor } from './panel-reload';

const C = 'contact-1';

describe('chat side panel reload rules', () => {
  it('never reloads on a new message, a conversation update or another table', () => {
    expect(panelReloadFor('messages', { new: { id: 'm1', contact_id: C, conversation_id: 'v1' }, old: {} }, C)).toBeNull();
    expect(panelReloadFor('conversations', { new: { id: 'v1', contact_id: C, unread_count: 3 }, old: { id: 'v1' } }, C)).toBeNull();
    expect(panelReloadFor('message_reactions', { new: { contact_id: C }, old: {} }, C)).toBeNull();
    expect(panelReloadFor('notifications', { new: { id: C }, old: {} }, C)).toBeNull();
  });

  it('reloads the contact details when this contact changes, not another one', () => {
    expect(panelReloadFor('contacts', { new: { id: C, name: 'Asha' }, old: { id: C } }, C)).toBe('contact');
    expect(panelReloadFor('contacts', { new: {}, old: { id: C } }, C)).toBe('contact');
    expect(panelReloadFor('contacts', { new: { id: 'contact-2' }, old: { id: 'contact-2' } }, C)).toBeNull();
  });

  it('reloads the contact details on a tag change for this contact', () => {
    expect(panelReloadFor('contact_tags', { new: { contact_id: C, tag_id: 't1' }, old: {} }, C)).toBe('contact');
    expect(panelReloadFor('contact_tags', { new: {}, old: { contact_id: C, tag_id: 't1' } }, C)).toBe('contact');
    expect(panelReloadFor('contact_tags', { new: { contact_id: 'contact-2' }, old: {} }, C)).toBeNull();
  });

  it('reloads the orders, payments and deals blocks on a deal of this contact, including one moved away', () => {
    expect(panelReloadFor('deals', { new: { id: 'd1', contact_id: C }, old: {} }, C)).toBe('commerce');
    expect(panelReloadFor('deals', { new: { id: 'd1', contact_id: 'contact-2' }, old: { id: 'd1', contact_id: C } }, C)).toBe('commerce');
    expect(panelReloadFor('deals', { new: { id: 'd1', contact_id: 'contact-2' }, old: { id: 'd1', contact_id: 'contact-2' } }, C)).toBeNull();
  });

  it('does nothing without an open contact', () => {
    expect(panelReloadFor('contacts', { new: { id: C }, old: {} }, null)).toBeNull();
    expect(panelReloadFor('deals', { new: { contact_id: undefined }, old: {} }, undefined)).toBeNull();
  });
});
