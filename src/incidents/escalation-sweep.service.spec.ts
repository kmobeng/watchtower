import 'reflect-metadata';
import { IncidentStatus } from '../../generated/prisma/client';
import { PrismaService } from '../prisma.service';
import { FlapDetectorService } from '../flapping/flap-detector.service';
import { IncidentEventPublisher } from './incident-event.publisher';
import { IncidentFeedEvent } from './incident-feed.events';
import { EscalationSweepService } from './escalation-sweep.service';

const CHAN_1 = '11111111-1111-4111-8111-111111111111';
const CHAN_2 = '22222222-2222-4222-8222-222222222222';

const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

const incident = (overrides: Record<string, any> = {}) => ({
  id: 'inc-1',
  monitorId: 'mon-1',
  cause: 'http_5xx',
  startedAt: minutesAgo(10),
  escalationStep: 0,
  monitor: {
    userId: 'user-1',
    escalationPolicy: {
      steps: [{ afterMinutes: 5, notifyChannelId: CHAN_1 }],
    },
  },
  ...overrides,
});

describe('EscalationSweepService', () => {
  let service: EscalationSweepService;
  let findMany: jest.Mock;
  let updateMany: jest.Mock;
  let txUpdateMany: jest.Mock;
  let createEvent: jest.Mock;
  let transaction: jest.Mock;
  let flaps: { isFlapping: jest.Mock };
  let publisher: { publish: jest.Mock };
  let logger: { log: jest.Mock; warn: jest.Mock; error: jest.Mock };

  beforeEach(() => {
    findMany = jest.fn().mockResolvedValue([]);
    updateMany = jest.fn().mockResolvedValue({ count: 1 });
    txUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    createEvent = jest.fn().mockResolvedValue(undefined);
    transaction = jest.fn((cb: (tx: unknown) => unknown) =>
      cb({ incident: { updateMany: txUpdateMany } }),
    );
    flaps = { isFlapping: jest.fn().mockResolvedValue(false) };
    publisher = { publish: jest.fn().mockResolvedValue(undefined) };

    service = new EscalationSweepService(
      {
        incident: { findMany, updateMany },
        $transaction: transaction,
      } as unknown as PrismaService,
      { createEvent },
      flaps as unknown as FlapDetectorService,
      publisher as unknown as IncidentEventPublisher,
    );

    logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    (service as any).logger = logger;
  });

  it('selects only open incidents whose deadline has passed', async () => {
    await service.sweep();

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          status: { in: [IncidentStatus.OPEN, IncidentStatus.ESCALATED] },
          nextEscalationAt: { not: null, lte: expect.any(Date) },
        },
        take: 100,
      }),
    );
  });

  it('fires the first step without marking the incident escalated', async () => {
    findMany.mockResolvedValue([incident()]);

    await service.sweep();

    expect(txUpdateMany).toHaveBeenCalledWith({
      where: {
        id: 'inc-1',
        status: { in: [IncidentStatus.OPEN, IncidentStatus.ESCALATED] },
        escalationStep: 0,
      },
      data: {
        escalationStep: 1,
        nextEscalationAt: null,
      },
    });
    expect(createEvent).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        aggregateType: 'incident',
        aggregateId: 'inc-1',
        eventType: 'incident-escalated',
        payload: expect.objectContaining({
          incidentId: 'inc-1',
          step: 0,
          notifyChannelId: CHAN_1,
        }),
      }),
    );
    expect(publisher.publish).toHaveBeenCalledWith(
      IncidentFeedEvent.Updated,
      expect.objectContaining({
        id: 'inc-1',
        userId: 'user-1',
        status: IncidentStatus.OPEN,
        escalationStep: 1,
      }),
    );
  });

  it('marks the incident escalated once a later step fires', async () => {
    findMany.mockResolvedValue([
      incident({
        startedAt: minutesAgo(20),
        escalationStep: 1,
        monitor: {
          userId: 'user-1',
          escalationPolicy: {
            steps: [
              { afterMinutes: 5, notifyChannelId: CHAN_1 },
              { afterMinutes: 10, notifyChannelId: CHAN_2 },
            ],
          },
        },
      }),
    ]);

    await service.sweep();

    expect(txUpdateMany).toHaveBeenCalledWith({
      where: {
        id: 'inc-1',
        status: { in: [IncidentStatus.OPEN, IncidentStatus.ESCALATED] },
        escalationStep: 1,
      },
      data: {
        status: IncidentStatus.ESCALATED,
        escalationStep: 2,
        nextEscalationAt: null,
      },
    });
    expect(publisher.publish).toHaveBeenCalledWith(
      IncidentFeedEvent.Escalated,
      expect.objectContaining({
        id: 'inc-1',
        userId: 'user-1',
        status: IncidentStatus.ESCALATED,
        escalationStep: 2,
      }),
    );
  });

  it('schedules the next step deadline when more steps remain', async () => {
    const startedAt = minutesAgo(10);
    findMany.mockResolvedValue([
      incident({
        startedAt,
        monitor: {
          userId: 'user-1',
          escalationPolicy: {
            steps: [
              { afterMinutes: 5, notifyChannelId: CHAN_1 },
              { afterMinutes: 10, notifyChannelId: CHAN_2 },
            ],
          },
        },
      }),
    ]);

    await service.sweep();

    const expected = new Date(startedAt.getTime() + 10 * 60_000);
    expect(txUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ nextEscalationAt: expected }),
      }),
    );
  });

  it('does not escalate when another writer won the race', async () => {
    findMany.mockResolvedValue([incident()]);
    txUpdateMany.mockResolvedValue({ count: 0 });

    await service.sweep();

    expect(createEvent).not.toHaveBeenCalled();
    expect(logger.log).not.toHaveBeenCalled();
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it('defers instead of firing early when the policy was edited', async () => {
    const startedAt = minutesAgo(10);
    findMany.mockResolvedValue([
      incident({
        startedAt,
        monitor: {
          userId: 'user-1',
          escalationPolicy: {
            steps: [{ afterMinutes: 60, notifyChannelId: CHAN_1 }],
          },
        },
      }),
    ]);

    await service.sweep();

    const expected = new Date(startedAt.getTime() + 60 * 60_000);
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: 'inc-1',
        status: { in: [IncidentStatus.OPEN, IncidentStatus.ESCALATED] },
        escalationStep: 0,
      },
      data: { nextEscalationAt: expected },
    });
    expect(transaction).not.toHaveBeenCalled();
    expect(createEvent).not.toHaveBeenCalled();
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it.each([
    ['no policy', null],
    ['malformed steps', { steps: [{ afterMinutes: 0 }] }],
  ])('clears the deadline when the monitor has %s', async (_label, policy) => {
    findMany.mockResolvedValue([
      incident({ monitor: { userId: 'user-1', escalationPolicy: policy } }),
    ]);

    await service.sweep();

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: 'inc-1',
        status: { in: [IncidentStatus.OPEN, IncidentStatus.ESCALATED] },
      },
      data: { nextEscalationAt: null },
    });
    expect(transaction).not.toHaveBeenCalled();
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it('clears the deadline when the policy shrank below the current step', async () => {
    findMany.mockResolvedValue([incident({ escalationStep: 3 })]);

    await service.sweep();

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { nextEscalationAt: null } }),
    );
    expect(transaction).not.toHaveBeenCalled();
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it('suppresses escalation while the monitor is flapping', async () => {
    findMany.mockResolvedValue([incident()]);
    flaps.isFlapping.mockResolvedValue(true);

    await service.sweep();

    expect(flaps.isFlapping).toHaveBeenCalledWith('mon-1');
    expect(transaction).not.toHaveBeenCalled();
    expect(createEvent).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
    expect(publisher.publish).not.toHaveBeenCalled();
  });

  it('keeps processing the batch when one incident throws', async () => {
    findMany.mockResolvedValue([
      incident({ id: 'inc-1' }),
      incident({ id: 'inc-2' }),
    ]);
    txUpdateMany
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce({ count: 1 });

    await service.sweep();

    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(createEvent).toHaveBeenCalledTimes(1);
    expect(publisher.publish).toHaveBeenCalledTimes(1);
  });
});
