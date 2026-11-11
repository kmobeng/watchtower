import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { HttpMethod } from '../../../generated/prisma/client';

export class UpdateMonitorDto {
  @IsOptional()
  @IsString({ message: 'URL must be a string' })
  @IsUrl(
    {
      require_protocol: true,
      protocols: ['http', 'https'],
      require_tld: false,
    },
    { message: 'URL must be a valid http(s) URL' },
  )
  @MaxLength(2048, { message: 'URL must be at most 2048 characters long' })
  url?: string;

  @IsOptional()
  @IsEnum(HttpMethod, {
    message: 'Method must be one of GET, HEAD or POST',
  })
  method?: HttpMethod;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'Interval must be an integer number of seconds' })
  @Min(60, { message: 'Interval must be at least 60 seconds' })
  @Max(86400, { message: 'Interval must be at most 86400 seconds' })
  intervalSeconds?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'Timeout must be an integer number of milliseconds' })
  @Min(1000, { message: 'Timeout must be at least 1000ms' })
  @Max(30000, { message: 'Timeout must be at most 30000ms' })
  timeoutMs?: number;

  /** Send `null` to disable the slow-response limit. */
  @IsOptional()
  @Type(() => Number)
  @IsInt({
    message:
      'Response time threshold must be an integer number of milliseconds',
  })
  @Min(100, { message: 'Response time threshold must be at least 100ms' })
  @Max(30000, {
    message: 'Response time threshold must be at most 30000ms',
  })
  responseTimeThresholdMs?: number | null;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'Failure threshold must be an integer' })
  @Min(1, { message: 'Failure threshold must be at least 1' })
  @Max(10, { message: 'Failure threshold must be at most 10' })
  failureThreshold?: number;

  @IsOptional()
  @IsUUID('4', { message: 'Escalation policy ID must be a valid UUID' })
  escalationPolicyId?: string | null;
}
