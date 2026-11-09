import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import {
  CHECK_FLEET_CONFIG,
  DEFAULT_CHECK_REGION,
  checkQueueName,
} from './check-regions';
import type { FleetConfig } from './check-regions';
import {
  CHECK_MONITOR_JOB,
  CheckSchedulerService,
} from './check-scheduler.service';
import type { CheckMonitorJob } from './check-scheduler.service';
import { classifyCheck } from './check-classifier';
import { CheckLockService, scheduledTimeOfJob } from './check-lock.service';
import { runHttpCheck } from './check-http';
import { evaluateQuorum, freshnessWindowMs } from './check-quorum';
import type { QuorumEvaluation, RegionSnapshot } from './check-quorum';
import { IncidentService } from '../incidents/incident.service';
import { PrismaService } from '../prisma.service';

// Evaluated at import so the @Processor decorator can pick its region queue.
// Entrypoints import 'dotenv/config' first, before this module is loaded.
const WORKER_REGION = process.env.CHECK_REGION?.trim() || DEFAULT_CHECK_REGION;

@Processor(checkQueueName(WORKER_REGION))
export class CheckProcessor extends WorkerHost {
  private readonly logger = new Logger(CheckProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scheduler: CheckSchedulerService,
    private readonly incidents: IncidentService,
    private readonly locks: CheckLockService,
    @Inject(CHECK_FLEET_CONFIG) private readonly fleet: FleetConfig,
  ) {
    super();
  }

  async process(job: Job<CheckMonitorJob>): Promise<QuorumEvaluation | null> {
    if (job.name !== CHECK_MONITOR_JOB) {
      this.logger.warn(
        { jobId: job.id, jobName: job.name },
        `No handler for job name: ${job.name}`,
      );
      return null;
    }

    const region = job.data.region ?? this.fleet.region ?? DEFAULT_CHECK_REGION;

    if (this.fleet.region !== null && region !== this.fleet.region) {
      // Queues are region-scoped, so this should be impossible. Dropping is
      // safer than probing from the wrong region and corrupting the quorum.
      this.logger.warn(
        { jobRegion: region, workerRegion: this.fleet.region },
        'Dropping job for another region',
      );
      return null;
    }

    const scheduledTime = scheduledTimeOfJob(job);
    const token = await this.locks.acquire(
      region,
      job.data.monitorId,
      scheduledTime,
    );

    if (!token) {
      this.logger.log(
        {
          monitorId: job.data.monitorId,
          region,
          scheduledTime,
        },
        'Check already claimed by another worker, skipping duplicate',
      );
      return null;
    }

    try {
      return await this.runCheck(job.data.monitorId, region);
    } catch (error) {
      // A held lock would turn BullMQ's retry into a silent no-op. Release it
      // so the retry can claim the slot, and never mask the original failure.
      try {
        await this.locks.release(
          region,
          job.data.monitorId,
          scheduledTime,
          token,
        );
      } catch (releaseError) {
        this.logger.warn(
          {
            monitorId: job.data.monitorId,
            region,
            scheduledTime,
            err: releaseError,
          },
          'Failed to release check lock',
        );
      }

      throw error;
    }
  }

  private async runCheck(
    monitorId: string,
    region: string,
  ): Promise<QuorumEvaluation | null> {
    const monitor = await this.prisma.monitor.findUnique({
      where: { id: monitorId },
    });

    if (!monitor) {
      await this.scheduler.unschedule(monitorId);
      this.logger.log({ monitorId, region }, 'Monitor gone, scheduler pruned');
      return null;
    }

    const result = await runHttpCheck(monitor.url, monitor.timeoutMs);
    const isUp = classifyCheck(result.statusCode);

    // Record this region's result before evaluating, so the snapshot query
    // below sees it.
    const check = await this.prisma.check.create({
      data: {
        monitorId: monitor.id,
        region,
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
        region,
        statusCode: result.statusCode,
        responseTimeMs: result.responseTimeMs,
        isUp,
      },
      'Check recorded',
    );

    const snapshots = await this.loadSnapshots(
      monitor.id,
      monitor.failureThreshold,
    );

    const evaluation = evaluateQuorum({
      snapshots,
      threshold: monitor.failureThreshold,
      quorum: this.fleet.quorum,
      now: new Date(),
      freshnessMs: freshnessWindowMs(monitor.intervalSeconds),
    });

    this.logger.log(
      {
        monitorId: monitor.id,
        region,
        verdict: evaluation.verdict,
        freshRegions: evaluation.freshRegions,
        downRegions: evaluation.downRegions,
        upRegions: evaluation.upRegions,
        threshold: monitor.failureThreshold,
      },
      'Quorum evaluated',
    );

    // Incidents own what happens next: open on 'down', resolve on 'up', and
    // ignore 'hold'.
    await this.incidents.handleVerdict(
      monitor.id,
      { state: evaluation.verdict },
      check,
    );

    return evaluation;
  }

  private async loadSnapshots(
    monitorId: string,
    threshold: number,
  ): Promise<RegionSnapshot[]> {
    // One small indexed query per region. This stays correct even when one
    // region is slow: a shared limit could crowd its history out.
    return Promise.all(
      this.fleet.regions.map(async (region) => {
        const recent = await this.prisma.check.findMany({
          where: { monitorId, region },
          orderBy: { checkedAt: 'desc' },
          take: threshold,
          select: { isUp: true, checkedAt: true },
        });

        return {
          region,
          recent,
          latestCheckedAt: recent[0]?.checkedAt ?? null,
        };
      }),
    );
  }
}
