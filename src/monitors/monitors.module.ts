import { Module } from '@nestjs/common';
import { MonitorsController } from './monitors.controller';
import { MonitorsService } from './monitors.service';
import { PrismaService } from '../prisma.service';
import { AuthModule } from '../auth/auth.module';
import { CheckSchedulingModule } from '../checks/check-scheduling.module';
import { loadApiFleetConfig } from '../checks/check-regions';
import { RollupsModule } from '../rollups/rollups.module';

@Module({
  imports: [
    AuthModule,
    CheckSchedulingModule.forRoot(loadApiFleetConfig(process.env)),
    RollupsModule,
  ],
  controllers: [MonitorsController],
  providers: [MonitorsService, PrismaService],
  exports: [MonitorsService],
})
export class MonitorsModule {}
