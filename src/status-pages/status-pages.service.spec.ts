import 'reflect-metadata';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import {
  IncidentStatus,
  Prisma,
  RollupGranularity,
} from '../../generated/prisma/client';
import { PrismaService } from '../prisma.service';
import { RollupsService, UptimeBucketTotals } from '../rollups/rollups.service';
import { StatusPagesService } from './status-pages.service';

const window = {
  granularity: RollupGranularity.HOUR,
  from: new Date('2026-11-10T12:00:00.000Z'),
  to: new Date('2026-11-11T12:00:00.000Z'),
  firstBucket: new Date('2026-11-10T12:00:00.000Z'),
  lastBucket: new Date('2026-11-11T12:00:00.000Z'),
};

const bucket = (
  overrides: Partial<UptimeBucketTotals> = {},
): UptimeBucketTotals => ({
  bucketStart: '2026-11-11T11:00:00.000Z',
  checkCount: 10,
  upCount: 9,
  upResponseTimeSumMs: 900,
  uptimePct: 90,
  avgResponseTimeMs: 100,
  ...overrides,
});

const incident = (overrides: Record<string, unknown> = {}) => ({
  id: 'inc-1',
  monitorId: 'mon-1',
  status: IncidentStatus.OPEN,
  cause: 'http_5xx',
  startedAt: new Date('2026-11-11T10:00:00.000Z'),
  resolvedAt: null,
  downtimeSeconds: null,
  ...overrides,
});

