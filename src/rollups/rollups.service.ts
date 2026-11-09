import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { RollupGranularity } from '../../generated/prisma/client';
import { PrismaService } from '../prisma.service';
import {
  DAY_MS,
  HOUR_MS,
  addBuckets,
  bucketSizeMs,
  bucketStartsBetween,
  completedBuckets,
  toApiGranularity,
  toRollupGranularity,
  truncateToBucket,
} from './bucket';
import {
  GetUptimeDto,
  UPTIME_DEFAULT_DAYS,
  UPTIME_DEFAULT_HOURS,
  UPTIME_MAX_BUCKETS,
} from './dto/get-uptime.dto';

const UPSERT_CHUNK_SIZE = 500;

export interface RollupRunResult {
  buckets: number;
  rows: number;
}

export interface UptimeBucket {
  bucketStart: string;
  checkCount: number;
  upCount: number;
  uptimePct: number | null;
  avgResponseTimeMs: number | null;
}

export interface UptimeSummary {
  monitorId: string;
  granularity: 'hour' | 'day';
  from: string;
  to: string;
  region: string | null;
  buckets: UptimeBucket[];
}

interface BucketTotals {
  monitorId: string;
  region: string;
  checkCount: number;
  upCount: number;
  upResponseTimeSumMs: number;
}

function percentage(up: number, total: number): number | null {
  if (total <= 0) return null;
  return Math.round((up / total) * 10_000) / 100;
}

function average(sumMs: number, count: number): number | null {
  if (count <= 0) return null;
  return Math.round((sumMs / count) * 100) / 100;
}

