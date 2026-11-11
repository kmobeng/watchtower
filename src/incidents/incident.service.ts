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
import type { QuorumVerdict } from '../checks/check-quorum';
import {
  escalationDeadline,
  tryParseEscalationSteps,
} from '../escalation-policies/escalation-steps';
import type { EscalationStep } from '../escalation-policies/escalation-steps';
import { IncidentEventPublisher } from './incident-event.publisher';
import { IncidentFeedEvent, toFeedIncident } from './incident-feed.events';

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
 * Acknowledge moves OPEN or ESCALATED to ACKNOWLEDGED atomically; RESOLVED is
 * terminal. See `acknowledge` for the conditional write that enforces it.
 */
@Injectable()
export class IncidentService {
  private readonly logger = new Logger(IncidentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly publisher: IncidentEventPublisher,
  ) {}

  /**
   * Consumes one quorum verdict. Opens on 'down' (idempotent), resolves on
   * 'up', and holds on 'hold' — no transition without quorum evidence. Called
   * by the check processor; nothing else should open or auto-resolve
   * incidents.
   */
  async handleVerdict(
    monitorId: string,
    verdict: { state: QuorumVerdict } | null,
    check: DownCheck,
  ): Promise<Incident | null> {
    if (!verdict) return null;

    if (verdict.state === 'down') {
      return this.openIfNeeded(monitorId, check);
    }
    if (verdict.state === 'up') {
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

    const result = await this.prisma.incident.updateMany({
      where: {
        id: incident.id,
        // Only an unacknowledged incident can be acknowledged. The status is
        // part of the write, so a concurrent escalation cannot win the race
        // and resurrect an incident the user just acknowledged.
        status: { in: [IncidentStatus.OPEN, IncidentStatus.ESCALATED] },
      },
      data: {
        status: IncidentStatus.ACKNOWLEDGED,
        acknowledgedAt: new Date(),
        nextEscalationAt: null,
      },
    });

    if (result.count === 0) {
      throw new ConflictException(
        `Cannot transition incident from ${incident.status} to ${IncidentStatus.ACKNOWLEDGED}`,
      );
    }

    const updated = await this.prisma.incident.findUniqueOrThrow({
      where: { id: incident.id },
    });

    await this.publisher.publish(
      IncidentFeedEvent.Acknowledged,
      toFeedIncident(updated, incident.monitor.userId),
    );

    return updated;
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

    const { userId, steps } = await this.monitorContext(monitorId);
    const startedAt = new Date();
    const nextEscalationAt = steps
      ? escalationDeadline(startedAt, steps, 0)
      : null;

    let incident: Incident;
    try {
      incident = await this.prisma.incident.create({
        data: {
          monitorId,
          status: IncidentStatus.OPEN,
          cause: deriveCause(check),
          openedByCheckId: check.id,
          startedAt,
          nextEscalationAt,
        },
      });
    } catch (error) {
      // Lost a concurrent open race: the partial unique index rejected us,
      // so return the winner instead of failing. The winner publishes.
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

    this.logger.log(
      { incidentId: incident.id, monitorId, cause: incident.cause },
      'Incident opened',
    );

    await this.publisher.publish(
      IncidentFeedEvent.Opened,
      toFeedIncident(incident, userId),
    );

    return incident;
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
    // Several regions can report 'up' concurrently. The status is part of the
    // write so only the first resolver wins and the rest see count 0; a plain
    // update would let a loser overwrite resolvedAt and downtimeSeconds.
    const result = await this.prisma.incident.updateMany({
      where: { id: existing.id, status: { in: OPEN_STATUSES } },
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
        // Resolution ends the escalation chain; the sweep also filters on
        // open status, so this is defence in depth.
        nextEscalationAt: null,
      },
    });

    if (result.count === 0) {
      return null;
    }

    const incident = await this.prisma.incident.findUniqueOrThrow({
      where: { id: existing.id },
      include: { monitor: { select: { userId: true } } },
    });
    this.logger.log(
      {
        incidentId: incident.id,
        monitorId,
        downtimeSeconds: incident.downtimeSeconds,
      },
      'Incident resolved',
    );

    await this.publisher.publish(
      IncidentFeedEvent.Resolved,
      toFeedIncident(incident, incident.monitor.userId),
    );

    return incident;
  }

  private async monitorContext(monitorId: string): Promise<{
    userId: string;
    steps: EscalationStep[] | null;
  }> {
    const monitor = await this.prisma.monitor.findUnique({
      where: { id: monitorId },
      select: {
        userId: true,
        escalationPolicy: { select: { steps: true } },
      },
    });

    return {
      userId: monitor?.userId ?? '',
      steps: monitor?.escalationPolicy
        ? tryParseEscalationSteps(monitor.escalationPolicy.steps)
        : null,
    };
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
