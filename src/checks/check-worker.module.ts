import { DynamicModule, Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { IncidentService } from '../incidents/incident.service';
import type { FleetConfig } from './check-regions';
import { CheckSchedulingModule } from './check-scheduling.module';
import { CheckProcessor } from './check.processor';
import { CheckReconciler } from './check-reconciler';

/**
 * The data plane: runs HTTP checks for one region and evaluates quorum.
 *
 * Deliberately does not import IncidentsModule or OutboxModule — those pull in
 * the escalation sweep and notification processors, and only the API process
 * should own those. IncidentService has a Prisma-only constructor, so the
 * worker can provide it directly.
 */
@Module({})
export class CheckWorkerModule {
  static forRoot(fleet: FleetConfig): DynamicModule {
    return {
      module: CheckWorkerModule,
      imports: [CheckSchedulingModule.forRoot(fleet)],
      providers: [
        PrismaService,
        IncidentService,
        CheckProcessor,
        CheckReconciler,
      ],
    };
  }
}
