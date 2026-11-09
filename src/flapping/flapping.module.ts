import { Global, Module } from '@nestjs/common';
import { RedisModule } from '../redis/redis.module';
import { FlapDetectorService } from './flap-detector.service';

/**
 * Shared by the API process (suppression + monitor API) and the worker
 * process (recording verdicts). Global so every feature module can inject the
 * detector without re-importing this module; import it once per root graph.
 */
@Global()
@Module({
  imports: [RedisModule],
  providers: [FlapDetectorService],
  exports: [FlapDetectorService],
})
export class FlappingModule {}
