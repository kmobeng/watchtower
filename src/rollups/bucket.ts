import { RollupGranularity } from '../../generated/prisma/client';

/** Public granularity names used by the HTTP API. */
export type UptimeGranularity = 'hour' | 'day';

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;

export function bucketSizeMs(granularity: RollupGranularity): number {
  return granularity === RollupGranularity.DAY ? DAY_MS : HOUR_MS;
}

export function toRollupGranularity(
  granularity: UptimeGranularity,
): RollupGranularity {
  return granularity === 'day' ? RollupGranularity.DAY : RollupGranularity.HOUR;
}

export function toApiGranularity(
  granularity: RollupGranularity,
): UptimeGranularity {
  return granularity === RollupGranularity.DAY ? 'day' : 'hour';
}

/**
 * Floors a timestamp to the start of its UTC bucket. Buckets are UTC so they
 * do not shift with the server's local timezone.
 */
export function truncateToBucket(
  date: Date,
  granularity: RollupGranularity,
): Date {
  const size = bucketSizeMs(granularity);
  return new Date(Math.floor(date.getTime() / size) * size);
}

/** Moves `count` buckets forward (or backward when negative). */
export function addBuckets(
  start: Date,
  granularity: RollupGranularity,
  count: number,
): Date {
  return new Date(start.getTime() + bucketSizeMs(granularity) * count);
}

/**
 * The `count` most recent buckets that are fully closed at `now`, oldest
 * first. The bucket containing `now` is intentionally excluded: it is still
 * receiving checks and is rolled up by a later run.
 */
export function completedBuckets(
  now: Date,
  granularity: RollupGranularity,
  count: number,
): Date[] {
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(
      `Bucket count must be a non-negative integer (got ${count})`,
    );
  }

  const current = truncateToBucket(now, granularity);

  return Array.from({ length: count }, (_, index) =>
    addBuckets(current, granularity, index - count),
  );
}

/**
 * Every bucket start from the bucket containing `from` through the bucket
 * containing `to`, inclusive and oldest first. Used by the backfill CLI.
 */
export function bucketStartsBetween(
  from: Date,
  to: Date,
  granularity: RollupGranularity,
): Date[] {
  if (from.getTime() > to.getTime()) {
    throw new Error('`from` must be before `to`');
  }

  const first = truncateToBucket(from, granularity);
  const last = truncateToBucket(to, granularity);
  const size = bucketSizeMs(granularity);
  const count = Math.floor((last.getTime() - first.getTime()) / size) + 1;

  return Array.from({ length: count }, (_, index) =>
    addBuckets(first, granularity, index),
  );
}

/** Uptime as a percentage with two decimals, null when nothing was checked. */
export function uptimePercentage(
  upCount: number,
  checkCount: number,
): number | null {
  if (checkCount <= 0) return null;
  return Math.round((upCount / checkCount) * 10_000) / 100;
}

/** Average response time with two decimals, null when no check succeeded. */
export function averageResponseTime(
  sumMs: number,
  count: number,
): number | null {
  if (count <= 0) return null;
  return Math.round((sumMs / count) * 100) / 100;
}
