import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WsJwtGuard } from '../common/guards/ws-jwt.guard';
import { PrismaService } from '../prisma.service';
import { DashboardGateway } from './dashboard.gateway';
import { DashboardSubscriberService } from './dashboard.subscriber';

/**
 * API-only live dashboard feed. The worker process imports IncidentEventsModule
 * (Redis publisher) but never this module, so it cannot register a gateway or a
 * subscriber connection.
 */
@Module({
  imports: [AuthModule],
  providers: [
    DashboardGateway,
    DashboardSubscriberService,
    WsJwtGuard,
    PrismaService,
  ],
  exports: [DashboardGateway],
})
export class DashboardModule {}
