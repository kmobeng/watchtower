import { Module } from '@nestjs/common';
import { OutboxService } from './outbox.service';
import { NotificationModule } from '../notification/notification.module';
import { IncidentNotificationsModule } from '../incident-notifications/incident-notifications.module';
import { OutboxPoller } from './outbox-poller';
import { PrismaService } from '../prisma.service';

@Module({
  imports: [NotificationModule, IncidentNotificationsModule],
  providers: [OutboxService, OutboxPoller, PrismaService],
  exports: [OutboxService],
})
export class OutboxModule {}
