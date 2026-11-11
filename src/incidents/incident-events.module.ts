import { Module } from '@nestjs/common';
import { RedisModule } from '../redis/redis.module';
import { IncidentEventPublisher } from './incident-event.publisher';

/**
 * Redis-only bridge for the live dashboard. Both the API process (which owns
 * the gateway) and the worker process (which opens and resolves incidents)
 * import this module; neither needs the other's feature modules.
 */
@Module({
  imports: [RedisModule],
  providers: [IncidentEventPublisher],
  exports: [IncidentEventPublisher],
})
export class IncidentEventsModule {}
