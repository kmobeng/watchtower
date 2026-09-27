import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export const MONITORS_DEFAULT_PAGE = 1;
export const MONITORS_DEFAULT_LIMIT = 20;
export const MONITORS_MAX_LIMIT = 100;

export class ListMonitorsDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'Page must be an integer' })
  @Min(1, { message: 'Page must be at least 1' })
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'Limit must be an integer' })
  @Min(1, { message: 'Limit must be at least 1' })
  @Max(MONITORS_MAX_LIMIT, {
    message: `Limit must be at most ${MONITORS_MAX_LIMIT}`,
  })
  limit?: number;
}
