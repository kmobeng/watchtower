import 'reflect-metadata';
import {
  DEFAULT_CHECK_REGION,
  checkQueueName,
  loadApiFleetConfig,
  loadWorkerFleetConfig,
  parseRegionList,
  resolveQuorum,
} from './check-regions';

describe('parseRegionList', () => {
  it('splits, trims, drops blanks and dedupes', () => {
    expect(parseRegionList(' eu-west-1, us-east-1 ,, eu-west-1 ')).toEqual([
      'eu-west-1',
      'us-east-1',
    ]);
  });

  it('returns an empty list for unset or blank values', () => {
    expect(parseRegionList(undefined)).toEqual([]);
    expect(parseRegionList('   ')).toEqual([]);
  });
});

describe('resolveQuorum', () => {
  it.each([
    [1, 1],
    [2, 2],
    [3, 2],
    [4, 3],
    [5, 3],
  ])('uses a strict majority for %i regions -> %i', (regions, expected) => {
    expect(resolveQuorum(undefined, regions)).toBe(expected);
  });

  it('honours a valid override', () => {
    expect(resolveQuorum('1', 3)).toBe(1);
    expect(resolveQuorum('3', 3)).toBe(3);
  });

  it.each(['0', '4', '2.5', 'abc', '-1'])(
    'rejects an out-of-range override %p',
    (value) => {
      expect(() => resolveQuorum(value, 3)).toThrow(/CHECK_QUORUM/);
    },
  );

  it('treats a blank override as unset', () => {
    expect(resolveQuorum('', 3)).toBe(2);
  });
});

describe('loadApiFleetConfig', () => {
  it('defaults to the local region with quorum 1', () => {
    expect(loadApiFleetConfig({})).toEqual({
      regions: [DEFAULT_CHECK_REGION],
      region: null,
      scheduleRegions: [DEFAULT_CHECK_REGION],
      quorum: 1,
    });
  });

  it('schedules every configured region', () => {
    const config = loadApiFleetConfig({ CHECK_REGIONS: 'a,b,c' });

    expect(config.regions).toEqual(['a', 'b', 'c']);
    expect(config.region).toBeNull();
    expect(config.scheduleRegions).toEqual(['a', 'b', 'c']);
    expect(config.quorum).toBe(2);
  });

  it('honours CHECK_QUORUM', () => {
    expect(
      loadApiFleetConfig({ CHECK_REGIONS: 'a,b,c', CHECK_QUORUM: '3' }).quorum,
    ).toBe(3);
  });
});

describe('loadWorkerFleetConfig', () => {
  it('scopes scheduling to the worker region but evaluates the full fleet', () => {
    const config = loadWorkerFleetConfig({
      CHECK_REGIONS: 'a,b,c',
      CHECK_REGION: 'b',
    });

    expect(config.regions).toEqual(['a', 'b', 'c']);
    expect(config.region).toBe('b');
    expect(config.scheduleRegions).toEqual(['b']);
    expect(config.quorum).toBe(2);
  });

  it('defaults the region list to the worker region', () => {
    const config = loadWorkerFleetConfig({ CHECK_REGION: 'eu-west-1' });

    expect(config.regions).toEqual(['eu-west-1']);
    expect(config.scheduleRegions).toEqual(['eu-west-1']);
    expect(config.quorum).toBe(1);
  });

  it('rejects a worker region missing from CHECK_REGIONS', () => {
    expect(() =>
      loadWorkerFleetConfig({ CHECK_REGIONS: 'a,b', CHECK_REGION: 'c' }),
    ).toThrow(/not listed/);
  });
});

describe('checkQueueName', () => {
  it('is region-scoped and hyphenated for BullMQ job ids', () => {
    expect(checkQueueName('eu-west-1')).toBe('monitor-checks-eu-west-1');
  });
});
