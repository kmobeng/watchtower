import 'dotenv/config';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import cookieParser from 'cookie-parser';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma.service';

describe('Auth smoke (live Postgres + Redis)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const email = `smoke-${Date.now()}@watchtower.local`;
  const password = 'password123';
  let accessToken: string;

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

  it('register -> login -> refresh -> logout', async () => {
    const agent = request.agent(app.getHttpServer());

    const reg = await agent
      .post('/api/v1/auth/register')
      .send({ email, password, name: 'Smoke' })
      .expect(201);
    expect(reg.body.success).toBe(true);
    expect(reg.body.token).toBeDefined();

    // NOTE: live-auction refresh JWTs carry only {sub}+iat (1s granularity),
    // so register->login inside the same second yields an identical token and
    // hits RefreshToken.token unique. Delay to cross a second boundary.
    await new Promise((r) => setTimeout(r, 1200));

    const login = await agent
      .post('/api/v1/auth/login')
      .send({ email, password })
      .expect(200);
    expect(login.body.success).toBe(true);
    accessToken = login.body.token;
    expect(accessToken).toBeDefined();

    const refresh = await agent.post('/api/v1/auth/refresh').expect(200);
    expect(refresh.body.success).toBe(true);
    expect(refresh.body.token).toBeDefined();

    await agent
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
  });

  it('forgot-password stays silent and returns success', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/forgot-password')
      .send({ email })
      .expect(200);
  });
});
