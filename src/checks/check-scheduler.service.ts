import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

export const MONITOR_CHECKS_QUEUE = 'monitor-checks';
export const CHECK_MONITOR_JOB = 'check-monitor';

export function checkSchedulerId(monitorId: string): string {
  return `monitor:${monitorId}`;
}

@Injectable()
export class CheckSchedulerService {
  private readonly logger = new Logger(CheckSchedulerService.name);

  constructor(
    @InjectQueue(MONITOR_CHECKS_QUEUE) private readonly queue: Queue,
  ) {}

  async schedule(monitor: {
    id: string;
    intervalSeconds: number;
  }): Promise<void> {
    await this.queue.upsertJobScheduler(
      checkSchedulerId(monitor.id),
      { every: monitor.intervalSeconds * 1000 },
      { name: CHECK_MONITOR_JOB, data: { monitorId: monitor.id } },
    );
    this.logger.log(
      { monitorId: monitor.id, everyMs: monitor.intervalSeconds * 1000 },
      'Check scheduled',
    );
  }

  async unschedule(monitorId: string): Promise<void> {
    // Returns false when nothing was scheduled; never throws for that case.
    await this.queue.removeJobScheduler(checkSchedulerId(monitorId));
    this.logger.log({ monitorId }, 'Check unscheduled');
  }

  async listScheduledIds(): Promise<string[]> {
    const schedulers = await this.queue.getJobSchedulers();
    return schedulers.map((scheduler) => scheduler.key);
  }
}
