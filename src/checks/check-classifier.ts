export interface CheckClassification {
  isUp: boolean;
  /** True when the response arrived but exceeded the monitor's slow limit. */
  slow: boolean;
}

/**
 * Classifies a single check as up or down.
 *
 * UP means: an HTTP response arrived within the monitor's timeout, its status
 * is below 400 (2xx success + 3xx redirects; fetch follows redirects so 3xx is
 * rarely observed raw, but tolerated), and — when the monitor sets
 * `responseTimeThresholdMs` — it arrived within that limit.
 *
 * Everything else — 4xx/5xx, timeouts, refused connections, DNS failures (all
 * represented as statusCode null), and slow-but-successful responses — is DOWN.
 *
 * The timeout is the hard limit: a response arriving after it is aborted and
 * reported as a timeout, so `responseTimeThresholdMs` must be lower than
 * `timeoutMs` to be reachable (validated on write).
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
