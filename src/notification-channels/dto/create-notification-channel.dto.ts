import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { NotificationChannelType } from '../../../generated/prisma/client';

export class CreateNotificationChannelDto {
  @IsEnum(NotificationChannelType, {
    message: 'type must be EMAIL or SMS',
  })
  type!: NotificationChannelType;

  @IsString({ message: 'destination must be a string' })
  @IsNotEmpty({ message: 'destination is required' })
  @MaxLength(320, { message: 'destination must be at most 320 characters' })
  destination!: string;

  @IsOptional()
  @IsString({ message: 'label must be a string' })
  @MaxLength(100, { message: 'label must be at most 100 characters' })
  label?: string;
}
