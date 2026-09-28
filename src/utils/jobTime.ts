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
// expose only ok flags) into an honest error. The gateway provides no
// detail, so the field is 'request' and the message says so , never
// attribute the failure to a specific field we did not verify.
export const rejectionErrors = (
  scope: 'create' | 'update' | 'action',
  detail?: string,
): ServerFieldError[] => {
  const suffix = detail ? ` ${detail}` : '';
  if (scope === 'create') {
    return [
      {
        field: 'request',
        code: 'GATEWAY_REJECTED',
        message: `The gateway did not accept the request, and no detail was provided. Nothing was created.${suffix}`,
      },
    ];
  }
  if (scope === 'update') {
    return [
      {
        field: 'request',
        code: 'GATEWAY_REJECTED',
        message: `The gateway did not accept the update, and no detail was provided. Nothing was changed.${suffix}`,
      },
    ];
  }
  return [
    {
      field: 'request',
      code: 'GATEWAY_ACTION_FAILED',
      message: `The gateway did not accept the action, and no detail was provided. Rolled back to the last known state.${suffix}`,
    },
  ];
};

// UTC offset label for a zone at a given moment, e.g. "UTC+03:00".
// Computed from Intl for `at` (default now) so DST is honored.
export const timezoneOffsetLabel = (
  tz: string,
  at?: number | string | Date,
): string => {
  const zone = safeTimeZone(tz);
  const d = at === undefined ? new Date() : new Date(at);
  if (Number.isNaN(d.getTime())) return '';
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const parts: Record<string, string> = {};
    for (const p of dtf.formatToParts(d)) parts[p.type] = p.value;
    const asUTC = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second),
    );
    let mins = Math.round((asUTC - d.getTime()) / 60000);
    if (mins > 720) mins -= 1440;
    if (mins < -720) mins += 1440;
    const sign = mins < 0 ? '-' : '+';
    const abs = Math.abs(mins);
    const hh = String(Math.floor(abs / 60)).padStart(2, '0');
    const mm = String(abs % 60).padStart(2, '0');
    return `UTC${sign}${hh}:${mm}`;
  } catch {
    return '';
  }
};

// Timezone <option> label with its current offset, e.g. "(UTC+03:00) Asia/Riyadh".
export const formatTimezoneOption = (tz: string): string => {
  const off = timezoneOffsetLabel(tz);
  return off ? `(${off}) ${tz}` : tz;
};

// Local, UX-only reading of a schedule string. Returns null when the shape
// is unrecognized , the gateway is authoritative and decides what runs.
// Covers the built-in presets, plain-language cadences, and 5-field cron.
export const scheduleSummary = (schedule: string): string | null => {
  const v = schedule.trim().toLowerCase();
  if (!v) return null;
  if (v === 'once')
    return 'Runs a single time shortly after creation, then stops. No repeating schedule.';
  let m = v.match(/^every\s+(\d+)\s*(m|min|mins|minute|minutes)$/);
  if (m) {
    const n = Number(m[1]);
    return n === 1 ? 'Every minute.' : `Every ${n} minutes.`;
  }
  m = v.match(/^every\s+(\d+)\s*(h|hr|hrs|hour|hours)$/);
  if (m) {
    const n = Number(m[1]);
    return n === 1 ? 'Every hour.' : `Every ${n} hours.`;
  }
  m = v.match(/^every\s+(\d+)\s*(d|day|days)$/);
  if (m) {
    const n = Number(m[1]);
    return n === 1 ? 'Every day.' : `Every ${n} days.`;
  }
  m = v.match(/^every\s+day\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (m) {
    let h = Number(m[1]);
    const min = m[2] ?? '00';
    const ap = m[3];
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    return `Daily at ${String(h).padStart(2, '0')}:${min}.`;
  }
  m = v.match(/^every\s+weekday\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (m) {
    let h = Number(m[1]);
    const min = m[2] ?? '00';
    const ap = m[3];
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    return `Weekdays (Mon-Fri) at ${String(h).padStart(2, '0')}:${min}.`;
  }
  const fields = v.split(/\s+/);
  if (fields.length === 5) {
    const [minF, hourF, domF, monF, dowF] = fields;
    const plain = (s: string): number | null =>
      /^\d+$/.test(s) ? Number(s) : null;
    const min = plain(minF);
    const hour = plain(hourF);
    if (min !== null && hour !== null && domF === '*' && monF === '*') {
      const clock = `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
      if (dowF === '*') return `Daily at ${clock}.`;
      if (dowF === '1-5' || dowF === 'mon-fri') return `Weekdays (Mon-Fri) at ${clock}.`;
      return `At ${clock} on days "${dowF}".`;
    }
    const stepMin = minF.match(/^\*\/(\d+)$/);
    if (stepMin && hourF === '*' && domF === '*' && monF === '*' && dowF === '*') {
      const n = Number(stepMin[1]);
      return n === 1 ? 'Every minute.' : `Every ${n} minutes.`;
    }
    if (minF === '0' && hourF === '*' && domF === '*' && monF === '*' && dowF === '*')
      return 'Every hour.';
    return 'Cron expression. The gateway decides the exact cadence.';
  }
  return null;
};
