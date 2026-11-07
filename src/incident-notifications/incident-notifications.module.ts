import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PrismaService } from '../prisma.service';
import { SendersModule } from '../notification/senders/senders.module';
import {
  INCIDENT_NOTIFICATIONS_QUEUE,
  IncidentNotificationsService,
} from './incident-notifications.service';
import { IncidentNotificationsProcessor } from './incident-notifications.processor';
import { IncidentNotificationsReaper } from './incident-notifications.reaper';
import { NotificationDeliveryService } from './notification-delivery.service';

@Module({
  imports: [
    BullModule.registerQueue({
      name: INCIDENT_NOTIFICATIONS_QUEUE,
      defaultJobOptions: {
        attempts: 5,
        // Fixed delay longer than DELIVERY_LEASE_MS, so a retry after a crash
        // always finds the lease stale and can re-claim.
        backoff: { type: 'fixed', delay: 150_000 },
        removeOnComplete: 1000,
        removeOnFail: false,
      },
    }),
    SendersModule,
  ],
  providers: [
    IncidentNotificationsService,
    IncidentNotificationsProcessor,
    IncidentNotificationsReaper,
    NotificationDeliveryService,
    PrismaService,
  ],
  exports: [IncidentNotificationsService],
})
export class IncidentNotificationsModule {}
