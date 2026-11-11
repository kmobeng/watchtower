import 'reflect-metadata';
import { CheckProcessor } from './check.processor';
import { CHECK_MONITOR_JOB } from './check-scheduler.service';
import { PrismaService } from '../prisma.service';
import { CheckSchedulerService } from './check-scheduler.service';
import { IncidentService } from '../incidents/incident.service';
import { CheckLockService } from './check-lock.service';
import { FlapDetectorService } from '../flapping/flap-detector.service';
import type { FleetConfig } from './check-regions';

describe('CheckProcessor', () => {
  let processor: CheckProcessor;
  let prisma: {
    monitor: { findUnique: jest.Mock; updateMany: jest.Mock };
    check: { create: jest.Mock; findMany: jest.Mock };
  };
  let scheduler: { unschedule: jest.Mock };
  let incidents: { handleVerdict: jest.Mock };
  let locks: { acquire: jest.Mock; release: jest.Mock };
  let flaps: { record: jest.Mock };

  const fleet: FleetConfig = {
    regions: ['local'],
    region: 'local',
    scheduleRegions: ['local'],
    quorum: 1,
  };

  const monitor = {
    id: 'mon-1',
    url: 'https://example.com/health',
    method: 'GET',
    timeoutMs: 10000,
    responseTimeThresholdMs: null,
    failureThreshold: 3,
    intervalSeconds: 60,
  };

  function jobFor(
    monitorId: string,
    region = 'local',
    id = `repeat:monitor:${monitorId}:1700000000000`,
  ) {
    return {
      id,
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
      monitor: { findUnique: jest.fn(), updateMany: jest.fn() },
      check: { create: jest.fn(), findMany: jest.fn() },
    };
    scheduler = { unschedule: jest.fn() };
    incidents = { handleVerdict: jest.fn() };
    locks = {
      acquire: jest.fn().mockResolvedValue('lock-token'),
      release: jest.fn().mockResolvedValue(undefined),
    };
    flaps = {
      record: jest.fn().mockResolvedValue({ changes: 0, flapping: false }),
    };
    processor = new CheckProcessor(
      prisma as unknown as PrismaService,
      scheduler as unknown as CheckSchedulerService,
      incidents as unknown as IncidentService,
      locks as unknown as CheckLockService,
      flaps as unknown as FlapDetectorService,
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

  it('marks a slow response down and records the slow cause', async () => {
    prisma.monitor.findUnique.mockResolvedValue({
      ...monitor,
      responseTimeThresholdMs: 100,
    });
    prisma.check.findMany.mockResolvedValue(checks(true));
    jest.spyOn(global, 'fetch').mockResolvedValue({
      status: 200,
      body: { cancel: jest.fn().mockResolvedValue(undefined) },
    } as never);
    // runHttpCheck reads the clock once at start and once at finish.
    jest
      .spyOn(Date, 'now')
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(1_500);

    await processor.process(jobFor('mon-1'));

    expect(prisma.check.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        statusCode: 200,
        isUp: false,
        error: 'slow',
      }),
    });
  });

  it('persists the derived monitor state for read paths', async () => {
    prisma.monitor.findUnique.mockResolvedValue(monitor);
    prisma.check.findMany.mockResolvedValue(checks(false, false, false));
    jest.spyOn(global, 'fetch').mockResolvedValue({
      status: 500,
      body: { cancel: jest.fn().mockResolvedValue(undefined) },
    } as never);

    await processor.process(jobFor('mon-1'));

    expect(prisma.monitor.updateMany).toHaveBeenCalledWith({
      where: { id: 'mon-1', state: { not: 'DOWN' } },
      data: { state: 'DOWN' },
    });
  });

  it('does not fail a recorded check when persisting state fails', async () => {
    prisma.monitor.findUnique.mockResolvedValue(monitor);
    prisma.check.findMany.mockResolvedValue(checks(true));
    prisma.monitor.updateMany.mockRejectedValue(new Error('DB down'));
    jest.spyOn(global, 'fetch').mockResolvedValue({
      status: 200,
      body: { cancel: jest.fn().mockResolvedValue(undefined) },
    } as never);

    await expect(processor.process(jobFor('mon-1'))).resolves.toMatchObject({
      verdict: 'up',
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

  it('records the verdict for flapping before handing it to incidents', async () => {
    prisma.monitor.findUnique.mockResolvedValue(monitor);
    prisma.check.findMany.mockResolvedValue(checks(false));
    jest.spyOn(global, 'fetch').mockResolvedValue({
      status: 500,
      body: { cancel: jest.fn().mockResolvedValue(undefined) },
    } as never);

    await processor.process(jobFor('mon-1'));

    expect(flaps.record).toHaveBeenCalledWith('mon-1', 'hold');
    expect(flaps.record.mock.invocationCallOrder[0]).toBeLessThan(
      incidents.handleVerdict.mock.invocationCallOrder[0],
    );
  });

  it('claims the scheduled slot before probing', async () => {
    prisma.monitor.findUnique.mockResolvedValue(monitor);
    prisma.check.findMany.mockResolvedValue(checks(true));
    jest.spyOn(global, 'fetch').mockResolvedValue({
      status: 200,
      body: { cancel: jest.fn().mockResolvedValue(undefined) },
    } as never);

    await processor.process(jobFor('mon-1'));

    expect(locks.acquire).toHaveBeenCalledWith(
      'local',
      'mon-1',
      '1700000000000',
    );
    expect(locks.release).not.toHaveBeenCalled();
  });

  it('skips without probing when another worker owns the slot', async () => {
    locks.acquire.mockResolvedValue(null);

    await expect(processor.process(jobFor('mon-1'))).resolves.toBeNull();

    expect(prisma.monitor.findUnique).not.toHaveBeenCalled();
    expect(prisma.check.create).not.toHaveBeenCalled();
    expect(incidents.handleVerdict).not.toHaveBeenCalled();
    expect(flaps.record).not.toHaveBeenCalled();
    expect(locks.release).not.toHaveBeenCalled();
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

    expect(locks.release).toHaveBeenCalledWith(
      'local',
      'mon-1',
      '1700000000000',
      'lock-token',
    );
  });

  it('still rethrows the original failure when releasing the lock fails', async () => {
    prisma.monitor.findUnique.mockResolvedValue(monitor);
    jest.spyOn(global, 'fetch').mockResolvedValue({
      status: 200,
      body: { cancel: jest.fn().mockResolvedValue(undefined) },
    } as never);
    prisma.check.create.mockRejectedValue(new Error('DB down'));
    locks.release.mockRejectedValue(new Error('Redis down'));

    await expect(processor.process(jobFor('mon-1'))).rejects.toThrow('DB down');
  });
});
