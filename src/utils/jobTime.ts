// Timezone-aware formatting helpers for the Jobs tab.
// All formatting goes through Intl with an explicit timeZone so DST is
// handled by the platform. No manual offset math lives here.
export interface ServerFieldError {
  field: string;
  code: string;
  message: string;
}

export const COMMON_TIMEZONES: string[] = [
  'UTC',
  'Asia/Riyadh',
  'Asia/Dubai',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Paris',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'Asia/Karachi',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Australia/Sydney',
];

export const resolveDeviceTimezone = (): string => {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz) return tz;
  } catch {
    // fall through to UTC
  }
  return 'UTC';
};

export const isValidTimeZone = (tz: string): boolean => {
  if (!tz) return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

const parseDate = (value: number | string | Date): Date | null => {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d;
};

const safeTimeZone = (tz: string): string =>
  isValidTimeZone(tz) ? tz : 'UTC';

// Short HH:mm clock time in the given zone, 24h to stay locale neutral.
export const formatClockTime = (
  value: number | string | Date,
  timeZone: string,
): string => {
  const d = parseDate(value);
  if (!d) return '';
  const tz = safeTimeZone(timeZone);
  try {
    return new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: tz,
    }).format(d);
  } catch {
    return '';
  }
};

// JOB-01: every job shows its zone, e.g. "09:00 Asia/Riyadh".
export const formatTimeWithZone = (
  value: number | string | Date,
  timeZone: string,
): string => {
  const clock = formatClockTime(value, timeZone);
  if (!clock) return '';
  return `${clock} ${safeTimeZone(timeZone)}`;
};

export const formatDateTimeInTimezone = (
  value: number | string | Date,
  timeZone: string,
  lang = 'en',
): string => {
  const d = parseDate(value);
  if (!d) return '';
  try {
    return d.toLocaleString(lang, { timeZone: safeTimeZone(timeZone) });
  } catch {
    return d.toLocaleString(lang);
  }
};

const dayKeyInZone = (d: Date, timeZone: string): string => {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      timeZone: safeTimeZone(timeZone),
    }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
};

// JOB-03: relative history labels with zone, e.g.
// "Today, 09:00 Asia/Riyadh" or "28 Sep 2026, 09:00 Asia/Riyadh".
export const formatRunTimestamp = (
  value: number | string | Date,
  timeZone: string,
): string => {
  const d = parseDate(value);
  if (!d) return '';
  const tz = safeTimeZone(timeZone);
  const clock = formatClockTime(d, tz);
  const now = new Date();
  const dayMs = 24 * 60 * 60 * 1000;
  const dayOf = (key: string): number => {
    const [y, m, day] = key.split('-').map(Number);
    return Date.UTC(y, m - 1, day);
  };
  const diffDays = Math.round(
    (dayOf(dayKeyInZone(now, tz)) - dayOf(dayKeyInZone(d, tz))) / dayMs,
  );
  if (diffDays <= 0) return `Today, ${clock} ${tz}`;
  if (diffDays === 1) return `Yesterday, ${clock} ${tz}`;
  let day: string;
  try {
    day = new Intl.DateTimeFormat('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: tz,
    }).format(d);
  } catch {
    day = d.toLocaleDateString('en-GB');
  }
  return `${day}, ${clock} ${tz}`;
};

// Client-side cron hint. UX only, never blocks submit. The gateway
// is authoritative and its rejection maps to structured field errors.
export const cronHint = (
  schedule: string,
  presetVals: string[],
): string | null => {
  const v = schedule.trim();
  if (!v) return null;
  if (presetVals.includes(v)) return null;
  if (/^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/.test(v)) return null;
  return 'Unrecognized format. Presets and 5-field cron (e.g. 0 9 * * *) usually work, but the gateway decides.';
};

// JOB-02: map a boolean gateway rejection (the context/gateway layers
// expose only ok flags) into structured per-field errors for rendering.
export const rejectionErrors = (
  scope: 'create' | 'update' | 'action',
  detail?: string,
): ServerFieldError[] => {
  const suffix = detail ? ` ${detail}` : '';
  if (scope === 'create') {
    return [
      {
        field: 'schedule',
        code: 'GATEWAY_REJECTED',
        message: `Gateway rejected the job. It was not created. Check the schedule and retry.${suffix}`,
      },
    ];
  }
  if (scope === 'update') {
    return [
      {
        field: 'schedule',
        code: 'GATEWAY_REJECTED',
        message: `Gateway rejected the update. The job was not changed.${suffix}`,
      },
    ];
  }
  return [
    {
      field: 'job',
      code: 'GATEWAY_ACTION_FAILED',
      message: `Gateway rejected the action. Rolled back to the last known state.${suffix}`,
    },
  ];
};
