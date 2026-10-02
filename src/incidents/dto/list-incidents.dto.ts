import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { MONITORS_MAX_LIMIT } from '../../monitors/dto/list-monitors.dto';

export class ListIncidentsDto {
  @IsOptional()
  @IsUUID('4', { message: 'Monitor ID must be a valid UUID' })
  monitorId?: string;

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
