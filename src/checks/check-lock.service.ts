import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { RedisService } from '../redis/redis.service';

const DEFAULT_TTL_SECONDS = 5 * 60;

/**
 * Delete the key only when the caller still owns it. Without the compare, a
 * lock that expired and was re-acquired by another worker could be deleted by
 * the previous owner.
 */
const RELEASE_IF_OWNER = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

/**
 * A check is unique per region, monitor and scheduled slot. The region is
 * load-bearing: each region has its own queue and its own scheduler slot, and
 * the same monitor must still be probed once per region for quorum. Only
 * duplicate deliveries *within* a region need suppressing.
 */
export function checkLockKey(
  region: string,
  monitorId: string,
  scheduledTime: string,
): string {
  return `check-lock:${region}:${monitorId}:${scheduledTime}`;
}

/**
 * BullMQ gives repeatable jobs the id `repeat:<schedulerId>:<scheduledMillis>`
 * (see addJobScheduler.lua), where the scheduler id is `monitor:<id>`. The
 * trailing millis is the slot the job was scheduled for, so every delivery and
 * retry of that slot resolves to the same value. Fall back to the job's
 * creation timestamp, then the id, for non-repeatable jobs.
 */
export function scheduledTimeOfJob(job: {
  id?: string | null;
  timestamp?: number;
}): string {
  const match = /^repeat:.+:(\d+)$/.exec(job.id ?? '');
  if (match) {
    return match[1];
  }

  if (typeof job.timestamp === 'number') {
    return String(job.timestamp);
  }

  return String(job.id ?? 'unknown');
}

/**
 * At-most-once claim for a scheduled check. The lock is intentionally not
 * released on success: it lives until the TTL so any later duplicate delivery
 * of the same slot is dropped rather than probed twice. Callers release it
 * only when the attempt failed, so BullMQ's retry can claim the slot again.
 */
@Injectable()
export class CheckLockService {
  private readonly logger = new Logger(CheckLockService.name);
  private readonly ttlMs: number;

  constructor(
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    const configured = config.get<string>('CHECK_LOCK_TTL_SECONDS');
    const seconds = Number(configured ?? DEFAULT_TTL_SECONDS);

    if (!Number.isFinite(seconds) || seconds <= 0) {
      throw new Error(
        `CHECK_LOCK_TTL_SECONDS must be a positive number (got "${configured}")`,
      );
    }

    this.ttlMs = seconds * 1000;
  }

  /**
   * Returns the ownership token when this caller claimed the slot, or null
   * when another worker already holds it.
   */
  async acquire(
    region: string,
    monitorId: string,
    scheduledTime: string,
  ): Promise<string | null> {
    const key = checkLockKey(region, monitorId, scheduledTime);
    const token = randomUUID();

    const result = await this.redis
      .getClient()
      .set(key, token, 'PX', this.ttlMs, 'NX');

    if (result !== 'OK') {
      return null;
    }

    this.logger.debug({ key, ttlMs: this.ttlMs }, 'Check lock acquired');
    return token;
  }

  async release(
    region: string,
    monitorId: string,
    scheduledTime: string,
    token: string,
  ): Promise<void> {
    const key = checkLockKey(region, monitorId, scheduledTime);

    await this.redis.getClient().eval(RELEASE_IF_OWNER, 1, key, token);
    this.logger.debug({ key }, 'Check lock released');
  }
}
