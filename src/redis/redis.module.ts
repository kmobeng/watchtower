import { Module, Global } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { RedisService } from './redis.service';
import { TokenStoreService } from './token-store.service';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [RedisService, TokenStoreService],
  exports: [RedisService, TokenStoreService],
})
export class RedisModule {}
