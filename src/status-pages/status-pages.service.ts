import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  IncidentStatus,
  Prisma,
  StatusPage,
} from '../../generated/prisma/client';
import { OPEN_STATUSES } from '../incidents/incident.service';
import { PrismaService } from '../prisma.service';
import {
  DAY_MS,
  averageResponseTime,
  uptimePercentage,
} from '../rollups/bucket';
import { RollupsService, UptimeBucket } from '../rollups/rollups.service';
import { CreateStatusPageDto } from './dto/create-status-page.dto';
import { UpdateStatusPageDto } from './dto/update-status-page.dto';

/** Uptime is always the last 24 hours in hourly buckets (the rollup default). */
export const PUBLIC_UPTIME_GRANULARITY = 'hour' as const;

/** How far back the public incident history reaches. */
export const PUBLIC_INCIDENT_HISTORY_DAYS = 30;

/** Per-monitor cap on returned incidents, newest first. */
export const PUBLIC_INCIDENT_HISTORY_LIMIT = 10;

export type PublicMonitorStatus = 'up' | 'down' | 'unknown';

export interface PublicStatusIncident {
  id: string;
  status: IncidentStatus;
  cause: string;
  startedAt: string;
  resolvedAt: string | null;
  downtimeSeconds: number | null;
}

export interface PublicStatusMonitor {
  id: string;
  url: string;
  status: PublicMonitorStatus;
  uptimePct: number | null;
  avgResponseTimeMs: number | null;
  buckets: UptimeBucket[];
  incidents: PublicStatusIncident[];
}

export interface PublicStatusPage {
  slug: string;
  title: string | null;
  generatedAt: string;
  monitors: PublicStatusMonitor[];
}

type IncidentRow = {
  id: string;
  monitorId: string;
  status: IncidentStatus;
  cause: string;
  startedAt: Date;
  resolvedAt: Date | null;
  downtimeSeconds: number | null;
};

const INCIDENT_SELECT = {
  id: true,
  monitorId: true,
  status: true,
  cause: true,
  startedAt: true,
  resolvedAt: true,
  downtimeSeconds: true,
} as const;

