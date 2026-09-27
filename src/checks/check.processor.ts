import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { CHECK_REGION } from './check-region';
import {
  CHECK_MONITOR_JOB,
  MONITOR_CHECKS_QUEUE,
} from './check-scheduler.service';
import { CheckSchedulerService } from './check-scheduler.service';
import { classifyCheck } from './check-classifier';
import { runHttpCheck } from './check-http';
import { PrismaService } from '../prisma.service';

type CheckMonitorData = {
  monitorId: string;
};

@Processor(MONITOR_CHECKS_QUEUE)
export class CheckProcessor extends WorkerHost {
  private readonly logger = new Logger(CheckProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scheduler: CheckSchedulerService,
  ) {
    super();
  }

  async process(job: Job<CheckMonitorData>): Promise<void> {
    switch (job.name) {
      case CHECK_MONITOR_JOB: {
        await this.runCheck(job.data.monitorId);
        break;
      }
      default:
        this.logger.warn(
          { jobId: job.id, jobName: job.name },
          `No handler for job name: ${job.name}`,
        );
    }
  }

  private async runCheck(monitorId: string): Promise<void> {
    const monitor = await this.prisma.monitor.findUnique({
      where: { id: monitorId },
    });

    if (!monitor) {
      await this.scheduler.unschedule(monitorId);
      this.logger.log({ monitorId }, 'Monitor gone, scheduler pruned');
      return;
    }

    const result = await runHttpCheck(monitor.url, monitor.timeoutMs);
    const isUp = classifyCheck(result.statusCode);

    // A DOWN result is a successful job: persist it and return normally.
    // Only infra failures (e.g. the DB write below) throw, letting BullMQ
    // retry with backoff. Retrying a 500 or a timeout would just re-hammer
    // a struggling target and skew response-time history.
    await this.prisma.check.create({
      data: {
        monitorId: monitor.id,
        region: CHECK_REGION,
        statusCode: result.statusCode,
        responseTimeMs: result.responseTimeMs,
        isUp,
        timedOut: result.timedOut,
        error: result.error,
      },
    });

    this.logger.log(
      {
        monitorId: monitor.id,
        statusCode: result.statusCode,
        responseTimeMs: result.responseTimeMs,
        isUp,
      },
      'Check recorded',
    );
  }
}
