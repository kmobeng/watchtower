import 'dotenv/config';
import { createServer, Server, AddressInfo } from 'http';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma.service';
import { AllExceptionsFilter } from '../src/common/filters/all-exception.filter';
import { CHECK_MONITOR_JOB } from '../src/checks/check-scheduler.service';
import { CheckProcessor } from '../src/checks/check.processor';

describe('Incidents (live Postgres + Redis)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let processor: CheckProcessor;

  const ts = Date.now();
  const emailA = `incidents-a-${ts}@watchtower.local`;
  const emailB = `incidents-b-${ts}@watchtower.local`;
  const password = 'Password123!';
  let tokenA: string;
  let tokenB: string;
  let monitorId: string;
  let incidentId: string;

  let stub: Server;
  let stubUrl: string;

  jest.setTimeout(60000);

  beforeAll(async () => {
    // Deterministic UP target: a stub that always answers 200.
    stub = createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
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
    prisma = app.get(PrismaService);
    processor = app.get(CheckProcessor);

    const regA = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email: emailA, password, name: 'IncA' })
      .expect(201);
    tokenA = regA.body.token;

    const regB = await request(app.getHttpServer())
      .post('/api/v1/auth/register')
      .send({ email: emailB, password, name: 'IncB' })
      .expect(201);
    tokenB = regB.body.token;
  });

  afterAll(async () => {
    // Incidents + monitors + checks cascade-delete with their users.
    await prisma.user.deleteMany({
      where: { email: { in: [emailA, emailB] } },
    });
    await new Promise<void>((resolve) => stub.close(() => resolve()));
    await app.close();
  });

  function fire(id: string) {
    return processor.process({
      name: CHECK_MONITOR_JOB,
      data: { monitorId: id },
    } as never);
  }

  it('opens an incident on the down transition', async () => {
    const server = app.getHttpServer();
    const created = await request(server)
      .post('/api/v1/monitors')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({
        url: 'http://127.0.0.1:50099',
        intervalSeconds: 60,
        failureThreshold: 1,
      })
      .expect(201);
    monitorId = created.body.data.id;

    await fire(monitorId);

    const incidents = await prisma.incident.findMany({
      where: { monitorId },
    });
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({
      status: 'OPEN',
      cause: 'connection_refused',
    });
    expect(incidents[0].openedByCheckId).toBeTruthy();
    incidentId = incidents[0].id;
  });

  it('does not double-open while still down', async () => {
    await fire(monitorId);
    await fire(monitorId);

    const count = await prisma.incident.count({ where: { monitorId } });
    expect(count).toBe(1);
  });

  it('acknowledges, rejects double-ack and foreign users', async () => {
    const server = app.getHttpServer();

    const acked = await request(server)
      .post(`/api/v1/incidents/${incidentId}/acknowledge`)
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);
    expect(acked.body.data.status).toBe('ACKNOWLEDGED');

    await request(server)
      .post(`/api/v1/incidents/${incidentId}/acknowledge`)
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(409);

    await request(server)
      .post(`/api/v1/incidents/${incidentId}/acknowledge`)
      .set('Authorization', `Bearer ${tokenB}`)
      .expect(404);
  });

  it('resolves on recovery with downtime', async () => {
    const server = app.getHttpServer();
    const auth = { Authorization: `Bearer ${tokenA}` };

    await request(server)
      .patch(`/api/v1/monitors/${monitorId}`)
      .set(auth)
      .send({ url: stubUrl })
      .expect(200);

    await fire(monitorId);

    const incident = await prisma.incident.findUnique({
      where: { id: incidentId },
    });
    expect(incident).toMatchObject({ status: 'RESOLVED' });
    expect(incident?.resolvedAt).toBeTruthy();
    expect(incident?.downtimeSeconds).toBeGreaterThanOrEqual(0);
    expect(incident?.closedByCheckId).toBeTruthy();
  });

  it('lists incidents scoped to the owner', async () => {
    const server = app.getHttpServer();

    const listA = await request(server)
      .get(`/api/v1/incidents?monitorId=${monitorId}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);
    expect(listA.body.data).toHaveLength(1);
    expect(listA.body.meta.total).toBe(1);

    const listB = await request(server)
      .get('/api/v1/incidents')
      .set('Authorization', `Bearer ${tokenB}`)
      .expect(200);
    expect(listB.body.data).toHaveLength(0);
    expect(listB.body.meta.total).toBe(0);
  });
});
