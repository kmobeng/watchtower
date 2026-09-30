import 'dotenv/config';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma.service';
import { AllExceptionsFilter } from '../src/common/filters/all-exception.filter';
import {
  CHECK_MONITOR_JOB,
  CheckSchedulerService,
  checkSchedulerId,
} from '../src/checks/check-scheduler.service';
import { CheckProcessor } from '../src/checks/check.processor';

describe('Monitors (live Postgres + Redis)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let scheduler: CheckSchedulerService;

  const ts = Date.now();
  const emailA = `monitors-a-${ts}@watchtower.local`;
  const emailB = `monitors-b-${ts}@watchtower.local`;
  const password = 'Password123!';
  let tokenA: string;
  let tokenB: string;
  let monitorId: string;

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
    // Mirror production main.ts so Prisma error mapping (P2002 -> 409,
    // P2025 -> 404) behaves exactly like the live server.
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();
    prisma = app.get(PrismaService);
    scheduler = app.get(CheckSchedulerService);

    const regA = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email: emailA, password, name: 'MonA' })
      .expect(201);
    tokenA = regA.body.token;

    const regB = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email: emailB, password, name: 'MonB' })
      .expect(201);
    tokenB = regB.body.token;
  });

  afterAll(async () => {
    // Monitors cascade-delete with their users (onDelete: Cascade).
    await prisma.user.deleteMany({
      where: { email: { in: [emailA, emailB] } },
    });
    await app.close();
  });

  it('creates a monitor with defaults', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/monitors')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ url: 'https://example.com/health', intervalSeconds: 300 })
      .expect(201);

    expect(res.body.success).toBe(true);
    expect(res.body.data.url).toBe('https://example.com/health');
    expect(res.body.data.method).toBe('GET');
    expect(res.body.data.timeoutMs).toBe(10000);
    expect(res.body.data.failureThreshold).toBe(3);
    monitorId = res.body.data.id;

    await expect(scheduler.listScheduledIds()).resolves.toContain(
      checkSchedulerId(monitorId),
    );
  });

  it('rejects invalid input', async () => {
    const server = app.getHttpServer();
    const auth = { Authorization: `Bearer ${tokenA}` };

    await request(server)
      .post('/api/v1/monitors')
      .set(auth)
      .send({ url: 'not-a-url', intervalSeconds: 300 })
      .expect(400);

    await request(server)
      .post('/api/v1/monitors')
      .set(auth)
      .send({ url: 'https://example.com/a', intervalSeconds: 10 })
      .expect(400);

    await request(server)
      .post('/api/v1/monitors')
      .set(auth)
      .send({
        url: 'https://example.com/b',
        intervalSeconds: 300,
        method: 'POST',
      })
      .expect(400);

    await request(server)
      .post('/api/v1/monitors')
      .set(auth)
      .send({ url: 'https://example.com/health', intervalSeconds: 300 })
      .expect(409);
  });

  it('paginates the list with meta', async () => {
    const server = app.getHttpServer();
    const auth = { Authorization: `Bearer ${tokenA}` };

    for (const n of [1, 2]) {
      await request(server)
        .post('/api/v1/monitors')
        .set(auth)
        .send({ url: `https://example.com/pag${n}`, intervalSeconds: 300 })
        .expect(201);
    }

    const p1 = await request(server)
      .get('/api/v1/monitors?page=1&limit=2')
      .set(auth)
      .expect(200);
    expect(p1.body.data).toHaveLength(2);
    expect(p1.body.meta).toMatchObject({
      page: 1,
      limit: 2,
      total: 3,
      totalPages: 2,
    });

    const p2 = await request(server)
      .get('/api/v1/monitors?page=2&limit=2')
      .set(auth)
      .expect(200);
    expect(p2.body.data).toHaveLength(1);
    expect(p2.body.meta.total).toBe(3);

    const p99 = await request(server)
      .get('/api/v1/monitors?page=99&limit=2')
      .set(auth)
      .expect(200);
    expect(p99.body.data).toHaveLength(0);
    expect(p99.body.meta.total).toBe(3);

    await request(server)
      .get('/api/v1/monitors?limit=101')
      .set(auth)
      .expect(400);
  });

  it('scopes monitors to their owner', async () => {
    const server = app.getHttpServer();
    const authB = { Authorization: `Bearer ${tokenB}` };

    await request(server)
      .patch(`/api/v1/monitors/${monitorId}`)
      .set(authB)
      .send({ intervalSeconds: 900 })
      .expect(404);

    await request(server)
      .delete(`/api/v1/monitors/${monitorId}`)
      .set(authB)
      .expect(404);

    const listB = await request(server)
      .get('/api/v1/monitors')
      .set(authB)
      .expect(200);
    expect(listB.body.data).toHaveLength(0);
    expect(listB.body.meta.total).toBe(0);
  });

  it('updates and deletes its own monitor', async () => {
    const server = app.getHttpServer();
    const auth = { Authorization: `Bearer ${tokenA}` };

    const patched = await request(server)
      .patch(`/api/v1/monitors/${monitorId}`)
      .set(auth)
      .send({ intervalSeconds: 600 })
      .expect(200);
    expect(patched.body.data.intervalSeconds).toBe(600);

    await request(server)
      .delete(`/api/v1/monitors/${monitorId}`)
      .set(auth)
      .expect(200);

    await expect(scheduler.listScheduledIds()).resolves.not.toContain(
      checkSchedulerId(monitorId),
    );

    await request(server)
      .patch(`/api/v1/monitors/${monitorId}`)
      .set(auth)
      .send({ intervalSeconds: 600 })
      .expect(404);
  });

  it('persists check results through the wired processor', async () => {
    const server = app.getHttpServer();
    const auth = { Authorization: `Bearer ${tokenA}` };

    // 127.0.0.1 on a high closed port deterministically refuses connections
    // (undici forbids low ports like :9 with 'bad port', so use :50099),
    // needing no external network and always classifying down.
    const created = await request(server)
      .post('/api/v1/monitors')
      .set(auth)
      .send({ url: 'http://127.0.0.1:50099', intervalSeconds: 60 })
      .expect(201);
    const checkMonitorId: string = created.body.data.id;

    const processor = app.get(CheckProcessor);
    const fire = () =>
      processor.process({
        name: CHECK_MONITOR_JOB,
        data: { monitorId: checkMonitorId },
      } as never);

    // Threshold defaults to 3: first two failures are suspicious, not down.
    await expect(fire()).resolves.toMatchObject({
      state: 'suspicious',
      consecutiveFailures: 1,
    });
    await expect(fire()).resolves.toMatchObject({
      state: 'suspicious',
      consecutiveFailures: 2,
    });
    await expect(fire()).resolves.toMatchObject({
      state: 'down',
      consecutiveFailures: 3,
    });

    const rows = await prisma.check.findMany({
      where: { monitorId: checkMonitorId },
    });
    // At least one row: creating the monitor arms the real scheduler, whose
    // first fire may race this manual invocation and persist its own row.
    expect(rows.length).toBeGreaterThanOrEqual(1);
    for (const row of rows) {
      expect(row).toMatchObject({
        statusCode: null,
        isUp: false,
        timedOut: false,
        error: 'connection_refused',
        region: 'local',
      });
      expect(row.responseTimeMs).toBeGreaterThanOrEqual(0);
    }

    await request(server)
      .delete(`/api/v1/monitors/${checkMonitorId}`)
      .set(auth)
      .expect(200);
  });

  it('requires authentication', async () => {
    await request(app.getHttpServer()).get('/api/v1/monitors').expect(401);
  });
});
