import 'dotenv/config';
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { CheckLockService } from '../src/checks/check-lock.service';
import { RedisService } from '../src/redis/redis.service';

describe('CheckLockService (live Redis)', () => {
  let app: INestApplication;
  let first: CheckLockService;
  let second: CheckLockService;

  const region = 'lock-test';
  const monitorId = `monitor-${Date.now()}`;
  const scheduledTime = String(Date.now());

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    const redis = app.get(RedisService);
    const config = app.get(ConfigService);
    first = new CheckLockService(redis, config);
    second = new CheckLockService(redis, config);
  });

  afterAll(async () => {
    await app.close();
  });

  it('lets exactly one worker claim a scheduled slot', async () => {
    const a = await first.acquire(region, monitorId, scheduledTime);
    const b = await second.acquire(region, monitorId, scheduledTime);

    expect(a).toEqual(expect.any(String));
    expect(b).toBeNull();

    await first.release(region, monitorId, scheduledTime, a!);

    const c = await second.acquire(region, monitorId, scheduledTime);
    expect(c).toEqual(expect.any(String));

    await second.release(region, monitorId, scheduledTime, c!);
  });

  it('does not release a slot owned by another worker', async () => {
    const slot = `${scheduledTime}-other`;
    const token = await first.acquire(region, monitorId, slot);
    expect(token).toEqual(expect.any(String));

    // A stale owner must not delete the live lock.
    await second.release(region, monitorId, slot, 'stale-token');
    await expect(second.acquire(region, monitorId, slot)).resolves.toBeNull();

    await first.release(region, monitorId, slot, token!);
  });
});
