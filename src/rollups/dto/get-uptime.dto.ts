import {
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export const UPTIME_DEFAULT_HOURS = 24;
export const UPTIME_DEFAULT_DAYS = 30;
export const UPTIME_MAX_BUCKETS = 1000;

export class GetUptimeDto {
  @IsOptional()
  @IsIn(['hour', 'day'], {
    message: 'Granularity must be either "hour" or "day"',
  })
  granularity?: 'hour' | 'day';

  @IsOptional()
  @IsISO8601({}, { message: 'From must be an ISO 8601 timestamp' })
  from?: string;

  @IsOptional()
  @IsISO8601({}, { message: 'To must be an ISO 8601 timestamp' })
  to?: string;

  @IsOptional()
  @IsString({ message: 'Region must be a string' })
  @MaxLength(64, { message: 'Region must be at most 64 characters long' })
  region?: string;
}
