import 'reflect-metadata';
import { Queue } from 'bullmq';
import {
  DELIVER_INCIDENT_NOTIFICATION_JOB,
  IncidentNotificationsService,
} from './incident-notifications.service';

describe('IncidentNotificationsService', () => {
  let queue: { add: jest.Mock };
  let service: IncidentNotificationsService;

  const data = { incidentId: 'inc-1', channelId: 'chan-1', step: 0 };

  beforeEach(() => {
    queue = { add: jest.fn().mockResolvedValue(undefined) };
    service = new IncidentNotificationsService(queue as unknown as Queue);
  });

  it('enqueues with a stable hyphenated job id', async () => {
    await service.enqueue(data);

    expect(queue.add).toHaveBeenCalledWith(
      DELIVER_INCIDENT_NOTIFICATION_JOB,
      data,
      { jobId: 'incident-inc-1-channel-chan-1-step-0' },
    );
  });

  it('uses a distinct id for recovery so a completed job cannot swallow it', async () => {
    await service.enqueueRecovery(data);

    const options = queue.add.mock.calls[0][2];
    expect(options.jobId).toMatch(
      /^incident-inc-1-channel-chan-1-step-0-reap-\d+$/,
    );
  });
});
