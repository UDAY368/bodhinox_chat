'use client';

import { useEffect, type RefObject } from 'react';

type Node = {
  parentElement: Node | null;
  children: ArrayLike<Node>;
  nodeType?: number;
  tagName?: string;
  hasAttribute(name: string): boolean;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
};

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'LINK', 'META']);

/**
 * Marks every element outside `node`'s ancestor chain (up to `stop`, normally document.body)
 * `inert`, so the page behind a full-screen overlay leaves the focus order and the
 * accessibility tree. Elements already inert, and the toaster, are left alone. Returns undo.
 */
export function isolateOutside(node: Node, stop: Node): () => void {
  const made: Node[] = [];
  for (let el = node; el.parentElement && el !== stop; el = el.parentElement) {
    for (const sibling of Array.from(el.parentElement.children)) {
      if (sibling === el || (sibling.nodeType !== undefined && sibling.nodeType !== 1)) continue;
      if (SKIP_TAGS.has(sibling.tagName ?? '') || sibling.hasAttribute('inert')) continue;
      // Toasts raised from inside the overlay must stay readable.
      if (sibling.hasAttribute('data-sonner-toaster')) continue;
      sibling.setAttribute('inert', '');
      made.push(sibling);
    }
  }
  return () => made.forEach((el) => el.removeAttribute('inert'));
}

/** isolateOutside for a mounted full-screen overlay; menus portalled later are not affected. */
export function useIsolateOverlay(ref: RefObject<HTMLElement | null>, active = true) {
  useEffect(() => {
    const node = ref.current;
    if (!active || !node) return;
    return isolateOutside(node as unknown as Node, document.body as unknown as Node);
  }, [ref, active]);
}
