export type CheckErrorKind =
  'timeout' | 'connection_refused' | 'dns' | 'network';

export interface HttpCheckResult {
  statusCode: number | null;
  responseTimeMs: number;
  timedOut: boolean;
  error: CheckErrorKind | null;
}

/**
 * Sends a single GET request and records the outcome. Never throws for
 * HTTP-level outcomes (5xx, timeouts, refused connections, DNS failures) —
 * those are data, returned as a down-classified result. Only truly
 * unexpected failures propagate.
 */
export async function runHttpCheck(
  url: string,
  timeoutMs: number,
): Promise<HttpCheckResult> {
  const startedAt = Date.now();

  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const statusCode = response.status;

    await response.body?.cancel().catch(() => undefined);

    return {
      statusCode,
      responseTimeMs: Date.now() - startedAt,
      timedOut: false,
      error: null,
    };
  } catch (error) {
    const responseTimeMs = Date.now() - startedAt;

    if (error instanceof Error && error.name === 'AbortError') {
      return {
        statusCode: null,
        responseTimeMs,
        timedOut: true,
        error: 'timeout',
      };
    }

    return {
      statusCode: null,
      responseTimeMs,
      timedOut: false,
      error: classifyNetworkError(error),
    };
  }
}

function classifyNetworkError(error: unknown): CheckErrorKind {
  // Walk the cause chain to find a code or message we recognize. This is
  // a best-effort heuristic; the error may be wrapped in multiple layers of
  // library-specific types, and we don't want to depend on any particular
  // library's error type.
  for (
    let current: unknown = error;
    current !== null && current !== undefined;
    current =
      typeof current === 'object' && 'cause' in current
        ? current.cause
        : undefined
  ) {
    const code =
      typeof current === 'object' && 'code' in current
        ? String(current.code)
        : '';
    const message =
      current instanceof Error
        ? current.message
        : (JSON.stringify(current) ?? '');

    if (code === 'ECONNREFUSED' || /refused/i.test(message)) {
      return 'connection_refused';
    }
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || /dns/i.test(message)) {
      return 'dns';
    }
    if (/timeout/i.test(message)) {
      return 'timeout';
    }
  }
  return 'network';
}
