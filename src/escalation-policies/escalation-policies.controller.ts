import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/auth.guard';
import { CurrentUser } from '../common/decorators/currentUser.decorator';
import type { AccessJWTPayload } from '../common/interfaces/jwt.interface';
import { CreateEscalationPolicyDto } from './dto/create-escalation-policy.dto';
import { UpdateEscalationPolicyDto } from './dto/update-escalation-policy.dto';
import { EscalationPoliciesService } from './escalation-policies.service';

@UseGuards(JwtAuthGuard)
@Controller('escalation-policies')
export class EscalationPoliciesController {
  constructor(
    private readonly escalationPoliciesService: EscalationPoliciesService,
  ) {}

  @Post()
  async create(
    @CurrentUser() user: AccessJWTPayload,
    @Body() dto: CreateEscalationPolicyDto,
  ) {
    const policy = await this.escalationPoliciesService.create(user.sub, dto);
    return { success: true, data: policy };
  }

  @Get()
  async findAll(@CurrentUser() user: AccessJWTPayload) {
    const policies = await this.escalationPoliciesService.findAll(user.sub);
    return { success: true, data: policies };
  }

  @Get(':id')
  async findOne(
    @CurrentUser() user: AccessJWTPayload,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    const policy = await this.escalationPoliciesService.findOne(user.sub, id);
    return { success: true, data: policy };
  }

  @Patch(':id')
  async update(
    @CurrentUser() user: AccessJWTPayload,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateEscalationPolicyDto,
  ) {
    const policy = await this.escalationPoliciesService.update(
      user.sub,
      id,
      dto,
    );
    return { success: true, data: policy };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async remove(
    @CurrentUser() user: AccessJWTPayload,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    await this.escalationPoliciesService.remove(user.sub, id);
    return {
      success: true,
      message: 'Escalation policy deleted successfully',
    };
  }
}
