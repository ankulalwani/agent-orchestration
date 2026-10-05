import { AppError } from './errors.js';

/**
 * Five-field cron expressions (minute hour day-of-month month day-of-week) for scheduled tasks, evaluated
 * in an IANA time zone. Supports `*`, lists (`1,15`), ranges (`1-5`), steps (a `/15` after `*` or after a
 * range such as `8-18/2`), month and weekday names, `7` for Sunday, and `@hourly`, `@daily`, `@weekly`, `@monthly`.
 * As in cron, when both day fields are restricted a day matches if either one does.
 */
export interface CronExpression {
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  daysOfMonth: ReadonlySet<number>;
  months: ReadonlySet<number>;
  daysOfWeek: ReadonlySet<number>;
  anyDayOfMonth: boolean;
  anyDayOfWeek: boolean;
}

const MACROS: Record<string, string> = { '@hourly': '0 * * * *', '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@weekly': '0 0 * * 0', '@monthly': '0 0 1 * *' };
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

const invalid = (message: string) => new AppError('VALIDATION_FAILED', message);

function parseField(field: string, label: string, min: number, max: number, names?: string[]): Set<number> {
  const out = new Set<number>();
  const value = (raw: string) => {
    const named = names?.indexOf(raw.toLowerCase()) ?? -1;
    const n = named >= 0 ? named + (names === MONTHS ? 1 : 0) : /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (Number.isNaN(n) || n < min || n > max) throw invalid(`Schedule: "${raw}" is not a valid ${label} (${min}-${max})`);
    return n;
  };
  for (const part of field.split(',')) {
    const [range, stepRaw, extra] = part.split('/');
    if (!range || extra !== undefined) throw invalid(`Schedule: "${part}" is not a valid ${label}`);
    const step = stepRaw === undefined ? 1 : /^\d+$/.test(stepRaw) ? Number(stepRaw) : NaN;
    if (Number.isNaN(step) || step < 1) throw invalid(`Schedule: "${part}" has an invalid step`);
    let from: number;
    let to: number;
    if (range === '*') [from, to] = [min, max];
    else if (range.includes('-')) {
      const [a, b, c] = range.split('-');
      if (!a || !b || c !== undefined) throw invalid(`Schedule: "${range}" is not a valid ${label} range`);
      [from, to] = [value(a), value(b)];
      if (from > to) throw invalid(`Schedule: the range "${range}" runs backwards`);
    } else {
      from = value(range);
      // "5/15" means "from 5, every 15".
      to = stepRaw === undefined ? from : max;
    }
    for (let n = from; n <= to; n += step) out.add(n);
  }
  return out;
}

export function parseCron(expression: string): CronExpression {
  const text = expression.trim().toLowerCase();
  const fields = (MACROS[text] ?? text).split(/\s+/);
  if (fields.length !== 5) throw invalid('Schedule: use five fields (minute hour day-of-month month day-of-week), for example "0 2 * * 1-5"');
  const [minute, hour, dom, month, dow] = fields as [string, string, string, string, string];
  const daysOfWeek = parseField(dow, 'day of the week', 0, 7, DAYS);
  if (daysOfWeek.delete(7)) daysOfWeek.add(0);
  return {
    minutes: parseField(minute, 'minute', 0, 59),
    hours: parseField(hour, 'hour', 0, 23),
    daysOfMonth: parseField(dom, 'day of the month', 1, 31),
    months: parseField(month, 'month', 1, 12, MONTHS),
    daysOfWeek,
    anyDayOfMonth: dom.startsWith('*'),
    anyDayOfWeek: dow.startsWith('*'),
  };
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string) {
  let f = formatters.get(timeZone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
    } catch {
      throw invalid(`Schedule: "${timeZone}" is not a known time zone (use a name like "Europe/Berlin")`);
    }
    formatters.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** The wall-clock time of an instant in a time zone, as milliseconds of a UTC date with the same fields. */
function wallClock(instant: number, timeZone: string): number {
  const p: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(instant))) if (part.type !== 'literal') p[part.type] = Number(part.value);
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!);
}

/** The instant at which a time zone shows this wall-clock time. */
function fromWallClock(wall: number, timeZone: string): number {
  const first = wall - (wallClock(wall, timeZone) - wall);
  return wall - (wallClock(first, timeZone) - first);
}

const MINUTE = 60_000;

/** The first run strictly after `after`. Throws when the expression never matches (for example 30 February). */
export function nextCronRun(expression: string | CronExpression, after: Date, timeZone = 'UTC'): Date {
  const c = typeof expression === 'string' ? parseCron(expression) : expression;
  const dayMatches = (d: Date) => {
    const dom = c.daysOfMonth.has(d.getUTCDate());
    const dow = c.daysOfWeek.has(d.getUTCDay());
    if (c.anyDayOfMonth) return dow;
    if (c.anyDayOfWeek) return dom;
    return dom || dow;
  };
  // Search in wall-clock time, a whole field at a time.
  let wall = Math.floor(wallClock(after.getTime(), timeZone) / MINUTE) * MINUTE + MINUTE;
  for (let guard = 0; guard < 200_000; guard++) {
    const d = new Date(wall);
    if (!c.months.has(d.getUTCMonth() + 1)) wall = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    else if (!dayMatches(d)) wall = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
    else if (!c.hours.has(d.getUTCHours())) wall = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours() + 1);
    else if (!c.minutes.has(d.getUTCMinutes())) wall += MINUTE;
    else {
      const instant = fromWallClock(wall, timeZone);
      // A wall-clock time skipped or repeated by a daylight-saving change can land on or before `after`.
      if (instant > after.getTime()) return new Date(instant);
      wall += MINUTE;
    }
    if (wall - after.getTime() > 8 * 366 * 86_400_000) break;
  }
  throw invalid('Schedule: this expression never runs');
}
