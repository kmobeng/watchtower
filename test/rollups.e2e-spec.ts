import 'dotenv/config';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma.service';
import { AllExceptionsFilter } from '../src/common/filters/all-exception.filter';
import { RollupsService } from '../src/rollups/rollups.service';
import { RollupSweepService } from '../src/rollups/rollup-sweep.service';
import { HOUR_MS, truncateToBucket } from '../src/rollups/bucket';
import { RollupGranularity } from '../generated/prisma/client';

describe('Uptime rollups (live Postgres + Redis)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let rollups: RollupsService;
  let sweep: RollupSweepService;

  const ts = Date.now();
  const ownerEmail = `rollups-owner-${ts}@watchtower.local`;
  const otherEmail = `rollups-other-${ts}@watchtower.local`;
  const password = 'Password123!';

  let ownerToken: string;
  let monitorId: string;
  let otherMonitorId: string;

  // A fully closed hourly bucket, far enough back that no other test writes
  // to it.
  const bucket = truncateToBucket(
    new Date(Date.now() - 5 * HOUR_MS),
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

    // Drive rollups explicitly; the crons would race the assertions.
    const registry = app.get(SchedulerRegistry);
    for (const name of registry.getCronJobs().keys()) {
      registry.deleteCronJob(name);
    }

    prisma = app.get(PrismaService);
    rollups = app.get(RollupsService);
    sweep = app.get(RollupSweepService);

    const owner = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email: ownerEmail, password, name: 'Rollup Owner' })
      .expect(201);
    ownerToken = owner.body.token;

    await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email: otherEmail, password, name: 'Rollup Other' })
      .expect(201);

    const ownerUser = await prisma.user.findUniqueOrThrow({
      where: { email: ownerEmail },
    });
    const otherUser = await prisma.user.findUniqueOrThrow({
      where: { email: otherEmail },
    });

    const monitor = await prisma.monitor.create({
      data: {
        userId: ownerUser.id,
        url: `http://127.0.0.1:9/rollups-${ts}`,
        intervalSeconds: 60,
      },
    });
    monitorId = monitor.id;

    const other = await prisma.monitor.create({
      data: {
        userId: otherUser.id,
        url: `http://127.0.0.1:9/rollups-other-${ts}`,
        intervalSeconds: 60,
      },
    });
    otherMonitorId = other.id;

    const at = (minutes: number) =>
      new Date(bucket.getTime() + minutes * 60_000);

    // Two regions. The failed check contributes to uptime but not to the
    // average response time.
    await prisma.check.createMany({
      data: [
        {
          monitorId,
          region: 'us',
          checkedAt: at(1),
          statusCode: 200,
          responseTimeMs: 100,
          isUp: true,
        },
        {
          monitorId,
          region: 'us',
          checkedAt: at(2),
          statusCode: 200,
          responseTimeMs: 300,
          isUp: true,
        },
        {
          monitorId,
          region: 'us',
          checkedAt: at(3),
          statusCode: 500,
          responseTimeMs: 999,
          isUp: false,
        },
        {
          monitorId,
          region: 'eu',
          checkedAt: at(4),
          statusCode: 200,
          responseTimeMs: 200,
          isUp: true,
        },
      ],
    });

    // Exercise the real scheduled path: Redis lock -> service -> upsert.
    await expect(
      sweep.run(
        RollupGranularity.HOUR,
        1,
        new Date(bucket.getTime() + HOUR_MS),
      ),
    ).resolves.toMatchObject({ processed: 1, skipped: 0, failed: 0 });
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.user.deleteMany({
        where: { email: { in: [ownerEmail, otherEmail] } },
      });
    }
    await app?.close();
  });

  const window = {
    from: bucket.toISOString(),
    to: new Date(bucket.getTime() + HOUR_MS - 1).toISOString(),
  };

  it('returns combined materialized buckets with derived metrics', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/monitors/${monitorId}/uptime`)
      .query({ granularity: 'hour', ...window })
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);

    expect(res.body.data).toMatchObject({
      monitorId,
      granularity: 'hour',
      region: null,
    });
    expect(res.body.data.buckets).toEqual([
      {
        bucketStart: bucket.toISOString(),
        checkCount: 4,
        upCount: 3,
        uptimePct: 75,
        avgResponseTimeMs: 200,
      },
    ]);
  });

  it('recomputes the same bucket idempotently', async () => {
    await expect(
      sweep.run(
        RollupGranularity.HOUR,
        1,
        new Date(bucket.getTime() + HOUR_MS),
      ),
    ).resolves.toMatchObject({ processed: 1, failed: 0 });

    const res = await request(app.getHttpServer())
      .get(`/api/v1/monitors/${monitorId}/uptime`)
      .query({ granularity: 'hour', ...window })
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);

    expect(res.body.data.buckets).toEqual([
      {
        bucketStart: bucket.toISOString(),
        checkCount: 4,
        upCount: 3,
        uptimePct: 75,
        avgResponseTimeMs: 200,
      },
    ]);
  });

  it('narrows to a single region when requested', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1/monitors/${monitorId}/uptime`)
      .query({ granularity: 'hour', region: 'eu', ...window })
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);

    expect(res.body.data.region).toBe('eu');
    expect(res.body.data.buckets).toEqual([
      {
        bucketStart: bucket.toISOString(),
        checkCount: 1,
        upCount: 1,
        uptimePct: 100,
        avgResponseTimeMs: 200,
      },
    ]);
  });

  it('serves daily rollups from the same raw checks', async () => {
    await rollups.rollupBucket(RollupGranularity.DAY, bucket);

    const res = await request(app.getHttpServer())
      .get(`/api/v1/monitors/${monitorId}/uptime`)
      .query({ granularity: 'day', ...window })
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);

    expect(res.body.data.granularity).toBe('day');
    expect(res.body.data.buckets).toHaveLength(1);
    expect(res.body.data.buckets[0]).toMatchObject({
      checkCount: 4,
      upCount: 3,
      uptimePct: 75,
      avgResponseTimeMs: 200,
    });
  });

  it('returns only buckets that have been materialized', async () => {
    const empty = new Date('2020-01-01T00:00:00.000Z');

    const res = await request(app.getHttpServer())
      .get(`/api/v1/monitors/${monitorId}/uptime`)
      .query({
        granularity: 'hour',
        from: empty.toISOString(),
        to: new Date(empty.getTime() + HOUR_MS - 1).toISOString(),
      })
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(200);

    expect(res.body.data.buckets).toEqual([]);
  });

  it('hides another user\u2019s monitor', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/monitors/${otherMonitorId}/uptime`)
      .query(window)
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(404);
  });

  it('rejects an oversized range and an unknown granularity', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/monitors/${monitorId}/uptime`)
      .query({
        granularity: 'hour',
        from: '2020-01-01T00:00:00.000Z',
        to: '2026-01-01T00:00:00.000Z',
      })
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(400);

    await request(app.getHttpServer())
      .get(`/api/v1/monitors/${monitorId}/uptime`)
      .query({ granularity: 'week' })
      .set('Authorization', `Bearer ${ownerToken}`)
      .expect(400);
  });
});
