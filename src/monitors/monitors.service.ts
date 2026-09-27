import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Monitor } from '../../generated/prisma/client';
import { PrismaService } from '../prisma.service';
import { CreateMonitorDto } from './dto/create-monitor.dto';
import {
  MONITORS_DEFAULT_LIMIT,
  MONITORS_DEFAULT_PAGE,
  MONITORS_MAX_LIMIT,
} from './dto/list-monitors.dto';
import { UpdateMonitorDto } from './dto/update-monitor.dto';

export interface PaginatedMonitors {
  items: Monitor[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

@Injectable()
export class MonitorsService {
  constructor(private readonly prisma: PrismaService) {}

  create(userId: string, dto: CreateMonitorDto): Promise<Monitor> {
    this.assertTimeoutWithinInterval(
      dto.intervalSeconds,
      dto.timeoutMs ?? 10000,
    );

    return this.prisma.monitor.create({
      data: {
        userId,
        url: dto.url,
        intervalSeconds: dto.intervalSeconds,
        timeoutMs: dto.timeoutMs ?? 10000,
        failureThreshold: dto.failureThreshold ?? 3,
      },
    });
  }

  async findAll(
    userId: string,
    page: number = MONITORS_DEFAULT_PAGE,
    limit: number = MONITORS_DEFAULT_LIMIT,
  ): Promise<PaginatedMonitors> {
    const safePage = Math.max(1, Math.floor(page));
    const safeLimit = Math.min(
      Math.max(1, Math.floor(limit)),
      MONITORS_MAX_LIMIT,
    );
    const skip = (safePage - 1) * safeLimit;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.monitor.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: safeLimit,
      }),
      this.prisma.monitor.count({ where: { userId } }),
    ]);

    return {
      items,
      total,
      page: safePage,
      limit: safeLimit,
      totalPages: Math.ceil(total / safeLimit),
    };
  }

  async findOne(userId: string, id: string): Promise<Monitor> {
    const monitor = await this.prisma.monitor.findFirst({
      where: { id, userId },
    });

    if (!monitor) {
      throw new NotFoundException('Monitor not found');
    }

    return monitor;
  }

  async update(
    userId: string,
    id: string,
    dto: UpdateMonitorDto,
  ): Promise<Monitor> {
    const existing = await this.prisma.monitor.findFirst({
      where: { id, userId },
    });

    if (!existing) {
      throw new NotFoundException('Monitor not found');
    }

    const nextInterval = dto.intervalSeconds ?? existing.intervalSeconds;
    const nextTimeout = dto.timeoutMs ?? existing.timeoutMs;
    this.assertTimeoutWithinInterval(nextInterval, nextTimeout);

    if (Object.keys(dto).length === 0) {
      return existing;
    }

    return this.prisma.monitor.update({
      where: { id: existing.id },
      data: {
        ...(dto.url !== undefined ? { url: dto.url } : {}),
        ...(dto.intervalSeconds !== undefined
          ? { intervalSeconds: dto.intervalSeconds }
          : {}),
        ...(dto.timeoutMs !== undefined ? { timeoutMs: dto.timeoutMs } : {}),
        ...(dto.failureThreshold !== undefined
          ? { failureThreshold: dto.failureThreshold }
          : {}),
      },
    });
  }

  async remove(userId: string, id: string): Promise<void> {
    const result = await this.prisma.monitor.deleteMany({
      where: { id, userId },
    });

    if (result.count === 0) {
      throw new NotFoundException('Monitor not found');
    }
  }

  private assertTimeoutWithinInterval(
    intervalSeconds: number,
    timeoutMs: number,
  ): void {
    if (timeoutMs >= intervalSeconds * 1000) {
      throw new BadRequestException(
        'Timeout must be less than the check interval',
      );
    }
  }
}
