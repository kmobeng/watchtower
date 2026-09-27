import { MonitorsService } from './monitors.service';
import { PrismaService } from '../prisma.service';

describe('MonitorsService.findAll', () => {
  let service: MonitorsService;
  let prisma: {
    monitor: { findMany: jest.Mock; count: jest.Mock };
    $transaction: jest.Mock;
  };

  beforeEach(() => {
    prisma = {
      monitor: { findMany: jest.fn(), count: jest.fn() },
      $transaction: jest.fn((promises: Promise<unknown>[]) =>
        Promise.all(promises),
      ),
    };
    service = new MonitorsService(prisma as unknown as PrismaService);
  });

  it('paginates with skip/take and returns meta', async () => {
    prisma.monitor.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);
    prisma.monitor.count.mockResolvedValue(5);

    const result = await service.findAll('user-1', 2, 2);

    expect(prisma.monitor.findMany).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      orderBy: { createdAt: 'desc' },
      skip: 2,
      take: 2,
    });
    expect(prisma.monitor.count).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
    });
    expect(result).toEqual({
      items: [{ id: 'a' }, { id: 'b' }],
      total: 5,
      page: 2,
      limit: 2,
      totalPages: 3,
    });
  });

  it('returns an empty page instead of throwing', async () => {
    prisma.monitor.findMany.mockResolvedValue([]);
    prisma.monitor.count.mockResolvedValue(0);

    const result = await service.findAll('user-1', 1, 20);

    expect(result).toEqual({
      items: [],
      total: 0,
      page: 1,
      limit: 20,
      totalPages: 0,
    });
  });

  it('clamps limit to the max', async () => {
    prisma.monitor.findMany.mockResolvedValue([]);
    prisma.monitor.count.mockResolvedValue(0);

    const result = await service.findAll('user-1', 1, 500);

    expect(prisma.monitor.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 100 }),
    );
    expect(result.limit).toBe(100);
  });
});
