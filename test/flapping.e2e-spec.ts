import 'dotenv/config';
import { createServer, Server, AddressInfo } from 'http';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma.service';
import { RedisService } from '../src/redis/redis.service';
import { AllExceptionsFilter } from '../src/common/filters/all-exception.filter';
import {
  CHECK_MONITOR_JOB,
  CheckSchedulerService,
} from '../src/checks/check-scheduler.service';
import { CheckProcessor } from '../src/checks/check.processor';
import type { CheckLockService } from '../src/checks/check-lock.service';
import { IncidentService } from '../src/incidents/incident.service';
import { EscalationSweepService } from '../src/incidents/escalation-sweep.service';
import { OutboxPoller } from '../src/outbox/outbox-poller';
import {
  FlapDetectorService,
  flapActiveKey,
} from '../src/flapping/flap-detector.service';
import type { FleetConfig } from '../src/checks/check-regions';

describe('Flapping detection (live Postgres + Redis)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let scheduler: CheckSchedulerService;
  let sweep: EscalationSweepService;
  let poller: OutboxPoller;
  let flaps: FlapDetectorService;
  let processor: CheckProcessor;

  const ts = Date.now();
  const email = `flapping-${ts}@watchtower.local`;
  const password = 'Password123!';
  let token: string;
  let monitorId: string;
  let channelId: string;
  let incidentIds: string[] = [];

  let stub: Server;
  let stubUrl: string;
  let healthy = true;

  jest.setTimeout(60000);

  beforeAll(async () => {
    stub = createServer((_req, res) => {
      res.writeHead(healthy ? 200 : 500, { 'Content-Type': 'text/plain' });
      res.end(healthy ? 'ok' : 'boom');
    });
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
    const { port } = stub.address() as AddressInfo;
    stubUrl = `http://127.0.0.1:${port}/health`;

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

    // The sweep and poller are driven explicitly so the assertions do not
    // race the 15s/5s crons.
    const registry = app.get(SchedulerRegistry);
    for (const name of registry.getCronJobs().keys()) {
      registry.deleteCronJob(name);
    }

    prisma = app.get(PrismaService);
    scheduler = app.get(CheckSchedulerService);
    sweep = app.get(EscalationSweepService);
    poller = app.get(OutboxPoller);
    flaps = app.get(FlapDetectorService);

    const reg = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email, password, name: 'Flapper' })
      .expect(201);
    token = reg.body.token;

    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const channel = await prisma.notificationChannel.create({
      data: {
        userId: user.id,
        type: 'EMAIL',
        destination: `flapping-${ts}@watchtower.local`,
        label: 'flapping e2e',
      },
    });
    channelId = channel.id;

    const policy = await prisma.escalationPolicy.create({
      data: {
        userId: user.id,
        name: `flapping-${ts}`,
        steps: [{ afterMinutes: 0, notifyChannelId: channel.id }],
      },
    });

    processor = new CheckProcessor(
      prisma,
      scheduler,
      app.get(IncidentService),
      {
        acquire: () => Promise.resolve('test-token'),
        release: () => Promise.resolve(),
      } as unknown as CheckLockService,
      flaps,
      {
        regions: ['local'],
        region: 'local',
        scheduleRegions: ['local'],
        quorum: 1,
      } satisfies FleetConfig,
    );

    const created = await request(app.getHttpServer())
      .post('/api/v1/monitors')
      .set('Authorization', `Bearer ${token}`)
      .send({
        url: stubUrl,
        intervalSeconds: 60,
        failureThreshold: 1,
        escalationPolicyId: policy.id,
      })
      .expect(201);
    monitorId = created.body.data.id;
  });

  afterAll(async () => {
    if (!prisma) {
      try {
        await app?.close();
      } catch {
        // Best effort when setup failed before the app initialised.
      }
      if (stub) {
        await new Promise<void>((resolve) => stub.close(() => resolve()));
      }
      return;
    }

    const incidents = await prisma.incident.findMany({
      where: { monitorId },
      select: { id: true },
    });
    incidentIds = incidents.map((incident) => incident.id);

    if (incidentIds.length > 0) {
      await prisma.outboxEvent.deleteMany({
        where: { aggregateId: { in: incidentIds } },
      });
    }

    await prisma.user.deleteMany({ where: { email } });
    await flaps.reset(monitorId);

    try {
      await scheduler.unschedule(monitorId);
    } catch {
      // The app may already have torn the queue down.
    }

    await new Promise<void>((resolve) => stub.close(() => resolve()));
    await app.close();
  });

  function fire() {
    return processor.process({
      name: CHECK_MONITOR_JOB,
      data: { monitorId, region: 'local' },
    } as never);
  }

  async function flip(nextHealthy: boolean) {
    healthy = nextHealthy;
    await expect(fire()).resolves.toMatchObject({
      verdict: nextHealthy ? 'up' : 'down',
    });
  }

  it('marks a monitor flapping after more than the allowed transitions', async () => {
    // The first down is a baseline; each later flip counts. Defaults allow 5
    // changes, so the seventh verdict is the sixth transition.
    await flip(false);
    await flip(true);
    await flip(false);
    await flip(true);
    await flip(false);
    await flip(true);
    await flip(false);

    const res = await request(app.getHttpServer())
      .get(`/api/v1/monitors/${monitorId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(res.body.data.flapping).toBe(true);

    // `hold` is a no-op: it neither counts a change nor clears the flag.
    await expect(flaps.record(monitorId, 'hold')).resolves.toMatchObject({
      changes: 6,
      flapping: true,
    });

    const list = await request(app.getHttpServer())
      .get('/api/v1/monitors')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(list.body.data[0].flapping).toBe(true);
  });

  it('suppresses escalation while flapping, including a queued outbox event', async () => {
    const incident = await prisma.incident.findFirstOrThrow({
      where: { monitorId, status: 'OPEN' },
    });
    incidentIds = [incident.id];

    expect(incident.nextEscalationAt).not.toBeNull();
    expect(incident.nextEscalationAt!.getTime()).toBeLessThanOrEqual(
      Date.now(),
    );

    await sweep.sweep();

    const escalated = await prisma.outboxEvent.findMany({
      where: {
        aggregateId: incident.id,
        eventType: 'incident-escalated',
      },
    });
    expect(escalated).toHaveLength(0);

    // A notification intent written just before the flag appeared must also be
    // deferred rather than delivered mid-flap.
    const queued = await prisma.outboxEvent.create({
      data: {
        aggregateType: 'incident',
        aggregateId: incident.id,
        eventType: 'incident-escalated',
        payload: {
          incidentId: incident.id,
          monitorId,
          cause: incident.cause,
          step: 1,
          notifyChannelId: channelId,
        },
      },
    });

    await poller.dispatchOutboxEvents();

    const afterPoll = await prisma.outboxEvent.findUniqueOrThrow({
      where: { id: queued.id },
    });
    expect(afterPoll.processedAt).toBeNull();
  });

  it('resumes the escalation chain once the monitor stabilises', async () => {
    await app.get(RedisService).getClient().del(flapActiveKey(monitorId));

    const res = await request(app.getHttpServer())
      .get(`/api/v1/monitors/${monitorId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.data.flapping).toBe(false);

    const incident = await prisma.incident.findFirstOrThrow({
      where: { monitorId, status: 'OPEN' },
    });

    await sweep.sweep();

    const escalated = await prisma.outboxEvent.findMany({
      where: {
        aggregateId: incident.id,
        eventType: 'incident-escalated',
      },
    });
    expect(escalated.some((event) => (event.payload as any).step === 0)).toBe(
      true,
    );

    const updated = await prisma.incident.findUniqueOrThrow({
      where: { id: incident.id },
    });
    expect(updated.escalationStep).toBe(1);
  });
});
