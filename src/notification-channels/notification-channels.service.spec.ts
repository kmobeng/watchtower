import 'reflect-metadata';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { NotificationChannelType } from '../../generated/prisma/client';
import { PrismaService } from '../prisma.service';
import { NotificationChannelsService } from './notification-channels.service';

const CHAN_1 = '11111111-1111-4111-8111-111111111111';

describe('NotificationChannelsService', () => {
  let service: NotificationChannelsService;
  let prisma: {
    notificationChannel: {
      create: jest.Mock;
      findMany: jest.Mock;
      findFirst: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
    };
    escalationPolicy: { findMany: jest.Mock };
  };

  beforeEach(() => {
    prisma = {
      notificationChannel: {
        create: jest.fn(),
        findMany: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      escalationPolicy: { findMany: jest.fn().mockResolvedValue([]) },
    };
    service = new NotificationChannelsService(
      prisma as unknown as PrismaService,
    );
  });

  describe('create', () => {
    it('creates an email channel and trims the destination', async () => {
      prisma.notificationChannel.create.mockResolvedValue({ id: 'chan-1' });

      await service.create('user-1', {
        type: NotificationChannelType.EMAIL,
        destination: '  jane@example.com  ',
        label: 'Primary',
      });

      expect(prisma.notificationChannel.create).toHaveBeenCalledWith({
        data: {
          userId: 'user-1',
          type: NotificationChannelType.EMAIL,
          destination: 'jane@example.com',
          label: 'Primary',
        },
      });
    });

    it('creates an SMS channel from an E.164 number', async () => {
      prisma.notificationChannel.create.mockResolvedValue({ id: 'chan-1' });

      await service.create('user-1', {
        type: NotificationChannelType.SMS,
        destination: '+15551234567',
      });

      expect(prisma.notificationChannel.create).toHaveBeenCalledWith({
        data: {
          userId: 'user-1',
          type: NotificationChannelType.SMS,
          destination: '+15551234567',
        },
      });
    });

    it('rejects a malformed email', async () => {
      await expect(
        service.create('user-1', {
          type: NotificationChannelType.EMAIL,
          destination: 'not-an-email',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.notificationChannel.create).not.toHaveBeenCalled();
    });

    it('rejects a non-E.164 phone number', async () => {
      await expect(
        service.create('user-1', {
          type: NotificationChannelType.SMS,
          destination: '555-1234',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  it('lists only the user channels, newest first', async () => {
    prisma.notificationChannel.findMany.mockResolvedValue([{ id: CHAN_1 }]);

    await expect(service.findAll('user-1')).resolves.toEqual([{ id: CHAN_1 }]);
    expect(prisma.notificationChannel.findMany).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('404s when a channel is missing or owned by someone else', async () => {
    prisma.notificationChannel.findFirst.mockResolvedValue(null);

    await expect(service.findOne('user-1', CHAN_1)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.notificationChannel.findFirst).toHaveBeenCalledWith({
      where: { id: CHAN_1, userId: 'user-1' },
    });
  });

  it('re-validates the destination when only the type changes', async () => {
    prisma.notificationChannel.findFirst.mockResolvedValue({
      id: CHAN_1,
      type: NotificationChannelType.EMAIL,
      destination: 'jane@example.com',
    });

    await expect(
      service.update('user-1', CHAN_1, { type: NotificationChannelType.SMS }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.notificationChannel.update).not.toHaveBeenCalled();
  });

  it('patches the provided fields', async () => {
    prisma.notificationChannel.findFirst.mockResolvedValue({
      id: CHAN_1,
      type: NotificationChannelType.EMAIL,
      destination: 'jane@example.com',
    });
    prisma.notificationChannel.update.mockResolvedValue({ id: CHAN_1 });

    await service.update('user-1', CHAN_1, { label: 'Alerts' });

    expect(prisma.notificationChannel.update).toHaveBeenCalledWith({
      where: { id: CHAN_1 },
      data: { label: 'Alerts' },
    });
  });

  it('refuses to delete a channel referenced by a policy', async () => {
    prisma.notificationChannel.findFirst.mockResolvedValue({ id: CHAN_1 });
    prisma.escalationPolicy.findMany.mockResolvedValue([
      { steps: [{ afterMinutes: 5, notifyChannelId: CHAN_1 }] },
    ]);

    await expect(service.remove('user-1', CHAN_1)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(prisma.notificationChannel.delete).not.toHaveBeenCalled();
  });

  it('turns a delivery-history FK violation into a 409', async () => {
    prisma.notificationChannel.findFirst.mockResolvedValue({ id: CHAN_1 });
    prisma.notificationChannel.delete.mockRejectedValue({ code: 'P2003' });

    await expect(service.remove('user-1', CHAN_1)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('deletes an unreferenced channel', async () => {
    prisma.notificationChannel.findFirst.mockResolvedValue({ id: CHAN_1 });
    prisma.notificationChannel.delete.mockResolvedValue({ id: CHAN_1 });

    await expect(service.remove('user-1', CHAN_1)).resolves.toBeUndefined();
    expect(prisma.notificationChannel.delete).toHaveBeenCalledWith({
      where: { id: CHAN_1 },
    });
  });
});
