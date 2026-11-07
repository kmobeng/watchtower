import 'reflect-metadata';
import {
  NotificationChannelType,
  NotificationDeliveryStatus,
} from '../../generated/prisma/client';
import { PrismaService } from '../prisma.service';
import {
  DELIVERY_LEASE_MS,
  DELIVERY_MAX_ATTEMPTS,
  NotificationDeliveryService,
} from './notification-delivery.service';

const input = {
  incidentId: 'inc-1',
  channelId: 'chan-1',
  step: 0,
  channelType: NotificationChannelType.EMAIL,
  destination: 'jane@example.com',
};

describe('NotificationDeliveryService', () => {
  let service: NotificationDeliveryService;
  let prisma: {
    notificationDelivery: {
      create: jest.Mock;
      updateMany: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
    };
  };

  beforeEach(() => {
    prisma = {
      notificationDelivery: {
        create: jest.fn(),
        updateMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue(undefined),
      },
    };
    service = new NotificationDeliveryService(
      prisma as unknown as PrismaService,
    );
  });

  describe('claim', () => {
    it('claims a new delivery with a lease', async () => {
      const delivery = { id: 'd1', attempts: 1 };
      prisma.notificationDelivery.create.mockResolvedValue(delivery);

      await expect(service.claim(input)).resolves.toEqual({
        kind: 'claimed',
        delivery,
      });
      expect(prisma.notificationDelivery.create).toHaveBeenCalledWith({
        data: {
          incidentId: 'inc-1',
          channelId: 'chan-1',
          step: 0,
          channelType: NotificationChannelType.EMAIL,
          destination: 'jane@example.com',
          status: NotificationDeliveryStatus.PENDING,
          attempts: 1,
          claimedAt: expect.any(Date),
        },
      });
      expect(prisma.notificationDelivery.updateMany).not.toHaveBeenCalled();
    });

    it('steals a stale lease from a crashed worker', async () => {
      prisma.notificationDelivery.create.mockRejectedValue({ code: 'P2002' });
      prisma.notificationDelivery.updateMany.mockResolvedValue({ count: 1 });
      const delivery = { id: 'd1', attempts: 2 };
      prisma.notificationDelivery.findUnique.mockResolvedValue(delivery);

      await expect(service.claim(input)).resolves.toEqual({
        kind: 'claimed',
        delivery,
      });

      const where =
        prisma.notificationDelivery.updateMany.mock.calls[0][0].where;
      expect(where).toMatchObject({
        incidentId: 'inc-1',
        channelId: 'chan-1',
        step: 0,
        status: NotificationDeliveryStatus.PENDING,
      });
      expect(where.OR).toEqual([
        { claimedAt: null },
        { claimedAt: { lt: expect.any(Date) } },
      ]);
      const staleBefore = (where.OR[1].claimedAt.lt as Date).getTime();
      expect(Date.now() - staleBefore).toBeGreaterThanOrEqual(
        DELIVERY_LEASE_MS - 1000,
      );
      expect(
        prisma.notificationDelivery.updateMany.mock.calls[0][0].data,
      ).toEqual({
        claimedAt: expect.any(Date),
        attempts: { increment: 1 },
      });
    });

    it('reports busy when another worker holds a live lease', async () => {
      prisma.notificationDelivery.create.mockRejectedValue({ code: 'P2002' });
      prisma.notificationDelivery.updateMany.mockResolvedValue({ count: 0 });
      prisma.notificationDelivery.findUnique.mockResolvedValue({
        id: 'd1',
        status: NotificationDeliveryStatus.PENDING,
      });

      await expect(service.claim(input)).resolves.toEqual({ kind: 'busy' });
    });

    it('reports terminal once the row is settled', async () => {
      prisma.notificationDelivery.create.mockRejectedValue({ code: 'P2002' });
      prisma.notificationDelivery.updateMany.mockResolvedValue({ count: 0 });
      const delivery = {
        id: 'd1',
        status: NotificationDeliveryStatus.SENT,
      };
      prisma.notificationDelivery.findUnique.mockResolvedValue(delivery);

      await expect(service.claim(input)).resolves.toEqual({
        kind: 'terminal',
        delivery,
      });
    });

    it('rethrows errors that are not unique violations', async () => {
      prisma.notificationDelivery.create.mockRejectedValue(
        new Error('db down'),
      );

      await expect(service.claim(input)).rejects.toThrow('db down');
      expect(prisma.notificationDelivery.updateMany).not.toHaveBeenCalled();
    });
  });

  describe('terminal transitions', () => {
    it('records a successful send', async () => {
      await service.markSent('d1');

      expect(prisma.notificationDelivery.update).toHaveBeenCalledWith({
        where: { id: 'd1' },
        data: {
          status: NotificationDeliveryStatus.SENT,
          sentAt: expect.any(Date),
          claimedAt: null,
          lastError: null,
        },
      });
    });

    it('records a skip with its reason', async () => {
      await service.markSkipped('d1', 'incident is ACKNOWLEDGED');

      expect(prisma.notificationDelivery.update).toHaveBeenCalledWith({
        where: { id: 'd1' },
        data: {
          status: NotificationDeliveryStatus.SKIPPED,
          claimedAt: null,
          lastError: 'incident is ACKNOWLEDGED',
        },
      });
    });

    it('hands a retryable failure back to the queue', async () => {
      await expect(service.markFailure('d1', 1, 'boom')).resolves.toBe(false);

      expect(prisma.notificationDelivery.update).toHaveBeenCalledWith({
        where: { id: 'd1' },
        data: { claimedAt: null, lastError: 'boom' },
      });
    });

    it('makes the last allowed failure terminal', async () => {
      await expect(
        service.markFailure('d1', DELIVERY_MAX_ATTEMPTS, 'boom'),
      ).resolves.toBe(true);

      expect(prisma.notificationDelivery.update).toHaveBeenCalledWith({
        where: { id: 'd1' },
        data: {
          status: NotificationDeliveryStatus.FAILED,
          claimedAt: null,
          lastError: 'boom',
        },
      });
    });

    it('marks an abandoned delivery failed', async () => {
      await service.markAbandoned('d1', 'lease expired');

      expect(prisma.notificationDelivery.update).toHaveBeenCalledWith({
        where: { id: 'd1' },
        data: {
          status: NotificationDeliveryStatus.FAILED,
          claimedAt: null,
          lastError: 'lease expired',
        },
      });
    });
  });
});
