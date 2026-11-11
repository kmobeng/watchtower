import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import Redis from 'ioredis';
import {
  DASHBOARD_INCIDENT_CHANNEL,
  isIncidentFeedMessage,
} from '../incidents/incident-feed.events';
import { RedisService } from '../redis/redis.service';
import { DashboardGateway } from './dashboard.gateway';

/**
 * Bridges the worker's Redis publish to this API instance's sockets.
 *
 * A dedicated (duplicated) connection is required: once an ioredis client is
 * in subscriber mode it cannot issue normal commands, and the shared client is
 * used for auth and locks.
 */
@Injectable()
export class DashboardSubscriberService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(DashboardSubscriberService.name);

  private subscriber?: Redis;
  private ready: Promise<void> = Promise.resolve();

  constructor(
    private readonly redisService: RedisService,
    private readonly gateway: DashboardGateway,
  ) {}

  async onModuleInit(): Promise<void> {
    const subscriber = this.redisService.getClient().duplicate();
    this.subscriber = subscriber;

    subscriber.on('error', (error) => {
      this.logger.error(
        'Dashboard subscriber Redis error',
        error?.stack ?? String(error),
      );
    });

    subscriber.on('message', (channel: string, raw: string) => {
      this.handleMessage(channel, raw);
    });

    this.ready = subscriber.subscribe(DASHBOARD_INCIDENT_CHANNEL).then(
      () => {
        this.logger.log(`Subscribed to ${DASHBOARD_INCIDENT_CHANNEL}`);
      },
      (error) => {
        this.logger.error(
          { err: error instanceof Error ? error.message : String(error) },
          'Failed to subscribe to dashboard incident events',
        );
        throw error;
      },
    );

    // A Redis outage must not stop the API from booting; `whenReady` surfaces
    // the failure to callers that need a live feed (such as the e2e suite).
    await this.ready.catch(() => undefined);
  }

  /** Resolves once the subscription is active; rejects if it failed. */
  whenReady(): Promise<void> {
    return this.ready;
  }

  async onModuleDestroy(): Promise<void> {
    const subscriber = this.subscriber;
    this.subscriber = undefined;
    if (!subscriber) return;

    try {
      await subscriber.quit();
    } catch (error) {
      this.logger.warn(
        {
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to close dashboard subscriber connection',
      );
    }
  }

  private handleMessage(channel: string, raw: string): void {
    if (channel !== DASHBOARD_INCIDENT_CHANNEL) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.logger.warn(
        { channel },
        'Ignoring malformed dashboard incident payload',
      );
      return;
    }

    if (!isIncidentFeedMessage(parsed)) {
      this.logger.warn(
        { channel },
        'Ignoring unrecognized dashboard incident payload',
      );
      return;
    }

    this.gateway.emitIncident(parsed);
  }
}
