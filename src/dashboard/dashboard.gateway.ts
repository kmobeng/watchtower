import { Logger, UseFilters } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
  WsException,
} from '@nestjs/websockets';
import { Namespace, Socket } from 'socket.io';
import { WsExceptionFilter } from '../common/filters/ws-exception.filter';
import { WsJwtGuard } from '../common/guards/ws-jwt.guard';
import type { AccessJWTPayload } from '../common/interfaces/jwt.interface';
import { OPEN_STATUSES } from '../incidents/incident.service';
import {
  DashboardSnapshot,
  IncidentFeedMessage,
  toFeedIncident,
} from '../incidents/incident-feed.events';
import { PrismaService } from '../prisma.service';

const DASHBOARD_NAMESPACE = '/dashboard';
const SNAPSHOT_EVENT = 'dashboard:snapshot';
const ERROR_EVENT = 'dashboard:error';

function corsOrigin(): string | string[] {
  const raw = process.env.WS_CORS_ORIGIN?.trim();
  if (!raw || raw === '*') return '*';
  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

type DashboardClientData = {
  user: AccessJWTPayload;
  expiryTimer?: NodeJS.Timeout;
};

/**
 * Live incident feed for dashboard clients.
 *
 * Authentication happens once at connection: an invalid or missing token is
 * disconnected before the client can receive any event. Each client joins a
 * per-user room, so the Redis subscriber can fan an event out without knowing
 * which sockets belong to that user.
 */
@UseFilters(WsExceptionFilter)
@WebSocketGateway({
  namespace: DASHBOARD_NAMESPACE,
  cors: { origin: corsOrigin(), credentials: true },
})
export class DashboardGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(DashboardGateway.name);

  @WebSocketServer()
  server!: Namespace;

  constructor(
    private readonly guard: WsJwtGuard,
    private readonly prisma: PrismaService,
  ) {}

  async handleConnection(client: Socket): Promise<void> {
    let user: AccessJWTPayload;
    try {
      user = await this.guard.authenticate(client);
    } catch (error) {
      const message =
        error instanceof WsException
          ? extractWsErrorMessage(error)
          : 'Unauthorized';
      this.logger.warn(
        { socketId: client.id, message },
        'Dashboard connection rejected',
      );
      client.emit('exception', { status: 'error', message });
      client.disconnect(true);
      return;
    }

    try {
      await client.join(userRoom(user.sub));
    } catch (error) {
      this.logger.error(
        {
          socketId: client.id,
          userId: user.sub,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to join dashboard user room',
      );
      client.disconnect(true);
      return;
    }

    this.logger.log(
      { socketId: client.id, userId: user.sub },
      'Dashboard client connected',
    );

    this.scheduleExpiry(client, user);

    try {
      const incidents = await this.prisma.incident.findMany({
        where: {
          monitor: { userId: user.sub },
          status: { in: OPEN_STATUSES },
        },
        include: { monitor: { select: { userId: true } } },
        orderBy: { startedAt: 'desc' },
      });

      const snapshot: DashboardSnapshot = {
        incidents: incidents.map((incident) =>
          toFeedIncident(incident, incident.monitor.userId),
        ),
        serverTime: new Date().toISOString(),
      };

      client.emit(SNAPSHOT_EVENT, snapshot);
    } catch (error) {
      // Never emit an empty snapshot on failure: the client replaces its open
      // set with whatever it receives.
      this.logger.error(
        {
          socketId: client.id,
          userId: user.sub,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to build dashboard snapshot',
      );
      client.emit(ERROR_EVENT, {
        message: 'Failed to load dashboard snapshot',
      });
    }
  }

  handleDisconnect(client: Socket): void {
    const data = client.data as Partial<DashboardClientData> | undefined;

    if (data?.expiryTimer) {
      clearTimeout(data.expiryTimer);
      data.expiryTimer = undefined;
    }

    this.logger.log(
      { socketId: client.id, userId: data?.user?.sub },
      'Dashboard client disconnected',
    );
  }

  /** Called by the Redis subscriber; the server fans out to local sockets. */
  emitIncident(message: IncidentFeedMessage): void {
    if (!this.server) {
      this.logger.warn(
        { incidentId: message.incident.id, event: message.event },
        'Dashboard gateway server not initialized; dropping event',
      );
      return;
    }

    this.server
      .to(userRoom(message.incident.userId))
      .emit(message.event, message);
  }

  private scheduleExpiry(client: Socket, user: AccessJWTPayload): void {
    if (!user.exp) return;

    const remainingMs = user.exp * 1000 - Date.now();
    const data = client.data as DashboardClientData;

    if (remainingMs <= 0) {
      client.emit('exception', {
        status: 'error',
        message: 'Access token expired',
      });
      client.disconnect(true);
      return;
    }

    const timer = setTimeout(
      () => {
        client.emit('exception', {
          status: 'error',
          message: 'Access token expired',
        });
        client.disconnect(true);
      },
      Math.min(remainingMs, 2_147_483_647),
    );

    timer.unref?.();
    data.expiryTimer = timer;
  }
}

function userRoom(userId: string): string {
  return `user:${userId}`;
}

function extractWsErrorMessage(error: WsException): string {
  const payload = error.getError();
  if (typeof payload === 'string') return payload;
  return (payload as { message?: string } | null)?.message ?? 'Unauthorized';
}
