import { Module } from '@nestjs/common';
import { MonitorsController } from './monitors.controller';
import { MonitorsService } from './monitors.service';
import { PrismaService } from '../prisma.service';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [AuthModule],
  controllers: [MonitorsController],
  providers: [MonitorsService, PrismaService],
  exports: [MonitorsService],
})
export class MonitorsModule {}
