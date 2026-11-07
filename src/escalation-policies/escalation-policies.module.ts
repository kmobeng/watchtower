import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { PrismaService } from '../prisma.service';
import { EscalationPoliciesController } from './escalation-policies.controller';
import { EscalationPoliciesService } from './escalation-policies.service';

@Module({
  imports: [AuthModule],
  controllers: [EscalationPoliciesController],
  providers: [EscalationPoliciesService, PrismaService],
  exports: [EscalationPoliciesService],
})
export class EscalationPoliciesModule {}
