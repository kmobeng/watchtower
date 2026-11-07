import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaService } from '../prisma.service';
import { NotificationChannelsController } from './notification-channels.controller';
import { NotificationChannelsService } from './notification-channels.service';

@Module({
  imports: [AuthModule],
  controllers: [NotificationChannelsController],
  providers: [NotificationChannelsService, PrismaService],
  exports: [NotificationChannelsService],
})
export class NotificationChannelsModule {}
