'use client';

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';

/**
 * Scroll the open chat to a message and flash it, loading older history pages
 * until the message is in the list. The thread renders each message's wrapper
 * with `data-message-id={msg.id}` (MESSAGE_ID_ATTRIBUTE) so it can be found.
 *
 *   const { jumpTo } = useJumpToMessage({
 *     scrollRef, messages, hasOlder: history?.hasOlder ?? false, loadOlder,
 *     loadingOlder, ready: !loading && history?.conversationId === conversationId,
 *     onNotFound: () => toast.error(t('jumpNotFound')),
 *   });
 *
 * Paging is bounded by `maxPages` (default 20 pages), so an old or deleted
 * message gives up instead of pulling the whole history.
 */

export const MESSAGE_ID_ATTRIBUTE = 'data-message-id';
export const DEFAULT_JUMP_MAX_PAGES = 20;
const DEFAULT_HIGHLIGHT_MS = 2_500;
const HIGHLIGHT_CLASSES = ['ring-2', 'ring-primary', 'ring-offset-2', 'ring-offset-background', 'rounded-xl', 'transition-shadow'];

export type JumpStep = 'wait' | 'scroll' | 'load' | 'give_up';

/** Pure decision for one pass of the jump loop. */
export function nextJumpStep(state: {
  found: boolean;
  ready: boolean;
  loading: boolean;
  hasOlder: boolean;
  pagesLoaded: number;
  maxPages: number;
}): JumpStep {
  if (!state.ready) return 'wait';
  if (state.found) return 'scroll';
  if (state.loading) return 'wait';
  if (state.hasOlder && state.pagesLoaded < state.maxPages) return 'load';
  return 'give_up';
}

/** CSS selector for a message's element. Ids are uuids; anything else is quoted defensively. */
export function messageElementSelector(messageId: string): string {
  return `[${MESSAGE_ID_ATTRIBUTE}="${messageId.replace(/["\\]/g, '\\$&')}"]`;
}

export interface UseJumpToMessageOptions {
  /** The thread's scroll container. */
  scrollRef: RefObject<HTMLElement | null>;
  /** Messages currently loaded, in any order. */
  messages: ReadonlyArray<{ id: string }>;
  /** Whether older history remains to load. */
  hasOlder: boolean;
  /** Loads the next older page into `messages`. */
  loadOlder: () => Promise<unknown> | unknown;
  /** True while an older page is loading. */
  loadingOlder?: boolean;
  /** False while the thread is still loading the target conversation's first page. */
  ready?: boolean;
  maxPages?: number;
  highlightMs?: number;
  /** Called when the message is not in the history (or not rendered). */
  onNotFound?: (messageId: string) => void;
}

export interface JumpToMessage {
  jumpTo: (messageId: string) => void;
  cancel: () => void;
  /** The message being searched for, while paging. */
  pendingId: string | null;
  /** The message currently flashed. */
  highlightedId: string | null;
}

export function useJumpToMessage({
  scrollRef,
  messages,
  hasOlder,
  loadOlder,
  loadingOlder = false,
  ready = true,
  maxPages = DEFAULT_JUMP_MAX_PAGES,
  highlightMs = DEFAULT_HIGHLIGHT_MS,
  onNotFound,
}: UseJumpToMessageOptions): JumpToMessage {
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  // Bumped when a page load settles, so a failed load (no new messages) re-runs the loop.
  const [tick, setTick] = useState(0);
  const pagesRef = useRef(0);
  const inFlightRef = useRef(false);
  const loadOlderRef = useRef(loadOlder);
  const onNotFoundRef = useRef(onNotFound);
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    loadOlderRef.current = loadOlder;
    onNotFoundRef.current = onNotFound;
  });

  const jumpTo = useCallback((messageId: string) => {
    pagesRef.current = 0;
    inFlightRef.current = false;
    setPendingId(messageId);
  }, []);
  const cancel = useCallback(() => setPendingId(null), []);

  useEffect(() => {
    if (!pendingId) return;
    const step = nextJumpStep({
      found: messages.some((m) => m.id === pendingId),
      ready,
      loading: loadingOlder || inFlightRef.current,
      hasOlder,
      pagesLoaded: pagesRef.current,
      maxPages,
    });
    if (step === 'wait') return;

    if (step === 'load') {
      inFlightRef.current = true;
      pagesRef.current += 1;
      Promise.resolve()
        .then(() => loadOlderRef.current())
        .catch(() => undefined)
        .finally(() => {
          inFlightRef.current = false;
          setTick((n) => n + 1);
        });
      return;
    }

    // 'scroll' or 'give_up'. For a scroll, wait one frame for layout (and the
    // thread's own prepend scroll restoration) before scrolling to it.
    const target = pendingId;
    const frame = requestAnimationFrame(() => {
      setPendingId(null);
      const el = step === 'scroll'
        ? scrollRef.current?.querySelector<HTMLElement>(messageElementSelector(target))
        : null;
      if (!el) {
        onNotFoundRef.current?.(target);
        return;
      }
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.classList.add(...HIGHLIGHT_CLASSES);
      setHighlightedId(target);
      if (highlightTimer.current) clearTimeout(highlightTimer.current);
      highlightTimer.current = setTimeout(() => {
        el.classList.remove(...HIGHLIGHT_CLASSES);
        setHighlightedId((current) => (current === target ? null : current));
      }, highlightMs);
    });
    return () => cancelAnimationFrame(frame);
  }, [pendingId, messages, ready, loadingOlder, hasOlder, maxPages, highlightMs, scrollRef, tick]);

  useEffect(() => () => {
    if (highlightTimer.current) clearTimeout(highlightTimer.current);
  }, []);

  return { jumpTo, cancel, pendingId, highlightedId };
}
