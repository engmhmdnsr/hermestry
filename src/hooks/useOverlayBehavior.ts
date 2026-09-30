import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { isTopOverlay, registerOverlay } from '../services/overlayStack';

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.offsetParent !== null || el === document.activeElement,
  );
}

export type OverlayBehaviorOptions = {
  /** Close on Escape. Default true. */
  escape?: boolean;
  /** Register with the overlay stack so the Android back button closes it. Default true. */
  backButton?: boolean;
  /** Trap Tab focus inside the container while open. Default true. */
  trapFocus?: boolean;
};

/**
 * Standard behavior for a modal, drawer, sheet or dialog:
 * Escape closes it, the Android back button closes it (via the overlay stack),
 * Tab focus stays inside it, and focus returns to the previously focused
 * element when it closes.
 *
 * Usage: const ref = useOverlayBehavior(open, onClose); ... <div ref={ref}>
 */
export function useOverlayBehavior(
  open: boolean,
  onClose: () => void,
  containerRef?: RefObject<HTMLElement | null>,
  options: OverlayBehaviorOptions = {},
): RefObject<HTMLDivElement | null> {
  const { escape = true, backButton = true, trapFocus = true } = options;
  const localRef = useRef<HTMLDivElement | null>(null);
  const ref = (containerRef as RefObject<HTMLDivElement | null>) ?? localRef;
  const restoreRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;
    const handler = () => closeRef.current();
    const unregister = backButton ? registerOverlay(handler) : () => {};

    const onKeyDown = (event: KeyboardEvent) => {
      if (escape && event.key === 'Escape') {
        // Every open overlay listens on document, and stopPropagation does not
        // suppress a sibling listener on the same node, so a stacked pair used
        // to close on one keypress: only the top-most one reacts now.
        if (backButton && !isTopOverlay(handler)) return;
        event.stopPropagation();
        closeRef.current();
        return;
      }
      if (!trapFocus || event.key !== 'Tab') return;
      const root = ref.current;
      if (!root) return;
      const items = focusableIn(root);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (event.shiftKey) {
        if (!active || active === first || !root.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);

    // Move focus into the overlay on the next frame so the mount animation and
    // any lazy content settle first.
    const timer = window.setTimeout(() => {
      const root = ref.current;
      if (!root) return;
      if (root.contains(document.activeElement)) return;
      const items = focusableIn(root);
      (items[0] ?? root).focus?.();
    }, 30);

    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      window.clearTimeout(timer);
      unregister();
      const restore = restoreRef.current;
      if (restore && document.contains(restore) && typeof restore.focus === 'function') {
        restore.focus();
      }
    };
  }, [open, escape, backButton, trapFocus, ref]);

  return ref;
}
