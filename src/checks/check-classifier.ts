/**
 * Classifies a single check as up or down.
 *
 * UP means: an HTTP response arrived within the monitor's timeout and its
 * status is below 400 (2xx success + 3xx redirects; fetch follows redirects
 * so 3xx is rarely observed raw, but tolerated).
 *
 * Everything else — 4xx/5xx, timeouts, refused connections, DNS failures
 * (all represented as statusCode null) — is DOWN.
 *
 * Note: the response-time limit IS the monitor's timeoutMs. Any response
 * arriving after it is by construction a timeout (fetch aborted), so there
 * is no separate "slow" threshold at this step. A "slow but within timeout"
 * cause is deferred to incident-cause work.
 */
export function classifyCheck(statusCode: number | null): boolean {
  return statusCode !== null && statusCode < 400;
}
