import { evaluateStreak, MonitorState } from './check-streak';

export type QuorumVerdict = 'up' | 'down' | 'hold';

export interface RegionSnapshot {
  region: string;
  /** Checks for this region, newest first. */
  recent: { isUp: boolean }[];
  /** Timestamp of the newest check, or null when the region never reported. */
  latestCheckedAt: Date | null;
}

export interface RegionEvaluation {
  region: string;
  state: MonitorState;
  fresh: boolean;
}

export interface QuorumEvaluation {
  verdict: QuorumVerdict;
  regions: RegionEvaluation[];
  downRegions: string[];
  upRegions: string[];
  freshRegions: string[];
}

/**
 * A region counts only while it is still reporting. Two missed intervals
 * (with a 30s floor) keeps a crashed worker from pinning the monitor in one
 * state forever, while tolerating a single slow tick.
 */
export function freshnessWindowMs(intervalSeconds: number): number {
  return Math.max(intervalSeconds * 2_000, 30_000);
}

/**
 * Combines per-region streaks into one verdict.
 *
 * - `down`  when at least `quorum` fresh regions are down
 * - `up`    when at least `quorum` fresh regions are up
 * - `hold`  otherwise, including when fewer than `quorum` regions are fresh
 *
 * A region is `up`/`suspicious`/`down` by the same leading-failure streak the
 * single-region implementation used, so `failureThreshold` stays per region.
 * Regions that never reported are not fresh and cannot vote.
 */
export function evaluateQuorum(input: {
  snapshots: RegionSnapshot[];
  threshold: number;
  quorum: number;
  now: Date;
  freshnessMs: number;
}): QuorumEvaluation {
  const regions: RegionEvaluation[] = input.snapshots.map((snapshot) => ({
    region: snapshot.region,
    state: evaluateStreak(snapshot.recent, input.threshold).state,
    fresh:
      snapshot.latestCheckedAt !== null &&
      input.now.getTime() - snapshot.latestCheckedAt.getTime() <=
        input.freshnessMs,
  }));

  const fresh = regions.filter((region) => region.fresh);
  const downRegions = fresh
    .filter((region) => region.state === 'down')
    .map((region) => region.region);
  const upRegions = fresh
    .filter((region) => region.state === 'up')
    .map((region) => region.region);

  let verdict: QuorumVerdict = 'hold';
  if (fresh.length >= input.quorum) {
    // With the default strict majority these cannot both be true. If an
    // operator lowers CHECK_QUORUM, down wins so the system errs toward
    // alerting rather than silently staying green.
    if (downRegions.length >= input.quorum) {
      verdict = 'down';
    } else if (upRegions.length >= input.quorum) {
      verdict = 'up';
    }
  }

  return {
    verdict,
    regions,
    downRegions,
    upRegions,
    freshRegions: fresh.map((region) => region.region),
  };
}
