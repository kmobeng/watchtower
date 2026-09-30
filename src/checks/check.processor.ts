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
import { evaluateStreak, StreakEvaluation } from './check-streak';
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

  async process(job: Job<CheckMonitorData>): Promise<StreakEvaluation | null> {
    switch (job.name) {
      case CHECK_MONITOR_JOB: {
        return this.runCheck(job.data.monitorId);
      }
      default:
        this.logger.warn(
          { jobId: job.id, jobName: job.name },
          `No handler for job name: ${job.name}`,
        );
        return null;
    }
  }

  private async runCheck(monitorId: string): Promise<StreakEvaluation | null> {
    const monitor = await this.prisma.monitor.findUnique({
      where: { id: monitorId },
    });

    if (!monitor) {
      await this.scheduler.unschedule(monitorId);
      this.logger.log({ monitorId }, 'Monitor gone, scheduler pruned');
      return null;
    }

    const result = await runHttpCheck(monitor.url, monitor.timeoutMs);
    const isUp = classifyCheck(result.statusCode);

    // Record the check result.
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

    // Evaluate the current streak of failures.
    const recent = await this.prisma.check.findMany({
      where: { monitorId: monitor.id },
      orderBy: { checkedAt: 'desc' },
      take: monitor.failureThreshold,
      select: { isUp: true },
    });

    const evaluation = evaluateStreak(recent, monitor.failureThreshold);
    this.logger.log(
      {
        monitorId: monitor.id,
        state: evaluation.state,
        consecutiveFailures: evaluation.consecutiveFailures,
        threshold: monitor.failureThreshold,
      },
      'Streak evaluated',
    );

    return evaluation;
  }
}
