import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../redis/redis.service';
import {
  CheckLockService,
  checkLockKey,
  scheduledTimeOfJob,
} from './check-lock.service';

describe('CheckLockService', () => {
  let client: { set: jest.Mock; eval: jest.Mock };
  let service: CheckLockService;

  function configWith(ttl: string | undefined): ConfigService {
    return {
      get: jest.fn().mockReturnValue(ttl),
    } as unknown as ConfigService;
  }

  beforeEach(() => {
    client = { set: jest.fn(), eval: jest.fn() };
    service = new CheckLockService(
      { getClient: () => client } as unknown as RedisService,
      configWith(undefined),
    );
  });

  it('scopes the key by region, monitor and scheduled slot', () => {
    expect(checkLockKey('eu-west', 'mon-1', '1700000000000')).toBe(
      'check-lock:eu-west:mon-1:1700000000000',
    );
  });

  it('acquires with SET NX PX and returns a token', async () => {
    client.set.mockResolvedValue('OK');

    const token = await service.acquire('local', 'mon-1', '1700000000000');

    expect(token).toEqual(expect.any(String));
    expect(client.set).toHaveBeenCalledWith(
      'check-lock:local:mon-1:1700000000000',
      token,
      'PX',
      300000,
      'NX',
    );
  });

  it('returns null when another worker already holds the slot', async () => {
    client.set.mockResolvedValue(null);

    await expect(
      service.acquire('local', 'mon-1', '1700000000000'),
    ).resolves.toBeNull();
  });

  it('uses a fresh token for every acquisition', async () => {
    client.set.mockResolvedValue('OK');

    const first = await service.acquire('local', 'mon-1', '1700000000000');
    const second = await service.acquire('local', 'mon-1', '1700000000000');

    expect(first).not.toBe(second);
  });

  it('releases only when the token still owns the key', async () => {
    await service.release('local', 'mon-1', '1700000000000', 'token-1');

    expect(client.eval).toHaveBeenCalledWith(
      expect.stringContaining('redis.call("get", KEYS[1])'),
      1,
      'check-lock:local:mon-1:1700000000000',
      'token-1',
    );
    expect(client.eval).toHaveBeenCalledWith(
      expect.stringContaining('redis.call("del", KEYS[1])'),
      1,
      'check-lock:local:mon-1:1700000000000',
      'token-1',
    );
  });

  it('honours CHECK_LOCK_TTL_SECONDS', async () => {
    const custom = new CheckLockService(
      { getClient: () => client } as unknown as RedisService,
      configWith('30'),
    );
    client.set.mockResolvedValue('OK');

    await custom.acquire('local', 'mon-1', '1700000000000');

    expect(client.set).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      'PX',
      30000,
      'NX',
    );
  });

  it('rejects a non-positive TTL at construction', () => {
    expect(
      () =>
        new CheckLockService(
          { getClient: () => client } as unknown as RedisService,
          configWith('0'),
        ),
    ).toThrow('CHECK_LOCK_TTL_SECONDS');
  });
});

describe('scheduledTimeOfJob', () => {
  it('parses the scheduled slot from a repeatable job id', () => {
    expect(
      scheduledTimeOfJob({
        id: 'repeat:monitor:mon-1:1700000000000',
        timestamp: 1699999999999,
      }),
    ).toBe('1700000000000');
  });

  it('falls back to the job timestamp for non-repeatable jobs', () => {
    expect(scheduledTimeOfJob({ id: 'job-1', timestamp: 1700000000000 })).toBe(
      '1700000000000',
    );
  });

  it('falls back to the job id when no timestamp exists', () => {
    expect(scheduledTimeOfJob({ id: 'job-1' })).toBe('job-1');
  });
});
