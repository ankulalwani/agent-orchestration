import { describe, expect, it } from 'vitest';
import { isValidTimeZone, nextCronRun, parseCron } from './cron.js';

const next = (expr: string, after: string, tz?: string) => nextCronRun(expr, new Date(after), tz).toISOString();

describe('cron expressions', () => {
  it('parses lists, ranges, steps, names and macros', () => {
    const c = parseCron('*/15 8-18/5 1,15 jan-mar mon-fri');
    expect([...c.minutes]).toEqual([0, 15, 30, 45]);
    expect([...c.hours]).toEqual([8, 13, 18]);
    expect([...c.daysOfMonth]).toEqual([1, 15]);
    expect([...c.months]).toEqual([1, 2, 3]);
    expect([...c.daysOfWeek]).toEqual([1, 2, 3, 4, 5]);
    expect([...parseCron('0 0 * * 7').daysOfWeek]).toEqual([0]);
    expect([...parseCron('5/20 * * * *').minutes]).toEqual([5, 25, 45]);
    expect(parseCron('@daily')).toEqual(parseCron('0 0 * * *'));
  });

  it('rejects what it cannot run', () => {
    for (const bad of ['', '* * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', '* * * * 8', '5-1 * * * *', '*/0 * * * *', '1//2 * * * *', 'a * * * *', '* * * * * *']) {
      expect(() => parseCron(bad), bad).toThrow(/Schedule/);
    }
    expect(() => nextCronRun('0 0 30 2 *', new Date('2026-01-01T00:00:00Z'))).toThrow(/never runs/);
    expect(() => nextCronRun('0 0 * * *', new Date(), 'Mars/Olympus')).toThrow(/time zone/);
    expect(isValidTimeZone('Asia/Kolkata')).toBe(true);
    expect(isValidTimeZone('Nowhere')).toBe(false);
  });

  it('finds the next run strictly after a time', () => {
    expect(next('*/15 * * * *', '2026-10-05T10:07:30Z')).toBe('2026-10-05T10:15:00.000Z');
    expect(next('*/15 * * * *', '2026-10-05T10:15:00Z')).toBe('2026-10-05T10:30:00.000Z');
    expect(next('0 2 * * *', '2026-10-05T02:00:00Z')).toBe('2026-10-06T02:00:00.000Z');
    expect(next('30 9 1 * *', '2026-12-31T23:59:00Z')).toBe('2027-01-01T09:30:00.000Z');
    expect(next('0 0 29 2 *', '2026-03-01T00:00:00Z')).toBe('2028-02-29T00:00:00.000Z');
  });

  it('weekdays, and either day field when both are restricted', () => {
    // 2026-10-05 is a Monday.
    expect(next('0 9 * * mon-fri', '2026-10-09T09:00:00Z')).toBe('2026-10-12T09:00:00.000Z');
    expect(next('0 9 * * 0', '2026-10-05T00:00:00Z')).toBe('2026-10-11T09:00:00.000Z');
    expect(next('0 0 13 * fri', '2026-10-05T00:00:00Z')).toBe('2026-10-09T00:00:00.000Z');
    expect(next('0 0 13 * fri', '2026-10-09T00:00:00Z')).toBe('2026-10-13T00:00:00.000Z');
  });

  it('runs in the wall-clock time of a time zone, across daylight-saving changes', () => {
    expect(next('0 2 * * *', '2026-10-05T00:00:00Z', 'Asia/Kolkata')).toBe('2026-10-05T20:30:00.000Z');
    // Berlin: UTC+2 until 25 October 2026, then UTC+1.
    expect(next('0 9 * * *', '2026-10-24T08:00:00Z', 'Europe/Berlin')).toBe('2026-10-25T08:00:00.000Z');
    expect(next('0 9 * * *', '2026-10-23T08:00:00Z', 'Europe/Berlin')).toBe('2026-10-24T07:00:00.000Z');
    // New York springs forward on 8 March 2026: 02:30 does not exist that day. It still runs once, never early.
    const skipped = nextCronRun('30 2 * * *', new Date('2026-03-08T05:00:00Z'), 'America/New_York');
    expect(skipped.getTime()).toBeGreaterThan(new Date('2026-03-08T05:00:00Z').getTime());
    expect(skipped.getTime()).toBeLessThanOrEqual(new Date('2026-03-09T06:30:00Z').getTime());
  });
});
