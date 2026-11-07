import { Type } from 'class-transformer';
import { IsInt, IsUUID, Max, Min } from 'class-validator';
import {
  ESCALATION_MAX_AFTER_MINUTES,
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

  @IsUUID('4', { message: 'notifyChannelId must be a UUID' })
  notifyChannelId!: string;
}
