import 'reflect-metadata';
import {
  IncidentStatus,
  NotificationChannelType,
  NotificationDeliveryStatus,
} from '../../generated/prisma/client';
import type { PrismaService } from '../prisma.service';
import {
  DELIVER_INCIDENT_NOTIFICATION_JOB,
  IncidentNotificationJob,
} from './incident-notifications.service';
import { IncidentNotificationsProcessor } from './incident-notifications.processor';
import type { NotificationDeliveryService } from './notification-delivery.service';

const job = (
  data: Partial<IncidentNotificationJob> = {},
): { name: string; data: IncidentNotificationJob } => ({
  name: DELIVER_INCIDENT_NOTIFICATION_JOB,
  data: { incidentId: 'inc-1', channelId: 'chan-1', step: 0, ...data },
});

const openIncident = (overrides: Record<string, any> = {}) => ({
  id: 'inc-1',
  cause: 'http_5xx',
  startedAt: new Date('2026-01-01T00:00:00Z'),
  status: IncidentStatus.OPEN,
  monitor: { userId: 'user-1', url: 'https://example.com/health' },
  ...overrides,
});

const emailChannel = (overrides: Record<string, any> = {}) => ({
  id: 'chan-1',
  userId: 'user-1',
  type: NotificationChannelType.EMAIL,
  destination: 'jane@example.com',
  ...overrides,
});

describe('IncidentNotificationsProcessor', () => {
  let processor: IncidentNotificationsProcessor;
  let prisma: {
    incident: { findUnique: jest.Mock };
    notificationChannel: { findUnique: jest.Mock };
  };
  let deliveries: {
    claim: jest.Mock;
    markSent: jest.Mock;
    markSkipped: jest.Mock;
    markFailure: jest.Mock;
  };
  let emailSender: { send: jest.Mock };
  let smsSender: { send: jest.Mock };
  let logger: { log: jest.Mock; warn: jest.Mock; error: jest.Mock };

  beforeEach(() => {
    prisma = {
      incident: { findUnique: jest.fn().mockResolvedValue(openIncident()) },
      notificationChannel: {
        findUnique: jest.fn().mockResolvedValue(emailChannel()),
      },
    };
    deliveries = {
      claim: jest.fn().mockResolvedValue({
        kind: 'claimed',
        delivery: { id: 'd1', attempts: 1 },
      }),
      markSent: jest.fn().mockResolvedValue(undefined),
      markSkipped: jest.fn().mockResolvedValue(undefined),
      markFailure: jest.fn().mockResolvedValue(false),
    };
    emailSender = { send: jest.fn().mockResolvedValue(undefined) };
    smsSender = { send: jest.fn().mockResolvedValue(undefined) };

    processor = new IncidentNotificationsProcessor(
      prisma as unknown as PrismaService,
      deliveries as unknown as NotificationDeliveryService,
      emailSender,
      smsSender,
    );

    logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    (processor as any).logger = logger;
  });

  it('drops the job when the incident or channel is gone', async () => {
    prisma.notificationChannel.findUnique.mockResolvedValue(null);

    await processor.process(job() as any);

    expect(deliveries.claim).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('throws when another worker holds the lease so BullMQ retries', async () => {
    deliveries.claim.mockResolvedValue({ kind: 'busy' });

    await expect(processor.process(job() as any)).rejects.toThrow(
      'already in flight',
    );
    expect(emailSender.send).not.toHaveBeenCalled();
  });

  it('does nothing when the delivery is already settled', async () => {
    deliveries.claim.mockResolvedValue({
      kind: 'terminal',
      delivery: { id: 'd1', status: NotificationDeliveryStatus.SENT },
    });

    await processor.process(job() as any);

    expect(emailSender.send).not.toHaveBeenCalled();
    expect(deliveries.markSent).not.toHaveBeenCalled();
  });

  it('skips an incident that was acknowledged while queued', async () => {
    prisma.incident.findUnique.mockResolvedValue(
      openIncident({ status: IncidentStatus.ACKNOWLEDGED }),
    );

    await processor.process(job() as any);

    expect(deliveries.markSkipped).toHaveBeenCalledWith(
      'd1',
      'incident is ACKNOWLEDGED',
    );
    expect(emailSender.send).not.toHaveBeenCalled();
  });

  it('skips a channel that does not belong to the monitor owner', async () => {
    prisma.notificationChannel.findUnique.mockResolvedValue(
      emailChannel({ userId: 'user-2' }),
    );

    await processor.process(job() as any);

    expect(deliveries.markSkipped).toHaveBeenCalledWith(
      'd1',
      'channel does not belong to the monitor owner',
    );
    expect(emailSender.send).not.toHaveBeenCalled();
  });

  it('sends an email with a provider idempotency key and marks it sent', async () => {
    await processor.process(job() as any);

    expect(emailSender.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'jane@example.com',
        subject: expect.stringContaining('https://example.com/health'),
        idempotencyKey: 'inc-1:jane@example.com:0',
      }),
    );
    expect(smsSender.send).not.toHaveBeenCalled();
    expect(deliveries.markSent).toHaveBeenCalledWith('d1');
  });

  it('sends an SMS through the SMS sender', async () => {
    prisma.notificationChannel.findUnique.mockResolvedValue(
      emailChannel({
        type: NotificationChannelType.SMS,
        destination: '+15551234567',
      }),
    );

    await processor.process(job() as any);

    expect(smsSender.send).toHaveBeenCalledWith({
      to: '+15551234567',
      body: expect.stringContaining('https://example.com/health'),
    });
    expect(emailSender.send).not.toHaveBeenCalled();
    expect(deliveries.markSent).toHaveBeenCalledWith('d1');
  });

  it('records a retryable failure and rethrows', async () => {
    emailSender.send.mockRejectedValue(new Error('provider 500'));

    await expect(processor.process(job() as any)).rejects.toThrow(
      'provider 500',
    );
    expect(deliveries.markFailure).toHaveBeenCalledWith(
      'd1',
      1,
      'provider 500',
    );
    expect(deliveries.markSent).not.toHaveBeenCalled();
  });

  it('does not retry a terminal failure', async () => {
    emailSender.send.mockRejectedValue(new Error('provider 400'));
    deliveries.markFailure.mockResolvedValue(true);

    await expect(processor.process(job() as any)).resolves.toBeUndefined();
    expect(deliveries.markFailure).toHaveBeenCalledWith(
      'd1',
      1,
      'provider 400',
    );
  });
});
