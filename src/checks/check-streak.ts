export type MonitorState = 'up' | 'suspicious' | 'down';

export interface StreakEvaluation {
  state: MonitorState;
  consecutiveFailures: number;
}

/**
 * Evaluates a monitor's current state from its most recent checks
 * (newest first) against the monitor's failure threshold.
 *
 * Only the LEADING failures count: a single success anywhere in the
 * window breaks the streak and recovers to 'up'.
 * The evaluation rules are:
 * - 0 leading failures            -> 'up'
 * - 1..threshold-1 leading        -> 'suspicious'
 * - >= threshold leading failures -> 'down'
 *
 * threshold = 1 means any failure is immediately 'down' (no special case).
 * An empty history means 'up' (no evidence of failure).
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