@Injectable()
export class StatusPagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rollups: RollupsService,
  ) {}

  async create(userId: string, dto: CreateStatusPageDto): Promise<StatusPage> {
    const monitorIds = [...new Set(dto.monitorIds)];
    await this.assertMonitorsOwned(userId, monitorIds);

    try {
      return await this.prisma.statusPage.create({
        data: {
          userId,
          slug: dto.slug,
          monitorIds,
          isPublic: dto.isPublic ?? false,
          title: dto.title ?? null,
        },
      });
    } catch (error) {
      throw this.translateWriteError(error);
    }
  }

  findAll(userId: string): Promise<StatusPage[]> {
    return this.prisma.statusPage.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async update(
    userId: string,
    id: string,
    dto: UpdateStatusPageDto,
  ): Promise<StatusPage> {
    await this.getOwnedOrThrow(userId, id);

    const monitorIds = dto.monitorIds
      ? [...new Set(dto.monitorIds)]
      : undefined;

    if (monitorIds) {
      await this.assertMonitorsOwned(userId, monitorIds);
    }

    try {
      return await this.prisma.statusPage.update({
        where: { id },
        data: {
          ...(dto.slug !== undefined ? { slug: dto.slug } : {}),
          ...(monitorIds ? { monitorIds } : {}),
          ...(dto.isPublic !== undefined ? { isPublic: dto.isPublic } : {}),
          ...(dto.title !== undefined ? { title: dto.title } : {}),
        },
      });
    } catch (error) {
      throw this.translateWriteError(error);
    }
  }

  async remove(userId: string, id: string): Promise<void> {
    await this.getOwnedOrThrow(userId, id);
    await this.prisma.statusPage.delete({ where: { id } });
  }

  /**
   * The unauthenticated read. An unpublished or unknown slug is a 404 in both
   * cases, so a probe cannot tell the difference.
   */
  async getPublicPage(slug: string): Promise<PublicStatusPage> {
    const page = await this.prisma.statusPage.findUnique({
      where: { slug: slug.trim().toLowerCase() },
      select: {
        slug: true,
        title: true,
        userId: true,
        isPublic: true,
        monitorIds: true,
      },
    });

    if (!page || !page.isPublic) {
      throw new NotFoundException('Status page not found');
    }

    // Re-scope to the page owner: a monitor deleted after being listed, or a
    // row tampered to reference someone else's monitor, silently drops out.
    const monitors = await this.prisma.monitor.findMany({
      where: { id: { in: page.monitorIds }, userId: page.userId },
      select: { id: true, url: true },
    });

    const byId = new Map(monitors.map((monitor) => [monitor.id, monitor]));
    const ordered = [...new Set(page.monitorIds)]
      .map((id) => byId.get(id))
      .filter((monitor): monitor is { id: string; url: string } =>
        Boolean(monitor),
      );

    if (ordered.length === 0) {
      return {
        slug: page.slug,
        title: page.title,
        generatedAt: new Date().toISOString(),
        monitors: [],
      };
    }

    const monitorIds = ordered.map((monitor) => monitor.id);
    const window = this.rollups.resolveWindow({
      granularity: PUBLIC_UPTIME_GRANULARITY,
    });
    const historySince = new Date(
      Date.now() - PUBLIC_INCIDENT_HISTORY_DAYS * DAY_MS,
    );

    // Five queries in total, independent of how many monitors the page lists.
    const [bucketsByMonitor, openIncidents, recentIncidents, latestChecks] =
      await Promise.all([
        this.rollups.getUptimeForMonitors(monitorIds, window),
        this.prisma.incident.findMany({
          where: {
            monitorId: { in: monitorIds },
            status: { in: OPEN_STATUSES },
          },
          select: INCIDENT_SELECT,
        }),
        this.prisma.incident.findMany({
          where: {
            monitorId: { in: monitorIds },
            startedAt: { gte: historySince },
          },
          orderBy: { startedAt: 'desc' },
          select: INCIDENT_SELECT,
        }),
        this.latestCheckPerMonitor(monitorIds, window.from),
      ]);

    const incidentsByMonitor = mergeIncidents(openIncidents, recentIncidents);
    const openByMonitor = new Set(
      openIncidents.map((incident) => incident.monitorId),
    );

    const publicMonitors: PublicStatusMonitor[] = ordered.map((monitor) => {
      const buckets = bucketsByMonitor.get(monitor.id) ?? [];
      const totals = buckets.reduce(
        (acc, bucket) => ({
          checkCount: acc.checkCount + bucket.checkCount,
          upCount: acc.upCount + bucket.upCount,
          upResponseTimeSumMs:
            acc.upResponseTimeSumMs + bucket.upResponseTimeSumMs,
        }),
        { checkCount: 0, upCount: 0, upResponseTimeSumMs: 0 },
      );

      return {
        id: monitor.id,
        url: monitor.url,
        status: publicStatus(
          openByMonitor.has(monitor.id),
          latestChecks.get(monitor.id),
        ),
        uptimePct: uptimePercentage(totals.upCount, totals.checkCount),
        avgResponseTimeMs: averageResponseTime(
          totals.upResponseTimeSumMs,
          totals.upCount,
        ),
        buckets: buckets.map((bucket) => ({
          bucketStart: bucket.bucketStart,
          checkCount: bucket.checkCount,
          upCount: bucket.upCount,
          uptimePct: bucket.uptimePct,
          avgResponseTimeMs: bucket.avgResponseTimeMs,
        })),
        incidents: (incidentsByMonitor.get(monitor.id) ?? [])
          .slice(0, PUBLIC_INCIDENT_HISTORY_LIMIT)
          .map(toPublicIncident),
      };
    });

    return {
      slug: page.slug,
      title: page.title,
      generatedAt: new Date().toISOString(),
      monitors: publicMonitors,
    };
  }

  /**
   * Latest check per monitor without one query per monitor: group for the
   * timestamps, then fetch only those rows.
   *
   * Bounded to the reported window on purpose. Without it this scans every
   * check a monitor has ever recorded on each public page load. The cost is
   * that a monitor with no check in the last 24h reports `unknown`, which is
   * the honest answer for a stale monitor.
   */
  private async latestCheckPerMonitor(
    monitorIds: string[],
    since: Date,
  ): Promise<Map<string, boolean>> {
    const grouped = await this.prisma.check.groupBy({
      by: ['monitorId'],
      where: { monitorId: { in: monitorIds }, checkedAt: { gte: since } },
      _max: { checkedAt: true },
    });

    const stamps = grouped
      .filter(
        (row): row is { monitorId: string; _max: { checkedAt: Date } } =>
          row._max.checkedAt !== null,
      )
      .map((row) => ({
        monitorId: row.monitorId,
        checkedAt: row._max.checkedAt,
      }));

    if (stamps.length === 0) return new Map();

    const rows = await this.prisma.check.findMany({
      where: { OR: stamps },
      select: { monitorId: true, isUp: true },
    });

    return new Map(rows.map((row) => [row.monitorId, row.isUp]));
  }

  private async getOwnedOrThrow(
    userId: string,
    id: string,
  ): Promise<{ id: string }> {
    const page = await this.prisma.statusPage.findFirst({
      where: { id, userId },
      select: { id: true },
    });

    if (!page) {
      throw new NotFoundException('Status page not found');
    }

    return page;
  }

  /** Publishing someone else's monitor would expose their uptime. */
  private async assertMonitorsOwned(
    userId: string,
    monitorIds: string[],
  ): Promise<void> {
    if (monitorIds.length === 0) return;

    const owned = await this.prisma.monitor.count({
      where: { id: { in: monitorIds }, userId },
    });

    if (owned !== monitorIds.length) {
      throw new BadRequestException(
        'monitorIds must reference monitors you own',
      );
    }
  }

  private translateWriteError(error: unknown): Error {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      return new ConflictException(
        'A status page with that slug already exists',
      );
    }

    return error instanceof Error ? error : new Error(String(error));
  }
}

function publicStatus(
  hasOpenIncident: boolean,
  latestCheckIsUp: boolean | undefined,
): PublicMonitorStatus {
  if (hasOpenIncident) return 'down';
  if (latestCheckIsUp === undefined) return 'unknown';
  return latestCheckIsUp ? 'up' : 'down';
}

/** Dedupes an incident that is both open and inside the history window. */
function mergeIncidents(
  open: IncidentRow[],
  recent: IncidentRow[],
): Map<string, IncidentRow[]> {
  const byId = new Map<string, IncidentRow>();

  for (const incident of [...open, ...recent]) {
    if (!byId.has(incident.id)) byId.set(incident.id, incident);
  }

  const grouped = new Map<string, IncidentRow[]>();

  for (const incident of [...byId.values()].sort(
    (left, right) => right.startedAt.getTime() - left.startedAt.getTime(),
  )) {
    const list = grouped.get(incident.monitorId) ?? [];
    list.push(incident);
    grouped.set(incident.monitorId, list);
  }

  return grouped;
}

function toPublicIncident(incident: IncidentRow): PublicStatusIncident {
  return {
    id: incident.id,
    status: incident.status,
    cause: incident.cause,
    startedAt: incident.startedAt.toISOString(),
    resolvedAt: incident.resolvedAt?.toISOString() ?? null,
    downtimeSeconds: incident.downtimeSeconds,
  };
}
