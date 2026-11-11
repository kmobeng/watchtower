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
import { CurrentUser } from '../common/decorators/currentUser.decorator';
import { JwtAuthGuard } from '../common/guards/auth.guard';
import type { AccessJWTPayload } from '../common/interfaces/jwt.interface';
import { CreateStatusPageDto } from './dto/create-status-page.dto';
import { UpdateStatusPageDto } from './dto/update-status-page.dto';
import { StatusPagesService } from './status-pages.service';

/**
 * Owner-scoped management. There is deliberately no `GET /:id`: the public
 * read owns `GET /status-pages/:slug`, and two param routes at the same depth
 * would collide. The list endpoint is enough for an editor.
 */
@UseGuards(JwtAuthGuard)
@Controller('status-pages')
export class StatusPagesController {
  constructor(private readonly statusPages: StatusPagesService) {}

  @Get()
  async findAll(@CurrentUser() user: AccessJWTPayload) {
    const pages = await this.statusPages.findAll(user.sub);
    return { success: true, data: pages };
  }

  @Post()
  async create(
    @CurrentUser() user: AccessJWTPayload,
    @Body() dto: CreateStatusPageDto,
  ) {
    const page = await this.statusPages.create(user.sub, dto);
    return { success: true, data: page };
  }

  @Patch(':id')
  async update(
    @CurrentUser() user: AccessJWTPayload,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateStatusPageDto,
  ) {
    const page = await this.statusPages.update(user.sub, id, dto);
    return { success: true, data: page };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async remove(
    @CurrentUser() user: AccessJWTPayload,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    await this.statusPages.remove(user.sub, id);
    return { success: true, message: 'Status page deleted successfully' };
  }
}
