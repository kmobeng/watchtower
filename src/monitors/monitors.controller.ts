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
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../common/guards/auth.guard';
import { CurrentUser } from '../common/decorators/currentUser.decorator';
import type { AccessJWTPayload } from '../common/interfaces/jwt.interface';
import { CreateMonitorDto } from './dto/create-monitor.dto';
import {
  MONITORS_DEFAULT_LIMIT,
  MONITORS_DEFAULT_PAGE,
  ListMonitorsDto,
} from './dto/list-monitors.dto';
import { UpdateMonitorDto } from './dto/update-monitor.dto';
import { MonitorsService } from './monitors.service';

@UseGuards(JwtAuthGuard)
@Controller('monitors')
export class MonitorsController {
  constructor(private readonly monitorsService: MonitorsService) {}

  @Post()
  async create(
    @CurrentUser() user: AccessJWTPayload,
    @Body() dto: CreateMonitorDto,
  ) {
    const monitor = await this.monitorsService.create(user.sub, dto);
    return { success: true, data: monitor };
  }

  @Get()
  async findAll(
    @CurrentUser() user: AccessJWTPayload,
    @Query() query: ListMonitorsDto,
  ) {
    const page = query.page ?? MONITORS_DEFAULT_PAGE;
    const limit = query.limit ?? MONITORS_DEFAULT_LIMIT;
    const result = await this.monitorsService.findAll(user.sub, page, limit);
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

  @Get(':id')
  async findOne(
    @CurrentUser() user: AccessJWTPayload,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    const monitor = await this.monitorsService.findOne(user.sub, id);
    return { success: true, data: monitor };
  }

  @Patch(':id')
  async update(
    @CurrentUser() user: AccessJWTPayload,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateMonitorDto,
  ) {
    const monitor = await this.monitorsService.update(user.sub, id, dto);
    return { success: true, data: monitor };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async remove(
    @CurrentUser() user: AccessJWTPayload,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    await this.monitorsService.remove(user.sub, id);
    return { success: true, message: 'Monitor deleted successfully' };
  }
}
