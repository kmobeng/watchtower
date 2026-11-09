import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { QueueModule } from './queue/queue.module';
import { RedisModule } from './redis/redis.module';
import { FlappingModule } from './flapping/flapping.module';
import { CheckWorkerModule } from './checks/check-worker.module';
import { loadWorkerFleetConfig } from './checks/check-regions';

/**
 * Worker process entrypoint module. No HTTP, no scheduler, no notification
 * processors: it only consumes its region's check queue.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    RedisModule,
    FlappingModule,
    QueueModule,
    CheckWorkerModule.forRoot(loadWorkerFleetConfig(process.env)),
  ],
})
export class WorkerModule {}