describe('StatusPagesService', () => {
  let service: StatusPagesService;
  let prisma: {
    statusPage: Record<string, jest.Mock>;
    monitor: Record<string, jest.Mock>;
    incident: Record<string, jest.Mock>;
    check: Record<string, jest.Mock>;
  };
  let rollups: { resolveWindow: jest.Mock; getUptimeForMonitors: jest.Mock };

  beforeEach(() => {
    prisma = {
      statusPage: {
        create: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn(),
        delete: jest.fn(),
        findFirst: jest.fn(),
        findUnique: jest.fn(),
      },
      monitor: {
        count: jest.fn().mockResolvedValue(2),
        findMany: jest.fn().mockResolvedValue([
          { id: 'mon-1', url: 'https://one.example/health' },
          { id: 'mon-2', url: 'https://two.example/health' },
        ]),
      },
      incident: { findMany: jest.fn().mockResolvedValue([]) },
      check: {
        groupBy: jest.fn().mockResolvedValue([]),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };

    rollups = {
      resolveWindow: jest.fn().mockReturnValue(window),
      getUptimeForMonitors: jest.fn().mockResolvedValue(new Map()),
    };

    service = new StatusPagesService(
      prisma as unknown as PrismaService,
      rollups as unknown as RollupsService,
    );
  });

  describe('create', () => {
    it('dedupes monitor ids and defaults the page to private', async () => {
      prisma.statusPage.create.mockResolvedValue({ id: 'page-1' });

      await service.create('user-1', {
        slug: 'acme',
        monitorIds: ['mon-1', 'mon-1', 'mon-2'],
      });

      expect(prisma.monitor.count).toHaveBeenCalledWith({
        where: { id: { in: ['mon-1', 'mon-2'] }, userId: 'user-1' },
      });
      expect(prisma.statusPage.create).toHaveBeenCalledWith({
        data: {
          userId: 'user-1',
          slug: 'acme',
          monitorIds: ['mon-1', 'mon-2'],
          isPublic: false,
          title: null,
        },
      });
    });

    it('refuses to publish a monitor the caller does not own', async () => {
      prisma.monitor.count.mockResolvedValue(1);

      await expect(
        service.create('user-1', {
          slug: 'acme',
          monitorIds: ['mon-1', 'mon-2'],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.statusPage.create).not.toHaveBeenCalled();
    });

    it('maps a duplicate slug to 409', async () => {
      prisma.monitor.count.mockResolvedValue(1);
      prisma.statusPage.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('dup', {
          code: 'P2002',
          clientVersion: 'test',
        }),
      );

      await expect(
        service.create('user-1', { slug: 'acme', monitorIds: ['mon-1'] }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('update', () => {
    it('404s on a page owned by someone else', async () => {
      prisma.statusPage.findFirst.mockResolvedValue(null);

      await expect(
        service.update('user-1', 'page-1', { isPublic: true }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.statusPage.update).not.toHaveBeenCalled();
    });

    it('validates ownership when the monitor list changes', async () => {
      prisma.statusPage.findFirst.mockResolvedValue({ id: 'page-1' });
      prisma.monitor.count.mockResolvedValue(0);

      await expect(
        service.update('user-1', 'page-1', { monitorIds: ['mon-9'] }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.statusPage.update).not.toHaveBeenCalled();
    });

    it('only writes the fields that were provided', async () => {
      prisma.statusPage.findFirst.mockResolvedValue({ id: 'page-1' });
      prisma.statusPage.update.mockResolvedValue({ id: 'page-1' });

      await service.update('user-1', 'page-1', { isPublic: true });

      expect(prisma.statusPage.update).toHaveBeenCalledWith({
        where: { id: 'page-1' },
        data: { isPublic: true },
      });
    });
  });

  describe('remove', () => {
    it('404s on a foreign page and deletes an owned one', async () => {
      prisma.statusPage.findFirst.mockResolvedValueOnce(null);
      await expect(service.remove('user-1', 'page-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );

      prisma.statusPage.findFirst.mockResolvedValueOnce({ id: 'page-1' });
      await service.remove('user-1', 'page-1');
      expect(prisma.statusPage.delete).toHaveBeenCalledWith({
        where: { id: 'page-1' },
      });
    });
  });

  describe('getPublicPage', () => {
    const publishedPage = {
      slug: 'acme',
      title: 'Acme Status',
      userId: 'user-1',
      isPublic: true,
      monitorIds: ['mon-2', 'mon-1'],
    };

    beforeEach(() => {
      prisma.statusPage.findUnique.mockResolvedValue(publishedPage);
    });

    it('404s for an unknown slug', async () => {
      prisma.statusPage.findUnique.mockResolvedValue(null);

      await expect(service.getPublicPage('nope')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('404s for a page that is not published, without revealing it exists', async () => {
      prisma.statusPage.findUnique.mockResolvedValue({
        ...publishedPage,
        isPublic: false,
      });

      await expect(service.getPublicPage('acme')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.monitor.findMany).not.toHaveBeenCalled();
    });

    it('normalizes the slug before lookup', async () => {
      await service.getPublicPage('  ACME ');

      expect(prisma.statusPage.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { slug: 'acme' } }),
      );
    });

    it('scopes monitors to the page owner and preserves the listed order', async () => {
      await service.getPublicPage('acme');

      expect(prisma.monitor.findMany).toHaveBeenCalledWith({
        where: { id: { in: ['mon-2', 'mon-1'] }, userId: 'user-1' },
        select: { id: true, url: true },
      });

      const page = await service.getPublicPage('acme');
      expect(page.monitors.map((monitor) => monitor.id)).toEqual([
        'mon-2',
        'mon-1',
      ]);
    });

    it('drops monitors that were deleted or are not owned by the page owner', async () => {
      prisma.monitor.findMany.mockResolvedValue([
        { id: 'mon-1', url: 'https://one.example/health' },
      ]);

      const page = await service.getPublicPage('acme');

      expect(page.monitors).toHaveLength(1);
      expect(page.monitors[0].id).toBe('mon-1');
    });

    it('combines buckets into a window uptime and average', async () => {
      rollups.getUptimeForMonitors.mockResolvedValue(
        new Map([
          [
            'mon-1',
            [
              bucket({ checkCount: 10, upCount: 9, upResponseTimeSumMs: 900 }),
              bucket({
                bucketStart: '2026-11-11T10:00:00.000Z',
                checkCount: 10,
                upCount: 10,
                upResponseTimeSumMs: 1500,
              }),
            ],
          ],
        ]),
      );

      const page = await service.getPublicPage('acme');
      const monitor = page.monitors.find((item) => item.id === 'mon-1')!;

      // 19 of 20 checks, and (900 + 1500) / 19 for the average.
      expect(monitor.uptimePct).toBe(95);
      expect(monitor.avgResponseTimeMs).toBe(126.32);
      expect(monitor.buckets).toHaveLength(2);
      expect(monitor.buckets[0]).not.toHaveProperty('upResponseTimeSumMs');
    });

    it('reports a null uptime when the window has no checks', async () => {
      const page = await service.getPublicPage('acme');

      expect(page.monitors[0].uptimePct).toBeNull();
      expect(page.monitors[0].avgResponseTimeMs).toBeNull();
      expect(page.monitors[0].buckets).toEqual([]);
    });

    it('derives status from an open incident, else the latest check, else unknown', async () => {
      prisma.incident.findMany
        .mockResolvedValueOnce([
          incident({ id: 'inc-open', monitorId: 'mon-1' }),
        ])
        .mockResolvedValueOnce([]);
      prisma.check.groupBy.mockResolvedValue([
        { monitorId: 'mon-2', _max: { checkedAt: new Date() } },
      ]);
      prisma.check.findMany.mockResolvedValue([
        { monitorId: 'mon-2', isUp: true },
      ]);

      const page = await service.getPublicPage('acme');
      const byId = new Map(page.monitors.map((item) => [item.id, item]));

      expect(byId.get('mon-1')!.status).toBe('down');
      expect(byId.get('mon-2')!.status).toBe('up');
    });

    it('marks a monitor with a failed latest check as down', async () => {
      prisma.check.groupBy.mockResolvedValue([
        { monitorId: 'mon-1', _max: { checkedAt: new Date() } },
      ]);
      prisma.check.findMany.mockResolvedValue([
        { monitorId: 'mon-1', isUp: false },
      ]);

      const page = await service.getPublicPage('acme');
      const monitor = page.monitors.find((item) => item.id === 'mon-1')!;

      expect(monitor.status).toBe('down');
    });

    it('marks a monitor with no checks as unknown', async () => {
      const page = await service.getPublicPage('acme');

      expect(page.monitors[0].status).toBe('unknown');
    });

    it('bounds the latest-check lookup to the reported window', async () => {
      await service.getPublicPage('acme');

      expect(prisma.check.groupBy).toHaveBeenCalledWith({
        by: ['monitorId'],
        where: {
          monitorId: { in: ['mon-2', 'mon-1'] },
          checkedAt: { gte: window.from },
        },
        _max: { checkedAt: true },
      });
    });

    it('includes open incidents outside the history window exactly once', async () => {
      const ancient = incident({
        id: 'inc-ancient',
        monitorId: 'mon-1',
        status: IncidentStatus.ACKNOWLEDGED,
        startedAt: new Date('2026-01-01T00:00:00.000Z'),
        acknowledgedAt: new Date('2026-01-01T00:05:00.000Z'),
        escalationStep: 2,
        nextEscalationAt: new Date('2026-01-01T00:15:00.000Z'),
      });

      prisma.incident.findMany
        .mockResolvedValueOnce([ancient])
        .mockResolvedValueOnce([ancient]);

      const page = await service.getPublicPage('acme');
      const monitor = page.monitors.find((item) => item.id === 'mon-1')!;

      expect(monitor.incidents).toHaveLength(1);
      expect(monitor.incidents[0]).toEqual({
        id: 'inc-ancient',
        status: IncidentStatus.ACKNOWLEDGED,
        cause: 'http_5xx',
        startedAt: '2026-01-01T00:00:00.000Z',
        resolvedAt: null,
        downtimeSeconds: null,
      });
    });

    it('caps the per-monitor history at the newest ten incidents', async () => {
      const many = Array.from({ length: 15 }, (_, index) =>
        incident({
          id: `inc-${index}`,
          monitorId: 'mon-1',
          startedAt: new Date(Date.UTC(2026, 10, 1, index)),
        }),
      );

      prisma.incident.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(many);

      const page = await service.getPublicPage('acme');
      const monitor = page.monitors.find((item) => item.id === 'mon-1')!;

      expect(monitor.incidents).toHaveLength(10);
      expect(monitor.incidents[0].id).toBe('inc-14');
    });

    it('never exposes internal fields', async () => {
      rollups.getUptimeForMonitors.mockResolvedValue(
        new Map([['mon-1', [bucket()]]]),
      );
      prisma.incident.findMany
        .mockResolvedValueOnce([
          incident({
            acknowledgedAt: new Date(),
            escalationStep: 3,
            nextEscalationAt: new Date(),
          }),
        ])
        .mockResolvedValueOnce([]);

      const page = await service.getPublicPage('acme');
      const serialized = JSON.stringify(page);

      expect(serialized).not.toContain('userId');
      expect(serialized).not.toContain('acknowledgedAt');
      expect(serialized).not.toContain('escalationStep');
      expect(serialized).not.toContain('nextEscalationAt');
      expect(Object.keys(page.monitors[0]).sort()).toEqual([
        'avgResponseTimeMs',
        'buckets',
        'id',
        'incidents',
        'status',
        'uptimePct',
        'url',
      ]);
    });

    it('returns an empty monitor list when every listed monitor is gone', async () => {
      prisma.monitor.findMany.mockResolvedValue([]);

      const page = await service.getPublicPage('acme');

      expect(page.monitors).toEqual([]);
      expect(rollups.getUptimeForMonitors).not.toHaveBeenCalled();
    });
  });
});
