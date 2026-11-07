import 'reflect-metadata';
import { CheckProcessor } from './check.processor';
import { CHECK_MONITOR_JOB } from './check-scheduler.service';
import { PrismaService } from '../prisma.service';
import { CheckSchedulerService } from './check-scheduler.service';
import { IncidentService } from '../incidents/incident.service';
import type { FleetConfig } from './check-regions';

describe('CheckProcessor', () => {
  let processor: CheckProcessor;
  let prisma: {
    monitor: { findUnique: jest.Mock };
    check: { create: jest.Mock; findMany: jest.Mock };
  };
  let scheduler: { unschedule: jest.Mock };
  let incidents: { handleVerdict: jest.Mock };

  const fleet: FleetConfig = {
    regions: ['local'],
    region: 'local',
    scheduleRegions: ['local'],
    quorum: 1,
  };

  const monitor = {
    id: 'mon-1',
    url: 'https://example.com/health',
    timeoutMs: 10000,
    failureThreshold: 3,
    intervalSeconds: 60,
  };

  function jobFor(monitorId: string, region = 'local') {
    return {
      id: 'job-1',
      name: CHECK_MONITOR_JOB,
      data: { monitorId, region },
    } as never;
  }

  function checks(...states: boolean[]) {
    const now = new Date();
    return states.map((isUp) => ({ isUp, checkedAt: now }));
  }

  beforeEach(() => {
    prisma = {
      monitor: { findUnique: jest.fn() },
      check: { create: jest.fn(), findMany: jest.fn() },
    };
    scheduler = { unschedule: jest.fn() };
    incidents = { handleVerdict: jest.fn() };
    processor = new CheckProcessor(
      prisma as unknown as PrismaService,
      scheduler as unknown as CheckSchedulerService,
      incidents as unknown as IncidentService,
      fleet,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('persists an up check and reports up', async () => {
    prisma.monitor.findUnique.mockResolvedValue(monitor);
    prisma.check.findMany.mockResolvedValue(checks(true));
    jest.spyOn(global, 'fetch').mockResolvedValue({
      status: 200,
      body: { cancel: jest.fn().mockResolvedValue(undefined) },
    } as never);

    await expect(processor.process(jobFor('mon-1'))).resolves.toMatchObject({
      verdict: 'up',
    });

    expect(prisma.check.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        monitorId: 'mon-1',
        region: 'local',
        statusCode: 200,
        isUp: true,
        timedOut: false,
        error: null,
      }),
    });
    expect(prisma.check.findMany).toHaveBeenCalledWith({
      where: { monitorId: 'mon-1', region: 'local' },
      orderBy: { checkedAt: 'desc' },
      take: 3,
      select: { isUp: true, checkedAt: true },
    });
  });

  it('persists a down check on 500 without throwing and holds below quorum', async () => {
    prisma.monitor.findUnique.mockResolvedValue(monitor);
    prisma.check.findMany.mockResolvedValue(checks(false));
    jest.spyOn(global, 'fetch').mockResolvedValue({
      status: 500,
      body: { cancel: jest.fn().mockResolvedValue(undefined) },
    } as never);

    await expect(processor.process(jobFor('mon-1'))).resolves.toMatchObject({
      verdict: 'hold',
    });
    expect(prisma.check.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ statusCode: 500, isUp: false }),
    });
  });

  it('persists a timed-out check without throwing', async () => {
    prisma.monitor.findUnique.mockResolvedValue(monitor);
    prisma.check.findMany.mockResolvedValue(checks(false, false));
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    jest.spyOn(global, 'fetch').mockRejectedValue(abortError);

    await expect(processor.process(jobFor('mon-1'))).resolves.toMatchObject({
      verdict: 'hold',
    });
    expect(prisma.check.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        statusCode: null,
        isUp: false,
        timedOut: true,
        error: 'timeout',
      }),
    });
  });

  it('reports down once the region reaches the threshold', async () => {
    prisma.monitor.findUnique.mockResolvedValue(monitor);
    prisma.check.findMany.mockResolvedValue(checks(false, false, false));
    jest.spyOn(global, 'fetch').mockResolvedValue({
      status: 500,
      body: { cancel: jest.fn().mockResolvedValue(undefined) },
    } as never);

    await expect(processor.process(jobFor('mon-1'))).resolves.toMatchObject({
      verdict: 'down',
      downRegions: ['local'],
    });
  });

  it('hands the quorum verdict and persisted check to incidents', async () => {
    const persistedCheck = { id: 'check-1' };
    prisma.monitor.findUnique.mockResolvedValue(monitor);
    prisma.check.create.mockResolvedValue(persistedCheck);
    prisma.check.findMany.mockResolvedValue(checks(false));
    jest.spyOn(global, 'fetch').mockResolvedValue({
      status: 500,
      body: { cancel: jest.fn().mockResolvedValue(undefined) },
    } as never);

    await processor.process(jobFor('mon-1'));

    expect(incidents.handleVerdict).toHaveBeenCalledWith(
      'mon-1',
      { state: 'hold' },
      persistedCheck,
    );
  });

  it('drops a job tagged for another region', async () => {
    await expect(
      processor.process(jobFor('mon-1', 'elsewhere')),
    ).resolves.toBeNull();

    expect(prisma.monitor.findUnique).not.toHaveBeenCalled();
    expect(prisma.check.create).not.toHaveBeenCalled();
  });

  it('prunes the scheduler and skips when the monitor is gone', async () => {
    prisma.monitor.findUnique.mockResolvedValue(null);

    await expect(processor.process(jobFor('mon-gone'))).resolves.toBeNull();

    expect(scheduler.unschedule).toHaveBeenCalledWith('mon-gone');
    expect(prisma.check.create).not.toHaveBeenCalled();
  });

  it('throws on infra failure so BullMQ retries', async () => {
    prisma.monitor.findUnique.mockResolvedValue(monitor);
    jest.spyOn(global, 'fetch').mockResolvedValue({
      status: 200,
      body: { cancel: jest.fn().mockResolvedValue(undefined) },
    } as never);
    prisma.check.create.mockRejectedValue(new Error('DB down'));

    await expect(processor.process(jobFor('mon-1'))).rejects.toThrow('DB down');
  });
});
