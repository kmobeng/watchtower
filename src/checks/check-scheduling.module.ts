import { DynamicModule, Module } from '@nestjs/common';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { CHECK_FLEET_CONFIG, checkQueueName } from './check-regions';
import type { FleetConfig } from './check-regions';
import { CHECK_QUEUES, CheckSchedulerService } from './check-scheduler.service';

const CHECK_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5000 },
  removeOnComplete: 100,
  removeOnFail: 500,
};

/**
 * Registers one BullMQ queue per region this process schedules work for.
 *
 * The API imports this with the full fleet, so it fans schedulers out to every
 * region. A worker imports it with a single-region fleet, so it only touches
 * its own queue.
 */
@Module({})
export class CheckSchedulingModule {
  static forRoot(fleet: FleetConfig): DynamicModule {
    const regions = [...new Set(fleet.scheduleRegions)];

    return {
      module: CheckSchedulingModule,
      imports: regions.map((region) =>
        BullModule.registerQueue({
          name: checkQueueName(region),
          defaultJobOptions: CHECK_JOB_OPTIONS,
        }),
      ),
      providers: [
        {
          provide: CHECK_FLEET_CONFIG,
          useValue: fleet,
        },
        {
          provide: CHECK_QUEUES,
          useFactory: (...queues: Queue[]) =>
            new Map(regions.map((region, index) => [region, queues[index]])),
          inject: regions.map((region) =>
            getQueueToken(checkQueueName(region)),
          ),
        },
        CheckSchedulerService,
      ],
      exports: [CheckSchedulerService, CHECK_FLEET_CONFIG, CHECK_QUEUES],
    };
  }
}
