import 'dotenv/config';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { SchedulerRegistry } from '@nestjs/schedule';
import { AddressInfo } from 'net';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma.service';
import { AllExceptionsFilter } from '../src/common/filters/all-exception.filter';
import { CheckSchedulerService } from '../src/checks/check-scheduler.service';
import { DashboardSubscriberService } from '../src/dashboard/dashboard.subscriber';
import { IncidentService } from '../src/incidents/incident.service';
import { EscalationSweepService } from '../src/incidents/escalation-sweep.service';
import type {
  DashboardSnapshot,
  IncidentFeedMessage,
} from '../src/incidents/incident-feed.events';

describe('Live dashboard feed (live Postgres + Redis)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let incidents: IncidentService;
  let sweep: EscalationSweepService;
  let scheduler: CheckSchedulerService;
  let url: string;

  const ts = Date.now();
  const email = `dashboard-${ts}@watchtower.local`;
  const password = 'Password123!';
  let token: string;
  let userId: string;
  let monitorId: string;

  const sockets: ClientSocket[] = [];

  jest.setTimeout(60000);

  const waitForEvent = <T>(
    socket: ClientSocket,
    event: string,
    timeoutMs = 5000,
  ): Promise<T> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Timed out waiting for ${event}`)),
        timeoutMs,
      );
      socket.once(event, (payload: T) => {
        clearTimeout(timer);
        resolve(payload);
      });
    });

  const connectDashboard = async (
    authToken: string,
  ): Promise<{ socket: ClientSocket; snapshot: DashboardSnapshot }> => {
    const socket = ioClient(`${url}/dashboard`, {
      auth: { token: authToken },
      reconnection: false,
      transports: ['websocket'],
    });
    sockets.push(socket);

    const snapshot = waitForEvent<DashboardSnapshot>(
      socket,
      'dashboard:snapshot',
    );

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Timed out connecting to the dashboard')),
        5000,
      );
      socket.once('connect', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once('connect_error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

    return { socket, snapshot: await snapshot };
  };

  const downCheck = (id: string) => ({
    id,
    statusCode: 500,
    timedOut: false,
    error: null,
  });

  const upCheck = (id: string) => ({
    id,
    statusCode: 200,
    timedOut: false,
    error: null,
  });

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.use(cookieParser());
    app.setGlobalPrefix('api/v1', { exclude: ['/'] });
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    await app.listen(0);

    const { port } = app.getHttpServer().address() as AddressInfo;
    url = `http://127.0.0.1:${port}`;

    // Drive the sweep explicitly; the 15s cron and the outbox poller would
    // race the assertions.
    const registry = app.get(SchedulerRegistry);
    for (const name of registry.getCronJobs().keys()) {
      registry.deleteCronJob(name);
    }

    prisma = app.get(PrismaService);
    incidents = app.get(IncidentService);
    sweep = app.get(EscalationSweepService);
    scheduler = app.get(CheckSchedulerService);

    await app.get(DashboardSubscriberService).whenReady();

    const reg = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password, name: 'Dashboard' })
      .expect(201);
    token = reg.body.token;

    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    userId = user.id;

    const channel = await prisma.notificationChannel.create({
      data: {
        userId,
        type: 'EMAIL',
        destination: `dashboard-${ts}@watchtower.local`,
        label: 'dashboard e2e',
      },
    });

    const policy = await prisma.escalationPolicy.create({
      data: {
        userId,
        name: `dashboard-${ts}`,
        steps: [
          { afterMinutes: 0, notifyChannelId: channel.id },
          { afterMinutes: 1, notifyChannelId: channel.id },
        ],
      },
    });

    const created = await request(app.getHttpServer())
      .post('/api/v1/monitors')
      .set('Authorization', `Bearer ${token}`)
      .send({
        url: 'http://127.0.0.1:1/health',
        intervalSeconds: 60,
        failureThreshold: 1,
        escalationPolicyId: policy.id,
      })
      .expect(201);
    monitorId = created.body.data.id;
  });

  afterAll(async () => {
    for (const socket of sockets) {
      try {
        socket.disconnect();
      } catch {
        // Best effort.
      }
    }

    if (!prisma) {
      try {
        await app?.close();
      } catch {
        // Setup may have failed before the app initialised.
      }
      return;
    }

    const rows = await prisma.incident.findMany({
      where: { monitorId },
      select: { id: true },
    });
    if (rows.length > 0) {
      await prisma.outboxEvent.deleteMany({
        where: { aggregateId: { in: rows.map((row) => row.id) } },
      });
    }

    await prisma.user.deleteMany({ where: { email } });

    try {
      await scheduler.unschedule(monitorId);
    } catch {
      // The app may already have torn the queue down.
    }

    await app.close();
  });

  it('pushes incident open, acknowledge, and resolve events', async () => {
    const { socket, snapshot } = await connectDashboard(token);
    expect(snapshot.incidents).toEqual([]);

    const opened = waitForEvent<IncidentFeedMessage>(socket, 'incident:opened');
    await incidents.handleVerdict(
      monitorId,
      { state: 'down' },
      downCheck('check-open'),
    );
    const openedMessage = await opened;

    expect(openedMessage).toMatchObject({
      event: 'incident:opened',
      incident: {
        monitorId,
        userId,
        status: 'OPEN',
        cause: 'http_5xx',
      },
    });
    const incidentId = openedMessage.incident.id;

    const acknowledged = waitForEvent<IncidentFeedMessage>(
      socket,
      'incident:acknowledged',
    );
    await request(app.getHttpServer())
      .post(`/api/v1/incidents/${incidentId}/acknowledge`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    const ackMessage = await acknowledged;

    expect(ackMessage.incident).toMatchObject({
      id: incidentId,
      status: 'ACKNOWLEDGED',
      userId,
    });
    expect(ackMessage.incident.acknowledgedAt).toEqual(expect.any(String));

    const resolved = waitForEvent<IncidentFeedMessage>(
      socket,
      'incident:resolved',
    );
    await incidents.handleVerdict(
      monitorId,
      { state: 'up' },
      upCheck('check-resolve'),
    );
    const resolvedMessage = await resolved;

    expect(resolvedMessage.incident).toMatchObject({
      id: incidentId,
      status: 'RESOLVED',
      downtimeSeconds: expect.any(Number),
    });
    expect(resolvedMessage.incident.resolvedAt).toEqual(expect.any(String));
  });

  it('sends the authoritative open set to a reconnecting client', async () => {
    const first = await connectDashboard(token);

    const opened = waitForEvent<IncidentFeedMessage>(
      first.socket,
      'incident:opened',
    );
    await incidents.handleVerdict(
      monitorId,
      { state: 'down' },
      downCheck('check-snapshot'),
    );
    const openedMessage = await opened;
    first.socket.disconnect();

    const second = await connectDashboard(token);
    expect(second.snapshot.incidents).toEqual([
      expect.objectContaining({
        id: openedMessage.incident.id,
        status: 'OPEN',
        userId,
      }),
    ]);

    const resolved = waitForEvent<IncidentFeedMessage>(
      second.socket,
      'incident:resolved',
    );
    await incidents.handleVerdict(
      monitorId,
      { state: 'up' },
      upCheck('check-snapshot-resolve'),
    );
    await resolved;
  });

  it('pushes escalation step 0 as an update and later steps as escalated', async () => {
    const { socket } = await connectDashboard(token);

    const opened = waitForEvent<IncidentFeedMessage>(socket, 'incident:opened');
    await incidents.handleVerdict(
      monitorId,
      { state: 'down' },
      downCheck('check-escalate'),
    );
    const openedMessage = await opened;
    const incidentId = openedMessage.incident.id;

    // The sweep recomputes each deadline from startedAt, so moving startedAt
    // into the past makes both steps due immediately.
    await prisma.incident.update({
      where: { id: incidentId },
      data: {
        startedAt: new Date(Date.now() - 2 * 60_000),
        nextEscalationAt: new Date(Date.now() - 1000),
      },
    });

    const updated = waitForEvent<IncidentFeedMessage>(
      socket,
      'incident:updated',
    );
    await sweep.sweep();
    const updatedMessage = await updated;

    expect(updatedMessage).toMatchObject({
      event: 'incident:updated',
      incident: {
        id: incidentId,
        status: 'OPEN',
        escalationStep: 1,
        userId,
      },
    });

    const escalated = waitForEvent<IncidentFeedMessage>(
      socket,
      'incident:escalated',
    );
    await sweep.sweep();
    const escalatedMessage = await escalated;

    expect(escalatedMessage).toMatchObject({
      event: 'incident:escalated',
      incident: {
        id: incidentId,
        status: 'ESCALATED',
        escalationStep: 2,
        userId,
      },
    });

    const resolved = waitForEvent<IncidentFeedMessage>(
      socket,
      'incident:resolved',
    );
    await incidents.handleVerdict(
      monitorId,
      { state: 'up' },
      upCheck('check-escalate-resolve'),
    );
    await resolved;
  });

  it('rejects a connection without a valid token', async () => {
    const socket = ioClient(`${url}/dashboard`, {
      auth: { token: 'not-a-valid-token' },
      reconnection: false,
      transports: ['websocket'],
    });
    sockets.push(socket);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Socket was not rejected')),
        5000,
      );
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      socket.once('disconnect', done);
      socket.once('connect_error', done);
    });

    expect(socket.connected).toBe(false);
  });
});
