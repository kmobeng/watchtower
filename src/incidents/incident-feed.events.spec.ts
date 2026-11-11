import { IncidentStatus } from '../../generated/prisma/client';
import {
  IncidentFeedEvent,
  isIncidentFeedMessage,
  toFeedIncident,
} from './incident-feed.events';

const source = {
  id: 'inc-1',
  monitorId: 'mon-1',
  status: IncidentStatus.OPEN,
  cause: 'http_5xx',
  startedAt: new Date('2026-01-01T00:00:00.000Z'),
  acknowledgedAt: null,
  resolvedAt: null,
  downtimeSeconds: null,
  escalationStep: 0,
  nextEscalationAt: null,
};

describe('incident feed events', () => {
  describe('toFeedIncident', () => {
    it('serializes dates and preserves nulls', () => {
      expect(toFeedIncident(source, 'user-1')).toEqual({
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
      });
    });

    it('serializes the terminal timestamps', () => {
      const result = toFeedIncident(
        {
          ...source,
          status: IncidentStatus.RESOLVED,
          acknowledgedAt: new Date('2026-01-01T00:01:00.000Z'),
          resolvedAt: new Date('2026-01-01T00:05:00.000Z'),
          downtimeSeconds: 300,
          escalationStep: 2,
          nextEscalationAt: new Date('2026-01-01T00:02:00.000Z'),
        },
        'user-1',
      );

      expect(result).toMatchObject({
        status: IncidentStatus.RESOLVED,
        acknowledgedAt: '2026-01-01T00:01:00.000Z',
        resolvedAt: '2026-01-01T00:05:00.000Z',
        downtimeSeconds: 300,
        escalationStep: 2,
        nextEscalationAt: '2026-01-01T00:02:00.000Z',
      });
    });
  });

  describe('isIncidentFeedMessage', () => {
    const message = {
      event: IncidentFeedEvent.Opened,
      incident: toFeedIncident(source, 'user-1'),
      occurredAt: '2026-01-01T00:00:00.000Z',
    };

    it('accepts a well-formed message', () => {
      expect(isIncidentFeedMessage(message)).toBe(true);
    });

    it.each([
      ['null', null],
      ['a string', 'nope'],
      ['an unknown event', { ...message, event: 'incident:unknown' }],
      ['a missing incident', { ...message, incident: undefined }],
      [
        'an incident without a user',
        { ...message, incident: { ...message.incident, userId: undefined } },
      ],
    ])('rejects %s', (_label, value) => {
      expect(isIncidentFeedMessage(value)).toBe(false);
    });
  });
});
