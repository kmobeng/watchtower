import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Validate,
  ValidateNested,
} from 'class-validator';
import {
  ESCALATION_MAX_STEPS,
  ESCALATION_MIN_STEPS,
} from '../escalation-steps';
import { IsEscalationStepsConstraint } from './create-escalation-policy.dto';
import { EscalationStepDto } from './escalation-step.dto';

export class UpdateEscalationPolicyDto {
  @IsOptional()
  @IsString({ message: 'Name must be a string' })
  @IsNotEmpty({ message: 'Name must not be empty' })
  @MaxLength(100, { message: 'Name must be at most 100 characters' })
  name?: string;

  @IsOptional()
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
  steps?: EscalationStepDto[];
}
