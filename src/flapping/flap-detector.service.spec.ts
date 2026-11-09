import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../redis/redis.service';
import {
  FlapDetectorService,
  flapActiveKey,
  flapEventsKey,
  flapLastKey,
} from './flap-detector.service';

describe('FlapDetectorService', () => {
  let client: {
    eval: jest.Mock;
    exists: jest.Mock;
    mget: jest.Mock;
    del: jest.Mock;
  };
  let service: FlapDetectorService;

  function configWith(
    values: Record<string, string | undefined>,
  ): ConfigService {
    return {
      get: jest.fn((key: string) => values[key]),
    } as unknown as ConfigService;
  }

  beforeEach(() => {
    client = {
      eval: jest.fn().mockResolvedValue([0, 0]),
      exists: jest.fn().mockResolvedValue(0),
      mget: jest.fn().mockResolvedValue([]),
      del: jest.fn().mockResolvedValue(0),
    };
    service = new FlapDetectorService(
      { getClient: () => client } as unknown as RedisService,
      configWith({}),
    );
  });

  it('namespaces the three keys by monitor', () => {
    expect(flapLastKey('mon-1')).toBe('flap:last:mon-1');
    expect(flapEventsKey('mon-1')).toBe('flap:events:mon-1');
    expect(flapActiveKey('mon-1')).toBe('flap:active:mon-1');
  });

  it('defaults to five allowed changes over thirty minutes', () => {
    expect(service.maxChanges).toBe(5);
    expect(service.windowMs).toBe(30 * 60 * 1000);
  });

  it('honours FLAP_MAX_CHANGES and FLAP_WINDOW_SECONDS', () => {
    const custom = new FlapDetectorService(
      { getClient: () => client } as unknown as RedisService,
      configWith({ FLAP_MAX_CHANGES: '2', FLAP_WINDOW_SECONDS: '90' }),
    );

    expect(custom.maxChanges).toBe(2);
    expect(custom.windowMs).toBe(90_000);
  });

  it.each(['-1', '1.5', 'abc'])(
    'rejects an invalid FLAP_MAX_CHANGES (%s)',
    (value) => {
      expect(
        () =>
          new FlapDetectorService(
            { getClient: () => client } as unknown as RedisService,
            configWith({ FLAP_MAX_CHANGES: value }),
          ),
      ).toThrow('FLAP_MAX_CHANGES');
    },
  );

  it.each(['0', '-5', 'abc'])(
    'rejects an invalid FLAP_WINDOW_SECONDS (%s)',
    (value) => {
      expect(
        () =>
          new FlapDetectorService(
            { getClient: () => client } as unknown as RedisService,
            configWith({ FLAP_WINDOW_SECONDS: value }),
          ),
      ).toThrow('FLAP_WINDOW_SECONDS');
    },
  );

  it('records a verdict atomically across the three keys', async () => {
    client.eval.mockResolvedValue([6, 1]);

    await expect(
      service.record('mon-1', 'down', 1700000000000),
    ).resolves.toEqual({ changes: 6, flapping: true });

    expect(client.eval).toHaveBeenCalledWith(
      expect.any(String),
      3,
      'flap:last:mon-1',
      'flap:events:mon-1',
      'flap:active:mon-1',
      'down',
      '1700000000000',
      '1800000',
      '5',
      expect.any(String),
    );
  });

  it('passes hold through so the script can ignore it', async () => {
    await service.record('mon-1', 'hold', 1700000000000);

    expect(client.eval).toHaveBeenCalledWith(
      expect.any(String),
      3,
      expect.any(String),
      expect.any(String),
      expect.any(String),
      'hold',
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.any(String),
    );
  });

  it('fails open when recording hits a Redis error', async () => {
    client.eval.mockRejectedValue(new Error('redis down'));

    await expect(service.record('mon-1', 'up')).resolves.toEqual({
      changes: 0,
      flapping: false,
    });
  });

  it('reads the active flag', async () => {
    client.exists.mockResolvedValueOnce(1).mockResolvedValueOnce(0);

    await expect(service.isFlapping('mon-1')).resolves.toBe(true);
    await expect(service.isFlapping('mon-1')).resolves.toBe(false);
    expect(client.exists).toHaveBeenCalledWith('flap:active:mon-1');
  });

  it('fails open to not flapping when the read fails', async () => {
    client.exists.mockRejectedValue(new Error('redis down'));

    await expect(service.isFlapping('mon-1')).resolves.toBe(false);
  });

  it('batches list lookups into one mget', async () => {
    client.mget.mockResolvedValue(['1', null]);

    await expect(service.isFlappingMany(['mon-1', 'mon-2'])).resolves.toEqual(
      new Map([
        ['mon-1', true],
        ['mon-2', false],
      ]),
    );
    expect(client.mget).toHaveBeenCalledWith([
      'flap:active:mon-1',
      'flap:active:mon-2',
    ]);
  });

  it('skips Redis for an empty list', async () => {
    await expect(service.isFlappingMany([])).resolves.toEqual(new Map());
    expect(client.mget).not.toHaveBeenCalled();
  });

  it('fails open to not flapping for a whole batch', async () => {
    client.mget.mockRejectedValue(new Error('redis down'));

    const result = await service.isFlappingMany(['mon-1', 'mon-2']);

    expect(result).toEqual(
      new Map([
        ['mon-1', false],
        ['mon-2', false],
      ]),
    );
  });

  it('resets all three keys for a monitor', async () => {
    await service.reset('mon-1');

    expect(client.del).toHaveBeenCalledWith(
      'flap:last:mon-1',
      'flap:events:mon-1',
      'flap:active:mon-1',
    );
  });

  it('fails open when reset fails', async () => {
    client.del.mockRejectedValue(new Error('redis down'));

    await expect(service.reset('mon-1')).resolves.toBeUndefined();
  });
});
