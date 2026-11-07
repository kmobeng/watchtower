import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { isEmail } from 'class-validator';
import {
  NotificationChannel,
  NotificationChannelType,
} from '../../generated/prisma/client';
import { PrismaService } from '../prisma.service';
import { tryParseEscalationSteps } from '../escalation-policies/escalation-steps';
import { CreateNotificationChannelDto } from './dto/create-notification-channel.dto';
import { UpdateNotificationChannelDto } from './dto/update-notification-channel.dto';

// E.164: leading +, country code 1-9, then 7-14 more digits.
const E164_PATTERN = /^\+[1-9]\d{7,14}$/;

@Injectable()
export class NotificationChannelsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    userId: string,
    dto: CreateNotificationChannelDto,
  ): Promise<NotificationChannel> {
    const destination = this.normalizeDestination(dto.type, dto.destination);

    return this.prisma.notificationChannel.create({
      data: {
        userId,
        type: dto.type,
        destination,
        ...(dto.label !== undefined ? { label: dto.label } : {}),
      },
    });
  }

  async findAll(userId: string): Promise<NotificationChannel[]> {
    return this.prisma.notificationChannel.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(userId: string, id: string): Promise<NotificationChannel> {
    const channel = await this.prisma.notificationChannel.findFirst({
      where: { id, userId },
    });

    if (!channel) {
      throw new NotFoundException('Notification channel not found');
    }

    return channel;
  }

  async update(
    userId: string,
    id: string,
    dto: UpdateNotificationChannelDto,
  ): Promise<NotificationChannel> {
    const existing = await this.findOne(userId, id);

    if (Object.keys(dto).length === 0) {
      return existing;
    }

    const type = dto.type ?? existing.type;
    // A type change must re-validate the destination, even when the caller
    // only sent the new type.
    const destination =
      dto.destination !== undefined || dto.type !== undefined
        ? this.normalizeDestination(
            type,
            dto.destination ?? existing.destination,
          )
        : undefined;

    return this.prisma.notificationChannel.update({
      where: { id: existing.id },
      data: {
        ...(dto.type !== undefined ? { type } : {}),
        ...(destination !== undefined ? { destination } : {}),
        ...(dto.label !== undefined ? { label: dto.label } : {}),
      },
    });
  }

  async remove(userId: string, id: string): Promise<void> {
    const existing = await this.findOne(userId, id);

    // The FK only protects channels that already have a delivery. A channel
    // referenced by a policy but never delivered would otherwise be deleted
    // and silently drop that step's alert at processing time.
    if (await this.isReferencedByPolicy(userId, existing.id)) {
      throw new ConflictException(
        'Notification channel is used by an escalation policy',
      );
    }

    try {
      await this.prisma.notificationChannel.delete({
        where: { id: existing.id },
      });
    } catch (error) {
      if (isForeignKeyViolation(error)) {
        throw new ConflictException(
          'Notification channel has delivery history and cannot be deleted',
        );
      }
      throw error;
    }
  }

  private async isReferencedByPolicy(
    userId: string,
    channelId: string,
  ): Promise<boolean> {
    const policies = await this.prisma.escalationPolicy.findMany({
      where: { userId },
      select: { steps: true },
    });

    return policies.some((policy) => {
      const steps = tryParseEscalationSteps(policy.steps);
      return steps?.some((step) => step.notifyChannelId === channelId) ?? false;
    });
  }

  private normalizeDestination(
    type: NotificationChannelType,
    value: string,
  ): string {
    const destination = value.trim();

    if (type === NotificationChannelType.EMAIL) {
      if (!isEmail(destination)) {
        throw new BadRequestException('destination must be a valid email');
      }
      return destination;
    }

    if (!E164_PATTERN.test(destination)) {
      throw new BadRequestException(
        'destination must be an E.164 phone number, e.g. +15551234567',
      );
    }
    return destination;
  }
}

function isForeignKeyViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === 'P2003'
  );
}
