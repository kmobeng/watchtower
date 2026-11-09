import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { RedisModule } from '../redis/redis.module';
import { RollupSweepService } from './rollup-sweep.service';
import { RollupsService } from './rollups.service';

/**
 * Rollup aggregation and read side. Imported by the API process only: the
 * worker module deliberately omits it so check processing never registers
 * rollup crons.
 */
@Module({
  imports: [RedisModule],
  providers: [PrismaService, RollupsService, RollupSweepService],
  exports: [RollupsService],
})
export class RollupsModule {}
