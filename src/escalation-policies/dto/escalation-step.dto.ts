import { Type } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  ESCALATION_MAX_AFTER_MINUTES,
  ESCALATION_MAX_CHANNEL_ID_LENGTH,
  ESCALATION_MIN_AFTER_MINUTES,
} from '../escalation-steps';

export class EscalationStepDto {
  @Type(() => Number)
  @IsInt({ message: 'afterMinutes must be an integer' })
  @Min(ESCALATION_MIN_AFTER_MINUTES, {
    message: `afterMinutes must be at least ${ESCALATION_MIN_AFTER_MINUTES}`,
  })
  @Max(ESCALATION_MAX_AFTER_MINUTES, {
    message: `afterMinutes must be at most ${ESCALATION_MAX_AFTER_MINUTES}`,
  })
  afterMinutes!: number;

  @IsString({ message: 'notifyChannelId must be a string' })
  @IsNotEmpty({ message: 'notifyChannelId is required' })
  @MaxLength(ESCALATION_MAX_CHANNEL_ID_LENGTH, {
    message: `notifyChannelId must be at most ${ESCALATION_MAX_CHANNEL_ID_LENGTH} characters`,
  })
  notifyChannelId!: string;
}
