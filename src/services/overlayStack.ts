/**
 * Overlay stack: lets the Android hardware/gesture back button close the
 * top-most open overlay (modal, drawer, sheet, dialog) before the app exits.
 *
 * Overlays register a close handler while they are open and unregister when
 * they close. App.tsx owns the Capacitor backButton listener and calls
 * closeTopOverlay() first; only when it returns false does the app exit.
 */

export type OverlayCloseHandler = () => void;

type Entry = {
  id: number;
  close: OverlayCloseHandler;
};

let seq = 0;
let stack: Entry[] = [];

/** Register an open overlay. Returns an unregister function. */
export function registerOverlay(close: OverlayCloseHandler): () => void {
  const entry: Entry = { id: ++seq, close };
  stack = stack.filter((e) => e.close !== close).concat(entry);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    stack = stack.filter((e) => e.id !== entry.id);
  };
}

/** Close the most recently opened overlay. Returns false when none is open. */
export function closeTopOverlay(): boolean {
  while (stack.length > 0) {
    const entry = stack[stack.length - 1];
    try {
      // Peek, do not pop: the overlay's own unmount cleanup unregisters its
      // entry. Popping first orphaned overlays whose close handler keeps
      // them mounted (onboarding step-back, skip-arm): the next back press
      // found an empty stack and hard-exited the app mid-onboarding.
      entry.close();
      return true;
    } catch (err) {
      // A broken handler must not trap the back button; drop it, try next.
      stack = stack.filter((e) => e.id !== entry.id);
      // eslint-disable-next-line no-console
      console.warn('[overlayStack] close handler failed', err);
    }
  }
  return false;
}

export function overlayCount(): number {
  return stack.length;
}

/** True when this exact close handler is the most recently opened overlay. */
export function isTopOverlay(close: OverlayCloseHandler): boolean {
  return stack.length > 0 && stack[stack.length - 1].close === close;
}
