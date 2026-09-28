import type { CSSProperties, FC } from 'react';

export interface SkeletonProps {
  className?: string;
  style?: CSSProperties;
  width?: string | number;
  height?: string | number;
  /** Render as a circle (avatars, status dots). */
  circle?: boolean;
  /** When set, exposes role="status" with this accessible label. */
  label?: string;
};

/**
 * Theme-aware shimmer placeholder. Track/sheen come from
 * --app-card-subtle / --app-border-subtle so it adapts to every palette and
 * mode; the shimmer halts under prefers-reduced-motion (see index.css).
 */
export const Skeleton: FC<SkeletonProps> = ({
  className = '',
  style,
  width,
  height,
  circle = false,
  label,
}) => {
  const merged: CSSProperties = {
    ...(width !== undefined ? { width } : null),
    ...(height !== undefined ? { height } : null),
    ...(circle ? { borderRadius: '9999px' } : null),
    ...style,
  };
  const cls = `hm-skeleton ${className}`.trim();
  if (label) {
    return <div role="status" aria-label={label} className={cls} style={merged} />;
  }
  return <div aria-hidden="true" className={cls} style={merged} />;
};

export interface TabPaneSkeletonProps {
  className?: string;
  rows?: number;
  label?: string;
};

/**
 * Suspense fallback for lazy tabs (Jobs/Settings): a hero block plus text
 * rows that roughly match tab content shape, replacing the bare spinner.
 */
export const TabPaneSkeleton: FC<TabPaneSkeletonProps> = ({
  className = '',
  rows = 5,
  label = 'Loading tab',
}) => (
  <div role="status" aria-label={label} className={`hm-tab-skeleton ${className}`.trim()}>
    <div className="hm-skeleton hm-tab-skeleton-hero" aria-hidden="true" />
    {Array.from({ length: rows }).map((_, i) => (
      <div
        key={i}
        className="hm-skeleton hm-tab-skeleton-row"
        aria-hidden="true"
        style={{ width: `${92 - (i % 3) * 12}%` }}
      />
    ))}
  </div>
);
