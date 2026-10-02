import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/auth.guard';
import { CurrentUser } from '../common/decorators/currentUser.decorator';
import type { AccessJWTPayload } from '../common/interfaces/jwt.interface';
import {
  MONITORS_DEFAULT_LIMIT,
  MONITORS_DEFAULT_PAGE,
} from '../monitors/dto/list-monitors.dto';
import { ListIncidentsDto } from './dto/list-incidents.dto';
import { IncidentService } from './incident.service';

@UseGuards(JwtAuthGuard)
@Controller('incidents')
export class IncidentsController {
  constructor(private readonly incidentService: IncidentService) {}

  @Get()
  async findAll(
    @CurrentUser() user: AccessJWTPayload,
    @Query() query: ListIncidentsDto,
  ) {
    const result = await this.incidentService.findAll(
      user.sub,
      query.monitorId,
      query.page ?? MONITORS_DEFAULT_PAGE,
      query.limit ?? MONITORS_DEFAULT_LIMIT,
    );
    return {
      success: true,
      data: result.items,
      meta: {
        page: result.page,
        limit: result.limit,
        total: result.total,
        totalPages: result.totalPages,
      },
    };
  }

  @Post(':id/acknowledge')
  @HttpCode(HttpStatus.OK)
  async acknowledge(
    @CurrentUser() user: AccessJWTPayload,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    const incident = await this.incidentService.acknowledge(user.sub, id);
    return { success: true, data: incident };
  }
}
