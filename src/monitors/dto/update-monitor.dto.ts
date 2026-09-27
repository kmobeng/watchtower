import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

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

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'Failure threshold must be an integer' })
  @Min(1, { message: 'Failure threshold must be at least 1' })
  @Max(10, { message: 'Failure threshold must be at most 10' })
  failureThreshold?: number;
}
