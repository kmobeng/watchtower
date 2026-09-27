import { ServiceUnavailableException } from '@nestjs/common';
import { MonitorsService } from './monitors.service';
import { PrismaService } from '../prisma.service';
import { CheckSchedulerService } from '../checks/check-scheduler.service';

describe('MonitorsService.findAll', () => {
  let service: MonitorsService;
  let prisma: {
    monitor: {
      findMany: jest.Mock;
      count: jest.Mock;
      create: jest.Mock;
      findFirst: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
      deleteMany: jest.Mock;
    };
    $transaction: jest.Mock;
  };
  let scheduler: {
    schedule: jest.Mock;
    unschedule: jest.Mock;
  };

  beforeEach(() => {
    prisma = {
      monitor: {
        findMany: jest.fn(),
        count: jest.fn(),
        create: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        deleteMany: jest.fn(),
      },
      $transaction: jest.fn((promises: Promise<unknown>[]) =>
        Promise.all(promises),
      ),
    };
    scheduler = { schedule: jest.fn(), unschedule: jest.fn() };
    service = new MonitorsService(
      prisma as unknown as PrismaService,
      scheduler as unknown as CheckSchedulerService,
    );
  });

  it('paginates with skip/take and returns meta', async () => {
    prisma.monitor.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
    prisma.monitor.count.mockResolvedValue(5);

    const result = await service.findAll('user-1', 2, 2);

    expect(prisma.monitor.findMany).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      orderBy: { createdAt: 'desc' },
      skip: 2,
      take: 2,
    });
    expect(prisma.monitor.count).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
    });
    expect(result).toEqual({
      items: [{ id: 'a' }, { id: 'b' }],
      total: 5,
      page: 2,
      limit: 2,
      totalPages: 3,
    });
  });

  it('returns an empty page instead of throwing', async () => {
    prisma.monitor.findMany.mockResolvedValue([]);
    prisma.monitor.count.mockResolvedValue(0);

    const result = await service.findAll('user-1', 1, 20);

    expect(result).toEqual({
      items: [],
      total: 0,
      page: 1,
      limit: 20,
      totalPages: 0,
    });
  });

  it('clamps limit to the max', async () => {
    prisma.monitor.findMany.mockResolvedValue([]);
    prisma.monitor.count.mockResolvedValue(0);

    const result = await service.findAll('user-1', 1, 500);

    expect(prisma.monitor.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 100 }),
    );
    expect(result.limit).toBe(100);
  });
});

describe('MonitorsService scheduling', () => {
  let service: MonitorsService;
  let prisma: {
    monitor: {
      create: jest.Mock;
      findFirst: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
      deleteMany: jest.Mock;
    };
  };
  let scheduler: {
    schedule: jest.Mock;
    unschedule: jest.Mock;
  };

  const monitor = {
    id: 'mon-1',
    userId: 'user-1',
    url: 'https://example.com/health',
    intervalSeconds: 300,
    timeoutMs: 10000,
    failureThreshold: 3,
  };

  beforeEach(() => {
    prisma = {
      monitor: {
        create: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        deleteMany: jest.fn(),
      },
    };
    scheduler = { schedule: jest.fn(), unschedule: jest.fn() };
    service = new MonitorsService(
      prisma as unknown as PrismaService,
      scheduler as unknown as CheckSchedulerService,
    );
  });

  it('schedules a check on create', async () => {
    prisma.monitor.create.mockResolvedValue(monitor);

    await service.create('user-1', {
      url: monitor.url,
      intervalSeconds: 300,
    });

    expect(scheduler.schedule).toHaveBeenCalledWith(monitor);
  });

  it('rolls back the monitor and throws 503 when scheduling fails', async () => {
    prisma.monitor.create.mockResolvedValue(monitor);
    scheduler.schedule.mockRejectedValue(new Error('Redis down'));

    await expect(
      service.create('user-1', { url: monitor.url, intervalSeconds: 300 }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(prisma.monitor.delete).toHaveBeenCalledWith({
      where: { id: monitor.id },
    });
  });

  it('leaves the timer alone when the interval is unchanged', async () => {
    prisma.monitor.findFirst.mockResolvedValue(monitor);
    prisma.monitor.update.mockResolvedValue(monitor);

    await service.update('user-1', 'mon-1', { url: 'https://example.com/x' });

    expect(scheduler.unschedule).not.toHaveBeenCalled();
    expect(scheduler.schedule).not.toHaveBeenCalled();
  });

  it('reschedules only when the interval changes', async () => {
    const updated = { ...monitor, intervalSeconds: 600 };
    prisma.monitor.findFirst.mockResolvedValue(monitor);
    prisma.monitor.update.mockResolvedValue(updated);

    await service.update('user-1', 'mon-1', { intervalSeconds: 600 });

    expect(scheduler.unschedule).toHaveBeenCalledWith('mon-1');
    expect(scheduler.schedule).toHaveBeenCalledWith(updated);
  });

  it('unschedules on remove', async () => {
    prisma.monitor.deleteMany.mockResolvedValue({ count: 1 });

    await service.remove('user-1', 'mon-1');

    expect(scheduler.unschedule).toHaveBeenCalledWith('mon-1');
  });

  it('still deletes when unscheduling fails on remove', async () => {
    prisma.monitor.deleteMany.mockResolvedValue({ count: 1 });
    scheduler.unschedule.mockRejectedValue(new Error('Redis down'));

    await expect(service.remove('user-1', 'mon-1')).resolves.toBeUndefined();
  });
});
