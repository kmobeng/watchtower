import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsNotEmpty,
  IsString,
  MaxLength,
  Validate,
  ValidateNested,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import {
  ESCALATION_MAX_STEPS,
  ESCALATION_MIN_STEPS,
  parseEscalationSteps,
} from '../escalation-steps';
import { EscalationStepDto } from './escalation-step.dto';

/**
 * Cross-entry rules (strictly increasing afterMinutes) cannot be expressed
 * with per-field decorators, so the whole array is validated as one unit.
 */
@ValidatorConstraint({ name: 'isEscalationSteps', async: false })
export class IsEscalationStepsConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    try {
      parseEscalationSteps(value);
      return true;
    } catch {
      return false;
    }
  }

  defaultMessage(): string {
    return `steps must contain ${ESCALATION_MIN_STEPS}-${ESCALATION_MAX_STEPS} entries with strictly increasing afterMinutes and a notifyChannelId`;
  }
}

export class CreateEscalationPolicyDto {
  @IsString({ message: 'Name must be a string' })
  @IsNotEmpty({ message: 'Name is required' })
  @MaxLength(100, { message: 'Name must be at most 100 characters' })
  name!: string;

  @IsArray({ message: 'steps must be an array' })
  @ArrayMinSize(ESCALATION_MIN_STEPS, {
    message: `steps must contain at least ${ESCALATION_MIN_STEPS} entry`,
  })
  @ArrayMaxSize(ESCALATION_MAX_STEPS, {
    message: `steps must contain at most ${ESCALATION_MAX_STEPS} entries`,
  })
  @Type(() => EscalationStepDto)
  @ValidateNested({ each: true })
  @Validate(IsEscalationStepsConstraint)
  steps!: EscalationStepDto[];
}
