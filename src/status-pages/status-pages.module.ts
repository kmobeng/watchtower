import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaService } from '../prisma.service';
import { RollupsModule } from '../rollups/rollups.module';
import { PublicStatusPagesController } from './public-status-pages.controller';
import { StatusPagesController } from './status-pages.controller';
import { StatusPagesService } from './status-pages.service';

/**
 * Public status pages. The public controller is unauthenticated and carries
 * its own per-route CORS header; the management controller is JWT-guarded.
 */
@Module({
  imports: [AuthModule, RollupsModule],
  controllers: [StatusPagesController, PublicStatusPagesController],
  providers: [PrismaService, StatusPagesService],
  exports: [StatusPagesService],
})
export class StatusPagesModule {}
