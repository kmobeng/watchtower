import { EventEmitter } from 'events';
import { IncidentStatus } from '../../generated/prisma/client';
import {
  DASHBOARD_INCIDENT_CHANNEL,
  IncidentFeedEvent,
  IncidentFeedMessage,
} from '../incidents/incident-feed.events';
import { DashboardSubscriberService } from './dashboard.subscriber';

const message: IncidentFeedMessage = {
  event: IncidentFeedEvent.Opened,
  incident: {
    id: 'inc-1',
    monitorId: 'mon-1',
    userId: 'user-1',
    status: IncidentStatus.OPEN,
    cause: 'http_5xx',
    startedAt: '2026-01-01T00:00:00.000Z',
    acknowledgedAt: null,
    resolvedAt: null,
    downtimeSeconds: null,
    escalationStep: 0,
    nextEscalationAt: null,
  },
  occurredAt: '2026-01-01T00:00:00.000Z',
};

const makeService = () => {
  const emitter = new EventEmitter();
  const subscriber = {
    on: emitter.on.bind(emitter),
    subscribe: jest.fn().mockResolvedValue(undefined),
    quit: jest.fn().mockResolvedValue('OK'),
  };
  const redis = { getClient: () => ({ duplicate: () => subscriber }) };
  const gateway = { emitIncident: jest.fn() };
  const service = new DashboardSubscriberService(
    redis as never,
    gateway as never,
  );
  (service as any).logger = {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };

  return { service, emitter, subscriber, gateway };
};

describe('DashboardSubscriberService', () => {
  it('subscribes to the dashboard channel on init', async () => {
    const { service, subscriber } = makeService();

    await service.onModuleInit();

    expect(subscriber.subscribe).toHaveBeenCalledWith(
      DASHBOARD_INCIDENT_CHANNEL,
    );
    await expect(service.whenReady()).resolves.toBeUndefined();
  });

  it('forwards a valid message to the gateway', async () => {
    const { service, emitter, gateway } = makeService();
    await service.onModuleInit();

    emitter.emit(
      'message',
      DASHBOARD_INCIDENT_CHANNEL,
      JSON.stringify(message),
    );

    expect(gateway.emitIncident).toHaveBeenCalledWith(message);
  });

  it.each([
    ['another channel', 'other:channel', JSON.stringify(message)],
    ['malformed JSON', DASHBOARD_INCIDENT_CHANNEL, '{not json'],
    [
      'an unrecognized payload',
      DASHBOARD_INCIDENT_CHANNEL,
      JSON.stringify({ event: 'incident:unknown' }),
    ],
  ])('ignores %s', async (_label, channel, raw) => {
    const { service, emitter, gateway } = makeService();
    await service.onModuleInit();

    emitter.emit('message', channel, raw);

    expect(gateway.emitIncident).not.toHaveBeenCalled();
  });

  it('surfaces a failed subscription through whenReady without failing boot', async () => {
    const { service, subscriber } = makeService();
    subscriber.subscribe.mockRejectedValueOnce(new Error('redis down'));

    await expect(service.onModuleInit()).resolves.toBeUndefined();
    await expect(service.whenReady()).rejects.toThrow('redis down');
  });

  it('closes the duplicated connection on destroy', async () => {
    const { service, subscriber } = makeService();
    await service.onModuleInit();

    await service.onModuleDestroy();

    expect(subscriber.quit).toHaveBeenCalled();
  });
});
