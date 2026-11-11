export interface CheckClassification {
  isUp: boolean;
  /** True when the response arrived but exceeded the monitor's slow limit. */
  slow: boolean;
}

/**
 * UP means a status below 400 arrived within the monitor's optional
 * `responseTimeThresholdMs`. Everything else — 4xx/5xx, timeouts, refused
 * connections, DNS failures, slow responses — is DOWN.
 *
 * `responseTimeThresholdMs` must be lower than `timeoutMs` to be reachable:
 * the request is aborted at the timeout first.
 */
export function classifyCheck(input: {
  statusCode: number | null;
  responseTimeMs: number;
  responseTimeThresholdMs?: number | null;
}): CheckClassification {
  const responded = input.statusCode !== null && input.statusCode < 400;

  const slow =
    responded &&
    input.responseTimeThresholdMs !== null &&
    input.responseTimeThresholdMs !== undefined &&
    input.responseTimeMs > input.responseTimeThresholdMs;

  return { isUp: responded && !slow, slow };
}
