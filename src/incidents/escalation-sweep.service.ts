import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { IncidentStatus } from '../../generated/prisma/client';
import { PrismaService } from '../prisma.service';
import { OutboxService } from '../outbox/outbox.service';
import { FlapDetectorService } from '../flapping/flap-detector.service';
import {
  escalationDeadline,
  tryParseEscalationSteps,
} from '../escalation-policies/escalation-steps';
import { IncidentEventPublisher } from './incident-event.publisher';
import { IncidentFeedEvent, toFeedIncident } from './incident-feed.events';

type DueIncident = {
  id: string;
  monitorId: string;
  cause: string;
  startedAt: Date;
  escalationStep: number;
  monitor: {
    userId: string;
    escalationPolicy: { steps: unknown } | null;
  };
};

const OPEN_STATUSES = [IncidentStatus.OPEN, IncidentStatus.ESCALATED];

@Injectable()
export class EscalationSweepService {
  private readonly logger = new Logger(EscalationSweepService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly flaps: FlapDetectorService,
    private readonly publisher: IncidentEventPublisher,
  ) {}

  @Cron('*/15 * * * * *') // Every 15 seconds for now, until we have a better idea of the load.
  async sweep(): Promise<void> {
    const due = (await this.prisma.incident.findMany({
      where: {
        status: { in: OPEN_STATUSES },
        nextEscalationAt: { not: null, lte: new Date() },
      },
      include: {
        monitor: {
          select: {
            userId: true,
            escalationPolicy: { select: { steps: true } },
          },
        },
      },
      orderBy: { nextEscalationAt: 'asc' },
      take: 100,
    })) as DueIncident[];

    for (const incident of due) {
      try {
        if (await this.flaps.isFlapping(incident.monitorId)) {
          // Keep the incident and its deadline: once the monitor stabilises
          // the next tick resumes the chain from where it stopped.
          this.logger.log(
            { incidentId: incident.id, monitorId: incident.monitorId },
            'Monitor is flapping, suppressing escalation',
          );
          continue;
        }

        await this.escalate(incident);
      } catch (error) {
        // One bad incident must not stop the rest of the batch.
        this.logger.error(
          {
            incidentId: incident.id,
            err: error instanceof Error ? error.message : String(error),
          },
          'Escalation tick failed',
        );
      }
    }
  }

  private async escalate(incident: DueIncident): Promise<void> {
    const steps = incident.monitor.escalationPolicy
      ? tryParseEscalationSteps(incident.monitor.escalationPolicy.steps)
      : null;

    if (!steps) {
      this.logger.warn(
        { incidentId: incident.id, monitorId: incident.monitorId },
        'No usable escalation policy; clearing deadline',
      );
      await this.clearDeadline(incident.id);
      return;
    }

    const stepIndex = incident.escalationStep;
    const step = steps[stepIndex];

    if (!step) {
      // The policy shrank below the current step: the chain is finished.
      await this.clearDeadline(incident.id);
      return;
    }

    // Recompute from startedAt so a policy edited mid-incident moves the
    // deadline instead of firing the next step early.
    const dueAt = escalationDeadline(incident.startedAt, steps, stepIndex);
    if (!dueAt) {
      await this.clearDeadline(incident.id);
      return;
    }
    if (dueAt.getTime() > Date.now()) {
      await this.prisma.incident.updateMany({
        where: {
          id: incident.id,
          status: { in: OPEN_STATUSES },
          escalationStep: stepIndex,
        },
        data: { nextEscalationAt: dueAt },
      });
      return;
    }

    const following = escalationDeadline(
      incident.startedAt,
      steps,
      stepIndex + 1,
    );

    const escalated = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.incident.updateMany({
        where: {
          id: incident.id,
          status: { in: OPEN_STATUSES },
          escalationStep: stepIndex,
        },
        data: {
          // Step 0 is the immediate first alert, not an escalation. Only
          // later steps move the incident into ESCALATED.
          ...(stepIndex > 0 ? { status: IncidentStatus.ESCALATED } : {}),
          escalationStep: stepIndex + 1,
          nextEscalationAt: following,
        },
      });

      // Acked, resolved, or another instance got there first.
      if (updated.count === 0) return false;

      // Same transaction as the state change, so a notification intent can
      // never be lost between the update and the outbox write.
      await this.outbox.createEvent(tx, {
        aggregateType: 'incident',
        aggregateId: incident.id,
        eventType: 'incident-escalated',
        payload: {
          incidentId: incident.id,
          monitorId: incident.monitorId,
          cause: incident.cause,
          step: stepIndex,
          notifyChannelId: step.notifyChannelId,
        },
      });

      return true;
    });

    if (escalated) {
      this.logger.log(
        {
          incidentId: incident.id,
          monitorId: incident.monitorId,
          step: stepIndex,
          notifyChannelId: step.notifyChannelId,
          nextEscalationAt: following,
        },
        'Incident escalated',
      );

      // Step 0 is the first alert and leaves the incident OPEN; later steps
      // move it to ESCALATED. The dashboard distinguishes the two.
      await this.publisher.publish(
        stepIndex > 0 ? IncidentFeedEvent.Escalated : IncidentFeedEvent.Updated,
        toFeedIncident(
          {
            id: incident.id,
            monitorId: incident.monitorId,
            status:
              stepIndex > 0 ? IncidentStatus.ESCALATED : IncidentStatus.OPEN,
            cause: incident.cause,
            startedAt: incident.startedAt,
            acknowledgedAt: null,
            resolvedAt: null,
            downtimeSeconds: null,
            escalationStep: stepIndex + 1,
            nextEscalationAt: following,
          },
          incident.monitor.userId,
        ),
      );
    }
  }

  private async clearDeadline(incidentId: string): Promise<void> {
    await this.prisma.incident.updateMany({
      where: { id: incidentId, status: { in: OPEN_STATUSES } },
      data: { nextEscalationAt: null },
    });
  }
}
