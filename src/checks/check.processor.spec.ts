import 'reflect-metadata';
import { CheckProcessor } from './check.processor';
import { CHECK_MONITOR_JOB } from './check-scheduler.service';
import { PrismaService } from '../prisma.service';
import { CheckSchedulerService } from './check-scheduler.service';

describe('CheckProcessor', () => {
  let processor: CheckProcessor;
  let prisma: {
    monitor: { findUnique: jest.Mock };
    check: { create: jest.Mock };
  };
  let scheduler: { unschedule: jest.Mock };

  const monitor = {
    id: 'mon-1',
    url: 'https://example.com/health',
    timeoutMs: 10000,
  };

  function jobFor(monitorId: string) {
    return { id: 'job-1', name: CHECK_MONITOR_JOB, data: { monitorId } } as never;
  }

  beforeEach(() => {
    prisma = {
      monitor: { findUnique: jest.fn() },
      check: { create: jest.fn() },
    };
    scheduler = { unschedule: jest.fn() };
    processor = new CheckProcessor(
      prisma as unknown as PrismaService,
      scheduler as unknown as CheckSchedulerService,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('persists an up check on 200', async () => {
    prisma.monitor.findUnique.mockResolvedValue(monitor);
    jest.spyOn(global, 'fetch').mockResolvedValue({
      status: 200,
      body: { cancel: jest.fn().mockResolvedValue(undefined) },
    } as never);

    await processor.process(jobFor('mon-1'));

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
  });

  it('persists a down check on 500 without throwing', async () => {
    prisma.monitor.findUnique.mockResolvedValue(monitor);
    jest.spyOn(global, 'fetch').mockResolvedValue({
      status: 500,
      body: { cancel: jest.fn().mockResolvedValue(undefined) },
    } as never);

    await expect(processor.process(jobFor('mon-1'))).resolves.toBeUndefined();
    expect(prisma.check.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ statusCode: 500, isUp: false }),
    });
  });

  it('persists a timed-out check without throwing', async () => {
    prisma.monitor.findUnique.mockResolvedValue(monitor);
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    jest.spyOn(global, 'fetch').mockRejectedValue(abortError);

    await expect(processor.process(jobFor('mon-1'))).resolves.toBeUndefined();
    expect(prisma.check.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        statusCode: null,
        isUp: false,
        timedOut: true,
        error: 'timeout',
      }),
    });
  });

  it('prunes the scheduler and skips when the monitor is gone', async () => {
    prisma.monitor.findUnique.mockResolvedValue(null);

    await processor.process(jobFor('mon-gone'));

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
