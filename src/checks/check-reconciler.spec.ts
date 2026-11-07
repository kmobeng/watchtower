import 'reflect-metadata';
import { CheckReconciler } from './check-reconciler';
import { PrismaService } from '../prisma.service';
import { CheckSchedulerService } from './check-scheduler.service';

describe('CheckReconciler', () => {
  it('schedules every monitor through the region-scoped scheduler', async () => {
    const monitors = [
      { id: 'mon-1', intervalSeconds: 60 },
      { id: 'mon-2', intervalSeconds: 120 },
    ];
    const prisma = {
      monitor: { findMany: jest.fn().mockResolvedValue(monitors) },
    };
    const scheduler = { schedule: jest.fn().mockResolvedValue(undefined) };

    const reconciler = new CheckReconciler(
      prisma as unknown as PrismaService,
      scheduler as unknown as CheckSchedulerService,
    );

    await reconciler.onModuleInit();

    expect(prisma.monitor.findMany).toHaveBeenCalledWith({
      select: { id: true, intervalSeconds: true },
    });
    expect(scheduler.schedule).toHaveBeenCalledTimes(2);
    expect(scheduler.schedule).toHaveBeenNthCalledWith(1, monitors[0]);
    expect(scheduler.schedule).toHaveBeenNthCalledWith(2, monitors[1]);
  });
});
