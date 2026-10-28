/** Human-facing clocks use company settings; epoch/UTC storage and scheduling stay unchanged. */
export function displayTimeZone(value?: string): string {
  if (typeof value !== 'string' || value.length > 100) return 'UTC';
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
  } catch { return 'UTC'; }
}

export function displayTime(at: number | string, zone?: string): string {
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: displayTimeZone(zone), year: 'numeric', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short',
  }).format(date);
}

/** Explicit offset avoids ambiguous local clocks during the autumn DST fold. */
export function offsetTimestamp(at: number, zone?: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: displayTimeZone(zone), hourCycle: 'h23', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at).map(p => [p.type, p.value]));
  const wall = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
  const minutes = Math.round((Date.parse(wall + 'Z') - Math.floor(at / 1000) * 1000) / 60000);
  const absolute = Math.abs(minutes);
  return `${wall}${minutes < 0 ? '-' : '+'}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`;
}

/** Accept the legacy Z format and explicit ISO offsets, never an ambiguous bare local clock. */
export function parseOffsetTimestamp(text: string): number | undefined {
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(Z|([+-])(\d\d):(\d\d))$/.exec(text);
  if (!match || Number(match[4] ?? 0) > 23 || Number(match[5] ?? 0) > 59) return undefined;
  const at = Date.parse(text);
  if (!Number.isFinite(at)) return undefined;
  const offset = (Number(match[4] ?? 0) * 60 + Number(match[5] ?? 0)) * (match[3] === '-' ? -1 : 1);
  if (new Date(at + offset * 60000).toISOString().slice(0, 19) !== match[1]) return undefined;
  return at;
}
