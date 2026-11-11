import { IncidentEventPublisher } from './incident-event.publisher';
import {
  DASHBOARD_INCIDENT_CHANNEL,
  FeedIncident,
  IncidentFeedEvent,
} from './incident-feed.events';
import { IncidentStatus } from '../../generated/prisma/client';

const incident: FeedIncident = {
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
};

describe('IncidentEventPublisher', () => {
  let publish: jest.Mock;
  let publisher: IncidentEventPublisher;

  beforeEach(() => {
    publish = jest.fn().mockResolvedValue(1);
    publisher = new IncidentEventPublisher({
      getClient: () => ({ publish }),
    } as never);
    (publisher as any).logger = { error: jest.fn() };
  });

  it('publishes a JSON message on the dashboard channel', async () => {
    await publisher.publish(IncidentFeedEvent.Opened, incident);

    expect(publish).toHaveBeenCalledWith(
      DASHBOARD_INCIDENT_CHANNEL,
      expect.any(String),
    );

    const [, raw] = publish.mock.calls[0] as [string, string];
    expect(JSON.parse(raw)).toEqual({
      event: IncidentFeedEvent.Opened,
      incident,
      occurredAt: expect.any(String),
    });
  });

  it('swallows a Redis failure so the committed transition still succeeds', async () => {
    publish.mockRejectedValueOnce(new Error('redis down'));

    await expect(
      publisher.publish(IncidentFeedEvent.Resolved, incident),
    ).resolves.toBeUndefined();
  });
});
