import { RollupGranularity } from '../../generated/prisma/client';
import {
  DAY_MS,
  HOUR_MS,
  addBuckets,
  bucketStartsBetween,
  completedBuckets,
  toApiGranularity,
  toRollupGranularity,
  truncateToBucket,
} from './bucket';

describe('rollup buckets', () => {
  it('floors to the start of the UTC hour', () => {
    expect(
      truncateToBucket(
        new Date('2026-11-09T10:34:56.789Z'),
        RollupGranularity.HOUR,
      ).toISOString(),
    ).toBe('2026-11-09T10:00:00.000Z');
  });

  it('floors to the start of the UTC day', () => {
    expect(
      truncateToBucket(
        new Date('2026-11-09T23:59:59.999Z'),
        RollupGranularity.DAY,
      ).toISOString(),
    ).toBe('2026-11-09T00:00:00.000Z');
  });

  it('moves forward and backward by whole buckets', () => {
    const start = new Date('2026-11-09T10:00:00.000Z');

    expect(addBuckets(start, RollupGranularity.HOUR, 2).toISOString()).toBe(
      '2026-11-09T12:00:00.000Z',
    );
    expect(addBuckets(start, RollupGranularity.DAY, -1).toISOString()).toBe(
      '2026-11-08T10:00:00.000Z',
    );
  });

  it('returns only fully closed hourly buckets, oldest first', () => {
    const buckets = completedBuckets(
      new Date('2026-11-09T10:34:00.000Z'),
      RollupGranularity.HOUR,
      2,
    );

    expect(buckets.map((bucket) => bucket.toISOString())).toEqual([
      '2026-11-09T08:00:00.000Z',
      '2026-11-09T09:00:00.000Z',
    ]);
  });

  it('returns only fully closed daily buckets, oldest first', () => {
    const buckets = completedBuckets(
      new Date('2026-11-09T00:10:00.000Z'),
      RollupGranularity.DAY,
      2,
    );

    expect(buckets.map((bucket) => bucket.toISOString())).toEqual([
      '2026-11-07T00:00:00.000Z',
      '2026-11-08T00:00:00.000Z',
    ]);
  });

  it('rejects an invalid bucket count', () => {
    const now = new Date();

    expect(() => completedBuckets(now, RollupGranularity.HOUR, -1)).toThrow(
      'non-negative integer',
    );
    expect(() => completedBuckets(now, RollupGranularity.HOUR, 1.5)).toThrow(
      'non-negative integer',
    );
  });

  it('enumerates every bucket touching an inclusive range', () => {
    const buckets = bucketStartsBetween(
      new Date('2026-11-09T08:15:00.000Z'),
      new Date('2026-11-09T10:05:00.000Z'),
      RollupGranularity.HOUR,
    );

    expect(buckets.map((bucket) => bucket.toISOString())).toEqual([
      '2026-11-09T08:00:00.000Z',
      '2026-11-09T09:00:00.000Z',
      '2026-11-09T10:00:00.000Z',
    ]);
  });

  it('rejects a reversed range', () => {
    expect(() =>
      bucketStartsBetween(
        new Date('2026-11-09T10:00:00.000Z'),
        new Date('2026-11-09T09:00:00.000Z'),
        RollupGranularity.HOUR,
      ),
    ).toThrow('before');
  });

  it('maps API names to enum values and back', () => {
    expect(toRollupGranularity('hour')).toBe(RollupGranularity.HOUR);
    expect(toRollupGranularity('day')).toBe(RollupGranularity.DAY);
    expect(toApiGranularity(RollupGranularity.HOUR)).toBe('hour');
    expect(toApiGranularity(RollupGranularity.DAY)).toBe('day');
  });

  it('uses fixed UTC bucket sizes', () => {
    expect(HOUR_MS).toBe(3_600_000);
    expect(DAY_MS).toBe(86_400_000);
  });
});
