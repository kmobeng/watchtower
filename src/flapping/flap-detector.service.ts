import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { RedisService } from '../redis/redis.service';

/** Verdicts the check pipeline can hand to the detector. */
export type FlapVerdict = 'up' | 'down' | 'hold';

export interface FlapState {
  /** Transitions inside the current window. */
  changes: number;
  /** True while alerts for this monitor are suppressed. */
  flapping: boolean;
}

const DEFAULT_MAX_CHANGES = 5;
const DEFAULT_WINDOW_SECONDS = 30 * 60;

export function flapLastKey(monitorId: string): string {
  return `flap:last:${monitorId}`;
}

export function flapEventsKey(monitorId: string): string {
  return `flap:events:${monitorId}`;
}

export function flapActiveKey(monitorId: string): string {
  return `flap:active:${monitorId}`;
}

/**
 * Records one verdict atomically.
 *
 * KEYS[1] last verdict, KEYS[2] transition window (sorted set),
 * KEYS[3] active flag.
 * ARGV[1] verdict, ARGV[2] now (ms), ARGV[3] window (ms),
 * ARGV[4] allowed changes, ARGV[5] unique member.
 *
 * The first verdict only establishes a baseline, so a monitor that is simply
 * down is not flapping. `hold` never moves the baseline. Concurrent region
 * evaluations race on the shared last state, so only the first caller to see a
 * real transition counts it.
 */
const RECORD_VERDICT = `
local state = ARGV[1]
local now = tonumber(ARGV[2])
local window = tonumber(ARGV[3])
local maxChanges = tonumber(ARGV[4])
local member = ARGV[5]

if state == 'hold' then
  return {redis.call('zcard', KEYS[2]), redis.call('exists', KEYS[3])}
end

local last = redis.call('get', KEYS[1])
if not last then
  redis.call('set', KEYS[1], state, 'PX', window)
  return {0, redis.call('exists', KEYS[3])}
end

if last == state then
  redis.call('pexpire', KEYS[1], window)
  return {redis.call('zcard', KEYS[2]), redis.call('exists', KEYS[3])}
end

redis.call('set', KEYS[1], state, 'PX', window)
redis.call('zremrangebyscore', KEYS[2], '-inf', '(' .. tostring(now - window))
redis.call('zadd', KEYS[2], now, member)
redis.call('pexpire', KEYS[2], window)

local changes = redis.call('zcard', KEYS[2])
if changes > maxChanges then
  redis.call('set', KEYS[3], '1', 'PX', window)
  return {changes, 1}
end

-- A transition while already flapping means the monitor has not stabilised:
-- keep the flag alive for another full window.
if redis.call('exists', KEYS[3]) == 1 then
  redis.call('pexpire', KEYS[3], window)
  return {changes, 1}
end

return {changes, 0}
`;

/**
 * Sliding-window flap detection backed by Redis.
 *
 * Every read and write fails open: a Redis outage must never stop checks,
 * incidents, or escalations. The worst case is that flapping suppression is
 * briefly unavailable.
 */
@Injectable()
export class FlapDetectorService {
  private readonly logger = new Logger(FlapDetectorService.name);
  readonly maxChanges: number;
  readonly windowMs: number;

  constructor(
    private readonly redis: RedisService,
    config: ConfigService,
  ) {
    const configuredMax = config.get<string>('FLAP_MAX_CHANGES');
    const maxChanges = Number(configuredMax ?? DEFAULT_MAX_CHANGES);
    if (!Number.isInteger(maxChanges) || maxChanges < 0) {
      throw new Error(
        `FLAP_MAX_CHANGES must be a non-negative integer (got "${configuredMax}")`,
      );
    }

    const configuredWindow = config.get<string>('FLAP_WINDOW_SECONDS');
    const windowSeconds = Number(configuredWindow ?? DEFAULT_WINDOW_SECONDS);
    const windowMs = Math.round(windowSeconds * 1000);
    if (!Number.isFinite(windowSeconds) || windowMs < 1) {
      throw new Error(
        `FLAP_WINDOW_SECONDS must be a positive number (got "${configuredWindow}")`,
      );
    }

    this.maxChanges = maxChanges;
    this.windowMs = windowMs;
  }

  /**
   * Records a verdict and returns the window state. `hold` is ignored; the
   * first real verdict is a baseline and is not counted as a change.
   */
  async record(
    monitorId: string,
    verdict: FlapVerdict,
    now: number = Date.now(),
  ): Promise<FlapState> {
    try {
      const result = (await this.redis
        .getClient()
        .eval(
          RECORD_VERDICT,
          3,
          flapLastKey(monitorId),
          flapEventsKey(monitorId),
          flapActiveKey(monitorId),
          verdict,
          String(now),
          String(this.windowMs),
          String(this.maxChanges),
          randomUUID(),
        )) as [number, number];

      return {
        changes: Number(result[0] ?? 0),
        flapping: Number(result[1] ?? 0) === 1,
      };
    } catch (error) {
      return this.failOpen('record', error, { changes: 0, flapping: false });
    }
  }

  async isFlapping(monitorId: string): Promise<boolean> {
    try {
      return (
        (await this.redis.getClient().exists(flapActiveKey(monitorId))) === 1
      );
    } catch (error) {
      return this.failOpen('isFlapping', error, false);
    }
  }

  /** Batched lookup for list endpoints. Unknown ids resolve to false. */
  async isFlappingMany(monitorIds: string[]): Promise<Map<string, boolean>> {
    if (monitorIds.length === 0) {
      return new Map();
    }

    try {
      const values = await this.redis
        .getClient()
        .mget(monitorIds.map((id) => flapActiveKey(id)));

      return new Map(
        monitorIds.map((id, index) => [id, values[index] !== null]),
      );
    } catch (error) {
      const fallback = new Map(monitorIds.map((id) => [id, false]));
      return this.failOpen('isFlappingMany', error, fallback);
    }
  }

  /** Clears every flap key for a monitor, e.g. when it is deleted. */
  async reset(monitorId: string): Promise<void> {
    try {
      await this.redis
        .getClient()
        .del(
          flapLastKey(monitorId),
          flapEventsKey(monitorId),
          flapActiveKey(monitorId),
        );
    } catch (error) {
      this.failOpen('reset', error, undefined);
    }
  }

  private failOpen<T>(action: string, error: unknown, fallback: T): T {
    this.logger.warn(
      { err: error instanceof Error ? error.message : String(error) },
      `Flap detector ${action} failed; failing open`,
    );
    return fallback;
  }
}
