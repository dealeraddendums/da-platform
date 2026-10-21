// Business days for DA-CRM timers (feed-order stalls, task due dates): Monday–
// Friday in Pacific time, minus the US federal holidays (observed dates — a
// Saturday holiday is observed Friday, a Sunday one Monday). Pure.

const TZ = "America/Los_Angeles";

/** YYYY-MM-DD of `d` in Pacific time. */
export function ptDate(d: Date): string {
  return d.toLocaleDateString("en-CA", { timeZone: TZ });
}

const iso = (y: number, m: number, day: number) => `${y}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
const dow = (y: number, m: number, day: number) => new Date(Date.UTC(y, m - 1, day)).getUTCDay();

/** n-th (1-based) weekday `wd` (0 = Sun) of a month; n = -1 → last. */
function nthWeekday(y: number, m: number, wd: number, n: number): string {
  if (n > 0) {
    const first = dow(y, m, 1);
    return iso(y, m, 1 + ((wd - first + 7) % 7) + (n - 1) * 7);
  }
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return iso(y, m, last - ((dow(y, m, last) - wd + 7) % 7));
}

function observed(y: number, m: number, day: number): string {
  const w = dow(y, m, day);
  const dt = new Date(Date.UTC(y, m - 1, day + (w === 6 ? -1 : w === 0 ? 1 : 0)));
  return dt.toISOString().slice(0, 10);
}

const cache = new Map<number, Set<string>>();

/** Observed US federal holidays for a year. */
export function usHolidays(y: number): Set<string> {
  const hit = cache.get(y);
  if (hit) return hit;
  const s = new Set<string>([
    observed(y, 1, 1),            // New Year's Day
    nthWeekday(y, 1, 1, 3),       // Martin Luther King Jr. Day
    nthWeekday(y, 2, 1, 3),       // Presidents' Day
    nthWeekday(y, 5, 1, -1),      // Memorial Day
    observed(y, 6, 19),           // Juneteenth
    observed(y, 7, 4),            // Independence Day
    nthWeekday(y, 9, 1, 1),       // Labor Day
    nthWeekday(y, 10, 1, 2),      // Columbus Day
    observed(y, 11, 11),          // Veterans Day
    nthWeekday(y, 11, 4, 4),      // Thanksgiving
    observed(y, 12, 25),          // Christmas Day
  ]);
  // Next year's Jan 1 observed on Dec 31 of this year.
  const nextNy = observed(y + 1, 1, 1);
  if (nextNy.startsWith(String(y))) s.add(nextNy);
  cache.set(y, s);
  return s;
}

export function isBusinessDay(dateStr: string): boolean {
  const [y, m, d] = dateStr.split("-").map(Number);
  const w = dow(y, m, d);
  return w !== 0 && w !== 6 && !usHolidays(y).has(dateStr);
}

function addDays(dateStr: string, n: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/**
 * Whole business days elapsed from `from` to `to` (Pacific dates): the
 * business days after `from`'s date up to and including `to`'s date. Same day
 * → 0; Friday → Monday → 1.
 */
export function businessDaysBetween(from: Date | string, to: Date | string): number {
  const a = ptDate(new Date(from)), b = ptDate(new Date(to));
  if (b <= a) return 0;
  let n = 0;
  for (let d = addDays(a, 1); d <= b; d = addDays(d, 1)) if (isBusinessDay(d)) n++;
  return n;
}

/** The next business day after `from` (Pacific), at 17:00 PT, as an ISO timestamp. */
export function nextBusinessDayDue(from: Date = new Date()): string {
  let d = addDays(ptDate(from), 1);
  while (!isBusinessDay(d)) d = addDays(d, 1);
  // 17:00 PT ≈ 00:00 / 01:00 UTC next day; compute via the offset on that date.
  const probe = new Date(`${d}T17:00:00Z`);
  const offsetMin = (new Date(probe.toLocaleString("en-US", { timeZone: "UTC" })).getTime() - new Date(probe.toLocaleString("en-US", { timeZone: TZ })).getTime()) / 60000;
  return new Date(probe.getTime() + offsetMin * 60000).toISOString();
}
