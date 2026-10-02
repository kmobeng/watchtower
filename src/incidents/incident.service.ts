import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  Incident,
  IncidentStatus,
  Prisma,
} from '../../generated/prisma/client';
import { PrismaService } from '../prisma.service';
import {
  MONITORS_DEFAULT_LIMIT,
  MONITORS_DEFAULT_PAGE,
  MONITORS_MAX_LIMIT,
} from '../monitors/dto/list-monitors.dto';
import type { StreakEvaluation } from '../checks/check-streak';

export const OPEN_STATUSES: IncidentStatus[] = [
  IncidentStatus.OPEN,
  IncidentStatus.ACKNOWLEDGED,
  IncidentStatus.ESCALATED,
];

type DownCheck = {
  id: string;
  statusCode: number | null;
  timedOut: boolean;
  error: string | null;
};

export interface PaginatedIncidents {
  items: Incident[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/**
 * Guarded transitions. Anything not listed throws ConflictException (409):
 * the state machine moves forward only, and RESOLVED is terminal.
 */
const ALLOWED_TRANSITIONS: Record<IncidentStatus, IncidentStatus[]> = {
  [IncidentStatus.OPEN]: [IncidentStatus.ACKNOWLEDGED, IncidentStatus.RESOLVED],
  [IncidentStatus.ACKNOWLEDGED]: [IncidentStatus.RESOLVED],
  [IncidentStatus.ESCALATED]: [
    IncidentStatus.ACKNOWLEDGED,
    IncidentStatus.RESOLVED,
  ],
  [IncidentStatus.RESOLVED]: [],
};

@Injectable()
export class IncidentService {
  private readonly logger = new Logger(IncidentService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Consumes one evaluated check. Opens on 'down' (idempotent), resolves on
   * 'up', ignores 'suspicious'. Called by the check processor; nothing else
   * should open or auto-resolve incidents.
   */
  async handleVerdict(
    monitorId: string,
    evaluation: StreakEvaluation | null,
    check: DownCheck,
  ): Promise<Incident | null> {
    if (!evaluation) return null;

    if (evaluation.state === 'down') {
      return this.openIfNeeded(monitorId, check);
    }
    if (evaluation.state === 'up') {
      return this.resolveIfOpen(monitorId, check.id);
    }
    return null;
  }

  async acknowledge(userId: string, incidentId: string): Promise<Incident> {
    const incident = await this.prisma.incident.findUnique({
      where: { id: incidentId },
      include: { monitor: { select: { userId: true } } },
    });

    if (!incident || incident.monitor.userId !== userId) {
      throw new NotFoundException('Incident not found');
    }

    return this.transition(incident, IncidentStatus.ACKNOWLEDGED);
  }

  async findAll(
    userId: string,
    monitorId: string | undefined,
    page: number = MONITORS_DEFAULT_PAGE,
    limit: number = MONITORS_DEFAULT_LIMIT,
  ): Promise<PaginatedIncidents> {
    const safePage = Math.max(1, Math.floor(page));
    const safeLimit = Math.min(
      Math.max(1, Math.floor(limit)),
      MONITORS_MAX_LIMIT,
    );

    const where: Prisma.IncidentWhereInput = {
      monitor: { userId },
      ...(monitorId ? { monitorId } : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.incident.findMany({
        where,
        orderBy: { startedAt: 'desc' },
        skip: (safePage - 1) * safeLimit,
        take: safeLimit,
      }),
      this.prisma.incident.count({ where }),
    ]);

    return {
      items,
      total,
      page: safePage,
      limit: safeLimit,
      totalPages: Math.ceil(total / safeLimit),
    };
  }

  private async openIfNeeded(
    monitorId: string,
    check: DownCheck,
  ): Promise<Incident> {
    const existing = await this.prisma.incident.findFirst({
      where: { monitorId, status: { in: OPEN_STATUSES } },
    });
    if (existing) return existing;

    try {
      const incident = await this.prisma.incident.create({
        data: {
          monitorId,
          status: IncidentStatus.OPEN,
          cause: deriveCause(check),
          openedByCheckId: check.id,
        },
      });
      this.logger.log(
        { incidentId: incident.id, monitorId, cause: incident.cause },
        'Incident opened',
      );
      return incident;
    } catch (error) {
      // Lost a concurrent open race: the partial unique index rejected us,
      // so return the winner instead of failing.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const winner = await this.prisma.incident.findFirst({
          where: { monitorId, status: { in: OPEN_STATUSES } },
        });
        if (winner) return winner;
      }
      throw error;
    }
  }

  private async resolveIfOpen(
    monitorId: string,
    checkId: string,
  ): Promise<Incident | null> {
    const existing = await this.prisma.incident.findFirst({
      where: { monitorId, status: { in: OPEN_STATUSES } },
    });
    if (!existing) return null;

    const resolvedAt = new Date();
    const incident = await this.prisma.incident.update({
      where: { id: existing.id },
      data: {
        status: IncidentStatus.RESOLVED,
        resolvedAt,
        downtimeSeconds: Math.max(
          0,
          Math.floor(
            (resolvedAt.getTime() - existing.startedAt.getTime()) / 1000,
          ),
        ),
        closedByCheckId: checkId,
      },
    });
    this.logger.log(
      {
        incidentId: incident.id,
        monitorId,
        downtimeSeconds: incident.downtimeSeconds,
      },
      'Incident resolved',
    );
    return incident;
  }

  private async transition(
    incident: Incident,
    to: IncidentStatus,
  ): Promise<Incident> {
    if (!ALLOWED_TRANSITIONS[incident.status].includes(to)) {
      throw new ConflictException(
        `Cannot transition incident from ${incident.status} to ${to}`,
      );
    }
    return this.prisma.incident.update({
      where: { id: incident.id },
      data: { status: to },
    });
  }
}

export function deriveCause(check: DownCheck): string {
  if (check.timedOut) return 'timeout';
  if (check.statusCode !== null) {
    if (check.statusCode >= 500) return 'http_5xx';
    if (check.statusCode >= 400) return 'http_4xx';
  }
  return check.error ?? 'network';
}
