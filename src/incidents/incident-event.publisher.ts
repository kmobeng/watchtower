import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import {
  DASHBOARD_INCIDENT_CHANNEL,
  IncidentFeedEventName,
  IncidentFeedMessage,
  FeedIncident,
} from './incident-feed.events';

/**
 * Publishes dashboard events to Redis. Every API instance subscribes and
 * fans the message out to its own sockets, so the producer (API or worker)
 * never needs to know which process holds a connection.
 *
 * Publishing is best-effort: the database transition has already committed,
 * so a Redis outage must not fail the incident write. A client that misses an
 * event recovers from the snapshot it receives on reconnect.
 */
@Injectable()
export class IncidentEventPublisher {
  private readonly logger = new Logger(IncidentEventPublisher.name);

  constructor(private readonly redisService: RedisService) {}

  async publish(
    event: IncidentFeedEventName,
    incident: FeedIncident,
  ): Promise<void> {
    const message: IncidentFeedMessage = {
      event,
      incident,
      occurredAt: new Date().toISOString(),
    };

    try {
      await this.redisService
        .getClient()
        .publish(DASHBOARD_INCIDENT_CHANNEL, JSON.stringify(message));
    } catch (error) {
      this.logger.error(
        {
          incidentId: incident.id,
          event,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to publish incident feed event',
      );
    }
  }
}
