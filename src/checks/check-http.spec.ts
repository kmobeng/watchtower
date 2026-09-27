import { runHttpCheck } from './check-http';

describe('runHttpCheck', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('records status and response time on success', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      status: 200,
      body: { cancel: jest.fn().mockResolvedValue(undefined) },
    } as never);

    const result = await runHttpCheck('https://example.com/health', 10000);

    expect(result).toMatchObject({
      statusCode: 200,
      timedOut: false,
      error: null,
    });
    expect(result.responseTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('maps aborts to timeouts with no status code', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    jest.spyOn(global, 'fetch').mockRejectedValue(abortError);

    const result = await runHttpCheck('https://example.com/health', 1000);

    expect(result).toMatchObject({
      statusCode: null,
      timedOut: true,
      error: 'timeout',
    });
  });

  it('maps refused connections without throwing', async () => {
    const refused = new Error('connect ECONNREFUSED 127.0.0.1:9') as Error & {
      code: string;
    };
    refused.code = 'ECONNREFUSED';
    jest.spyOn(global, 'fetch').mockRejectedValue(refused);

    const result = await runHttpCheck('http://127.0.0.1:9', 5000);

    expect(result).toMatchObject({
      statusCode: null,
      timedOut: false,
      error: 'connection_refused',
    });
  });

  it('finds undici-style failures nested in cause', async () => {
    const syscallFailure = new Error(
      'connect ECONNREFUSED 127.0.0.1:9',
    ) as Error & { code: string };
    syscallFailure.code = 'ECONNREFUSED';
    jest
      .spyOn(global, 'fetch')
      .mockRejectedValue(new TypeError('fetch failed', { cause: syscallFailure }));

    const result = await runHttpCheck('http://127.0.0.1:9', 5000);

    expect(result).toMatchObject({
      statusCode: null,
      timedOut: false,
      error: 'connection_refused',
    });
  });

  it('records 5xx as data, not as a throw', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue({
      status: 503,
      body: { cancel: jest.fn().mockResolvedValue(undefined) },
    } as never);

    const result = await runHttpCheck('https://example.com/health', 10000);

    expect(result.statusCode).toBe(503);
    expect(result.error).toBeNull();
  });
});
