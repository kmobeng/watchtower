import 'reflect-metadata';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { RollupGranularity } from '../../generated/prisma/client';
import { PrismaService } from '../prisma.service';
import { RollupsService } from './rollups.service';

describe('RollupsService', () => {
  let prisma: {
    check: { groupBy: jest.Mock };
    checkRollup: { upsert: jest.Mock; findMany: jest.Mock };
    monitor: { findFirst: jest.Mock };
    $transaction: jest.Mock;
  };
  let service: RollupsService;

  beforeEach(() => {
    prisma = {
      check: { groupBy: jest.fn().mockResolvedValue([]) },
      checkRollup: {
        upsert: jest.fn((args: unknown) => Promise.resolve(args)),
        findMany: jest.fn().mockResolvedValue([]),
      },
      monitor: { findFirst: jest.fn().mockResolvedValue({ id: 'mon-1' }) },
      $transaction: jest.fn((operations: Promise<unknown>[]) =>
        Promise.all(operations),
      ),
    };
    service = new RollupsService(prisma as unknown as PrismaService);
  });

  describe('rollupBucket', () => {
    it('stores additive counters per monitor and region', async () => {
      prisma.check.groupBy.mockResolvedValue([
        {
          monitorId: 'mon-1',
          region: 'us',
          isUp: true,
          _count: { _all: 3 },
          _sum: { responseTimeMs: 300 },
        },
        {
          monitorId: 'mon-1',
          region: 'us',
          isUp: false,
          _count: { _all: 2 },
          _sum: { responseTimeMs: 500 },
        },
        {
          monitorId: 'mon-1',
          region: 'eu',
          isUp: true,
          _count: { _all: 1 },
          _sum: { responseTimeMs: 100 },
        },
      ]);

      await expect(
        service.rollupBucket(
          RollupGranularity.HOUR,
          new Date('2026-11-09T10:37:00.000Z'),
        ),
      ).resolves.toBe(2);

      expect(prisma.check.groupBy).toHaveBeenCalledWith({
        by: ['monitorId', 'region', 'isUp'],
        where: {
          checkedAt: {
            gte: new Date('2026-11-09T10:00:00.000Z'),
            lt: new Date('2026-11-09T11:00:00.000Z'),
          },
        },
        _count: { _all: true },
        _sum: { responseTimeMs: true },
      });

      const creates = prisma.checkRollup.upsert.mock.calls.map(
        ([args]) => args.create,
      );

      expect(creates).toEqual(
        expect.arrayContaining([
          {
            monitorId: 'mon-1',
            region: 'us',
            granularity: RollupGranularity.HOUR,
            bucketStart: new Date('2026-11-09T10:00:00.000Z'),
            checkCount: 5,
            upCount: 3,
            upResponseTimeSumMs: 300,
          },
          {
            monitorId: 'mon-1',
            region: 'eu',
            granularity: RollupGranularity.HOUR,
            bucketStart: new Date('2026-11-09T10:00:00.000Z'),
            checkCount: 1,
            upCount: 1,
            upResponseTimeSumMs: 100,
          },
        ]),
      );

      // Failed checks contribute to checkCount but never to the response sum.
      expect(creates).toHaveLength(2);
    });

    it('does not write anything for an empty bucket', async () => {
      await expect(
        service.rollupBucket(
          RollupGranularity.HOUR,
          new Date('2026-11-09T10:00:00.000Z'),
        ),
      ).resolves.toBe(0);

      expect(prisma.checkRollup.upsert).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('rollupRecent', () => {
    it('recomputes the requested completed buckets oldest first', async () => {
      const rollup = jest.spyOn(service, 'rollupBucket').mockResolvedValue(2);

      await expect(
        service.rollupRecent(
          RollupGranularity.HOUR,
          2,
          new Date('2026-11-09T10:34:00.000Z'),
        ),
      ).resolves.toEqual({ buckets: 2, rows: 4 });

      expect(rollup).toHaveBeenNthCalledWith(
        1,
        RollupGranularity.HOUR,
        new Date('2026-11-09T08:00:00.000Z'),
      );
      expect(rollup).toHaveBeenNthCalledWith(
        2,
        RollupGranularity.HOUR,
        new Date('2026-11-09T09:00:00.000Z'),
      );
    });
  });

  describe('rollupRange', () => {
    it('recomputes every bucket touching the range', async () => {
      const rollup = jest.spyOn(service, 'rollupBucket').mockResolvedValue(1);

      await expect(
        service.rollupRange(
          RollupGranularity.DAY,
          new Date('2026-11-07T12:00:00.000Z'),
          new Date('2026-11-09T01:00:00.000Z'),
        ),
      ).resolves.toEqual({ buckets: 3, rows: 3 });

      expect(rollup).toHaveBeenCalledTimes(3);
      expect(rollup).toHaveBeenNthCalledWith(
        1,
        RollupGranularity.DAY,
        new Date('2026-11-07T00:00:00.000Z'),
      );
      expect(rollup).toHaveBeenNthCalledWith(
        3,
        RollupGranularity.DAY,
        new Date('2026-11-09T00:00:00.000Z'),
      );
    });
  });

  describe('getUptime', () => {
    const from = '2026-11-09T08:00:00.000Z';
    const to = '2026-11-09T09:59:59.000Z';

    it('combines regions and derives uptime and average on read', async () => {
      prisma.checkRollup.findMany.mockResolvedValue([
        {
          bucketStart: new Date('2026-11-09T09:00:00.000Z'),
          checkCount: 10,
          upCount: 9,
          upResponseTimeSumMs: 900,
        },
        {
          bucketStart: new Date('2026-11-09T09:00:00.000Z'),
          checkCount: 10,
          upCount: 10,
          upResponseTimeSumMs: 1000,
        },
        {
          bucketStart: new Date('2026-11-09T08:00:00.000Z'),
          checkCount: 5,
          upCount: 5,
          upResponseTimeSumMs: 500,
        },
      ]);

      const summary = await service.getUptime('user-1', 'mon-1', {
        granularity: 'hour',
        from,
        to,
      });

      expect(prisma.monitor.findFirst).toHaveBeenCalledWith({
        where: { id: 'mon-1', userId: 'user-1' },
        select: { id: true },
      });
      expect(summary).toEqual({
        monitorId: 'mon-1',
        granularity: 'hour',
        from,
        to,
        region: null,
        buckets: [
          {
            bucketStart: '2026-11-09T08:00:00.000Z',
            checkCount: 5,
            upCount: 5,
            uptimePct: 100,
            avgResponseTimeMs: 100,
          },
          {
            bucketStart: '2026-11-09T09:00:00.000Z',
            checkCount: 20,
            upCount: 19,
            uptimePct: 95,
            avgResponseTimeMs: 100,
          },
        ],
      });
    });

    it('filters to one region when requested', async () => {
      prisma.checkRollup.findMany.mockResolvedValue([]);

      const summary = await service.getUptime('user-1', 'mon-1', {
        granularity: 'hour',
        from,
        to,
        region: ' eu ',
      });

      expect(prisma.checkRollup.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ region: 'eu' }),
        }),
      );
      expect(summary.region).toBe('eu');
      expect(summary.buckets).toEqual([]);
    });

    it('returns a null average when no check succeeded', async () => {
      prisma.checkRollup.findMany.mockResolvedValue([
        {
          bucketStart: new Date('2026-11-09T08:00:00.000Z'),
          checkCount: 3,
          upCount: 0,
          upResponseTimeSumMs: 0,
        },
      ]);

      const summary = await service.getUptime('user-1', 'mon-1', {
        granularity: 'hour',
        from,
        to,
      });

      expect(summary.buckets[0]).toMatchObject({
        uptimePct: 0,
        avgResponseTimeMs: null,
      });
    });

    it('defaults to hourly granularity and a 24 hour window', async () => {
      await service.getUptime('user-1', 'mon-1', {});

      const where = prisma.checkRollup.findMany.mock.calls[0][0].where;

      expect(where.granularity).toBe(RollupGranularity.HOUR);
      expect(where.bucketStart.gte).toBeInstanceOf(Date);
      expect(where.bucketStart.lte).toBeInstanceOf(Date);
      expect(
        where.bucketStart.lte.getTime() - where.bucketStart.gte.getTime(),
      ).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000);
    });

    it('defaults to daily granularity and a 30 day window', async () => {
      await service.getUptime('user-1', 'mon-1', { granularity: 'day' });

      const where = prisma.checkRollup.findMany.mock.calls[0][0].where;

      expect(where.granularity).toBe(RollupGranularity.DAY);
      expect(
        where.bucketStart.lte.getTime() - where.bucketStart.gte.getTime(),
      ).toBeGreaterThanOrEqual(30 * 24 * 60 * 60 * 1000);
    });

    it('rejects a range wider than the bucket limit', async () => {
      await expect(
        service.getUptime('user-1', 'mon-1', {
          granularity: 'hour',
          from: '2026-01-01T00:00:00.000Z',
          to: '2026-04-01T00:00:00.000Z',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a reversed range', async () => {
      await expect(
        service.getUptime('user-1', 'mon-1', {
          granularity: 'hour',
          from: to,
          to: from,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('hides monitors owned by another user', async () => {
      prisma.monitor.findFirst.mockResolvedValue(null);

      await expect(
        service.getUptime('user-2', 'mon-1', { granularity: 'hour' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
