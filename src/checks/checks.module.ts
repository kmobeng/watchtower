import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PrismaService } from '../prisma.service';
import { MONITOR_CHECKS_QUEUE } from './check-scheduler.service';
import { CheckSchedulerService } from './check-scheduler.service';
import { CheckProcessor } from './check.processor';
import { CheckReconciler } from './check-reconciler';

@Module({
  imports: [
    BullModule.registerQueue({
      name: MONITOR_CHECKS_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 100,
        removeOnFail: 500,
      },
    }),
  ],
  providers: [
    CheckSchedulerService,
    CheckProcessor,
    CheckReconciler,
    PrismaService,
  ],
  exports: [CheckSchedulerService],
})
export class ChecksModule {}
