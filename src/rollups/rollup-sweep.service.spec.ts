import 'reflect-metadata';
import { RollupGranularity } from '../../generated/prisma/client';
import { RedisService } from '../redis/redis.service';
import { RollupSweepService, rollupLockKey } from './rollup-sweep.service';
import { RollupsService } from './rollups.service';

describe('RollupSweepService', () => {
  let redisClient: { set: jest.Mock; eval: jest.Mock };
  let rollups: { rollupBucket: jest.Mock };
  let service: RollupSweepService;

  const now = new Date('2026-11-09T10:34:00.000Z');

  beforeEach(() => {
    redisClient = {
      set: jest.fn().mockResolvedValue('OK'),
      eval: jest.fn().mockResolvedValue(1),
    };
    rollups = { rollupBucket: jest.fn().mockResolvedValue(1) };
    service = new RollupSweepService(
      rollups as unknown as RollupsService,
      { getClient: () => redisClient } as unknown as RedisService,
    );
  });

  it('namespaces the lock by granularity and bucket', () => {
    expect(
      rollupLockKey(
        RollupGranularity.HOUR,
        new Date('2026-11-09T09:00:00.000Z'),
      ),
    ).toBe('rollup-lock:HOUR:2026-11-09T09:00:00.000Z');
  });

  it('recomputes the previous two closed buckets and releases each lock', async () => {
    await expect(service.run(RollupGranularity.HOUR, 2, now)).resolves.toEqual({
      granularity: RollupGranularity.HOUR,
      buckets: 2,
      processed: 2,
      skipped: 0,
      failed: 0,
    });

    expect(redisClient.set).toHaveBeenNthCalledWith(
      1,
      'rollup-lock:HOUR:2026-11-09T08:00:00.000Z',
      expect.any(String),
      'PX',
      15 * 60 * 1000,
      'NX',
    );
    expect(rollups.rollupBucket).toHaveBeenNthCalledWith(
      1,
      RollupGranularity.HOUR,
      new Date('2026-11-09T08:00:00.000Z'),
    );
    expect(redisClient.eval).toHaveBeenCalledTimes(2);
  });

  it('skips a bucket another instance already claimed', async () => {
    redisClient.set.mockResolvedValue(null);

    await expect(
      service.run(RollupGranularity.HOUR, 2, now),
    ).resolves.toMatchObject({ processed: 0, skipped: 2, failed: 0 });

    expect(rollups.rollupBucket).not.toHaveBeenCalled();
    expect(redisClient.eval).not.toHaveBeenCalled();
  });

  it('runs unlocked when Redis is unavailable', async () => {
    redisClient.set.mockRejectedValue(new Error('redis down'));

    await expect(
      service.run(RollupGranularity.DAY, 1, now),
    ).resolves.toMatchObject({ processed: 1, skipped: 0, failed: 0 });

    expect(rollups.rollupBucket).toHaveBeenCalledWith(
      RollupGranularity.DAY,
      new Date('2026-11-08T00:00:00.000Z'),
    );
    expect(redisClient.eval).not.toHaveBeenCalled();
  });

  it('keeps going when one bucket fails', async () => {
    rollups.rollupBucket
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(1);

    await expect(
      service.run(RollupGranularity.HOUR, 2, now),
    ).resolves.toMatchObject({ processed: 1, skipped: 0, failed: 1 });

    expect(redisClient.eval).toHaveBeenCalledTimes(2);
  });

  it('does not fail the run when releasing a lock fails', async () => {
    redisClient.eval.mockRejectedValue(new Error('redis down'));

    await expect(
      service.run(RollupGranularity.HOUR, 1, now),
    ).resolves.toMatchObject({ processed: 1, failed: 0 });
  });
});
