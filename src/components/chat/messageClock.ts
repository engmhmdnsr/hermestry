/**
 * Bubble clock: hours, minutes and seconds, 24 hour, zero padded.
 *
 * The reference app stamps every message with a fixed width clock, and a
 * fixed width clock also stops the bubble headers from jittering while a
 * reply streams (see .t-micro tabular-nums on the stamp itself). 24 hour
 * keeps the format identical in every locale we ship.
 */
export const formatMessageClock = (timestamp?: number): string => {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp <= 0) {
    return '';
  }
  const at = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
};
