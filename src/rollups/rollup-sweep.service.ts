import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { randomUUID } from 'crypto';
import { RollupGranularity } from '../../generated/prisma/client';
import { RedisService } from '../redis/redis.service';
import { completedBuckets } from './bucket';
import { RollupsService } from './rollups.service';

/** Long enough for one bucket's groupBy and upserts to finish. */
const LOCK_TTL_MS = 15 * 60 * 1000;

/**
 * Delete the lock only when this instance still owns it. A lock that expired
 * and was re-acquired by another instance must not be released by its
 * previous owner.
 */
const RELEASE_IF_OWNER = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

export function rollupLockKey(
  granularity: RollupGranularity,
  bucketStart: Date,
): string {
  return `rollup-lock:${granularity}:${bucketStart.toISOString()}`;
}

export interface RollupSweepResult {
  granularity: RollupGranularity;
  buckets: number;
  processed: number;
  skipped: number;
  failed: number;
}

/**
 * Owns the rollup schedule. The API process runs this; the worker process does
 * not import RollupsModule, so checks and rollups stay independently
 * deployable. A Redis lock per bucket keeps multiple API instances from doing
 * the same groupBy at once; the upserts are idempotent even if the lock is
 * lost, so Redis trouble fails open rather than stopping rollups.
 */
@Injectable()
export class RollupSweepService {
  private readonly logger = new Logger(RollupSweepService.name);

  constructor(
    private readonly rollups: RollupsService,
    private readonly redis: RedisService,
  ) {}

  /** Five minutes past every hour UTC, recomputing the previous two hours. */
  @Cron('0 5 * * * *', { timeZone: 'UTC' })
  async rollupHourly(): Promise<void> {
    await this.run(RollupGranularity.HOUR, 2);
  }

  /** Ten minutes past midnight UTC, recomputing the previous two days. */
  @Cron('0 10 0 * * *', { timeZone: 'UTC' })
  async rollupDaily(): Promise<void> {
    await this.run(RollupGranularity.DAY, 2);
  }

  async run(
    granularity: RollupGranularity,
    count: number,
    now: Date = new Date(),
  ): Promise<RollupSweepResult> {
    const buckets = completedBuckets(now, granularity, count);
    const result: RollupSweepResult = {
      granularity,
      buckets: buckets.length,
      processed: 0,
      skipped: 0,
      failed: 0,
    };

    for (const bucket of buckets) {
      const key = rollupLockKey(granularity, bucket);
      const token = await this.acquire(key);

      if (token === null) {
        result.skipped += 1;
        this.logger.debug(
          { granularity, bucketStart: bucket.toISOString() },
          'Rollup bucket claimed by another instance, skipping',
        );
        continue;
      }

      try {
        await this.rollups.rollupBucket(granularity, bucket);
        result.processed += 1;
      } catch (error) {
        result.failed += 1;
        // One bad bucket must not stop the rest of the run.
        this.logger.error(
          {
            granularity,
            bucketStart: bucket.toISOString(),
            err: error instanceof Error ? error.message : String(error),
          },
          'Rollup bucket failed',
        );
      } finally {
        // `undefined` means Redis was unavailable and no lock was taken.
        if (token !== undefined) {
          await this.release(key, token);
        }
      }
    }

    if (result.processed > 0 || result.failed > 0) {
      this.logger.log(result, 'Rollup sweep finished');
    }

    return result;
  }

  /**
   * Returns an ownership token when this instance claimed the bucket, `null`
   * when another instance holds it, or `undefined` when Redis is unavailable
   * (proceed unlocked).
   */
  private async acquire(key: string): Promise<string | null | undefined> {
    const token = randomUUID();

    try {
      const result = await this.redis
        .getClient()
        .set(key, token, 'PX', LOCK_TTL_MS, 'NX');

      return result === 'OK' ? token : null;
    } catch (error) {
      this.logger.warn(
        { key, err: error instanceof Error ? error.message : String(error) },
        'Rollup lock unavailable; running without a lock',
      );
      return undefined;
    }
  }

  private async release(key: string, token: string): Promise<void> {
    try {
      await this.redis.getClient().eval(RELEASE_IF_OWNER, 1, key, token);
    } catch (error) {
      this.logger.warn(
        { key, err: error instanceof Error ? error.message : String(error) },
        'Failed to release rollup lock',
      );
    }
  }
}
