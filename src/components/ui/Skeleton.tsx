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
  /** Short, translated accessible label. Omit to render aria-hidden. */
  label?: string;
};

/**
 * Suspense fallback for lazy tabs (Jobs/Settings): a hero block plus text
 * rows that roughly match tab content shape, replacing the bare spinner.
 *
 * `label` is read out by a screen reader, so it must be short, specific and
 * already translated by the caller (for example "Loading your chats", not a
 * bare "Loading"). Omit it and the fallback stays aria-hidden.
 */
export const TabPaneSkeleton: FC<TabPaneSkeletonProps> = ({
  className = '',
  rows = 5,
  label,
}) => (
  <div
    {...(label ? { role: 'status', 'aria-label': label } : { 'aria-hidden': true })}
    className={`hm-tab-skeleton ${className}`.trim()}
  >
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

/* ---------------------------------------------------------------------------
   Geometry-matched primitives for tab owners.

   Each primitive reuses .hm-skeleton (theme-aware shimmer, RTL sheen,
   reduced-motion safe) and mirrors the height/padding/radius of the real
   content it stands in for, so the swap does not shift layout. Radii come from
   the shared .r-* scale and surfaces from .edge, so a skeleton matches the
   real component geometry in both themes.

   Import them from './components/ui/Skeleton' (or the tab's relative path):

     import {
       TabHeroSkeleton, ListRowSkeleton, CardSkeleton, ChatBubbleSkeleton,
     } from '../ui/Skeleton';

   All four accept `className` and `label`. Pass a short, translated `label`
   that names the content being waited on ("Loading your chats", "Loading your
   scheduled tasks") so the role="status" announcement is specific and
   localized; omit it to stay aria-hidden.
   --------------------------------------------------------------------------- */

export interface TabHeroSkeletonProps {
  className?: string;
  /** Accessible label; omit to render aria-hidden. */
  label?: string;
  /** Hero height in rem to match the real hero (Home ~8, Jobs ~6, Settings ~7). */
  heightRem?: number;
}

/** Single hero/header block matching a tab's top card or greeting block. */
export const TabHeroSkeleton: FC<TabHeroSkeletonProps> = ({
  className = '',
  label,
  heightRem = 8,
}) => (
  <div
    {...(label ? { role: 'status', 'aria-label': label } : { 'aria-hidden': true })}
    className={`hm-skeleton r-md ${className}`.trim()}
    style={{ height: `${heightRem}rem` }}
  />
);

export interface ListRowSkeletonProps {
  className?: string;
  rows?: number;
  /** Leading avatar/thumbnail bubble, as used by session and job lists. */
  thumb?: boolean;
  label?: string;
}

/** Rows matching a session/job list entry: thumb plus two text lines. */
export const ListRowSkeleton: FC<ListRowSkeletonProps> = ({
  className = '',
  rows = 5,
  thumb = true,
  label,
}) => (
  <div
    {...(label ? { role: 'status', 'aria-label': label } : { 'aria-hidden': true })}
    className={`flex flex-col gap-2 ${className}`.trim()}
  >
    {Array.from({ length: rows }).map((_, i) => (
      <div
        key={i}
        className="flex items-center gap-3 r-md edge px-3 py-3"
      >
        {thumb && <div className="hm-skeleton shrink-0" style={{ width: '2.25rem', height: '2.25rem', borderRadius: '9999px' }} />}
        <div className="flex-1 min-w-0 space-y-2">
          <div className="hm-skeleton r-xs" style={{ height: '0.75rem', width: `${78 - (i % 3) * 14}%` }} />
          <div className="hm-skeleton r-xs" style={{ height: '0.625rem', width: `${52 - (i % 2) * 12}%` }} />
        </div>
      </div>
    ))}
  </div>
);

export interface CardSkeletonProps {
  className?: string;
  cards?: number;
  lines?: number;
  label?: string;
}

/** Stacked content cards matching rounded content panels with a title and lines. */
export const CardSkeleton: FC<CardSkeletonProps> = ({
  className = '',
  cards = 3,
  lines = 2,
  label,
}) => (
  <div
    {...(label ? { role: 'status', 'aria-label': label } : { 'aria-hidden': true })}
    className={`flex flex-col gap-3 ${className}`.trim()}
  >
    {Array.from({ length: cards }).map((_, i) => (
      <div key={i} className="r-md edge p-4 space-y-2">
        <div className="hm-skeleton r-xs" style={{ height: '0.8125rem', width: `${60 - (i % 3) * 10}%` }} />
        {Array.from({ length: lines }).map((__, j) => (
          <div key={j} className="hm-skeleton r-xs" style={{ height: '0.625rem', width: `${90 - j * 18}%` }} />
        ))}
      </div>
    ))}
  </div>
);

export interface ChatBubbleSkeletonProps {
  className?: string;
  /** 'end' aligns like a user bubble, 'start' like an assistant bubble. */
  side?: 'start' | 'end';
  lines?: number;
  label?: string;
}

/** A chat bubble matching the transcript bubble width and padding. */
export const ChatBubbleSkeleton: FC<ChatBubbleSkeletonProps> = ({
  className = '',
  side = 'start',
  lines = 3,
  label,
}) => (
  <div
    {...(label ? { role: 'status', 'aria-label': label } : { 'aria-hidden': true })}
    className={`flex ${side === 'end' ? 'justify-end' : 'justify-start'} ${className}`.trim()}
  >
    <div className="max-w-[78%] r-md edge px-4 py-3 space-y-2">
      {Array.from({ length: lines }).map((_, i) => (
        <div
          key={i}
          className="hm-skeleton r-xs"
          style={{ height: '0.625rem', width: i === lines - 1 ? '58%' : `${92 - (i % 3) * 10}%` }}
        />
      ))}
    </div>
  </div>
);
