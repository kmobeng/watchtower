import 'dotenv/config';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { SchedulerRegistry } from '@nestjs/schedule';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma.service';
import { AllExceptionsFilter } from '../src/common/filters/all-exception.filter';
import { HOUR_MS, truncateToBucket } from '../src/rollups/bucket';
import { IncidentStatus, RollupGranularity } from '../generated/prisma/client';

describe('Public status pages (live Postgres + Redis)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const ts = Date.now();
  const ownerEmail = `status-owner-${ts}@watchtower.local`;
  const otherEmail = `status-other-${ts}@watchtower.local`;
  const password = 'Password123!';
  const slug = `acme-status-${ts}`;

  let ownerToken: string;
  let ownerId: string;
  let otherId: string;
  let healthyMonitorId: string;
  let downMonitorId: string;
  let foreignMonitorId: string;
  let pageId: string;

  const bucketStart = truncateToBucket(
    new Date(Date.now() - 2 * HOUR_MS),
    RollupGranularity.HOUR,
  );

  jest.setTimeout(60000);

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

    // The rollup and escalation crons would race the seeded fixtures.
    const registry = app.get(SchedulerRegistry);
    for (const name of registry.getCronJobs().keys()) {
      registry.deleteCronJob(name);
    }

    prisma = app.get(PrismaService);

    const owner = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email: ownerEmail, password, name: 'Status Owner' })
      .expect(201);
    ownerToken = owner.body.token;

    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email: otherEmail, password, name: 'Status Other' })
      .expect(201);

    ownerId = (
      await prisma.user.findUniqueOrThrow({ where: { email: ownerEmail } })
    ).id;
    otherId = (
      await prisma.user.findUniqueOrThrow({ where: { email: otherEmail } })
    ).id;

    const healthy = await prisma.monitor.create({
      data: {
        userId: ownerId,
        url: `http://127.0.0.1:9/healthy-${ts}`,
        intervalSeconds: 60,
      },
    });
    healthyMonitorId = healthy.id;

    const down = await prisma.monitor.create({
      data: {
        userId: ownerId,
        url: `http://127.0.0.1:9/down-${ts}`,
        intervalSeconds: 60,
      },
    });
    downMonitorId = down.id;

    const foreign = await prisma.monitor.create({
      data: {
        userId: otherId,
        url: `http://127.0.0.1:9/foreign-${ts}`,
        intervalSeconds: 60,
      },
    });
    foreignMonitorId = foreign.id;

    // One closed hourly bucket: 9 of 10 checks up, 900ms total response time.
    await prisma.checkRollup.create({
      data: {
        monitorId: healthyMonitorId,
        region: 'local',
        granularity: RollupGranularity.HOUR,
        bucketStart,
        checkCount: 10,
        upCount: 9,
        upResponseTimeSumMs: 900,
      },
    });

    // Current status comes from the latest check, not the rollup.
    await prisma.check.create({
      data: {
        monitorId: healthyMonitorId,
        checkedAt: new Date(),
        statusCode: 200,
        responseTimeMs: 100,
        isUp: true,
      },
    });

    await prisma.incident.create({
      data: {
        monitorId: healthyMonitorId,
        status: IncidentStatus.RESOLVED,
        cause: 'http_5xx',
        startedAt: new Date(Date.now() - 3 * HOUR_MS),
        resolvedAt: new Date(Date.now() - 2 * HOUR_MS),
        downtimeSeconds: 3600,
      },
    });

    await prisma.incident.create({
      data: {
        monitorId: downMonitorId,
        status: IncidentStatus.OPEN,
        cause: 'timeout',
        startedAt: new Date(Date.now() - 10 * 60_000),
      },
    });
  });

  afterAll(async () => {
    if (!prisma) {
      await app?.close();
      return;
    }

    await prisma.outboxEvent.deleteMany({
      where: { aggregateId: { in: [ownerId, otherId].filter(Boolean) } },
    });
    await prisma.user.deleteMany({
      where: { email: { in: [ownerEmail, otherEmail] } },
    });
    await app.close();
  });

  it('rejects management calls without a token', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/status-pages')
      .send({ slug: `nope-${ts}`, monitorIds: [healthyMonitorId] })
      .expect(401);

    await request(app.getHttpServer()).get('/api/v1/status-pages').expect(401);
  });

  it('refuses to publish a monitor the caller does not own', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/status-pages')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ slug: `foreign-${ts}`, monitorIds: [foreignMonitorId] })
      .expect(400);
  });

  it('creates a status page for the caller', async () => {
    const created = await request(app.getHttpServer())
      .post('/api/v1/status-pages')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        slug,
        monitorIds: [healthyMonitorId, downMonitorId],
        isPublic: true,
        title: 'Acme Status',
      })
      .expect(201);

    expect(created.body.data).toMatchObject({
      slug,
      title: 'Acme Status',
      isPublic: true,
      monitorIds: [healthyMonitorId, downMonitorId],
      userId: ownerId,
    });
    pageId = created.body.data.id;

    const listed = await request(app.getHttpServer())
      .get('/api/v1/status-pages')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);
    expect(listed.body.data.map((page: { slug: string }) => page.slug)).toEqual(
      [slug],
    );
  });

  it('rejects a duplicate slug with 409', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/status-pages')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ slug, monitorIds: [healthyMonitorId] })
      .expect(409);
  });

  it('serves the page without auth, with uptime and incident history', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/v1/status-pages/${slug}`)
      .set('Origin', 'https://embed.example')
      .expect(200);

    expect(response.headers['access-control-allow-origin']).toBe('*');
    expect(response.headers['cache-control']).toBe('public, max-age=30');

    const { data } = response.body;
    expect(data.slug).toBe(slug);
    expect(data.title).toBe('Acme Status');
    expect(data.generatedAt).toEqual(expect.any(String));

    const healthy = data.monitors.find(
      (monitor: { id: string }) => monitor.id === healthyMonitorId,
    );
    expect(healthy).toMatchObject({
      status: 'up',
      uptimePct: 90,
      avgResponseTimeMs: 100,
      url: `http://127.0.0.1:9/healthy-${ts}`,
    });
    expect(healthy.buckets).toEqual([
      {
        bucketStart: bucketStart.toISOString(),
        checkCount: 10,
        upCount: 9,
        uptimePct: 90,
        avgResponseTimeMs: 100,
      },
    ]);
    expect(healthy.incidents).toHaveLength(1);
    expect(healthy.incidents[0]).toMatchObject({
      status: IncidentStatus.RESOLVED,
      cause: 'http_5xx',
      downtimeSeconds: 3600,
    });
    expect(healthy.incidents[0].resolvedAt).toEqual(expect.any(String));

    const down = data.monitors.find(
      (monitor: { id: string }) => monitor.id === downMonitorId,
    );
    expect(down.status).toBe('down');
    expect(down.incidents[0]).toMatchObject({
      status: IncidentStatus.OPEN,
      cause: 'timeout',
      resolvedAt: null,
    });
    expect(down.uptimePct).toBeNull();
  });

  it('never leaks owner or internal incident fields', async () => {
    const response = await request(app.getHttpServer())
      .get(`/api/v1/status-pages/${slug}`)
      .expect(200);

    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain(ownerId);
    expect(serialized).not.toContain('userId');
    expect(serialized).not.toContain('acknowledgedAt');
    expect(serialized).not.toContain('escalationStep');
    expect(serialized).not.toContain('nextEscalationAt');
    expect(serialized).not.toContain(ownerEmail);
  });

  it('does not put CORS headers on the authenticated API', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/monitors')
      .set('Origin', 'https://embed.example')
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('hides an unpublished page behind a 404', async () => {
    await request(app.getHttpServer())
      .patch(`/api/v1/status-pages/${pageId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ isPublic: false })
      .expect(200);

    await request(app.getHttpServer())
      .get(`/api/v1/status-pages/${slug}`)
      .expect(404);
  });

  it('404s for an unknown slug', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/status-pages/does-not-exist-${ts}`)
      .expect(404);
  });

  it('deletes the page and stops serving it', async () => {
    await request(app.getHttpServer())
      .patch(`/api/v1/status-pages/${pageId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ isPublic: true })
      .expect(200);

    await request(app.getHttpServer())
      .get(`/api/v1/status-pages/${slug}`)
      .expect(200);

    await request(app.getHttpServer())
      .delete(`/api/v1/status-pages/${pageId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .get(`/api/v1/status-pages/${slug}`)
      .expect(404);
  });
});
