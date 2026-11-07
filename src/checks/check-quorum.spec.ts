import 'reflect-metadata';
import {
  evaluateQuorum,
  freshnessWindowMs,
  RegionSnapshot,
} from './check-quorum';

const NOW = new Date('2026-01-01T00:00:00.000Z');

function snapshot(
  region: string,
  recent: boolean[],
  latestCheckedAt: Date | null = NOW,
): RegionSnapshot {
  return {
    region,
    recent: recent.map((isUp) => ({ isUp })),
    latestCheckedAt,
  };
}

function evaluate(
  snapshots: RegionSnapshot[],
  quorum: number,
  threshold = 3,
  freshnessMs = 30_000,
) {
  return evaluateQuorum({
    snapshots,
    threshold,
    quorum,
    now: NOW,
    freshnessMs,
  });
}

describe('freshnessWindowMs', () => {
  it('allows two intervals with a 30s floor', () => {
    expect(freshnessWindowMs(5)).toBe(30_000);
    expect(freshnessWindowMs(60)).toBe(120_000);
  });
});

describe('evaluateQuorum', () => {
  it('reports down when a single region meets the threshold (quorum 1)', () => {
    const result = evaluate([snapshot('a', [false, false, false])], 1);

    expect(result.verdict).toBe('down');
    expect(result.downRegions).toEqual(['a']);
  });

  it('reports up when a single region is up (quorum 1)', () => {
    const result = evaluate([snapshot('a', [true])], 1);

    expect(result.verdict).toBe('up');
    expect(result.upRegions).toEqual(['a']);
  });

  it('holds when a split fleet has no strict majority', () => {
    const result = evaluate(
      [snapshot('a', [false, false, false]), snapshot('b', [true])],
      2,
    );

    expect(result.verdict).toBe('hold');
    expect(result.downRegions).toEqual(['a']);
    expect(result.upRegions).toEqual(['b']);
  });

  it('reports down when quorum regions are down', () => {
    const result = evaluate(
      [
        snapshot('a', [false, false, false]),
        snapshot('b', [false, false, false]),
        snapshot('c', [true]),
      ],
      2,
    );

    expect(result.verdict).toBe('down');
    expect(result.downRegions).toEqual(['a', 'b']);
  });

  it('reports up when quorum regions are up', () => {
    const result = evaluate(
      [
        snapshot('a', [true]),
        snapshot('b', [true]),
        snapshot('c', [false, false, false]),
      ],
      2,
    );

    expect(result.verdict).toBe('up');
    expect(result.upRegions).toEqual(['a', 'b']);
  });

  it('excludes stale regions from the vote', () => {
    const stale = new Date(NOW.getTime() - 60_000);
    const result = evaluate(
      [snapshot('a', [true]), snapshot('b', [false, false, false], stale)],
      1,
    );

    expect(result.verdict).toBe('up');
    expect(result.freshRegions).toEqual(['a']);
  });

  it('holds when fewer than quorum regions are fresh', () => {
    const stale = new Date(NOW.getTime() - 60_000);
    const result = evaluate(
      [
        snapshot('a', [false, false, false]),
        snapshot('b', [false, false, false], stale),
        snapshot('c', [false, false, false], stale),
      ],
      2,
    );

    expect(result.verdict).toBe('hold');
    expect(result.freshRegions).toEqual(['a']);
  });

  it('treats a region that never reported as not fresh', () => {
    const result = evaluate([snapshot('a', [], null)], 1);

    expect(result.verdict).toBe('hold');
    expect(result.freshRegions).toEqual([]);
  });

  it('counts suspicious as neither up nor down', () => {
    const result = evaluate(
      [snapshot('a', [false, false]), snapshot('b', [false, false, false])],
      2,
    );

    expect(result.verdict).toBe('hold');
    expect(result.regions[0]).toMatchObject({
      region: 'a',
      state: 'suspicious',
    });
  });

  it('lets down win if an operator lowers quorum below strict majority', () => {
    const result = evaluate(
      [snapshot('a', [false, false, false]), snapshot('b', [true])],
      1,
    );

    expect(result.verdict).toBe('down');
  });
});
