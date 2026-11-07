import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { OutboxModule } from '../outbox/outbox.module';
import { PrismaService } from '../prisma.service';
import { EscalationSweepService } from './escalation-sweep.service';
import { IncidentService } from './incident.service';
import { IncidentsController } from './incidents.controller';

@Module({
  imports: [AuthModule, OutboxModule],
  controllers: [IncidentsController],
  providers: [IncidentService, EscalationSweepService, PrismaService],
  exports: [IncidentService],
})
export class IncidentsModule {}
