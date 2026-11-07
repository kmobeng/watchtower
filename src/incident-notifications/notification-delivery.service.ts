import { Injectable } from '@nestjs/common';
import {
  NotificationChannelType,
  NotificationDelivery,
  NotificationDeliveryStatus,
} from '../../generated/prisma/client';
import { PrismaService } from '../prisma.service';

/**
 * How long a claimed delivery is considered in flight. A retry only steals
 * the claim once this window has passed, so two workers cannot both send.
 */
export const DELIVERY_LEASE_MS = 120_000;

/** After this many claims, a still-failing delivery becomes terminal. */
export const DELIVERY_MAX_ATTEMPTS = 5;

export type ClaimInput = {
  incidentId: string;
  channelId: string;
  step: number;
  channelType: NotificationChannelType;
  destination: string;
};

export type ClaimResult =
  | { kind: 'claimed'; delivery: NotificationDelivery }
  | { kind: 'busy' }
  | { kind: 'terminal'; delivery: NotificationDelivery };

/**
 * The idempotency gate.
 *
 * The unique `(incidentId, channelId, step)` constraint decides who may send:
 * the first worker to insert the row wins, and every later worker either sees
 * a live lease (`busy`) or a settled row (`terminal`). A crash mid-send leaves
 * a stale lease that a retry can steal, so an alert is never silently lost.
 */
@Injectable()
export class NotificationDeliveryService {
  constructor(private readonly prisma: PrismaService) {}

  async claim(input: ClaimInput): Promise<ClaimResult> {
    try {
      const delivery = await this.prisma.notificationDelivery.create({
        data: {
          incidentId: input.incidentId,
          channelId: input.channelId,
          step: input.step,
          channelType: input.channelType,
          destination: input.destination,
          status: NotificationDeliveryStatus.PENDING,
          attempts: 1,
          claimedAt: new Date(),
        },
      });
      return { kind: 'claimed', delivery };
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
    }

    const staleBefore = new Date(Date.now() - DELIVERY_LEASE_MS);
    const result = await this.prisma.notificationDelivery.updateMany({
      where: {
        incidentId: input.incidentId,
        channelId: input.channelId,
        step: input.step,
        status: NotificationDeliveryStatus.PENDING,
        // `claimedAt: null` is how a failed attempt hands the row back, so it
        // must be re-claimable immediately rather than after the lease.
        OR: [{ claimedAt: null }, { claimedAt: { lt: staleBefore } }],
      },
      data: { claimedAt: new Date(), attempts: { increment: 1 } },
    });

    const delivery = await this.prisma.notificationDelivery.findUnique({
      where: {
        incidentId_channelId_step: {
          incidentId: input.incidentId,
          channelId: input.channelId,
          step: input.step,
        },
      },
    });

    if (result.count === 0) {
      if (delivery?.status === NotificationDeliveryStatus.PENDING) {
        return { kind: 'busy' };
      }
      return delivery ? { kind: 'terminal', delivery } : { kind: 'busy' };
    }

    if (!delivery) {
      // Unreachable: the update matched a row, so it must still exist.
      throw new Error('Claimed delivery disappeared');
    }

    return { kind: 'claimed', delivery };
  }

  async markSent(id: string): Promise<void> {
    await this.prisma.notificationDelivery.update({
      where: { id },
      data: {
        status: NotificationDeliveryStatus.SENT,
        sentAt: new Date(),
        claimedAt: null,
        lastError: null,
      },
    });
  }

  async markSkipped(id: string, reason: string): Promise<void> {
    await this.prisma.notificationDelivery.update({
      where: { id },
      data: {
        status: NotificationDeliveryStatus.SKIPPED,
        claimedAt: null,
        lastError: reason,
      },
    });
  }

  /**
   * Records a failed attempt. Returns true when the delivery is now terminal
   * (so the caller must not throw and trigger another retry).
   */
  async markFailure(
    id: string,
    attempts: number,
    error: string,
  ): Promise<boolean> {
    if (attempts >= DELIVERY_MAX_ATTEMPTS) {
      await this.prisma.notificationDelivery.update({
        where: { id },
        data: {
          status: NotificationDeliveryStatus.FAILED,
          claimedAt: null,
          lastError: error,
        },
      });
      return true;
    }

    await this.prisma.notificationDelivery.update({
      where: { id },
      data: { claimedAt: null, lastError: error },
    });
    return false;
  }

  async markAbandoned(id: string, reason: string): Promise<void> {
    await this.prisma.notificationDelivery.update({
      where: { id },
      data: {
        status: NotificationDeliveryStatus.FAILED,
        claimedAt: null,
        lastError: reason,
      },
    });
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === 'P2002'
  );
}
