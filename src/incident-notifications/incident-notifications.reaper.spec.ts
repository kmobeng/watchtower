import 'reflect-metadata';
import { NotificationDeliveryStatus } from '../../generated/prisma/client';
import type { PrismaService } from '../prisma.service';
import { IncidentNotificationsReaper } from './incident-notifications.reaper';
import type { IncidentNotificationsService } from './incident-notifications.service';
import type { NotificationDeliveryService } from './notification-delivery.service';

describe('IncidentNotificationsReaper', () => {
  let reaper: IncidentNotificationsReaper;
  let prisma: {
    notificationDelivery: { findMany: jest.Mock };
  };
  let deliveries: { markAbandoned: jest.Mock };
  let notifications: { enqueueRecovery: jest.Mock };

  beforeEach(() => {
    prisma = {
      notificationDelivery: { findMany: jest.fn().mockResolvedValue([]) },
    };
    deliveries = { markAbandoned: jest.fn().mockResolvedValue(undefined) };
    notifications = { enqueueRecovery: jest.fn().mockResolvedValue(undefined) };

    reaper = new IncidentNotificationsReaper(
      prisma as unknown as PrismaService,
      deliveries as unknown as NotificationDeliveryService,
      notifications as unknown as IncidentNotificationsService,
    );
    (reaper as any).logger = {
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
  });

  it('scans pending rows with a stale lease or an orphaned handback', async () => {
    await reaper.reap();

    expect(prisma.notificationDelivery.findMany).toHaveBeenCalledWith({
      where: {
        status: NotificationDeliveryStatus.PENDING,
        OR: [
          { claimedAt: { lt: expect.any(Date) } },
          { claimedAt: null, updatedAt: { lt: expect.any(Date) } },
        ],
      },
      take: 100,
    });
  });

  it('re-enqueues a stalled delivery', async () => {
    prisma.notificationDelivery.findMany.mockResolvedValue([
      {
        id: 'd1',
        incidentId: 'inc-1',
        channelId: 'chan-1',
        step: 0,
        attempts: 2,
      },
    ]);

    await reaper.reap();

    expect(notifications.enqueueRecovery).toHaveBeenCalledWith({
      incidentId: 'inc-1',
      channelId: 'chan-1',
      step: 0,
    });
    expect(deliveries.markAbandoned).not.toHaveBeenCalled();
  });

  it('abandons a delivery that burned every attempt', async () => {
    prisma.notificationDelivery.findMany.mockResolvedValue([
      {
        id: 'd1',
        incidentId: 'inc-1',
        channelId: 'chan-1',
        step: 0,
        attempts: 5,
      },
    ]);

    await reaper.reap();

    expect(deliveries.markAbandoned).toHaveBeenCalledWith(
      'd1',
      'lease expired after maximum attempts',
    );
    expect(notifications.enqueueRecovery).not.toHaveBeenCalled();
  });
});
