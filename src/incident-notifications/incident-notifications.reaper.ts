import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { NotificationDeliveryStatus } from '../../generated/prisma/client';
import { PrismaService } from '../prisma.service';
import { IncidentNotificationsService } from './incident-notifications.service';
import {
  DELIVERY_LEASE_MS,
  DELIVERY_MAX_ATTEMPTS,
  NotificationDeliveryService,
} from './notification-delivery.service';

const ORPHAN_AGE_MS = 10 * 60_000;

/**
 * Safety net for deliveries whose BullMQ job was lost (for example, the
 * process died on every attempt). A stale lease is re-enqueued; a row that
 * has already burned every attempt is marked FAILED so it stops looking
 * in-flight forever.
 */
@Injectable()
export class IncidentNotificationsReaper {
  private readonly logger = new Logger(IncidentNotificationsReaper.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly deliveries: NotificationDeliveryService,
    private readonly notifications: IncidentNotificationsService,
  ) {}

  @Cron('0 */5 * * * *')
  async reap(): Promise<void> {
    const leaseCutoff = new Date(Date.now() - DELIVERY_LEASE_MS * 2);
    const orphanCutoff = new Date(Date.now() - ORPHAN_AGE_MS);

    const stuck = await this.prisma.notificationDelivery.findMany({
      where: {
        status: NotificationDeliveryStatus.PENDING,
        OR: [
          { claimedAt: { lt: leaseCutoff } },
          { claimedAt: null, updatedAt: { lt: orphanCutoff } },
        ],
      },
      take: 100,
    });

    for (const delivery of stuck) {
      if (delivery.attempts >= DELIVERY_MAX_ATTEMPTS) {
        await this.deliveries.markAbandoned(
          delivery.id,
          'lease expired after maximum attempts',
        );
        continue;
      }

      await this.notifications.enqueueRecovery({
        incidentId: delivery.incidentId,
        channelId: delivery.channelId,
        step: delivery.step,
      });

      this.logger.warn(
        {
          deliveryId: delivery.id,
          incidentId: delivery.incidentId,
          attempts: delivery.attempts,
        },
        'Re-enqueued stalled delivery',
      );
    }
  }
}
