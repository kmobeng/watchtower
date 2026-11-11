export type RegionState = 'up' | 'suspicious' | 'down';

export interface StreakEvaluation {
  state: RegionState;
  consecutiveFailures: number;
}

/**
 * Only the LEADING failures count: a single success breaks the streak and
 * recovers to 'up'. An empty history means 'up' (no evidence of failure).
 */
export function evaluateStreak(
  recent: { isUp: boolean }[],
  threshold: number,
): StreakEvaluation {
  let consecutiveFailures = 0;
  for (const check of recent) {
    if (check.isUp) break;
    consecutiveFailures += 1;
  }

  if (consecutiveFailures >= threshold) {
    return { state: 'down', consecutiveFailures };
  }
  if (consecutiveFailures > 0) {
    return { state: 'suspicious', consecutiveFailures };
  }
  return { state: 'up', consecutiveFailures: 0 };
}
