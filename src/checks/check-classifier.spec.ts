import { classifyCheck } from './check-classifier';

const classify = (
  statusCode: number | null,
  responseTimeMs = 50,
  responseTimeThresholdMs?: number | null,
) => classifyCheck({ statusCode, responseTimeMs, responseTimeThresholdMs });

describe('classifyCheck', () => {
  it.each([200, 201, 204, 301, 302, 399])('treats %i as up', (statusCode) => {
    expect(classify(statusCode).isUp).toBe(true);
  });

  it.each([400, 404, 500, 502, 503])('treats %i as down', (statusCode) => {
    expect(classify(statusCode).isUp).toBe(false);
  });

  it('treats a missing response (timeout/network) as down', () => {
    expect(classify(null).isUp).toBe(false);
  });

  describe('response time threshold', () => {
    it('is disabled when the monitor sets no threshold', () => {
      expect(classify(200, 9_000).isUp).toBe(true);
      expect(classify(200, 9_000).slow).toBe(false);
      expect(classify(200, 9_000, null).isUp).toBe(true);
    });

    it('marks a response slower than the threshold as down', () => {
      const result = classify(200, 900, 500);

      expect(result).toEqual({ isUp: false, slow: true });
    });

    it('keeps a response at or under the threshold up', () => {
      expect(classify(200, 500, 500)).toEqual({ isUp: true, slow: false });
      expect(classify(200, 499, 500)).toEqual({ isUp: true, slow: false });
    });

    it('does not call a failed status slow', () => {
      // The status already failed, so the slow limit is not the reason.
      expect(classify(503, 900, 500)).toEqual({ isUp: false, slow: false });
    });
  });
});
