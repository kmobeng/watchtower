import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { CHECK_FLEET_CONFIG, checkQueueName } from './check-regions';
import type { FleetConfig } from './check-regions';

export const CHECK_MONITOR_JOB = 'check-monitor';
export const CHECK_QUEUES = Symbol('CHECK_QUEUES');

export type CheckMonitorJob = {
  monitorId: string;
  region: string;
};

export function checkSchedulerId(monitorId: string): string {
  return `monitor:${monitorId}`;
}

/**
 * Owns the repeatable jobs that drive checks. The API schedules one scheduler
 * per configured region; a worker schedules only the region it serves, so a
 * new region can be added without touching the API.
 */
@Injectable()
export class CheckSchedulerService {
  private readonly logger = new Logger(CheckSchedulerService.name);

  constructor(
    @Inject(CHECK_FLEET_CONFIG) private readonly fleet: FleetConfig,
    @Inject(CHECK_QUEUES) private readonly queues: ReadonlyMap<string, Queue>,
  ) {}

  async schedule(monitor: {
    id: string;
    intervalSeconds: number;
  }): Promise<void> {
    await Promise.all(
      this.fleet.scheduleRegions.map((region) => {
        const queue = this.requireQueue(region);
        return queue.upsertJobScheduler(
          checkSchedulerId(monitor.id),
          { every: monitor.intervalSeconds * 1000 },
          {
            name: CHECK_MONITOR_JOB,
            data: { monitorId: monitor.id, region },
          },
        );
      }),
    );

    this.logger.log(
      {
        monitorId: monitor.id,
        everyMs: monitor.intervalSeconds * 1000,
        regions: this.fleet.scheduleRegions,
      },
      'Check scheduled',
    );
  }

  async unschedule(monitorId: string): Promise<void> {
    await Promise.all(
      this.fleet.scheduleRegions.map((region) =>
        this.requireQueue(region).removeJobScheduler(
          checkSchedulerId(monitorId),
        ),
      ),
    );

    this.logger.log(
      { monitorId, regions: this.fleet.scheduleRegions },
      'Check unscheduled',
    );
  }

  async listScheduledIds(): Promise<string[]> {
    const ids = new Set<string>();

    for (const queue of this.queues.values()) {
      for (const scheduler of await queue.getJobSchedulers()) {
        ids.add(scheduler.key);
      }
    }

    return [...ids];
  }

  private requireQueue(region: string): Queue {
    const queue = this.queues.get(region);
    if (!queue) {
      throw new Error(
        `No check queue registered for region ${region} (expected ${checkQueueName(region)})`,
      );
    }
    return queue;
  }
}
