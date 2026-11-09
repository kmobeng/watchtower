import { RollupGranularity } from '../../generated/prisma/client';
import { parseArgs } from './rollup-backfill';

describe('rollup backfill arguments', () => {
  const now = new Date('2026-11-09T10:34:00.000Z');

  it('defaults to hourly buckets and stops at the last completed hour', () => {
    const args = parseArgs([], now);

    expect(args.granularity).toBe(RollupGranularity.HOUR);
    expect(args.from.toISOString()).toBe('2026-11-02T10:34:00.000Z');
    expect(args.to.toISOString()).toBe('2026-11-09T09:00:00.000Z');
  });

  it('defaults to ninety days for daily buckets', () => {
    const args = parseArgs(['--granularity', 'day'], now);

    expect(args.granularity).toBe(RollupGranularity.DAY);
    expect(args.from.toISOString()).toBe('2026-08-11T10:34:00.000Z');
    expect(args.to.toISOString()).toBe('2026-11-08T00:00:00.000Z');
  });

  it('accepts an explicit range and inline values', () => {
    const args = parseArgs(
      [
        '--granularity=day',
        '--from',
        '2026-01-01T00:00:00.000Z',
        '--to=2026-02-01T00:00:00.000Z',
      ],
      now,
    );

    expect(args.granularity).toBe(RollupGranularity.DAY);
    expect(args.from.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(args.to.toISOString()).toBe('2026-02-01T00:00:00.000Z');
  });

  it('rejects unknown options, missing values and bad granularity', () => {
    expect(() => parseArgs(['--bogus', 'x'], now)).toThrow('Unknown option');
    expect(() => parseArgs(['--from'], now)).toThrow('Missing value');
    expect(() => parseArgs(['--granularity', 'week'], now)).toThrow(
      '--granularity',
    );
  });

  it('rejects invalid or reversed timestamps', () => {
    expect(() => parseArgs(['--from', 'not-a-date'], now)).toThrow(
      'valid ISO timestamps',
    );
    expect(() =>
      parseArgs(
        [
          '--from',
          '2026-02-01T00:00:00.000Z',
          '--to',
          '2026-01-01T00:00:00.000Z',
        ],
        now,
      ),
    ).toThrow('--from must be before --to');
  });
});
