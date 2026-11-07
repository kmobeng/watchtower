import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import {
  IncidentStatus,
  NotificationChannelType,
} from '../../generated/prisma/client';
import { PrismaService } from '../prisma.service';
import { EMAIL_SENDER } from '../notification/senders/email-sender.interface';
import type { EmailSender } from '../notification/senders/email-sender.interface';
import { SMS_SENDER } from '../notification/senders/sms-sender.interface';
import type { SmsSender } from '../notification/senders/sms-sender.interface';
import {
  DELIVER_INCIDENT_NOTIFICATION_JOB,
  INCIDENT_NOTIFICATIONS_QUEUE,
  IncidentNotificationJob,
} from './incident-notifications.service';
import { NotificationDeliveryService } from './notification-delivery.service';

@Processor(INCIDENT_NOTIFICATIONS_QUEUE)
export class IncidentNotificationsProcessor extends WorkerHost {
  private readonly logger = new Logger(IncidentNotificationsProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly deliveries: NotificationDeliveryService,
    @Inject(EMAIL_SENDER) private readonly emailSender: EmailSender,
    @Inject(SMS_SENDER) private readonly smsSender: SmsSender,
  ) {
    super();
  }

  async process(job: Job<IncidentNotificationJob>): Promise<void> {
    if (job.name !== DELIVER_INCIDENT_NOTIFICATION_JOB) {
      this.logger.warn({ jobName: job.name }, 'Unknown incident job');
      return;
    }

    const { incidentId, channelId, step } = job.data;

    const [incident, channel] = await Promise.all([
      this.prisma.incident.findUnique({
        where: { id: incidentId },
        include: { monitor: { select: { userId: true, url: true } } },
      }),
      this.prisma.notificationChannel.findUnique({ where: { id: channelId } }),
    ]);

    if (!incident || !channel) {
      // Without both rows there is nowhere to record a delivery; the policy
      // delete guard is what normally prevents this.
      this.logger.warn(
        { incidentId, channelId, step },
        'Incident or channel missing; dropping notification',
      );
      return;
    }

    const claim = await this.deliveries.claim({
      incidentId,
      channelId,
      step,
      channelType: channel.type,
      destination: channel.destination,
    });

    if (claim.kind === 'busy') {
      // Another worker holds a live lease. Throwing makes BullMQ retry after
      // the backoff, which is longer than the lease.
      throw new Error(
        `Delivery ${incidentId}/${channelId}/${step} is already in flight`,
      );
    }

    if (claim.kind === 'terminal') {
      this.logger.log(
        { incidentId, channelId, step, status: claim.delivery.status },
        'Delivery already settled; skipping',
      );
      return;
    }

    const delivery = claim.delivery;

    // A human may have acknowledged or resolved while the job sat in the
    // queue. Record the decision so a retry cannot fire it later.
    if (
      incident.status === IncidentStatus.ACKNOWLEDGED ||
      incident.status === IncidentStatus.RESOLVED
    ) {
      await this.deliveries.markSkipped(
        delivery.id,
        `incident is ${incident.status}`,
      );
      return;
    }

    if (channel.userId !== incident.monitor.userId) {
      await this.deliveries.markSkipped(
        delivery.id,
        'channel does not belong to the monitor owner',
      );
      return;
    }

    try {
      await this.send(channel.type, channel.destination, incident, step);
      await this.deliveries.markSent(delivery.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const terminal = await this.deliveries.markFailure(
        delivery.id,
        delivery.attempts,
        message,
      );

      this.logger.error(
        {
          incidentId,
          channelId,
          step,
          attempts: delivery.attempts,
          terminal,
          err: message,
        },
        'Notification delivery failed',
      );

      // Terminal failures are recorded and left alone; retryable ones throw
      // so BullMQ backs off and tries again.
      if (!terminal) {
        throw error;
      }
    }
  }

  private async send(
    type: NotificationChannelType,
    destination: string,
    incident: {
      id: string;
      cause: string;
      startedAt: Date;
      monitor: { url: string };
    },
    step: number,
  ): Promise<void> {
    if (type === NotificationChannelType.EMAIL) {
      await this.emailSender.send({
        to: destination,
        subject: `[WatchTower] ${incident.monitor.url} is down`,
        text: [
          `WatchTower detected that ${incident.monitor.url} is down.`,
          '',
          `Cause: ${incident.cause}`,
          `Started: ${incident.startedAt.toISOString()}`,
          `Incident: ${incident.id}`,
          `Escalation step: ${step}`,
          '',
          `Dashboard: ${process.env.APP_URL ?? ''}`,
        ].join('\n'),
        // Resend honours this for 24 hours; other providers ignore it.
        idempotencyKey: `${incident.id}:${destination}:${step}`,
      });
      return;
    }

    await this.smsSender.send({
      to: destination,
      body: `WatchTower: ${incident.monitor.url} is DOWN. Cause: ${incident.cause}. Incident ${incident.id}`,
    });
  }
}
