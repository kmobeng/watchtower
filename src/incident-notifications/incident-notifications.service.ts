import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

export const INCIDENT_NOTIFICATIONS_QUEUE = 'incident-notifications';
export const DELIVER_INCIDENT_NOTIFICATION_JOB =
  'deliver-incident-notification';

export type IncidentNotificationJob = {
  incidentId: string;
  channelId: string;
  step: number;
};

/**
 * BullMQ job ids reject colons, so the dedupe key is hyphenated. This only
 * collapses duplicate enqueues while the job is still tracked; the database
 * delivery row remains the source of truth.
 */
export function buildIncidentNotificationJobId(
  data: IncidentNotificationJob,
): string {
  return `incident-${data.incidentId}-channel-${data.channelId}-step-${data.step}`;
}

@Injectable()
export class IncidentNotificationsService {
  constructor(
    @InjectQueue(INCIDENT_NOTIFICATIONS_QUEUE)
    private readonly queue: Queue,
  ) {}

  async enqueue(data: IncidentNotificationJob): Promise<void> {
    await this.queue.add(DELIVER_INCIDENT_NOTIFICATION_JOB, data, {
      jobId: buildIncidentNotificationJobId(data),
    });
  }

  /**
   * The reaper must not reuse the original job id: a completed job may still
   * be in the completed set, and `add` would then be a no-op.
   */
  async enqueueRecovery(data: IncidentNotificationJob): Promise<void> {
    await this.queue.add(DELIVER_INCIDENT_NOTIFICATION_JOB, data, {
      jobId: `${buildIncidentNotificationJobId(data)}-reap-${Date.now()}`,
    });
  }
}
