import { WsException } from '@nestjs/websockets';
import { IncidentStatus } from '../../generated/prisma/client';
import type { AccessJWTPayload } from '../common/interfaces/jwt.interface';
import {
  FeedIncident,
  IncidentFeedEvent,
  IncidentFeedMessage,
} from '../incidents/incident-feed.events';
import { DashboardGateway } from './dashboard.gateway';

const futureExp = () => Math.floor(Date.now() / 1000) + 60;

const user = (overrides: Partial<AccessJWTPayload> = {}): AccessJWTPayload => ({
  sub: 'user-1',
  email: 'user@example.com',
  role: 'USER',
  provider: 'local',
  isEmailVerified: true,
  exp: futureExp(),
  ...overrides,
});

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

const message: IncidentFeedMessage = {
  event: IncidentFeedEvent.Opened,
  incident,
  occurredAt: '2026-01-01T00:00:00.000Z',
};

const makeSocket = () => ({
  id: 'socket-1',
  data: {} as Record<string, any>,
  join: jest.fn().mockResolvedValue(undefined),
  emit: jest.fn(),
  disconnect: jest.fn(),
});

const makeGateway = (
  options: {
    authenticate?: jest.Mock;
    findMany?: jest.Mock;
  } = {},
) => {
  const authenticate =
    options.authenticate ?? jest.fn().mockResolvedValue(user());
  const findMany = options.findMany ?? jest.fn().mockResolvedValue([]);
  const gateway = new DashboardGateway(
    { authenticate } as never,
    { incident: { findMany } } as never,
  );
  (gateway as any).logger = {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
  return { gateway, authenticate, findMany };
};

describe('DashboardGateway', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('authenticates, joins the user room, and emits the open snapshot', async () => {
    const { gateway, findMany } = makeGateway({
      findMany: jest.fn().mockResolvedValue([
        {
          ...incident,
          startedAt: new Date(incident.startedAt),
          monitor: { userId: 'user-1' },
        },
      ]),
    });
    const socket = makeSocket();

    await gateway.handleConnection(socket as never);

    expect(socket.join).toHaveBeenCalledWith('user:user-1');
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          monitor: { userId: 'user-1' },
          status: {
            in: [
              IncidentStatus.OPEN,
              IncidentStatus.ACKNOWLEDGED,
              IncidentStatus.ESCALATED,
            ],
          },
        },
      }),
    );
    expect(socket.emit).toHaveBeenCalledWith('dashboard:snapshot', {
      incidents: [incident],
      serverTime: expect.any(String),
    });
  });

  it('rejects a missing or invalid token before joining any room', async () => {
    const { gateway } = makeGateway({
      authenticate: jest
        .fn()
        .mockRejectedValue(new WsException('Access token is missing')),
    });
    const socket = makeSocket();

    await gateway.handleConnection(socket as never);

    expect(socket.join).not.toHaveBeenCalled();
    expect(socket.emit).toHaveBeenCalledWith('exception', {
      status: 'error',
      message: 'Access token is missing',
    });
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  it('keeps the socket connected and reports an error when the snapshot fails', async () => {
    const { gateway } = makeGateway({
      findMany: jest.fn().mockRejectedValue(new Error('db down')),
    });
    const socket = makeSocket();

    await gateway.handleConnection(socket as never);

    expect(socket.emit).toHaveBeenCalledWith('dashboard:error', {
      message: 'Failed to load dashboard snapshot',
    });
    expect(socket.disconnect).not.toHaveBeenCalled();
  });

  it('disconnects a token that is already past its expiry', async () => {
    const { gateway } = makeGateway({
      authenticate: jest
        .fn()
        .mockResolvedValue(user({ exp: Math.floor(Date.now() / 1000) - 1 })),
    });
    const socket = makeSocket();

    await gateway.handleConnection(socket as never);

    expect(socket.emit).toHaveBeenCalledWith('exception', {
      status: 'error',
      message: 'Access token expired',
    });
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });

  it('disconnects when the token expires and clears the timer on disconnect', async () => {
    jest.useFakeTimers();
    const { gateway } = makeGateway({
      authenticate: jest.fn().mockResolvedValue(user({ exp: futureExp() })),
    });
    const socket = makeSocket();

    await gateway.handleConnection(socket as never);
    expect(socket.data.expiryTimer).toBeDefined();

    gateway.handleDisconnect(socket as never);
    expect(socket.data.expiryTimer).toBeUndefined();

    jest.advanceTimersByTime(120_000);
    expect(socket.disconnect).not.toHaveBeenCalled();
  });

  it('fans an incident event out to the user room', () => {
    const { gateway } = makeGateway();
    const emit = jest.fn();
    const to = jest.fn().mockReturnValue({ emit });
    (gateway as any).server = { to };

    gateway.emitIncident(message);

    expect(to).toHaveBeenCalledWith('user:user-1');
    expect(emit).toHaveBeenCalledWith(IncidentFeedEvent.Opened, message);
  });

  it('drops an event when the server is not initialized', () => {
    const { gateway } = makeGateway();
    (gateway as any).server = undefined;

    expect(() => gateway.emitIncident(message)).not.toThrow();
  });
});
