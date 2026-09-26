import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PrismaService } from '../prisma.service';
import { TokenUtils } from './utils/auth.util';
import { OutboxModule } from '../outbox/outbox.module';
import { RedisModule } from '../redis/redis.module';

@Module({
  imports: [ConfigModule, JwtModule.register({}), OutboxModule, RedisModule],
  controllers: [AuthController],
  providers: [AuthService, PrismaService, TokenUtils],
  exports: [TokenUtils, AuthService],
})
export class AuthModule {}
