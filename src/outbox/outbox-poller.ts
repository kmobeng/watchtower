import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { NotificationService } from '../notification/notification.service';
import { IncidentNotificationsService } from '../incident-notifications/incident-notifications.service';
import { FlapDetectorService } from '../flapping/flap-detector.service';
import { PrismaService } from '../prisma.service';

type OutboxEvent = {
  id: string;
  aggregateId: string;
  aggregateType: string;
  eventType: string;
  payload: Record<string, any>;
  createdAt: Date;
  processedAt: Date | null;
};

@Injectable()
export class OutboxPoller {
  private readonly logger = new Logger(OutboxPoller.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notificationService: NotificationService,
    private readonly incidentNotifications: IncidentNotificationsService,
    private readonly flaps: FlapDetectorService,
  ) {}

  @Cron(CronExpression.EVERY_5_SECONDS)
  async dispatchOutboxEvents() {
    const events = (await this.prisma.outboxEvent.findMany({
      where: { processedAt: null },
      orderBy: { createdAt: 'asc' },
      take: 50,
    })) as OutboxEvent[];

    if (events.length === 0) return;

    for (const event of events) {
      try {
        const processed = await this.handleEvent(event);

        if (!processed) {
          // Deferred, not failed: leave processedAt null so a later poll
          // retries once the monitor stabilises.
          this.logger.log(
            { outboxEventId: event.id, eventType: event.eventType },
            'Outbox event deferred',
          );
          continue;
        }

        await this.prisma.outboxEvent.update({
          where: { id: event.id },
          data: { processedAt: new Date() },
        });
      } catch (err) {
        this.logger.error(
          {
            outboxEventId: event.id,
            eventType: event.eventType,
            err: err instanceof Error ? err.message : String(err),
          },
          'Failed to dispatch outbox event',
        );
      }
    }
  }

  private async handleEvent(event: OutboxEvent): Promise<boolean> {
    const eventType = event.eventType;

    switch (eventType) {
      case 'user-registered':
        await this.notificationService.enqueueEmailVerification({
          to: event.payload.email,
          token: event.payload.verificationToken,
        });
        break;
      case 'password-reset-requested':
        await this.notificationService.enqueuePasswordReset({
          to: event.payload.email,
          token: event.payload.resetToken,
        });
        break;
      case 'email-verification-requested':
        await this.notificationService.enqueueEmailVerification({
          to: event.payload.email,
          token: event.payload.token,
        });
        break;
      case 'email-change-requested':
        await this.notificationService.enqueueEmailVerification({
          to: event.payload.email,
          token: event.payload.token,
        });
        await this.notificationService.enqueueEmailChangeNotice({
          to: event.payload.previousEmail,
          newEmail: event.payload.email,
        });
        break;
      case 'incident-escalated':
        // Race guard: the sweep already skips flapping monitors, but an event
        // written just before the flag appeared must not alert mid-flap.
        if (
          event.payload.monitorId &&
          (await this.flaps.isFlapping(event.payload.monitorId))
        ) {
          return false;
        }

        // The delivery row is created by the worker, not here: enqueueing is
        // cheap and the unique constraint is the actual idempotency gate.
        await this.incidentNotifications.enqueue({
          incidentId: event.payload.incidentId,
          channelId: event.payload.notifyChannelId,
          step: event.payload.step,
        });
        break;
      default:
        this.logger.warn(
          { eventType },
          `Unhandled outbox event type: ${eventType}`,
        );
    }

    return true;
  }
}
