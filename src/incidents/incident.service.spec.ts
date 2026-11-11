import 'reflect-metadata';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { IncidentStatus, Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma.service';
import { IncidentEventPublisher } from './incident-event.publisher';
import { IncidentFeedEvent } from './incident-feed.events';
import {
  IncidentService,
  deriveCause,
  OPEN_STATUSES,
} from './incident.service';

const CHAN_1 = '11111111-1111-4111-8111-111111111111';
const CHAN_2 = '22222222-2222-4222-8222-222222222222';

const incidentRow = (overrides: Record<string, any> = {}) => ({
  id: 'inc-1',
  monitorId: 'mon-1',
  status: IncidentStatus.OPEN,
  cause: 'http_5xx',
  openedByCheckId: 'check-1',
  closedByCheckId: null,
  startedAt: new Date('2026-01-01T00:00:00.000Z'),
  acknowledgedAt: null,
  resolvedAt: null,
  downtimeSeconds: null,
  escalationStep: 0,
  nextEscalationAt: null,
  ...overrides,
});

describe('IncidentService', () => {
  let service: IncidentService;
  let publisher: { publish: jest.Mock };
  let prisma: {
    incident: {
      findFirst: jest.Mock;
      findUnique: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
    };
    monitor: { findUnique: jest.Mock };
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
        findUniqueOrThrow: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
      },
      monitor: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ userId: 'user-1', escalationPolicy: null }),
      },
      $transaction: jest.fn((promises: Promise<unknown>[]) =>
        Promise.all(promises),
      ),
    };
    publisher = { publish: jest.fn().mockResolvedValue(undefined) };
    service = new IncidentService(
      prisma as unknown as PrismaService,
      publisher as unknown as IncidentEventPublisher,
    );
  });

  describe('handleVerdict', () => {
    it('opens an incident on down with no existing one', async () => {
      prisma.incident.findFirst.mockResolvedValue(null);
      prisma.incident.create.mockResolvedValue(incidentRow());

      const result = await service.handleVerdict(
        'mon-1',
        { state: 'down' },
        check,
      );

      expect(prisma.incident.create).toHaveBeenCalledWith({
        data: {
          monitorId: 'mon-1',
          status: IncidentStatus.OPEN,
          cause: 'http_5xx',
          openedByCheckId: 'check-1',
          startedAt: expect.any(Date),
          nextEscalationAt: null,
        },
      });
      expect(result).toEqual(incidentRow());
      expect(publisher.publish).toHaveBeenCalledWith(
        IncidentFeedEvent.Opened,
        expect.objectContaining({
          id: 'inc-1',
          monitorId: 'mon-1',
          userId: 'user-1',
          status: IncidentStatus.OPEN,
          cause: 'http_5xx',
        }),
      );
    });

    it('sets the first escalation deadline when the monitor has a policy', async () => {
      prisma.incident.findFirst.mockResolvedValue(null);
      prisma.monitor.findUnique.mockResolvedValue({
        userId: 'user-1',
        escalationPolicy: {
          steps: [
            { afterMinutes: 5, notifyChannelId: CHAN_1 },
            { afterMinutes: 15, notifyChannelId: CHAN_2 },
          ],
        },
      });
      prisma.incident.create.mockResolvedValue(incidentRow());

      await service.handleVerdict('mon-1', { state: 'down' }, check);

      const { startedAt, nextEscalationAt } =
        prisma.incident.create.mock.calls[0][0].data;
      expect(startedAt).toBeInstanceOf(Date);
      expect(nextEscalationAt).toBeInstanceOf(Date);
      expect(nextEscalationAt.getTime() - startedAt.getTime()).toBe(5 * 60_000);
    });

    it('schedules an immediate first alert when the policy starts at zero', async () => {
      prisma.incident.findFirst.mockResolvedValue(null);
      prisma.monitor.findUnique.mockResolvedValue({
        userId: 'user-1',
        escalationPolicy: {
          steps: [{ afterMinutes: 0, notifyChannelId: CHAN_1 }],
        },
      });
      prisma.incident.create.mockResolvedValue(incidentRow());

      await service.handleVerdict('mon-1', { state: 'down' }, check);

      const { startedAt, nextEscalationAt } =
        prisma.incident.create.mock.calls[0][0].data;
      expect(nextEscalationAt).toBeInstanceOf(Date);
      expect(nextEscalationAt.getTime()).toBe(startedAt.getTime());
    });

    it('ignores a malformed policy instead of blocking the open', async () => {
      prisma.incident.findFirst.mockResolvedValue(null);
      prisma.monitor.findUnique.mockResolvedValue({
        userId: 'user-1',
        escalationPolicy: { steps: [{ afterMinutes: 0 }] },
      });
      prisma.incident.create.mockResolvedValue(incidentRow());

      await service.handleVerdict('mon-1', { state: 'down' }, check);

      expect(prisma.incident.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ nextEscalationAt: null }),
        }),
      );
    });

    it('does not double-open when one is already open', async () => {
      prisma.incident.findFirst.mockResolvedValue({ id: 'inc-1' });

      const result = await service.handleVerdict(
        'mon-1',
        { state: 'down' },
        check,
      );

      expect(prisma.incident.create).not.toHaveBeenCalled();
      expect(result).toEqual({ id: 'inc-1' });
      expect(publisher.publish).not.toHaveBeenCalled();
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
        { state: 'down' },
        check,
      );

      expect(result).toEqual({ id: 'inc-race' });
      expect(publisher.publish).not.toHaveBeenCalled();
    });

    it('resolves an open incident on up with downtime math', async () => {
      const startedAt = new Date(Date.now() - 125000);
      prisma.incident.findFirst.mockResolvedValue({
        id: 'inc-1',
        startedAt,
      });
      prisma.incident.updateMany.mockResolvedValue({ count: 1 });
      prisma.incident.findUniqueOrThrow.mockImplementation(
        ({ where }: { where: { id: string } }) =>
          incidentRow({
            id: where.id,
            status: IncidentStatus.RESOLVED,
            resolvedAt: new Date(),
            downtimeSeconds: 125,
            closedByCheckId: 'check-9',
            monitor: { userId: 'user-1' },
          }),
      );

      const result = await service.handleVerdict(
        'mon-1',
        { state: 'up' },
        { ...check, id: 'check-9' },
      );

      expect(prisma.incident.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'inc-1',
          status: { in: OPEN_STATUSES },
        },
        data: expect.objectContaining({
          status: IncidentStatus.RESOLVED,
          closedByCheckId: 'check-9',
          nextEscalationAt: null,
        }),
      });
      expect(result?.downtimeSeconds).toBe(125);
      expect(publisher.publish).toHaveBeenCalledWith(
        IncidentFeedEvent.Resolved,
        expect.objectContaining({
          id: 'inc-1',
          userId: 'user-1',
          status: IncidentStatus.RESOLVED,
          downtimeSeconds: 125,
        }),
      );
    });

    it('lets only one concurrent resolver win', async () => {
      prisma.incident.findFirst.mockResolvedValue({
        id: 'inc-1',
        startedAt: new Date(Date.now() - 1000),
      });
      // Another region resolved it between our read and our write.
      prisma.incident.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.handleVerdict(
          'mon-1',
          { state: 'up' },
          { ...check, id: 'check-9' },
        ),
      ).resolves.toBeNull();
      expect(prisma.incident.findUniqueOrThrow).not.toHaveBeenCalled();
      expect(publisher.publish).not.toHaveBeenCalled();
    });

    it('does nothing on up with no open incident', async () => {
      prisma.incident.findFirst.mockResolvedValue(null);

      await expect(
        service.handleVerdict('mon-1', { state: 'up' }, check),
      ).resolves.toBeNull();
      expect(prisma.incident.updateMany).not.toHaveBeenCalled();
      expect(publisher.publish).not.toHaveBeenCalled();
    });

    it('holds without touching incidents and ignores null verdicts', async () => {
      await expect(
        service.handleVerdict('mon-1', { state: 'hold' }, check),
      ).resolves.toBeNull();
      await expect(
        service.handleVerdict('mon-1', null, check),
      ).resolves.toBeNull();
      expect(prisma.incident.findFirst).not.toHaveBeenCalled();
      expect(prisma.incident.create).not.toHaveBeenCalled();
      expect(prisma.incident.updateMany).not.toHaveBeenCalled();
      expect(publisher.publish).not.toHaveBeenCalled();
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

    it('acknowledges an open incident and stops escalation', async () => {
      prisma.incident.findUnique.mockResolvedValue(openIncident);
      prisma.incident.updateMany.mockResolvedValue({ count: 1 });
      prisma.incident.findUniqueOrThrow.mockResolvedValue(
        incidentRow({
          status: IncidentStatus.ACKNOWLEDGED,
          acknowledgedAt: new Date(),
          monitor: { userId: 'user-1' },
        }),
      );

      const result = await service.acknowledge('user-1', 'inc-1');

      expect(prisma.incident.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'inc-1',
          status: { in: [IncidentStatus.OPEN, IncidentStatus.ESCALATED] },
        },
        data: {
          status: IncidentStatus.ACKNOWLEDGED,
          acknowledgedAt: expect.any(Date),
          nextEscalationAt: null,
        },
      });
      expect(result.status).toBe(IncidentStatus.ACKNOWLEDGED);
      expect(publisher.publish).toHaveBeenCalledWith(
        IncidentFeedEvent.Acknowledged,
        expect.objectContaining({
          id: 'inc-1',
          userId: 'user-1',
          status: IncidentStatus.ACKNOWLEDGED,
        }),
      );
    });

    it('acknowledges an already escalated incident', async () => {
      prisma.incident.findUnique.mockResolvedValue({
        ...openIncident,
        status: IncidentStatus.ESCALATED,
      });
      prisma.incident.updateMany.mockResolvedValue({ count: 1 });
      prisma.incident.findUniqueOrThrow.mockResolvedValue(
        incidentRow({
          status: IncidentStatus.ACKNOWLEDGED,
          acknowledgedAt: new Date(),
          monitor: { userId: 'user-1' },
        }),
      );

      await expect(
        service.acknowledge('user-1', 'inc-1'),
      ).resolves.toMatchObject({ status: IncidentStatus.ACKNOWLEDGED });
    });

    it('404s on missing or foreign incidents', async () => {
      prisma.incident.findUnique.mockResolvedValueOnce(null);
      await expect(
        service.acknowledge('user-1', 'nope'),
      ).rejects.toBeInstanceOf(NotFoundException);

      prisma.incident.findUnique.mockResolvedValueOnce({
        ...openIncident,
        monitor: { userId: 'user-2' },
      });
      await expect(
        service.acknowledge('user-1', 'inc-1'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(publisher.publish).not.toHaveBeenCalled();
    });

    it.each([IncidentStatus.ACKNOWLEDGED, IncidentStatus.RESOLVED])(
      '409s when acknowledging from %s',
      async (status) => {
        prisma.incident.findUnique.mockResolvedValue({
          ...openIncident,
          status,
        });
        prisma.incident.updateMany.mockResolvedValue({ count: 0 });

        await expect(
          service.acknowledge('user-1', 'inc-1'),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(publisher.publish).not.toHaveBeenCalled();
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
