import 'reflect-metadata';
import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { EscalationPoliciesService } from './escalation-policies.service';

describe('EscalationPoliciesService', () => {
  let service: EscalationPoliciesService;
  let prisma: {
    escalationPolicy: {
      create: jest.Mock;
      findMany: jest.Mock;
      findFirst: jest.Mock;
      update: jest.Mock;
      deleteMany: jest.Mock;
    };
  };

  const steps = [{ afterMinutes: 5, notifyChannelId: 'chan-1' }];

  beforeEach(() => {
    prisma = {
      escalationPolicy: {
        create: jest.fn(),
        findMany: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn(),
        deleteMany: jest.fn(),
      },
    };
    service = new EscalationPoliciesService(prisma as unknown as PrismaService);
  });

  it('creates a policy scoped to the user', async () => {
    prisma.escalationPolicy.create.mockResolvedValue({ id: 'pol-1' });

    await expect(
      service.create('user-1', { name: 'Primary', steps }),
    ).resolves.toEqual({ id: 'pol-1' });
    expect(prisma.escalationPolicy.create).toHaveBeenCalledWith({
      data: { userId: 'user-1', name: 'Primary', steps },
    });
  });

  it('lists only the user policies, newest first', async () => {
    prisma.escalationPolicy.findMany.mockResolvedValue([{ id: 'pol-1' }]);

    await expect(service.findAll('user-1')).resolves.toEqual([{ id: 'pol-1' }]);
    expect(prisma.escalationPolicy.findMany).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('404s when a policy is missing or owned by someone else', async () => {
    prisma.escalationPolicy.findFirst.mockResolvedValue(null);

    await expect(service.findOne('user-1', 'pol-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(prisma.escalationPolicy.findFirst).toHaveBeenCalledWith({
      where: { id: 'pol-1', userId: 'user-1' },
    });
  });

  it('returns the existing row for an empty patch', async () => {
    const existing = { id: 'pol-1' };
    prisma.escalationPolicy.findFirst.mockResolvedValue(existing);

    await expect(service.update('user-1', 'pol-1', {})).resolves.toBe(existing);
    expect(prisma.escalationPolicy.update).not.toHaveBeenCalled();
  });

  it('patches only the provided fields', async () => {
    prisma.escalationPolicy.findFirst.mockResolvedValue({ id: 'pol-1' });
    prisma.escalationPolicy.update.mockResolvedValue({
      id: 'pol-1',
      name: 'Renamed',
    });

    await service.update('user-1', 'pol-1', { name: 'Renamed' });

    expect(prisma.escalationPolicy.update).toHaveBeenCalledWith({
      where: { id: 'pol-1' },
      data: { name: 'Renamed' },
    });
  });

  it('deletes only the user policy and 404s when nothing matched', async () => {
    prisma.escalationPolicy.deleteMany.mockResolvedValue({ count: 1 });
    await expect(service.remove('user-1', 'pol-1')).resolves.toBeUndefined();
    expect(prisma.escalationPolicy.deleteMany).toHaveBeenCalledWith({
      where: { id: 'pol-1', userId: 'user-1' },
    });

    prisma.escalationPolicy.deleteMany.mockResolvedValue({ count: 0 });
    await expect(service.remove('user-1', 'pol-1')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
