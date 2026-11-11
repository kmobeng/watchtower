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
  averageResponseTime,
  bucketSizeMs,
  bucketStartsBetween,
  completedBuckets,
  toApiGranularity,
  toRollupGranularity,
  truncateToBucket,
  uptimePercentage,
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

/**
 * A bucket plus the raw response-time sum, so a caller combining buckets for a
 * window (a public status page) can derive an exact average instead of
 * re-averaging rounded per-bucket averages.
 */
export interface UptimeBucketTotals extends UptimeBucket {
  upResponseTimeSumMs: number;
}

export interface UptimeSummary {
  monitorId: string;
  granularity: 'hour' | 'day';
  from: string;
  to: string;
  region: string | null;
  buckets: UptimeBucket[];
}

/** A resolved, validated rollup window. */
export interface UptimeWindow {
  granularity: RollupGranularity;
  from: Date;
  to: Date;
  firstBucket: Date;
  lastBucket: Date;
  region?: string;
}

interface BucketTotals {
  monitorId: string;
  region: string;
  checkCount: number;
  upCount: number;
  upResponseTimeSumMs: number;
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
   * Resolves a request's granularity and window, enforcing the bucket bound.
   * Shared so owner-scoped reads and public status pages cannot drift apart.
   */
  resolveWindow(
    query: Pick<GetUptimeDto, 'granularity' | 'from' | 'to' | 'region'>,
    now: Date = new Date(),
  ): UptimeWindow {
    const granularity = toRollupGranularity(query.granularity ?? 'hour');
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

    return {
      granularity,
      from,
      to,
      firstBucket,
      lastBucket,
      region: query.region?.trim() || undefined,
    };
  }

  /**
   * Materialized buckets for many monitors in a single query.
   *
   * Deliberately takes no user id: the caller must already have established
   * that these monitors are readable (an owner check, or a published status
   * page). Every requested id is present in the result, empty when it has no
   * rollups in the window.
   */
  async getUptimeForMonitors(
    monitorIds: string[],
    window: UptimeWindow,
  ): Promise<Map<string, UptimeBucketTotals[]>> {
    const bucketsByMonitor = new Map<string, UptimeBucketTotals[]>(
      monitorIds.map((id) => [id, []]),
    );

    if (monitorIds.length === 0) {
      return bucketsByMonitor;
    }

    const rows = await this.prisma.checkRollup.findMany({
      where: {
        monitorId: { in: monitorIds },
        granularity: window.granularity,
        bucketStart: { gte: window.firstBucket, lte: window.lastBucket },
        ...(window.region ? { region: window.region } : {}),
      },
      orderBy: { bucketStart: 'asc' },
      select: {
        monitorId: true,
        bucketStart: true,
        checkCount: true,
        upCount: true,
        upResponseTimeSumMs: true,
      },
    });

    // Per monitor, per bucket: sum the region rows before deriving.
    const combined = new Map<
      string,
      Map<
        number,
        { checkCount: number; upCount: number; upResponseTimeSumMs: number }
      >
    >();

    for (const row of rows) {
      let byBucket = combined.get(row.monitorId);
      if (!byBucket) {
        byBucket = new Map();
        combined.set(row.monitorId, byBucket);
      }

      const key = row.bucketStart.getTime();
      const totals = byBucket.get(key) ?? {
        checkCount: 0,
        upCount: 0,
        upResponseTimeSumMs: 0,
      };

      totals.checkCount += row.checkCount;
      totals.upCount += row.upCount;
      totals.upResponseTimeSumMs += row.upResponseTimeSumMs;
      byBucket.set(key, totals);
    }

    for (const [monitorId, byBucket] of combined) {
      bucketsByMonitor.set(
        monitorId,
        [...byBucket.entries()]
          .sort(([left], [right]) => left - right)
          .map(([bucketStart, totals]) => ({
            bucketStart: new Date(bucketStart).toISOString(),
            checkCount: totals.checkCount,
            upCount: totals.upCount,
            upResponseTimeSumMs: totals.upResponseTimeSumMs,
            uptimePct: uptimePercentage(totals.upCount, totals.checkCount),
            avgResponseTimeMs: averageResponseTime(
              totals.upResponseTimeSumMs,
              totals.upCount,
            ),
          })),
      );
    }

    return bucketsByMonitor;
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

    const window = this.resolveWindow(query);
    const buckets = (
      (await this.getUptimeForMonitors([monitorId], window)).get(monitorId) ??
      []
    ).map((bucket) => ({
      bucketStart: bucket.bucketStart,
      checkCount: bucket.checkCount,
      upCount: bucket.upCount,
      uptimePct: bucket.uptimePct,
      avgResponseTimeMs: bucket.avgResponseTimeMs,
    }));

    return {
      monitorId,
      granularity: toApiGranularity(window.granularity),
      from: window.from.toISOString(),
      to: window.to.toISOString(),
      region: window.region ?? null,
      buckets,
    };
  }
}
