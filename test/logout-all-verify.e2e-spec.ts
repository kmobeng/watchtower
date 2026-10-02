import 'dotenv/config';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma.service';

// NOTE: `GET /` is unguarded, so access-token validity is probed through
// `POST /api/v1/auth/logout-all` itself: the JwtAuthGuard runs before the
// handler, so 401 = token revoked, 200 = token still valid (and the call is
// an idempotent re-logout-all in that case).
describe('logout-all verification (live Postgres + Redis)', () => {
  // Full AppModule boot (Prisma pools + BullMQ workers) can exceed the
  // default 5s hook timeout under parallel-suite load.
  jest.setTimeout(60000);

  let app: INestApplication;
  let prisma: PrismaService;
  const email = `logout-verify-${Date.now()}@watchtower.local`;
  const password = 'password123';

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
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email } });
    await app.close();
  });

  it('Case A: logout-all kills every session immediately', async () => {
    const deviceA = request.agent(app.getHttpServer());
    const deviceB = request.agent(app.getHttpServer());

    // Unknown email stays silent-ish: 409, same as wrong password.
    await deviceA
      .post('/api/v1/auth/login')
      .send({ email, password: 'wrong-password' })
      .expect(409);

    await deviceA
      .post('/api/v1/auth/register')
      .send({ email, password, name: 'LogoutVerify' })
      .expect(201);

    // Same-second logins on purpose (refresh jti fix must hold for both).
    const reloginA = await deviceA
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(200);
    const loginB = await deviceB
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(200);
    const tokenA: string = reloginA.body.token;
    const tokenB: string = loginB.body.token;
    expect(tokenA).toBeDefined();
    expect(tokenB).toBeDefined();
    expect(tokenB).not.toBe(tokenA);

    await deviceA
      .post('/api/v1/auth/logout-all')
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);

    // B's access token must die immediately — not at natural expiry.
    await deviceB
      .post('/api/v1/auth/logout-all')
      .set('Authorization', `Bearer ${tokenB}`)
      .expect(401);

    // Both refresh sessions must be gone (rows deleted).
    await deviceB.post('/api/v1/auth/refresh').expect(409);
    await deviceA.post('/api/v1/auth/refresh').expect(409);

    // A's own access token must die too.
    await deviceA
      .post('/api/v1/auth/logout-all')
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(401);
  });

  it('Case B (control): single logout leaves the other session alive', async () => {
    const deviceA = request.agent(app.getHttpServer());
    const deviceB = request.agent(app.getHttpServer());

    const loginA = await deviceA
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(200);
    const loginB = await deviceB
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(200);
    const tokenA: string = loginA.body.token;
    const tokenB: string = loginB.body.token;

    await deviceA
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(200);

    // A is dead everywhere: guard rejects the access token, and the cleared
    // cookie means the refresh endpoint sees no token at all.
    await deviceA
      .post('/api/v1/auth/logout-all')
      .set('Authorization', `Bearer ${tokenA}`)
      .expect(401);
    await deviceA.post('/api/v1/auth/refresh').expect(400);

    // B survives: refresh rotation works, and a guarded route is reachable
    // (proves the access token is still valid).
    const refreshB = await deviceB.post('/api/v1/auth/refresh').expect(200);
    expect(refreshB.body.success).toBe(true);
    await deviceB
      .post('/api/v1/auth/logout-all')
      .set('Authorization', `Bearer ${tokenB}`)
      .expect(200);
  });
});
