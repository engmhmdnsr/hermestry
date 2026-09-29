import React from 'react';
import { Zap } from 'lucide-react';

/**
 * 24px square brand mark for a reply: the Hermes lightning on the accent
 * subtle token. It sits inline in the label row instead of in an avatar
 * column, so a reply stays full width on a 360dp phone.
 */
export const BrandMark: React.FC = () => (
  <span
    aria-hidden="true"
    className="w-6 h-6 r-xs shrink-0 flex items-center justify-center bg-[var(--app-accent-subtle)] border border-[var(--app-accent-border)]"
  >
    <Zap className="w-3.5 h-3.5 text-[var(--app-accent-text)]" />
  </span>
);
