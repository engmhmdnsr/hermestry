import React from 'react';
import { TriangleAlert } from 'lucide-react';

/**
 * ErrorBoundary: the single recovery surface for the tab content area.
 *
 * Why it exists: the tabs are code-split (Jobs/Settings) and each one renders a
 * live gateway view. Before this boundary, one rejected dynamic import or one
 * render throw inside a tab unmounted the whole shell and left a white screen
 * with no route back. Now a failure is contained to the content area: Header,
 * BottomNav, the drawer and the back-button override all keep working.
 *
 * Behavior:
 *   - getDerivedStateFromError switches the subtree for a calm, honest panel.
 *   - componentDidCatch logs the real error to the console (never swallowed),
 *     and never prints it anywhere else in the UI except the disclosure below.
 *   - Retry clears the error and bumps a key, so the failed subtree is fully
 *     remounted rather than re-rendered in its half-broken state.
 *   - Go home clears the error and selects tab 0.
 *
 * The panel is scrim-free and token-based (.edge + .elev-0, --app-* tokens) so
 * it reads as part of the page rather than as an overlay, and both controls are
 * 44px tall for touch. Retry takes focus as soon as the panel mounts, so a
 * keyboard or switch user lands directly on the recovery action.
 */

export interface ErrorBoundaryLabels {
  /** Panel title, e.g. "This screen did not load". */
  title?: string;
  /** One sentence: what happened and that nothing was lost. */
  message?: string;
  /** Summary text for the technical disclosure. */
  details?: string;
  /** Retry control label. */
  retry?: string;
  /** Go home control label. */
  home?: string;
}

export interface ErrorBoundaryProps {
  children: React.ReactNode;
  /** Switch to tab 0. Called after the error state is cleared. */
  onGoHome?: () => void;
  /** Localized copy. English fallbacks are built in. */
  labels?: ErrorBoundaryLabels;
}

interface ErrorBoundaryState {
  error: Error | null;
  /** Bumped on every retry to force a fresh mount of the failed subtree. */
  retryKey: number;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, retryKey: 0 };

  private retryRef = React.createRef<HTMLButtonElement>();

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // The only place the raw error goes. Not swallowed, not shown twice.
    console.error('[Hermes] Screen failed to load:', error, info?.componentStack);
  }

  componentDidMount(): void {
    // An error thrown during the very first render of the children never
    // reaches componentDidUpdate, so land focus on Retry here as well.
    if (this.state.error) {
      this.retryRef.current?.focus();
    }
  }

  componentDidUpdate(_prevProps: ErrorBoundaryProps, prevState: ErrorBoundaryState): void {
    // Move focus onto Retry exactly once per failure, not on every render.
    if (!prevState.error && this.state.error) {
      this.retryRef.current?.focus();
    }
  }

  private handleRetry = (): void => {
    this.setState((prev) => ({ error: null, retryKey: prev.retryKey + 1 }));
  };

  private handleGoHome = (): void => {
    this.setState(
      (prev) => ({ error: null, retryKey: prev.retryKey + 1 }),
      () => this.props.onGoHome?.()
    );
  };

  render(): React.ReactNode {
    const { error } = this.state;
    if (!error) {
      // Safe: resetting the key remounts children from scratch after a retry.
      return <React.Fragment key={this.state.retryKey}>{this.props.children}</React.Fragment>;
    }

    const labels = this.props.labels ?? {};
    const title = labels.title ?? 'This screen did not load';
    const message =
      labels.message ??
      'Part of this screen broke while it was loading, so it stopped here. Nothing was lost: your chats and tasks are still there. Retry, or go home.';
    const details = labels.details ?? 'Technical details';
    const retry = labels.retry ?? 'Retry';
    const home = labels.home ?? 'Go home';

    return (
      <div role="alert" className="flex-1 min-h-0 w-full px-4 pt-4 hm-tab-bottom">
        <div className="max-w-2xl mx-auto r-md edge elev-0 bg-[var(--app-card)] p-5 space-y-4">
          <div className="flex items-start gap-3">
            <TriangleAlert
              aria-hidden="true"
              className="w-5 h-5 shrink-0 mt-0.5 text-[var(--app-warning)]"
            />
            <div className="min-w-0 space-y-1">
              <h2 className="t-heading text-[var(--app-text)]">{title}</h2>
              <p className="t-body text-[var(--app-text-muted)]">{message}</p>
            </div>
          </div>

          <details className="r-sm hairline elev-0 bg-[var(--app-card-subtle)]">
            <summary className="cursor-pointer px-3 py-2 t-micro text-[var(--app-text-dim)]">
              {details}
            </summary>
            <p className="px-3 pb-3 t-micro font-mono text-[var(--app-text-muted)] break-words">
              {error.message || String(error)}
            </p>
          </details>

          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              ref={this.retryRef}
              onClick={this.handleRetry}
              className="min-h-[44px] px-4 r-sm elev-0 bg-[var(--app-accent)] hover:bg-[var(--app-accent-hover)] text-[var(--app-bg)] t-label font-semibold cursor-pointer transition"
            >
              {retry}
            </button>
            <button
              type="button"
              onClick={this.handleGoHome}
              className="min-h-[44px] px-4 r-sm edge elev-0 bg-[var(--app-card)] hover:bg-[var(--app-card-hover)] text-[var(--app-text-muted)] t-label font-semibold cursor-pointer transition"
            >
              {home}
            </button>
          </div>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
