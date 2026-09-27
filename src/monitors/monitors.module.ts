import { Module } from '@nestjs/common';
import { MonitorsController } from './monitors.controller';
import { MonitorsService } from './monitors.service';
import { PrismaService } from '../prisma.service';
import { AuthModule } from '../auth/auth.module';
import { ChecksModule } from '../checks/checks.module';

@Module({
  imports: [AuthModule, ChecksModule],
  controllers: [MonitorsController],
  providers: [MonitorsService, PrismaService],
  exports: [MonitorsService],
})
export class MonitorsModule {}
