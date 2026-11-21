'use client';

import { useSyncExternalStore } from 'react';

/**
 * The app header's empty middle (desktop only): one page at a time can put a
 * compact tool there with createPortal(…, useHeaderSlot()). The inbox puts its
 * open-windows strip there.
 */

let slot: HTMLElement | null = null;
const listeners = new Set<() => void>();

function setSlot(element: HTMLElement | null) {
  if (slot === element) return;
  slot = element;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Inbox routes (all inboxes and each channel's) get the slot. */
export function hasHeaderSlot(pathname: string): boolean {
  return /^\/((whatsapp|instagram)\/)?inbox(\/|$)/.test(pathname);
}

/** The slot element; rendered by the header. Hidden below lg, where the phone header has no room. */
export function HeaderSlot() {
  return <div ref={setSlot} data-header-slot className="hidden h-full min-w-0 flex-1 items-center justify-center lg:flex" />;
}

/** The mounted slot element, or null when the header shows none (other pages, or before mount). */
export function useHeaderSlot(): HTMLElement | null {
  return useSyncExternalStore(subscribe, () => slot, () => null);
}
