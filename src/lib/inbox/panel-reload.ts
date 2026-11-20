// When the chat side panel re-reads its data. It loads when the open contact
// changes, after its own saves and on its Refresh button; otherwise only a
// realtime change to this contact, its deals or its tags reloads it. New
// messages, conversation updates and the event stream's periodic resync do
// not: they never change what the panel shows.
//
// "contact" re-reads the contact's own details (fields, tags, notes, flow
// answers); "commerce" re-reads the Orders, Payments and Deals blocks.
export type PanelReload = 'contact' | 'commerce';

export interface PanelChange {
  kind: PanelReload;
  /** Increases on every change, so the same kind twice still reloads. */
  seq: number;
}

interface ChangeEvent {
  new?: Record<string, unknown> | null;
  old?: Record<string, unknown> | null;
}

const field = (event: ChangeEvent, key: string): unknown[] => [event.new?.[key], event.old?.[key]];

/** What a realtime change means for the panel showing `contactId`; null = nothing to reload. */
export function panelReloadFor(table: string, event: ChangeEvent, contactId: string | null | undefined): PanelReload | null {
  if (!contactId) return null;
  switch (table) {
    case 'contacts':
      return field(event, 'id').includes(contactId) ? 'contact' : null;
    case 'contact_tags':
      // No tag events are streamed today (the panel's own tag edits reload it);
      // handled so a future tag event needs no change here.
      return field(event, 'contact_id').includes(contactId) ? 'contact' : null;
    case 'deals':
      // A deal moved to or from this contact changes the Deals block either way.
      return field(event, 'contact_id').includes(contactId) ? 'commerce' : null;
    default:
      return null;
  }
}

/**
 * The composer's + menu created an order, quote, deal or booking for this contact. Orders are not
 * streamed, so the chat panel listens for this browser event to re-read its records block.
 */
export const CONTACT_RECORDS_CHANGED = 'bodhinox:contact-records-changed';

export function announceContactRecordsChanged(contactId: string): void {
  window.dispatchEvent(new CustomEvent(CONTACT_RECORDS_CHANGED, { detail: { contactId } }));
}
