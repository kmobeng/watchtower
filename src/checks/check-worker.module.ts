import { DynamicModule, Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { IncidentService } from '../incidents/incident.service';
import { IncidentEventsModule } from '../incidents/incident-events.module';
import type { FleetConfig } from './check-regions';
import { CheckSchedulingModule } from './check-scheduling.module';
import { CheckLockService } from './check-lock.service';
import { CheckProcessor } from './check.processor';
import { CheckReconciler } from './check-reconciler';

/**
 * The data plane: runs HTTP checks for one region and evaluates quorum.
 *
 * Deliberately does not import IncidentsModule or OutboxModule — those pull in
 * the escalation sweep and notification processors, and only the API process
 * should own those. IncidentService needs only Prisma and the Redis publisher,
 * so the worker imports the lightweight IncidentEventsModule instead.
 */
@Module({})
export class CheckWorkerModule {
  static forRoot(fleet: FleetConfig): DynamicModule {
    return {
      module: CheckWorkerModule,
      imports: [CheckSchedulingModule.forRoot(fleet), IncidentEventsModule],
      providers: [
        PrismaService,
        IncidentService,
        CheckLockService,
        CheckProcessor,
        CheckReconciler,
      ],
    };
  }
}
