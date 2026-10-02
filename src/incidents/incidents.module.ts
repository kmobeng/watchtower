import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaService } from '../prisma.service';
import { IncidentService } from './incident.service';
import { IncidentsController } from './incidents.controller';

@Module({
  imports: [AuthModule],
  controllers: [IncidentsController],
  providers: [IncidentService, PrismaService],
  exports: [IncidentService],
})
export class IncidentsModule {}