@Injectable()
export class RollupsService {
  private readonly logger = new Logger(RollupsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Recomputes one closed bucket from raw checks. The aggregation is additive:
   * it stores counts and the response-time sum, never a rounded percentage, so
   * combining regions or re-running the bucket cannot accumulate rounding
   * drift. The unique key makes the upserts idempotent.
   */
  async rollupBucket(
    granularity: RollupGranularity,
    bucketStart: Date,
  ): Promise<number> {
    const start = truncateToBucket(bucketStart, granularity);
    const end = addBuckets(start, granularity, 1);

    const groups = await this.prisma.check.groupBy({
      by: ['monitorId', 'region', 'isUp'],
      where: { checkedAt: { gte: start, lt: end } },
      _count: { _all: true },
      _sum: { responseTimeMs: true },
    });

    const totals = new Map<string, BucketTotals>();

    for (const group of groups) {
      const key = `${group.monitorId}\u0000${group.region}`;
      const count = group._count._all;
      let row = totals.get(key);

      if (!row) {
        row = {
          monitorId: group.monitorId,
          region: group.region,
          checkCount: 0,
          upCount: 0,
          upResponseTimeSumMs: 0,
        };
        totals.set(key, row);
      }

      row.checkCount += count;

      if (group.isUp) {
        row.upCount += count;
        row.upResponseTimeSumMs += group._sum.responseTimeMs ?? 0;
      }
    }

    const rows = [...totals.values()];

    for (let offset = 0; offset < rows.length; offset += UPSERT_CHUNK_SIZE) {
      const chunk = rows.slice(offset, offset + UPSERT_CHUNK_SIZE);

      await this.prisma.$transaction(
        chunk.map((row) =>
          this.prisma.checkRollup.upsert({
            where: {
              monitorId_region_granularity_bucketStart: {
                monitorId: row.monitorId,
                region: row.region,
                granularity,
                bucketStart: start,
              },
            },
            create: {
              monitorId: row.monitorId,
              region: row.region,
              granularity,
              bucketStart: start,
              checkCount: row.checkCount,
              upCount: row.upCount,
              upResponseTimeSumMs: row.upResponseTimeSumMs,
            },
            update: {
              checkCount: row.checkCount,
              upCount: row.upCount,
              upResponseTimeSumMs: row.upResponseTimeSumMs,
            },
          }),
        ),
      );
    }

    this.logger.debug(
      {
        granularity,
        bucketStart: start.toISOString(),
        rows: rows.length,
        checks: groups.reduce((sum, group) => sum + group._count._all, 0),
      },
      'Rollup bucket recomputed',
    );

    return rows.length;
  }

  /** Recomputes the last `count` completed buckets, oldest first. */
  async rollupRecent(
    granularity: RollupGranularity,
    count: number,
    now: Date = new Date(),
  ): Promise<RollupRunResult> {
    const buckets = completedBuckets(now, granularity, count);
    let rows = 0;

    for (const bucket of buckets) {
      rows += await this.rollupBucket(granularity, bucket);
    }

    return { buckets: buckets.length, rows };
  }

  /** Recomputes every bucket touching the inclusive range. Used by backfill. */
  async rollupRange(
    granularity: RollupGranularity,
    from: Date,
    to: Date,
  ): Promise<RollupRunResult> {
    const buckets = bucketStartsBetween(from, to, granularity);
    let rows = 0;

    for (const bucket of buckets) {
      rows += await this.rollupBucket(granularity, bucket);
    }

    return { buckets: buckets.length, rows };
  }

  /**
   * Owner-scoped read of materialized buckets. With no region filter the
   * per-region rows are combined by summing counters, then uptime and average
   * response time are derived on read.
   */
  async getUptime(
    userId: string,
    monitorId: string,
    query: GetUptimeDto,
  ): Promise<UptimeSummary> {
    const monitor = await this.prisma.monitor.findFirst({
      where: { id: monitorId, userId },
      select: { id: true },
    });

    if (!monitor) {
      throw new NotFoundException('Monitor not found');
    }

    const granularity = toRollupGranularity(query.granularity ?? 'hour');
    const now = new Date();
    const defaultWindowMs =
      granularity === RollupGranularity.DAY
        ? UPTIME_DEFAULT_DAYS * DAY_MS
        : UPTIME_DEFAULT_HOURS * HOUR_MS;

    const from = query.from
      ? new Date(query.from)
      : new Date(now.getTime() - defaultWindowMs);
    const to = query.to ? new Date(query.to) : now;

    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new BadRequestException('`from` and `to` must be valid timestamps');
    }
    if (from.getTime() > to.getTime()) {
      throw new BadRequestException('`from` must be before `to`');
    }

    const firstBucket = truncateToBucket(from, granularity);
    const lastBucket = truncateToBucket(to, granularity);
    const bucketCount =
      Math.floor(
        (lastBucket.getTime() - firstBucket.getTime()) /
          bucketSizeMs(granularity),
      ) + 1;

    if (bucketCount > UPTIME_MAX_BUCKETS) {
      throw new BadRequestException(
        `Requested range covers ${bucketCount} buckets; the maximum is ${UPTIME_MAX_BUCKETS}`,
      );
    }

    const region = query.region?.trim() || undefined;
    const rows = await this.prisma.checkRollup.findMany({
      where: {
        monitorId,
        granularity,
        bucketStart: { gte: firstBucket, lte: lastBucket },
        ...(region ? { region } : {}),
      },
      orderBy: { bucketStart: 'asc' },
      select: {
        bucketStart: true,
        checkCount: true,
        upCount: true,
        upResponseTimeSumMs: true,
      },
    });

    const combined = new Map<
      number,
      { checkCount: number; upCount: number; upResponseTimeSumMs: number }
    >();

    for (const row of rows) {
      const key = row.bucketStart.getTime();
      const totals = combined.get(key) ?? {
        checkCount: 0,
        upCount: 0,
        upResponseTimeSumMs: 0,
      };

      totals.checkCount += row.checkCount;
      totals.upCount += row.upCount;
      totals.upResponseTimeSumMs += row.upResponseTimeSumMs;
      combined.set(key, totals);
    }

    const buckets = [...combined.entries()]
      .sort(([left], [right]) => left - right)
      .map(([bucketStart, totals]) => ({
        bucketStart: new Date(bucketStart).toISOString(),
        checkCount: totals.checkCount,
        upCount: totals.upCount,
        uptimePct: percentage(totals.upCount, totals.checkCount),
        avgResponseTimeMs: average(totals.upResponseTimeSumMs, totals.upCount),
      }));

    return {
      monitorId,
      granularity: toApiGranularity(granularity),
      from: from.toISOString(),
      to: to.toISOString(),
      region: region ?? null,
      buckets,
    };
  }
}
