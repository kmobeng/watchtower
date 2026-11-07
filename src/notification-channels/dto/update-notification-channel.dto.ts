import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { NotificationChannelType } from '../../../generated/prisma/client';

export class UpdateNotificationChannelDto {
  @IsOptional()
  @IsEnum(NotificationChannelType, {
    message: 'type must be EMAIL or SMS',
  })
  type?: NotificationChannelType;

  @IsOptional()
  @IsString({ message: 'destination must be a string' })
  @MaxLength(320, { message: 'destination must be at most 320 characters' })
  destination?: string;

  @IsOptional()
  @IsString({ message: 'label must be a string' })
  @MaxLength(100, { message: 'label must be at most 100 characters' })
  label?: string;
}
