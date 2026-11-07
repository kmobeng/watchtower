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
import { CreateNotificationChannelDto } from './dto/create-notification-channel.dto';
import { UpdateNotificationChannelDto } from './dto/update-notification-channel.dto';
import { NotificationChannelsService } from './notification-channels.service';

@UseGuards(JwtAuthGuard)
@Controller('notification-channels')
export class NotificationChannelsController {
  constructor(
    private readonly notificationChannelsService: NotificationChannelsService,
  ) {}

  @Post()
  async create(
    @CurrentUser() user: AccessJWTPayload,
    @Body() dto: CreateNotificationChannelDto,
  ) {
    const channel = await this.notificationChannelsService.create(
      user.sub,
      dto,
    );
    return { success: true, data: channel };
  }

  @Get()
  async findAll(@CurrentUser() user: AccessJWTPayload) {
    const channels = await this.notificationChannelsService.findAll(user.sub);
    return { success: true, data: channels };
  }

  @Get(':id')
  async findOne(
    @CurrentUser() user: AccessJWTPayload,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    const channel = await this.notificationChannelsService.findOne(
      user.sub,
      id,
    );
    return { success: true, data: channel };
  }

  @Patch(':id')
  async update(
    @CurrentUser() user: AccessJWTPayload,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateNotificationChannelDto,
  ) {
    const channel = await this.notificationChannelsService.update(
      user.sub,
      id,
      dto,
    );
    return { success: true, data: channel };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async remove(
    @CurrentUser() user: AccessJWTPayload,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    await this.notificationChannelsService.remove(user.sub, id);
    return {
      success: true,
      message: 'Notification channel deleted successfully',
    };
  }
}
