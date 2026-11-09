import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Monitor } from '../../generated/prisma/client';
import { PrismaService } from '../prisma.service';
import { CheckSchedulerService } from '../checks/check-scheduler.service';
import { FlapDetectorService } from '../flapping/flap-detector.service';
import { CreateMonitorDto } from './dto/create-monitor.dto';
import {
  MONITORS_DEFAULT_LIMIT,
  MONITORS_DEFAULT_PAGE,
  MONITORS_MAX_LIMIT,
} from './dto/list-monitors.dto';
import { UpdateMonitorDto } from './dto/update-monitor.dto';

export type MonitorWithFlapping = Monitor & { flapping: boolean };

export interface PaginatedMonitors {
  items: MonitorWithFlapping[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

@Injectable()
export class MonitorsService {
  private readonly logger = new Logger(MonitorsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scheduler: CheckSchedulerService,
    private readonly flaps: FlapDetectorService,
  ) {}

  async create(
    userId: string,
    dto: CreateMonitorDto,
  ): Promise<MonitorWithFlapping> {
    this.assertTimeoutWithinInterval(
      dto.intervalSeconds,
      dto.timeoutMs ?? 10000,
    );

    if (dto.escalationPolicyId) {
      await this.assertEscalationPolicyOwned(userId, dto.escalationPolicyId);
    }

    const monitor = await this.prisma.monitor.create({
      data: {
        userId,
        url: dto.url,
        intervalSeconds: dto.intervalSeconds,
        timeoutMs: dto.timeoutMs ?? 10000,
        failureThreshold: dto.failureThreshold ?? 3,
        ...(dto.escalationPolicyId
          ? { escalationPolicyId: dto.escalationPolicyId }
          : {}),
      },
    });

    try {
      await this.scheduler.schedule(monitor);
    } catch (error) {
      // No silent dead monitors: roll back the row so a retry starts clean.
      await this.prisma.monitor.delete({ where: { id: monitor.id } });
      this.logger.error(
        { monitorId: monitor.id, err: (error as Error)?.message },
        'Check scheduling failed, monitor rolled back',
      );
      throw new ServiceUnavailableException(
        'Monitor scheduling is temporarily unavailable. Please try again.',
      );
    }

    return { ...monitor, flapping: false };
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

    const flapping = await this.flaps.isFlappingMany(
      items.map((item) => item.id),
    );

    return {
      items: items.map((item) => ({
        ...item,
        flapping: flapping.get(item.id) ?? false,
      })),
      total,
      page: safePage,
      limit: safeLimit,
      totalPages: Math.ceil(total / safeLimit),
    };
  }

  async findOne(userId: string, id: string): Promise<MonitorWithFlapping> {
    const monitor = await this.prisma.monitor.findFirst({
      where: { id, userId },
    });

    if (!monitor) {
      throw new NotFoundException('Monitor not found');
    }

    return { ...monitor, flapping: await this.flaps.isFlapping(monitor.id) };
  }

  async update(
    userId: string,
    id: string,
    dto: UpdateMonitorDto,
  ): Promise<MonitorWithFlapping> {
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
      return {
        ...existing,
        flapping: await this.flaps.isFlapping(existing.id),
      };
    }

    if (dto.escalationPolicyId) {
      await this.assertEscalationPolicyOwned(userId, dto.escalationPolicyId);
    }

    const updated = await this.prisma.monitor.update({
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
        ...(dto.escalationPolicyId !== undefined
          ? { escalationPolicyId: dto.escalationPolicyId }
          : {}),
      },
    });

    // Only the interval affects the timer; other PATCHes leave it untouched so the schedule never resets or shifts phase.
    if (
      dto.intervalSeconds !== undefined &&
      dto.intervalSeconds !== existing.intervalSeconds
    ) {
      try {
        await this.scheduler.unschedule(existing.id);
        await this.scheduler.schedule(updated);
      } catch (error) {
        this.logger.error(
          { monitorId: existing.id, err: (error as Error)?.message },
          'Check rescheduling failed, reconciler will heal it on next boot',
        );
        throw new ServiceUnavailableException(
          'Monitor scheduling is temporarily unavailable. Please try again.',
        );
      }
    }

    return { ...updated, flapping: await this.flaps.isFlapping(updated.id) };
  }

  async remove(userId: string, id: string): Promise<void> {
    const result = await this.prisma.monitor.deleteMany({
      where: { id, userId },
    });

    if (result.count === 0) {
      throw new NotFoundException('Monitor not found');
    }

    await this.flaps.reset(id);

    try {
      await this.scheduler.unschedule(id);
    } catch (error) {
      this.logger.warn(
        { monitorId: id, err: (error as Error)?.message },
        'Check unscheduling failed after monitor delete',
      );
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

  private async assertEscalationPolicyOwned(
    userId: string,
    policyId: string,
  ): Promise<void> {
    const policy = await this.prisma.escalationPolicy.findFirst({
      where: { id: policyId, userId },
      select: { id: true },
    });

    if (!policy) {
      throw new NotFoundException('Escalation policy not found');
    }
  }
}
