import 'reflect-metadata';
import {
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import {
  IncidentStatus,
  Prisma,
} from '../../generated/prisma/client';
import { PrismaService } from '../prisma.service';
import { IncidentService, deriveCause } from './incident.service';

describe('IncidentService', () => {
  let service: IncidentService;
  let prisma: {
    incident: {
      findFirst: jest.Mock;
      findUnique: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
    };
    $transaction: jest.Mock;
  };

  const check = {
    id: 'check-1',
    statusCode: 500,
    timedOut: false,
    error: null,
  };

  beforeEach(() => {
    prisma = {
      incident: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
      },
      $transaction: jest.fn((promises: Promise<unknown>[]) =>
        Promise.all(promises),
      ),
    };
    service = new IncidentService(prisma as unknown as PrismaService);
  });

  describe('handleVerdict', () => {
    it('opens an incident on down with no existing one', async () => {
      prisma.incident.findFirst.mockResolvedValue(null);
      prisma.incident.create.mockResolvedValue({ id: 'inc-1' });

      const result = await service.handleVerdict(
        'mon-1',
        { state: 'down', consecutiveFailures: 3 },
        check,
      );

      expect(prisma.incident.create).toHaveBeenCalledWith({
        data: {
          monitorId: 'mon-1',
          status: IncidentStatus.OPEN,
          cause: 'http_5xx',
          openedByCheckId: 'check-1',
        },
      });
      expect(result).toEqual({ id: 'inc-1' });
    });

    it('does not double-open when one is already open', async () => {
      prisma.incident.findFirst.mockResolvedValue({ id: 'inc-1' });

      const result = await service.handleVerdict(
        'mon-1',
        { state: 'down', consecutiveFailures: 4 },
        check,
      );

      expect(prisma.incident.create).not.toHaveBeenCalled();
      expect(result).toEqual({ id: 'inc-1' });
    });

    it('returns the winner when losing an open race (P2002)', async () => {
      prisma.incident.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'inc-race' });
      prisma.incident.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('Unique constraint', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );

      const result = await service.handleVerdict(
        'mon-1',
        { state: 'down', consecutiveFailures: 3 },
        check,
      );

      expect(result).toEqual({ id: 'inc-race' });
    });

    it('resolves an open incident on up with downtime math', async () => {
      const startedAt = new Date(Date.now() - 125000);
      prisma.incident.findFirst.mockResolvedValue({
        id: 'inc-1',
        startedAt,
      });
      prisma.incident.update.mockImplementation(({ data }) => ({
        id: 'inc-1',
        ...data,
      }));

      const result = await service.handleVerdict(
        'mon-1',
        { state: 'up', consecutiveFailures: 0 },
        { ...check, id: 'check-9' },
      );

      expect(prisma.incident.update).toHaveBeenCalledWith({
        where: { id: 'inc-1' },
        data: expect.objectContaining({
          status: IncidentStatus.RESOLVED,
          closedByCheckId: 'check-9',
        }),
      });
      expect(result?.downtimeSeconds).toBeGreaterThanOrEqual(124);
      expect(result?.downtimeSeconds).toBeLessThanOrEqual(126);
    });

    it('does nothing on up with no open incident', async () => {
      prisma.incident.findFirst.mockResolvedValue(null);

      await expect(
        service.handleVerdict(
          'mon-1',
          { state: 'up', consecutiveFailures: 0 },
          check,
        ),
      ).resolves.toBeNull();
      expect(prisma.incident.update).not.toHaveBeenCalled();
    });

    it('ignores suspicious and null evaluations', async () => {
      await expect(
        service.handleVerdict(
          'mon-1',
          { state: 'suspicious', consecutiveFailures: 2 },
          check,
        ),
      ).resolves.toBeNull();
      await expect(service.handleVerdict('mon-1', null, check)).resolves.toBeNull();
      expect(prisma.incident.findFirst).not.toHaveBeenCalled();
      expect(prisma.incident.create).not.toHaveBeenCalled();
    });
  });

  describe('deriveCause', () => {
    it.each([
      [{ ...check, timedOut: true, statusCode: null }, 'timeout'],
      [{ ...check, statusCode: 500 }, 'http_5xx'],
      [{ ...check, statusCode: 503 }, 'http_5xx'],
      [{ ...check, statusCode: 404 }, 'http_4xx'],
      [
        { ...check, statusCode: null, error: 'connection_refused' },
        'connection_refused',
      ],
      [{ ...check, statusCode: null, error: 'dns' }, 'dns'],
      [{ ...check, statusCode: null, error: null }, 'network'],
    ])('maps %j to %s', (input, expected) => {
      expect(deriveCause(input)).toBe(expected);
    });
  });

  describe('acknowledge', () => {
    const openIncident = {
      id: 'inc-1',
      status: IncidentStatus.OPEN,
      monitor: { userId: 'user-1' },
    };

    it('acknowledges an open incident', async () => {
      prisma.incident.findUnique.mockResolvedValue(openIncident);
      prisma.incident.update.mockResolvedValue({
        ...openIncident,
        status: IncidentStatus.ACKNOWLEDGED,
      });

      const result = await service.acknowledge('user-1', 'inc-1');

      expect(prisma.incident.update).toHaveBeenCalledWith({
        where: { id: 'inc-1' },
        data: { status: IncidentStatus.ACKNOWLEDGED },
      });
      expect(result.status).toBe(IncidentStatus.ACKNOWLEDGED);
    });

    it('404s on missing or foreign incidents', async () => {
      prisma.incident.findUnique.mockResolvedValueOnce(null);
      await expect(service.acknowledge('user-1', 'nope')).rejects.toBeInstanceOf(
        NotFoundException,
      );

      prisma.incident.findUnique.mockResolvedValueOnce({
        ...openIncident,
        monitor: { userId: 'user-2' },
      });
      await expect(service.acknowledge('user-1', 'inc-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it.each([IncidentStatus.ACKNOWLEDGED, IncidentStatus.RESOLVED])(
      '409s when acknowledging from %s',
      async (status) => {
        prisma.incident.findUnique.mockResolvedValue({
          ...openIncident,
          status,
        });
        await expect(
          service.acknowledge('user-1', 'inc-1'),
        ).rejects.toBeInstanceOf(ConflictException);
      },
    );
  });

  describe('findAll', () => {
    it('scopes to the user and paginates', async () => {
      prisma.incident.findMany.mockResolvedValue([{ id: 'inc-1' }]);
      prisma.incident.count.mockResolvedValue(1);

      const result = await service.findAll('user-1', 'mon-1', 1, 20);

      expect(prisma.incident.findMany).toHaveBeenCalledWith({
        where: { monitor: { userId: 'user-1' }, monitorId: 'mon-1' },
        orderBy: { startedAt: 'desc' },
        skip: 0,
        take: 20,
      });
      expect(result).toEqual({
        items: [{ id: 'inc-1' }],
        total: 1,
        page: 1,
        limit: 20,
        totalPages: 1,
      });
    });
  });
});
