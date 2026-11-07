import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EscalationPolicy, Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma.service';
import { CreateEscalationPolicyDto } from './dto/create-escalation-policy.dto';
import { UpdateEscalationPolicyDto } from './dto/update-escalation-policy.dto';

@Injectable()
export class EscalationPoliciesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    userId: string,
    dto: CreateEscalationPolicyDto,
  ): Promise<EscalationPolicy> {
    await this.assertChannelsOwned(userId, dto.steps);

    return this.prisma.escalationPolicy.create({
      data: {
        userId,
        name: dto.name,
        steps: dto.steps as unknown as Prisma.InputJsonValue,
      },
    });
  }

  async findAll(userId: string): Promise<EscalationPolicy[]> {
    return this.prisma.escalationPolicy.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(userId: string, id: string): Promise<EscalationPolicy> {
    const policy = await this.prisma.escalationPolicy.findFirst({
      where: { id, userId },
    });

    if (!policy) {
      throw new NotFoundException('Escalation policy not found');
    }

    return policy;
  }

  async update(
    userId: string,
    id: string,
    dto: UpdateEscalationPolicyDto,
  ): Promise<EscalationPolicy> {
    const existing = await this.findOne(userId, id);

    if (Object.keys(dto).length === 0) {
      return existing;
    }

    if (dto.steps !== undefined) {
      await this.assertChannelsOwned(userId, dto.steps);
    }

    return this.prisma.escalationPolicy.update({
      where: { id: existing.id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.steps !== undefined
          ? { steps: dto.steps as unknown as Prisma.InputJsonValue }
          : {}),
      },
    });
  }

  async remove(userId: string, id: string): Promise<void> {
    const result = await this.prisma.escalationPolicy.deleteMany({
      where: { id, userId },
    });

    if (result.count === 0) {
      throw new NotFoundException('Escalation policy not found');
    }
  }

  /**
   * A policy that points at someone else's channel would leak another user's
   * destination into this user's alerts, so ownership is checked on every
   * write rather than trusted from the request body.
   */
  private async assertChannelsOwned(
    userId: string,
    steps: { notifyChannelId: string }[],
  ): Promise<void> {
    const ids = [...new Set(steps.map((step) => step.notifyChannelId))];
    if (ids.length === 0) return;

    const owned = await this.prisma.notificationChannel.findMany({
      where: { id: { in: ids }, userId },
      select: { id: true },
    });

    if (owned.length !== ids.length) {
      throw new BadRequestException(
        'steps reference an unknown notification channel',
      );
    }
  }
}
