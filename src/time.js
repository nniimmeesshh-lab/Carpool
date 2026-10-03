export const validTz = (tz) => {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return typeof tz === 'string' && tz.length < 64; } catch { return false; }
};

function offsetMs(ts, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ts / 1000) * 1000;
}

// Epoch ms of a wall-clock date/time in an IANA timezone.
export function rideStart(date, time, tz) {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const t = guess - offsetMs(guess, tz);
  return guess - offsetMs(t, tz);
}

export const todayIn = (tz, ts = Date.now()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(ts));
