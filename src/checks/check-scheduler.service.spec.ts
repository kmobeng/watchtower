import 'reflect-metadata';
import {
  CHECK_MONITOR_JOB,
  CheckSchedulerService,
  checkSchedulerId,
} from './check-scheduler.service';
import type { FleetConfig } from './check-regions';

describe('CheckSchedulerService', () => {
  let service: CheckSchedulerService;
  let queueA: {
    upsertJobScheduler: jest.Mock;
    removeJobScheduler: jest.Mock;
    getJobSchedulers: jest.Mock;
  };
  let queueB: typeof queueA;

  const apiFleet: FleetConfig = {
    regions: ['a', 'b'],
    region: null,
    scheduleRegions: ['a', 'b'],
    quorum: 2,
  };

  function makeQueue() {
    return {
      upsertJobScheduler: jest.fn(),
      removeJobScheduler: jest.fn(),
      getJobSchedulers: jest.fn().mockResolvedValue([]),
    };
  }

  beforeEach(() => {
    queueA = makeQueue();
    queueB = makeQueue();
    service = new CheckSchedulerService(
      apiFleet,
      new Map([
        ['a', queueA],
        ['b', queueB],
      ]) as never,
    );
  });

  it('fans out one scheduler per region with region-tagged data', async () => {
    await service.schedule({ id: 'mon-1', intervalSeconds: 300 });

    expect(queueA.upsertJobScheduler).toHaveBeenCalledWith(
      'monitor:mon-1',
      { every: 300000 },
      { name: CHECK_MONITOR_JOB, data: { monitorId: 'mon-1', region: 'a' } },
    );
    expect(queueB.upsertJobScheduler).toHaveBeenCalledWith(
      'monitor:mon-1',
      { every: 300000 },
      { name: CHECK_MONITOR_JOB, data: { monitorId: 'mon-1', region: 'b' } },
    );
  });

  it('unschedules every region by the same key', async () => {
    await service.unschedule('mon-1');

    expect(queueA.removeJobScheduler).toHaveBeenCalledWith('monitor:mon-1');
    expect(queueB.removeJobScheduler).toHaveBeenCalledWith('monitor:mon-1');
  });

  it('lists scheduled ids across queues without duplicates', async () => {
    queueA.getJobSchedulers.mockResolvedValue([
      { key: 'monitor:a' },
      { key: 'monitor:b' },
    ]);
    queueB.getJobSchedulers.mockResolvedValue([
      { key: 'monitor:b' },
      { key: 'monitor:c' },
    ]);

    await expect(service.listScheduledIds()).resolves.toEqual([
      'monitor:a',
      'monitor:b',
      'monitor:c',
    ]);
  });

  it('a worker fleet only touches its own queue', async () => {
    const worker = new CheckSchedulerService(
      {
        regions: ['a', 'b'],
        region: 'a',
        scheduleRegions: ['a'],
        quorum: 2,
      },
      new Map([['a', queueA]]) as never,
    );

    await worker.schedule({ id: 'mon-1', intervalSeconds: 60 });

    expect(queueA.upsertJobScheduler).toHaveBeenCalledTimes(1);
    expect(queueB.upsertJobScheduler).not.toHaveBeenCalled();
  });

  it('fails loudly when a region has no registered queue', async () => {
    const partial = new CheckSchedulerService(
      apiFleet,
      new Map([['a', queueA]]) as never,
    );

    await expect(
      partial.schedule({ id: 'mon-1', intervalSeconds: 60 }),
    ).rejects.toThrow(/No check queue registered for region b/);
  });

  it('builds stable scheduler ids', () => {
    expect(checkSchedulerId('mon-1')).toBe('monitor:mon-1');
  });
});
