import 'reflect-metadata';
import {
  CHECK_MONITOR_JOB,
  CheckSchedulerService,
  checkSchedulerId,
} from './check-scheduler.service';

describe('CheckSchedulerService', () => {
  let service: CheckSchedulerService;
  let queue: {
    upsertJobScheduler: jest.Mock;
    removeJobScheduler: jest.Mock;
    getJobSchedulers: jest.Mock;
  };

  beforeEach(() => {
    queue = {
      upsertJobScheduler: jest.fn(),
      removeJobScheduler: jest.fn(),
      getJobSchedulers: jest.fn(),
    };
    service = new CheckSchedulerService(queue as never);
  });

  it('schedules keyed by monitor id with interval in ms', async () => {
    await service.schedule({ id: 'mon-1', intervalSeconds: 300 });

    expect(queue.upsertJobScheduler).toHaveBeenCalledWith(
      'monitor:mon-1',
      { every: 300000 },
      { name: CHECK_MONITOR_JOB, data: { monitorId: 'mon-1' } },
    );
  });

  it('unschedules by the same key', async () => {
    await service.unschedule('mon-1');

    expect(queue.removeJobScheduler).toHaveBeenCalledWith('monitor:mon-1');
  });

  it('lists scheduled ids from scheduler keys', async () => {
    queue.getJobSchedulers.mockResolvedValue([
      { key: 'monitor:a' },
      { key: 'monitor:b' },
    ]);

    await expect(service.listScheduledIds()).resolves.toEqual([
      'monitor:a',
      'monitor:b',
    ]);
  });

  it('builds stable scheduler ids', () => {
    expect(checkSchedulerId('mon-1')).toBe('monitor:mon-1');
  });
});
