import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { CheckSchedulerService } from './check-scheduler.service';

/**
 * Ensures every monitor row has a matching BullMQ job scheduler.
 * Heals schedulers lost to a Redis outage, a crash between DB write and
 * schedule, or rows created before scheduling existed. Runs once at boot.
 */
@Injectable()
export class CheckReconciler implements OnModuleInit {
  private readonly logger = new Logger(CheckReconciler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scheduler: CheckSchedulerService,
  ) {}

  async onModuleInit() {
    const monitors = await this.prisma.monitor.findMany({
      select: { id: true, intervalSeconds: true },
    });

    for (const monitor of monitors) {
      // Keyed upsert: already-scheduled monitors are left untouched,
      // so this never duplicates or resets running timers.
      await this.scheduler.schedule(monitor);
    }

    this.logger.log({ count: monitors.length }, 'Reconciled check schedulers');
  }
}
